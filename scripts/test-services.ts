// Тесты публичной поверхности ядра (`createCore` → `Core`). Это ровно тот слой,
// который виден IPC: из renderer приходят те же вызовы, что и отсюда.
//
// Зачем файл: тонкие слои (нормализация, склейка, миграции, планировщик) тесты
// закрывали хорошо, а сам `services.ts` стоял на 85% строк при 69% веток —
// половина его методов не вызывалась ни одним тестом. Здесь они прогоняются на
// фейковых адаптерах и файловом хранилище: без сети и без Electron.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCore } from '../src/core/services.js';
import { closeDb, openDb, savePriceIfChanged } from '../src/core/db/db.js';
import { fileStorageAt } from '../electron/node-files.js';
import { UNASSIGNED_ID } from '../src/core/services.js';
import type { ScrapedProduct, StoreAdapter, StoreCategory } from '../src/shared/types.js';
import type { CoreDeps } from '../src/core/platform.js';

type SearchCtx = Parameters<StoreAdapter['search']>[1];
type ProductCtx = Parameters<StoreAdapter['fetchProduct']>[1];

const events: { channel: string; payload: unknown }[] = [];
const scheduled: { every?: () => void; after?: () => void } = {};

const product = (
  canonicalId: string,
  name: string,
  price: number,
  extra: Partial<ScrapedProduct> = {},
): ScrapedProduct => ({
  canonicalId,
  storeId: 'magnit',
  city: 'moscow',
  name,
  unit: '1 шт',
  price,
  promoPrice: null,
  oldPrice: null,
  inStock: true,
  url: 'https://magnit.ru/product/1',
  collectedAt: '2026-10-02T10:00:00.000Z',
  ...extra,
});

class FakeAdapter implements StoreAdapter {
  searchCalls = 0;
  categoryCalls = 0;
  productCalls = 0;
  failSearch = false;
  failCategory = false;
  failProduct = false;
  categories: StoreCategory[] = [];

  constructor(
    readonly storeId: 'magnit' | 'lenta',
    private readonly items: ScrapedProduct[],
    private readonly host: string,
  ) {}

  async search(query: string, ctx: SearchCtx): Promise<ScrapedProduct[]> {
    this.searchCalls += 1;
    if (this.failSearch) throw new Error(`${this.storeId}: сеть молчит`);
    return this.items
      .filter((i) => i.name.toLowerCase().includes(query.toLowerCase()))
      .map((i) => ({ ...i, city: ctx.city, storeId: this.storeId }));
  }

  async fetchCategories(): Promise<StoreCategory[]> {
    this.categoryCalls += 1;
    if (this.failCategory) throw new Error(`${this.storeId}: каталог недоступен`);
    return this.categories;
  }

  canHandleCategoryUrl(url: string): boolean {
    return url.includes(this.host);
  }

  async fetchCategoryProducts(_url: string, ctx: SearchCtx): Promise<ScrapedProduct[]> {
    if (this.failCategory) throw new Error(`${this.storeId}: витрина недоступна`);
    return this.items.map((i) => ({ ...i, city: ctx.city, storeId: this.storeId }));
  }

  async fetchProduct(canonicalId: string, ctx: ProductCtx): Promise<ScrapedProduct> {
    this.productCalls += 1;
    if (this.failProduct) throw new Error(`${this.storeId}: карточка не отвечает`);
    const found = this.items.find((i) => i.canonicalId === canonicalId);
    if (!found) throw new Error(`${this.storeId}: товар не найден`);
    return { ...found, city: ctx.city, storeId: this.storeId };
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-svc-'));
const jsonFiles = new Map<string, string>();
const magnit = new FakeAdapter(
  'magnit',
  [
    product('m-milk', 'Молоко ПРАВИЛЬНОЕ 3,2%, 930мл', 119),
    product('m-cheese', 'Сыр Hochland Сливочный 55% 200г', 229),
  ],
  'magnit.ru',
);
const lenta = new FakeAdapter(
  'lenta',
  [product('l-milk', 'Молоко ПРАВИЛЬНОЕ 3,2%, 930мл', 124)],
  'lenta.ru',
);
magnit.categories = [{ id: 'c1', name: 'Молоко', url: 'https://magnit.ru/catalog/1-', imageUrl: 'https://img/c1.webp' }];

const storage = fileStorageAt(path.join(tmpDir, 't.db'));
const deps: CoreDeps = {
  storage,
  json: {
    read: (name) => jsonFiles.get(name) ?? null,
    write: (name, text) => void jsonFiles.set(name, text),
  },
  shell: { version: () => '1.2.1', notify: () => {}, openExternal: async () => {} },
  background: {
    every: (_ms, task) => void (scheduled.every = task),
    after: (_ms, task) => void (scheduled.after = task),
  },
  log: { error: () => {}, warn: () => {}, info: () => {} },
  adapters: new Map([
    ['magnit', magnit],
    ['lenta', lenta],
  ]),
  emit: (channel, payload) => events.push({ channel, payload }),
};

const core = createCore(deps);
core.setCurrentCity('moscow');
const db = await openDb(storage);

/** Последняя сводка из событий завершения — её и красит renderer. */
const pollSummaryFrom = (list: { channel: string; payload: unknown }[]): string => {
  const last = [...list].reverse().find((e) => e.channel === 'scheduler:done');
  const payload = last?.payload as { summary?: string } | undefined;
  return payload?.summary ?? '';
};

// --- 0. Пустая база: опрос честно говорит, что нечего было проверять.
// Именно для этого блок идёт первым: openDb — синглтон на процесс, и база с
// товарами уже не опустеет.
{
  const res = await core.runScheduler({ city: 'moscow' });
  assert.match(res.summary, /отслеживаемых товаров пока нет/, 'пустой опрос не придумывает «проверено 0»');
  assert.equal(res.status.counts.inserted, 0, 'и в счётчиках честный ноль');
  assert.equal(pollSummaryFrom(events).length > 0, true, 'событие завершения всё равно пришло — renderer не ждёт вечно');
}

// --- 1. Поиск: строка на каждый магазин города, чужой адаптер не выдумывается.
{
  assert.deepEqual(await core.searchPrices({ query: '   ' }), [], 'пустой запрос не дёргает сети');

  const found = await core.searchPrices({ query: 'молоко' });
  const magnitRow = found.find((s) => s.storeId === 'magnit');
  const lentaRow = found.find((s) => s.storeId === 'lenta');
  assert.equal(magnitRow?.items.length, 1, 'Магнит нашёл своё');
  assert.equal(lentaRow?.items.length, 1, 'Лента нашла своё');
  assert.equal(magnitRow?.items[0]?.price, 119, 'цена Магнита его');
  assert.equal(lentaRow?.items[0]?.price, 124, 'цена Ленты её, а не смешанная');
  assert.ok(
    found.every((s) => s.items.every((i) => i.city === 'moscow')),
    'город из аргументов доехал до каждого товара',
  );
  const withoutAdapter = found.filter((s) => s.error === 'нет адаптера');
  assert.ok(
    withoutAdapter.every((s) => s.items.length === 0),
    'сеть без адаптера показана пустой строкой с причиной, а не выдуманными ценами',
  );

  magnit.failSearch = true;
  const degraded = await core.searchPrices({ query: 'молоко' });
  const failed = degraded.find((s) => s.storeId === 'magnit');
  assert.match(failed?.error ?? '', /молчит/, 'отказ сети виден в её строке');
  assert.equal(degraded.find((s) => s.storeId === 'lenta')?.items.length, 1, 'соседняя сеть не сломана');
  magnit.failSearch = false;
}

// --- 2. Каталоги: сеть без каталога пуста, кэш работает, отказ отдаёт протухшее.
{
  const first = await core.getCatalogs({ city: 'moscow' });
  assert.equal(first.find((c) => c.storeId === 'magnit')?.categories.length, 1, 'каталог Магнита приехал');
  assert.equal(
    first.find((c) => c.storeId === 'magnit')?.categories[0]?.imageUrl,
    'https://img/c1.webp',
    'картинка витрины не потерялась',
  );
  assert.equal(first.find((c) => c.storeId === 'lenta')?.categories.length, 0, 'у сети без каталога пусто');

  const calls = magnit.categoryCalls;
  await core.getCatalogs({ city: 'moscow' });
  assert.equal(magnit.categoryCalls, calls, 'повторный запрос взят из кэша, сеть не дёрнута');

  // Кэш свежий — сеть не дёрнута (проверено выше). Теперь состарим его и
  // откажем сеть: ядро обязано отдать протухшее, но не выдумать и не молчать.
  const key = [...jsonFiles.keys()].find((k) => k.includes('magnit'))!;
  const cached = JSON.parse(jsonFiles.get(key)!) as { at: number; categories: unknown };
  jsonFiles.set(key, JSON.stringify({ ...cached, at: Date.now() - 30 * 24 * 3600 * 1000 }));

  magnit.failCategory = true;
  const callsAfterAge = magnit.categoryCalls;
  const stale = await core.getCatalogs({ city: 'moscow' });
  const staleRow = stale.find((c) => c.storeId === 'magnit');
  assert.equal(magnit.categoryCalls, callsAfterAge + 1, 'протухший кэш не считается попаданием — сеть спросили');
  assert.equal(staleRow?.categories.length, 1, 'и при отказе отдаём протухшее, а не пустоту');
  assert.equal(staleRow?.error, undefined, 'протухшее показано спокойно, без страшной ошибки');
  magnit.failCategory = false;
}

// --- 3. Витрина: ссылка уходит только своей сети.
{
  assert.deepEqual(await core.getCategoryProducts({ city: 'moscow' }), [], 'без ссылки витрина не грузится');

  const own = await core.getCategoryProducts({ city: 'moscow', url: 'https://magnit.ru/catalog/1-' });
  const ownRow = own.find((s) => s.storeId === 'magnit');
  assert.equal(ownRow?.items.length, 2, 'своя витрина отдала товары');
  assert.ok(!own.some((s) => s.storeId === 'lenta'), 'чужая сеть в этот запрос не попала');

  const foreign = await core.getCategoryProducts({ city: 'moscow', url: 'https://example.com/catalog/zzz' });
  assert.equal(foreign.length, 1, 'на чужую ссылку отвечает одна строка-объяснение');
  assert.match(foreign[0]?.error ?? '', /не принадлежит ни одной сети/, 'и она говорит, что не так');
}

// --- 4. Наши полки: плоский список, виртуальная полка, кэш открытия.
{
  const list = core.getOurCategories({ city: 'moscow' });
  assert.equal(list.length, 17, '16 полок плюс виртуальная «Не разложено»');
  assert.ok(list.every((c) => c.parentId === null), 'список плоский: вложенности нет ни у одной полки');
  const unassigned = list.find((c) => c.id === UNASSIGNED_ID);
  assert.equal(unassigned?.virtual, true, 'виртуальная полка помечена, чтобы её не спутать с настоящей');
  assert.equal(unassigned?.queryCount, 0, 'у виртуальной полки нет запросов');

  const shelf = await core.getOurCategory({ city: 'moscow', id: 'dairy-milk' });
  assert.ok(shelf.some((s) => s.items.length > 0), 'полка «Молоко» собрала товары');

  const calls = magnit.searchCalls;
  await core.getOurCategory({ city: 'moscow', id: 'dairy-milk' });
  assert.equal(magnit.searchCalls, calls, 'повторное открытие полки взято из кэша');

  await assert.rejects(
    () => core.getOurCategory({ city: 'moscow', id: 'нет-такой-полки' }),
    /неизвестная категория/,
    'неизвестная полка отвергается, а не возвращает молчаливую пустоту',
  );
}

// --- 5. Полки товара: чтение, запись, отказ на плохих данных, возврат автораскладке.
{
  const scope = { canonicalId: 'm-milk', storeId: 'magnit', city: 'moscow' };
  // Товар уже видели поиском, поэтому автораскладка положила его на полки сама —
  // это и есть состояние «пока пользователь не выбирал руками».
  const auto = await core.getShelves(scope);
  assert.equal(auto.manual, false, 'до ручной правки раскладка автоматическая');
  assert.ok(auto.categoryIds.includes('dairy-milk'), 'автораскладка положила товар на профильную полку');

  const saved = await core.setShelves({ ...scope, categoryIds: ['dairy-milk', 'dairy-cheese', 'dairy-milk'] });
  assert.deepEqual(saved.categoryIds.slice().sort(), ['dairy-cheese', 'dairy-milk'], 'дубли схлопнулись, обе полки на месте');
  assert.equal(saved.manual, true, 'ручная раскладка помечена');

  const readBack = await core.getShelves(scope);
  assert.deepEqual(readBack.categoryIds.slice().sort(), ['dairy-cheese', 'dairy-milk'], 'полки читаются обратно');

  await assert.rejects(
    () => core.setShelves({ ...scope, categoryIds: ['нет-такой'] }),
    /неизвестная полка/,
    'неизвестная полка отвергается ДО записи',
  );
  await assert.rejects(
    () => core.setShelves({ ...scope, categoryIds: [UNASSIGNED_ID] }),
    /не полка/,
    'виртуальную полку назначить товару нельзя',
  );
  await assert.rejects(
    () => core.setShelves({ ...scope, categoryIds: ['  '] }),
    /пустая полка/,
    'пустая полка отвергается',
  );
  assert.deepEqual(
    (await core.getShelves(scope)).categoryIds.slice().sort(),
    ['dairy-cheese', 'dairy-milk'],
    'неудачные правки не изменили сохранённые полки',
  );

  const released = await core.releaseShelves(scope);
  assert.deepEqual(released.categoryIds, [], 'возврат автораскладки снял полки');
  assert.equal(released.manual, false, 'и снял признак ручной раскладки');
}

// --- 6. История: точка привязана к тройке (товар, магазин, город).
{
  const item = product('m-butter', 'Масло сливочное 82,5%, 180г', 199);
  savePriceIfChanged(db, item);
  savePriceIfChanged(db, { ...item, price: 159 });
  savePriceIfChanged(db, { ...item, price: 159 });

  const history = await core.getHistory({ canonicalId: 'm-butter', storeId: 'magnit', city: 'moscow' });
  assert.equal(history.length, 2, 'цена изменилась один раз — значит две точки: до и после');
  assert.equal(history[history.length - 1]?.price, 159, 'последняя точка — актуальная цена');
  assert.ok(typeof history[0]?.collected_at === 'string', 'у точки есть дата замера');

  assert.deepEqual(
    await core.getHistory({ canonicalId: 'm-butter', storeId: 'lenta', city: 'moscow' }),
    [],
    'история другого магазина не подмешалась',
  );
  assert.deepEqual(
    await core.getHistory({ canonicalId: 'm-butter', storeId: 'magnit', city: 'ulyanovsk' }),
    [],
    'история другого города не подмешалась',
  );
}

// --- 7. Избранное и порог: уведомление один раз на снижение.
{
  const scope = { canonicalId: 'm-cheese', storeId: 'magnit', city: 'moscow' };
  savePriceIfChanged(db, { ...product('m-cheese', 'Сыр Hochland Сливочный 55% 200г', 229) });

  const added = await core.setFavorite({ ...scope, targetPrice: null });
  assert.equal(added.length, 1, 'отметка появилась и сразу вернулась списком');
  assert.equal(added[0]?.price, 229, 'в отметке видна текущая цена');

  await core.setFavorite({ ...scope, targetPrice: 200 });
  const list = await core.getFavorites({ city: 'moscow' });
  assert.equal(list.find((f) => f.canonicalId === 'm-cheese')?.targetPrice, 200, 'порог сохранён');
  assert.deepEqual(await core.getFavorites({ city: 'ulyanovsk' }), [], 'избранное другого города не показывается');
  assert.deepEqual((await core.checkTargets('moscow')), [], 'при цене выше порога уведомлять нечего');

  savePriceIfChanged(db, { ...product('m-cheese', 'Сыр Hochland Сливочный 55% 200г', 179) });
  const hits = await core.checkTargets('moscow');
  assert.equal(hits.length, 1, 'сеть ответила ниже порога — есть что сообщить');
  assert.equal(hits[0]?.price, 179, 'в уведомлении новая цена');
  assert.equal(hits[0]?.target, 200, 'и порог, ради которого отмечено');

  await core.markNotifiedForTest(hits);
  assert.deepEqual(await core.checkTargets('moscow'), [], 'одна и та же цена повторно не сообщается');

  savePriceIfChanged(db, { ...product('m-cheese', 'Сыр Hochland Сливочный 55% 200г', 159) });
  assert.equal((await core.checkTargets('moscow')).length, 1, 'новое снижение — снова уведомление');

  assert.deepEqual(await core.removeFavorite(scope), [], 'отметка снята');
  assert.deepEqual(await core.getFavorites({ city: 'moscow' }), [], 'и её больше нет в списке города');
}

// --- 8. Разрывы склейки: общие для всех городов, ключ нормализован, снимаются.
{
  const pair = { canonicalIdA: 'm-milk', canonicalIdB: 'l-milk' };
  await core.splitProducts(pair);
  const pairs = await core.getSplitPairs({ city: 'moscow' });
  assert.equal(pairs.length, 1, 'разрыв запомнен');
  // Ключ нормализован по алфавиту: пара (A,B) и (B,A) — один и тот же разрыв,
  // иначе один и тот же товар можно было бы склеить дважды.
  assert.equal(pairs[0], 'l-milk m-milk', 'ключ разрыва отсортирован, порядок id не значит');
  await core.splitProducts({ canonicalIdA: 'l-milk', canonicalIdB: 'm-milk' });
  assert.equal((await core.getSplitPairs({ city: 'moscow' })).length, 1, 'обратный порядок не создал второй разрыв');
  assert.deepEqual(await core.getSplitPairs({ city: 'ulyanovsk' }), pairs, 'разрыв живёт на уровне id товара, а не города: склейка одна и та же везде');
  await assert.rejects(
    () => core.splitProducts({ canonicalIdA: 'm-milk', canonicalIdB: 'm-milk' }),
    /самим собой/,
    'разрыв товара с самим собой отвергается',
  );

  await core.removeSplit(pair);
  assert.deepEqual(await core.getSplitPairs({ city: 'moscow' }), [], 'разрыв снят');
}

// --- 9. Опрос: успех, отказ сети виден в счётчиках, метка не даёт гонять зря.
{
  const status = core.schedulerStatus();
  assert.equal(status.running, false, 'планировщик свободен перед запуском');
  assert.equal(status.intervalHours, 6, 'интервал по умолчанию 6 часов');

  const before = magnit.productCalls;
  const ok = await core.runScheduler({ city: 'moscow' });
  assert.ok(magnit.productCalls > before, 'опрос дёрнул сеть по отслеживаемым товарам');
  assert.match(ok.summary, /Опрос завершён: проверено \d+, новых цен \d+, ошибок \d+/, 'сводка с числами');

  // Кнопка «Опросить сейчас» обязана опрашивать сразу, даже если автозапуск
  // был минуту назад: откладывать ручной запрос нельзя.
  const manual = await core.runScheduler({ city: 'moscow' });
  assert.match(manual.summary, /Опрос завершён/, 'ручной опрос по кнопке не откладывается');
  assert.equal(manual.status.lastRun !== null, true, 'метка последнего прогона обновилась');

  // Два клика по кнопке подряд: второй должен честно сказать «уже идёт»,
  // а не запустить второй опрос поверх первого (иначе удваивается нагрузка
  // на сеть и счётчики в сводке).
  const first = core.runScheduler({ city: 'moscow' });
  const doneBefore = events.filter((e) => e.channel === 'scheduler:done').length;
  const second = await core.runScheduler({ city: 'moscow' });
  assert.match(second.summary, /Опрос уже идёт/, 'второй клик не запускает второй опрос');
  assert.equal(
    events.filter((e) => e.channel === 'scheduler:done').length,
    doneBefore,
    'и не эмитит второе событие завершения — баннер был бы один',
  );
  await first;

  // А вот автозапуск повторяет недавний опрос — и молча, без баннера в renderer.
  core.startScheduler();
  assert.ok(scheduled.every, 'планировщик поставил ежечасный таймер');
  assert.ok(scheduled.after, 'и разовый отложенный запуск');
  const callsBeforeAuto = magnit.productCalls;
  scheduled.every?.();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(magnit.productCalls, callsBeforeAuto, 'автозапуск не повторяет недавний опрос');
  assert.match(pollSummaryFrom(events), /Опрос отложен/, 'и объясняет это в сводке, а не молчит');

  magnit.failProduct = true;
  const failed = await core.runScheduler({ city: 'moscow' });
  assert.ok(failed.status.counts.failed > 0, 'отказ сети попал в счётчик ошибок');
  assert.doesNotMatch(failed.summary, /ошибок 0/, 'сводка не может показывать «ошибок 0», когда сеть отказала');
  assert.equal(failed.status.running, false, 'после провала планировщик не остался занятым');
  magnit.failProduct = false;

  assert.ok(
    events.filter((e) => e.channel === 'scheduler:done').length >= 3,
    'на каждый запуск приходит своё событие завершения',
  );
}

core.saveAll();
assert.ok(fs.existsSync(path.join(tmpDir, 't.db')), 'saveAll действительно пишет базу на диск');
closeDb();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('core api: ALL GREEN — поиск, каталоги, витрина, полки, история, избранное, разрывы, опрос');