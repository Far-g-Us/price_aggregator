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
import { CITY_STORES, pointKey, storesForCity } from '../src/shared/catalog.js';

// Ядро пишет цену и раскладку по коду точки ИЗ СПРАВОЧНИКА, подменяя код
// из ответа адаптера, поэтому фикстуры читаются обратно по тому же коду.
const MAGNIT_CODE = storesForCity('moscow', 'magnit')[0]?.externalStoreId ?? '';
const LENTA_CODE = storesForCity('moscow', 'lenta')[0]?.externalStoreId ?? '';
import { UNKNOWN_STORE_CODE } from '../src/shared/types.js';
import { StaleStoreError } from '../src/core/adapter-errors.js';
import {
  closeDb,
  openDb,
  getPriceHistory,
  manualShelfIds,
  saveFavorite,
  savePriceIfChanged,
  saveProductCategory,
} from '../src/core/db/db.js';
import { fileStorageAt } from '../electron/node-files.js';
import { UNASSIGNED_ID } from '../src/core/services.js';
import type { ScrapedProduct, StoreAdapter, StoreCategory } from '../src/shared/types.js';
import type { CoreDeps } from '../src/core/platform.js';
// печатает ошибки — в тестах это шум, мешающий прочитать результат.

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
  storeCode: MAGNIT_CODE,
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
/** Отказ отдельной точки при живой сети — протухший прайс магазина. */
    staleStore = false;
    /** Задержать ответ товара: нужно, чтобы поймать прогон на середине. */
    hold = false;
  categories: StoreCategory[] = [];

  // Точка своей сети из справочника: адаптер-фейк отвечает ЗА точку, и товар
  // должен нести её код. Иначе подставляется чужой (раньше здесь был код
  // Магнита у адаптера Ленты — и цены Ленты молча отбрасывались проверкой
  // кода точки в storeItems, то есть фикстура врала о том, что сеть ответила).
  private readonly pointCode: string;

  constructor(
    readonly storeId: 'magnit' | 'lenta',
    private readonly items: ScrapedProduct[],
    private readonly host: string,
  ) {
    this.pointCode = storesForCity('moscow', storeId)[0]?.externalStoreId ?? '';
  }

  async search(query: string, ctx: SearchCtx): Promise<ScrapedProduct[]> {
    this.searchCalls += 1;
    if (this.failSearch) throw new Error(`${this.storeId}: сеть молчит`);
    return this.items
      .filter((i) => i.name.toLowerCase().includes(query.toLowerCase()))
      .map((i) => ({ ...i, city: ctx.city, storeId: this.storeId, storeCode: this.pointCode }));
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
    return this.items.map((i) => ({ ...i, city: ctx.city, storeId: this.storeId, storeCode: this.pointCode }));
  }

  async fetchProduct(canonicalId: string, ctx: ProductCtx): Promise<ScrapedProduct> {
    this.productCalls += 1;
    if (this.failProduct) throw new Error(`${this.storeId}: карточка не отвечает`);
    // Задержка ответа: нужна, чтобы поймать прогон «в середине» — снятие галочки
    // приходит, пока идёт очередной товар.
    if (this.hold) await new Promise((r) => setTimeout(r, 40));
    if (this.staleStore) {
      throw new StaleStoreError(`${this.storeId}: прайс магазина протух`, `${this.storeId}:1`);
    }
    const found = this.items.find((i) => i.canonicalId === canonicalId);
    if (!found) throw new Error(`${this.storeId}: товар не найден`);
    return { ...found, city: ctx.city, storeId: this.storeId, storeCode: this.pointCode };
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
// Сети с адаптером в этой сборке. Интерфейс считает по этому списку доступные
// точки: справочник городов знает все шесть сетей, а сборка — не обязана.
assert.deepStrictEqual(
  [...core.getSupportedNetworks()].sort(),
  ['lenta', 'magnit'],
  'ядро отдаёт ровно те сети, для которых есть адаптер',
);
// Выбор сетей ядра: снятие выбора (`null`) возвращает опрос по всем сетям города —
// это состояние «пользователь ещё не выбирал», а не «опрашивать нечего».
core.setCurrentStores([pointKey('magnit', MAGNIT_CODE)]);
core.setCurrentStores(null);
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

  const own = await core.getCategoryProducts({ city: 'moscow', url: 'https://magnit.ru/catalog/1-'  });
  const ownRow = own.find((s) => s.storeId === 'magnit');
  assert.equal(ownRow?.items.length, 2, 'своя витрина отдала товары');
  assert.ok(!own.some((s) => s.storeId === 'lenta'), 'чужая сеть в этот запрос не попала');

const foreign = await core.getCategoryProducts({ city: 'moscow', url: 'https://example.com/catalog/zzz'  });
  assert.equal(foreign.length, 1, 'на чужую ссылку отвечает одна строка-объяснение');
  assert.match(foreign[0]?.error ?? '', /не принадлежит ни одной сети/, 'и она говорит, что не так');
}

// Витрина: две точки одной сети в городе — это два запроса в один домен, и
// между ними обязана стоять пауза. Без неё клик по плитке бьёт по сети дважды
// через миллисекунды.
{
  const moscow = CITY_STORES['moscow'];
  const extra = { storeId: 'magnit' as const, name: 'Магнит, витрина', externalStoreId: '999003', ready: true };
  moscow?.push(extra);
  try {
    const stamps: string[] = [];
    const spy: StoreAdapter = {
      storeId: 'magnit',
      async search() {
        return [];
      },
      async fetchProduct(id: string, _ctx: ProductCtx) {
        return product(id, 'Молоко', 100);
      },
      canHandleCategoryUrl: (url: string) => url.includes('magnit.ru'),
      async fetchCategoryProducts(_url: string, ctx: SearchCtx) {
        stamps.push(`${ctx.externalStoreId}@${Date.now()}`);
        return [product('m-vitrina', 'Молоко с витрины', 100, { storeCode: ctx.externalStoreId })];
      },
    };
    const shelfCore = createCore({
      ...deps,
      adapters: new Map<string, StoreAdapter>([['magnit', spy]]),
      closeBrowsers: async () => {},
    });
    await shelfCore.getCategoryProducts({ city: 'moscow', url: 'https://magnit.ru/catalog/1-' });
    assert.equal(stamps.length, 2, 'обе точки сети спросили витрину');
    const times = stamps.map((s) => Number(s.split('@')[1] ?? 0)).sort((a, b) => a - b);
    const gap = (times[1] ?? 0) - (times[0] ?? 0);
    assert.ok(gap >= 1000, `между точками одной сети на витрине стоит пауза (разрыв ${gap} мс)`);
  } finally {
    const at = moscow?.findIndex((s) => s.externalStoreId === extra.externalStoreId) ?? -1;
    if (moscow && at >= 0) moscow.splice(at, 1);
  }
}

  // --- 4. Наши полки: иерархия, виртуальная полка, кэш открытия.
  {
    const list = core.getOurCategories({ city: 'moscow' });
    assert.equal(list.length, 17, '16 полок плюс виртуальная «Не разложено»');
    // Узкие полки («Молоко» внутри «Молочного и яиц») — теперь уточнения своих
    // широких полок, а не равные им. Раньше все были корневыми, и в интерфейсе
    // это читалось как две одинаковые плитки рядом.
    const subs = list.filter((c) => c.parentId !== null);
    assert.ok(subs.length > 0, 'уточнения полок пришли с родителем');
    for (const sub of subs) {
      assert.ok(
        list.some((p) => p.id === sub.parentId),
        `родитель уточнения есть в списке: ${sub.id} → ${sub.parentId}`,
      );
    }
    assert.equal(
      list.filter((c) => c.parentId === null && c.virtual !== true).length + subs.length,
      16,
      'каждая настоящая полка — либо корень, либо уточнение своего корня',
    );
  const unassigned = list.find((c) => c.id === UNASSIGNED_ID);
  assert.equal(unassigned?.virtual, true, 'виртуальная полка помечена, чтобы её не спутать с настоящей');
  assert.equal(unassigned?.queryCount, 0, 'у виртуальной полки нет запросов');

  // «Не разложено» читается из базы по сети и городу, без кода точки: строки
  // там смешаны по всем точкам. Поэтому у них честный sentinel, а не код из
  // справочника — иначе вторая точка в городе получила бы чужой товар с чужим
  // кодом, и это уехало бы в ключ цены.
  const unassignedShelf = await core.getOurCategory({ city: 'moscow', id: UNASSIGNED_ID });
  assert.ok(
    unassignedShelf.every((s) => s.items.every((i) => i.storeCode === UNKNOWN_STORE_CODE)),
    'товар из базы несёт «точку неизвестна», а не код первой попавшейся точки',
  );

  const shelf = await core.getOurCategory({ city: 'moscow', id: 'dairy-milk' });
  assert.ok(shelf.some((s) => s.items.length > 0), 'полка «Молоко» собрала товары');

  const calls = magnit.searchCalls;
  const cachedShelf = await core.getOurCategory({ city: 'moscow', id: 'dairy-milk' });
  assert.equal(magnit.searchCalls, calls, 'повторное открытие полки взято из кэша');
  assert.ok(
    cachedShelf.some((s) => s.items.length > 0),
    'кэш вернул товары',
  );

  await assert.rejects(
    () => core.getOurCategory({ city: 'moscow', id: 'нет-такой-полки' }),
    /неизвестная категория/,
    'неизвестная полка отвергается, а не возвращает молчаливую пустоту',
  );
}

// --- 5. Полки товара: чтение, запись, отказ на плохих данных, возврат автораскладке.
{
  const scope = { canonicalId: 'm-milk', storeId: 'magnit', city: 'moscow', storeCode: MAGNIT_CODE };
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

  // Код точки из чужого города: раньше ядро подставляло «первую готовую точку
  // сети» и потому искало полку в другом городе. Теперь код приходит от
  // вызывающего, и чужой город читается как пустая раскладка — без подмены.
  const unknown = await core.getShelves({
    canonicalId: 'm-milk',
    storeId: 'magnit',
    city: 'нет-такого-города',
    storeCode: 'чужой-код',
  });
  assert.deepEqual(unknown.categoryIds, [], 'неизвестный город читается как пустая раскладка');
  assert.equal(unknown.manual, false, 'и без ручного управления, а не с ошибкой');
}

// --- 5b. Ручная раскладка поточечная: маркер точки A не выключает автораскладку
// точки B той же сети. Фильтр «по сети» был реальной ошибкой — он молча убирал
// автораскладку у всех точек города, где тот же товар разложили руками.
{
  const OTHER = '999004';
  const a = { canonicalId: 'm-milk', storeId: 'magnit', city: 'moscow', storeCode: MAGNIT_CODE };
  await core.setShelves({ ...a, categoryIds: ['dairy-milk'] });
  assert.ok(
    manualShelfIds(db, 'magnit', 'moscow', MAGNIT_CODE).has('m-milk'),
    'своя точка видит свой маркер ручной раскладки',
  );
  assert.equal(
    manualShelfIds(db, 'magnit', 'moscow', OTHER).has('m-milk'),
    false,
    'соседняя точка той же сети маркер не наследует',
  );
  assert.ok(
    manualShelfIds(db, 'magnit', 'moscow').has('m-milk'),
    'без кода точки спрашивается сеть целиком (раскладка до появления точек)',
  );
  await core.releaseShelves(a);
}

// --- 6. История: точка привязана к тройке (товар, магазин, город).
{
  const item = product('m-butter', 'Масло сливочное 82,5%, 180г', 199);
  savePriceIfChanged(db, item);
  savePriceIfChanged(db, { ...item, price: 159 });
  savePriceIfChanged(db, { ...item, price: 159 });

  const history = await core.getHistory({
    canonicalId: 'm-butter',
    storeId: 'magnit',
    city: 'moscow',
    storeCode: MAGNIT_CODE,
  });
  assert.equal(history.length, 2, 'цена изменилась один раз — значит две точки: до и после');
  assert.equal(history[history.length - 1]?.price, 159, 'последняя точка — актуальная цена');
  assert.ok(typeof history[0]?.collected_at === 'string', 'у точки есть дата замера');

  assert.deepEqual(
    await core.getHistory({
      canonicalId: 'm-butter',
      storeId: 'lenta',
      city: 'moscow',
      storeCode: MAGNIT_CODE,
    }),
    [],
    'история другого магазина не подмешалась',
  );
  assert.deepEqual(
    await core.getHistory({
      canonicalId: 'm-butter',
      storeId: 'magnit',
      city: 'ulyanovsk',
      storeCode: MAGNIT_CODE,
    }),
    [],
    'история другого города не подмешалась',
  );
  // Код точки в проверках выше обязателен: без него ответ пуст по ЛЮБОЙ причине,
  // и проверка проходила бы, ничего не проверяя.
  assert.deepEqual(
    await core.getHistory({
      canonicalId: 'm-butter',
      storeId: 'magnit',
      city: 'moscow',
      storeCode: 'чужой-код-точки',
    }),
    [],
    'и история другой точки той же сети — тоже своя кривая',
  );
}

// --- 7. Избранное и порог: уведомление один раз на снижение.
{
  const scope = { canonicalId: 'm-cheese', storeId: 'magnit', city: 'moscow', storeCode: MAGNIT_CODE };
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

  await core.markNotifiedForTest(hits.map((h) => ({ canonicalId: h.canonicalId, storeId: h.storeId, city: h.city, storeCode: MAGNIT_CODE, price: h.price })));
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

  // Протухшая точка обязана быть видна в сводке: сеть жива, но цены её магазина
  // заморожены, и молчаливый «успешный» опрос вводил бы в заблуждение.
  magnit.staleStore = true;
  const staleRun = await core.runScheduler({ city: 'moscow' });
  assert.match(staleRun.summary, /Сеть не обновляет: magnit:1/, 'сводка называет протухшую точку');
  assert.match(staleRun.summary, /цены этих магазинов заморожены/, 'сводка объясняет, что это значит');
  magnit.staleStore = false;

  // Кнопка «Опросить сейчас» обязана опрашивать сразу, даже если автозапуск
  // был минуту назад: откладывать ручной запрос нельзя.
  const manual = await core.runScheduler({ city: 'moscow' });
  assert.match(manual.summary, /Опрос завершён/, 'ручной опрос по кнопке не откладывается');
  assert.equal(manual.status.lastRun !== null, true, 'метка последнего прогона обновилась');

// Выбор магазинов в шапке ограничивает опрос: с выбранной сетью идёт только она.
  const lentaBefore = lenta.productCalls;
  const magnitBefore = magnit.productCalls;
  const onlyMagnit = await core.runScheduler({ city: 'moscow', pointKeys: [pointKey('magnit', MAGNIT_CODE)] });
  assert.ok(onlyMagnit.summary.includes('Опрос завершён') || onlyMagnit.summary.includes('нет отслеживаемых'), 'опрос по одной сети завершился');
  assert.equal(lenta.productCalls, lentaBefore, 'выключенная сеть не дёргалась');
  assert.ok(magnit.productCalls >= magnitBefore, 'выбранная сеть опрошена');
  // Тот же выбор, но поднятый в состояние ядра (как это делает renderer при
  // смене галочки), ограничивает и автозапуск: вызов БЕЗ pointKeys берёт выбор
  // из состояния.
  core.setCurrentStores([pointKey('lenta', LENTA_CODE)]);
  const lentaAfter = lenta.productCalls;
  const magnitAfter = magnit.productCalls;
  await core.runScheduler({ city: 'moscow' });
  assert.equal(magnit.productCalls, magnitAfter, 'без явного pointKeys действует выбор из состояния');
  assert.ok(lenta.productCalls > lentaAfter, 'выбранная сеть из состояния опрошена');
  core.setCurrentStores(null);

  // Ни одной сети не выбрано: это НЕ «нет отслеживаемых товаров». Молчаливый
  // баннер про товары увёл бы пользователя искать товары, хотя он просто снял
  // все галочки магазинов.
  const magnitBeforeEmpty = magnit.productCalls;
  const emptyPick = await core.runScheduler({ city: 'moscow', pointKeys: [] });
  assert.match(emptyPick.summary, /не выбрано ни одного магазина/, 'пустой выбор объяснён по-человечески');
  assert.equal(magnit.productCalls, magnitBeforeEmpty, 'ни одна сеть не дёргалась');

  // Выбрана сеть БЕЗ отслеживаемых товаров, хотя товары в городе есть (в
  // других сетях). Старый текст звал «найди что-нибудь поиском», хотя искать
  // уже было найдено — реальный случай телефона: в выборе остался один
  // Перекрёсток без истории, и сводка вводила в заблуждение.
  const beforeForeign = magnit.productCalls;
  const foreignPick = await core.runScheduler({
    city: 'moscow',
    pointKeys: [pointKey('chizhik', 'HD87')],
  });
  assert.match(
    foreignPick.summary,
    /в выбранных магазинах отслеживаемых товаров нет/,
    'ноль целей из-за выбора магазинов назван честно',
  );
  assert.equal(magnit.productCalls, beforeForeign, 'сеть мимо выбора не дёргалась');

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

  // Смена галочек магазина на ходу прерывает опрос. Пользователь снял сеть —
  // значит он больше не хочет в неё ходить, и ждать конца обхода нельзя.
  // Проверяем на живом прогоне: адаптер висит на первом товаре, галочка снимается.
  magnit.hold = true;
  const runningPoll = core.runScheduler({ city: 'moscow', pointKeys: [pointKey('magnit', MAGNIT_CODE)] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(core.schedulerStatus().running, true, 'опрос действительно идёт');
  core.setCurrentStores([pointKey('lenta', LENTA_CODE)]);
  magnit.hold = false;
  const byToggle = await runningPoll;
  assert.match(byToggle.summary, /Опрос прерван/, 'сводка называет прогон прерванным');
  assert.ok(byToggle.status.counts.remaining > 0, `остаток виден в статусе (${byToggle.status.counts.remaining})`);
  assert.doesNotMatch(byToggle.summary, /Опрос завершён/, 'прерванный прогон не называется завершённым');
  // Тот же выбор повторно галочки НЕ прерывает: `stores:set` прилетает на
  // каждое изменение состояния, включая монтирование, и безусловная отмена
  // сорвала бы автоопрос на старте.
  core.setCurrentStores([pointKey('lenta', LENTA_CODE)]);
  const notStopped = await core.runScheduler({ city: 'moscow' });
  assert.doesNotMatch(notStopped.summary, /Опрос прерван/, 'тот же выбор галочек прогон не прерывает');
  // Перестановка того же выбора — тоже не изменение.
  core.setCurrentStores([pointKey('lenta', LENTA_CODE), pointKey('magnit', MAGNIT_CODE)]);
  core.setCurrentStores([pointKey('magnit', MAGNIT_CODE), pointKey('lenta', LENTA_CODE)]);
  const reordered = await core.runScheduler({ city: 'moscow' });
  assert.doesNotMatch(reordered.summary, /Опрос прерван/, 'порядок галочек не считается изменением выбора');
  // Смена города прерывает: прогон старого города пользователь отменил фактом
  // перехода.
  magnit.hold = true;
  const cityPoll = core.runScheduler({ city: 'moscow' });
  await new Promise((r) => setTimeout(r, 20));
  core.setCurrentCity('ulyanovsk');
  magnit.hold = false;
  const cityStopped = await cityPoll;
  assert.match(cityStopped.summary, /Опрос прерван/, 'смена города прерывает идущий опрос');
  core.setCurrentCity('moscow');

  // Кнопка «Прервать»: тот же вызов из интерфейса.
  magnit.hold = true;
  const stopped = core.runScheduler({ city: 'moscow' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(core.schedulerStatus().running, true, 'прогон идёт — кнопка видна');
  assert.equal(core.cancelScheduler(), true, 'ядро подтвердило отмену');
  magnit.hold = false;
  const stoppedSummary = await stopped;
  assert.match(stoppedSummary.summary, /Опрос прерван/, 'прогон остановлен по кнопке');
  // Повторный клик по кнопке после завершения — враньё: идти уже нечего.
  assert.equal(core.cancelScheduler(), false, 'прервать нечего — честный false');

  assert.ok(
    events.filter((e) => e.channel === 'scheduler:done').length >= 3,
    'на каждый запуск приходит своё событие завершения',
  );
}

core.saveAll();
assert.ok(fs.existsSync(path.join(tmpDir, 't.db')), 'saveAll действительно пишет базу на диск');
// Браузеры сетей закрываются после прогона: каждый открытый браузер — отдельный
// процесс Firefox с сотнями мегабайт памяти, и до выхода из приложения они
// висели зря (проверено на живой сборке: после прогона по Москве оставалось 8
// таких процессов).
{
  let closed = 0;
  const closeErrors: string[] = [];
  const withBrowsers = createCore({
    ...deps,
    log: { ...deps.log, error: (m: string) => void closeErrors.push(m) },
    closeBrowsers: async () => {
      closed += 1;
      if (closed === 1) throw new Error('браузер завис');
    },
  });
  const first = await withBrowsers.runScheduler({ city: 'moscow', pointKeys: [] });
  assert.equal(closed, 1, 'браузеры закрыты даже на прогоне, который ничего не делал');
  assert.ok(first.summary.length > 0, 'падение закрытия не убивает прогон');
  assert.ok(
    closeErrors.some((e) => e.includes('закрыть браузеры')),
    'но ошибка закрытия громкая',
  );
  const second = await withBrowsers.runScheduler({ city: 'moscow', pointKeys: [] });
  assert.equal(closed, 2, 'закрытие повторяется на каждом прогоне');
  assert.doesNotMatch(second.summary, /Опрос уже идёт/, 'падение закрытия не оставило прогон занятым');
}

// Порядок на ЖИВОМ прогоне: закрытие обязано идти после запроса и после записи
// цены. Тест выше гонял пустой прогон и потому не ловил мутацию «звать close в
// начале try» — цены были бы записаны после закрытия, а товар недособран.
// Хендлер fake-адаптера дописывает 'fetch:<id>' в общий журнал, close — 'close',
// а проверка внутри close читает базу: значит к моменту teardown цена уже в БД.
{
  const order: string[] = [];
  let priceAtClose = -1;
  let runningDuringClose: boolean | null = null;
  // Ядро объявлено до замыкания: closeBrowsers читает его флаг во время прогона.
  let orderedCore: ReturnType<typeof createCore>;
  const spy: StoreAdapter = {
    storeId: 'magnit',
    search: (q, ctx) => magnit.search(q, ctx),
    fetchCategories: () => magnit.fetchCategories(),
    fetchProduct: async (id, ctx) => {
      order.push(`fetch:${id}`);
      return magnit.fetchProduct(id, ctx);
    },
  };
  orderedCore = createCore({
    ...deps,
    adapters: new Map([['magnit', spy], ['lenta', lenta]]),
    closeBrowsers: async () => {
      order.push('close');
      // Флаг прогона ещё поднят: если state.running сбросился ДО закрытия, за
      // это окно успел бы стартовать новый опрос и убить свежий браузер.
      runningDuringClose = orderedCore.schedulerStatus().running;
      // Цена читается прямо из БД в момент ПЕРВОГО закрытия: если close уедет в
      // начало прогона (мутация «звать close до pollOnce»), здесь будет пусто,
      // хотя второе, финальное закрытие уже увидит записанную цену.
      if (priceAtClose === -1) {
        priceAtClose = getPriceHistory(db, {
          canonicalId: 'm-milk',
          storeId: 'magnit',
          city: 'moscow',
          storeCode: MAGNIT_CODE,
        }).length;
      }
    },
  });
  orderedCore.startScheduler();
  await scheduled.after?.();
  assert.ok(!order.includes('close'), 'стартовый прогон-разведка (dryRun) браузеры не трогает');
  const live = await orderedCore.runScheduler({ city: 'moscow' });
  assert.equal(order[order.length - 1], 'close', `закрытие идёт последним: ${order.join(' ')}`);
  assert.ok(order.some((o) => o.startsWith('fetch:')), 'прогон реально что-то опросил');
  assert.ok(priceAtClose > 0, 'к моменту первого закрытия цены уже записаны в базу');
  assert.equal(order.filter((o) => o === 'close').length, 1, 'закрытие ровно одно за прогон');
  assert.match(live.summary, /проверено [1-9]/, 'сводка отчиталась о проверенных товарах');
  // Флаг прогона живёт ДО teardown: если бы `state.running = false` встал перед
  // закрытием, за это окно успел бы стартовать новый опрос и убить свежий браузер.
  assert.equal(runningDuringClose, true, 'во время закрытия прогон ещё считается идущим');
}

// Зависший close не должен держать прогон вечно: интерфейс ждёт ответа
// runScheduler и снимет флаг по нему. Потолок — 5 с, поэтому проверяем сам факт
// («ответ пришёл и флаг снят»), а не ровно время.
{
  const stuckCore = createCore({
    ...deps,
    closeBrowsers: () => new Promise<void>(() => {}),
  });
  const startedAt = Date.now();
  const out = await stuckCore.runScheduler({ city: 'moscow' });
  assert.ok(Date.now() - startedAt < 20_000, `зависшее закрытие не держит прогон (${Date.now() - startedAt} мс)`);
  assert.equal(stuckCore.schedulerStatus().running, false, 'флаг прогона снят по таймауту');
  assert.match(out.summary, /проверено [1-9]|пропущен/, 'сводка всё равно пришла');
}

// --- Две точки одной сети: раздельные блоки и пауза между ними. ----------
// Сценарий, ради которого существует вся фаза. Вторая точка добавляется прямо
// в справочник и убирается после: в настоящем каталоге её пока нет, а ждать
// её появления ради проверки нельзя.
{
  const moscow = CITY_STORES['moscow'];
  const extra = { storeId: 'magnit' as const, name: 'Магнит, Пушкинская', externalStoreId: '999001', ready: true };
  moscow?.push(extra);
  const stamps: string[] = [];
  const spyTwoPoints: StoreAdapter = {
    storeId: 'magnit',
    async search(_q: string, ctx: SearchCtx) {
      stamps.push(`${ctx.externalStoreId}@${Date.now()}`);
      // Адаптер отвечает ЗА запрошенную точку и кладёт её код в товар —
      // именно так поступает настоящий (после сверки ответа).
      return [product('m-two', 'Молоко второй точки', 100, { storeCode: ctx.externalStoreId })];
    },
    async fetchProduct(id: string, _ctx: ProductCtx) {
      return product(id, 'Молоко второй точки', 100);
    },
  };
  const twoPointCore = createCore({
    ...deps,
    adapters: new Map<string, StoreAdapter>([
      ['magnit', spyTwoPoints],
      ['lenta', lenta],
    ]),
    closeBrowsers: async () => {},
  });
  const startedAt = Date.now();
  const two = await twoPointCore.searchPrices({ city: 'moscow', query: 'молоко' });
  const magnitBlocks = two.filter((b) => b.storeId === 'magnit');
  assert.equal(magnitBlocks.length, 2, 'две точки сети дают два блока цен, а не один');
  assert.deepEqual(
    magnitBlocks.map((b) => b.storeCode).sort(),
    [MAGNIT_CODE, extra.externalStoreId].sort(),
    'и каждый блок несёт код своей точки',
  );
  assert.equal(stamps.length, 2, 'адаптер опрошен по обеим точкам');
  const gap = Number(stamps[1]?.split('@')[1] ?? 0) - Number(stamps[0]?.split('@')[1] ?? 0);
  assert.ok(
    gap >= 1000 && Date.now() - startedAt >= 1000,
    `между точками одной сети стоит пауза (разрыв ${gap} мс)`,
  );
  // Товар точки записан под её кодом, а не под кодом соседней точки.
  const hist = getPriceHistory(db, {
    canonicalId: 'm-two',
    storeId: 'magnit',
    city: 'moscow',
    storeCode: extra.externalStoreId,
  });
  assert.equal(hist.length, 1, 'цена второй точки записана по её коду');
  const idx = moscow?.findIndex((s) => s.externalStoreId === extra.externalStoreId) ?? -1;
  if (moscow && idx >= 0) moscow.splice(idx, 1);
}

// --- Полочная пауза между точками одной сети -------------------------------
// Полка ходит в сеть по ПАРАЛЛЕЛЬным цепочкам (разные сети — разные домены),
// и две точки одной сети в параллель означали бы два запроса в один домен через
// миллисекунды — ровно то, за что банят.
//
// Проверяем ВСЕ соседние запросы сети, а не первые два: полка на несколько
// запросов («Молочное и яйца» — восемь), и когда пауза резервировалась один раз
// на цепочку точки, второй запрос точки А приходился на первый запрос точки Б
// (разрыв 0 мс) при вроде бы правильных первых двух стартах.
{
  const moscow = CITY_STORES['moscow'];
  const extra = {
    storeId: 'magnit' as const,
    name: 'Магнит, пауза',
    externalStoreId: '999002',
    ready: true,
  };
  moscow?.push(extra);
  try {
    const stamps: number[] = [];
    const spy: StoreAdapter = {
      storeId: 'magnit',
      async search(_q: string, ctx: SearchCtx) {
        stamps.push(Date.now());
        return [product('m-shelf-pause', 'Молоко для полки', 100, { storeCode: ctx.externalStoreId })];
      },
      async fetchProduct(id: string, _ctx: ProductCtx) {
        return product(id, 'Молоко для полки', 100);
      },
    };
    const shelfCore = createCore({
      ...deps,
      adapters: new Map<string, StoreAdapter>([['magnit', spy]]),
      closeBrowsers: async () => {},
    });
    // Кефир и йогурты — три запроса на полку: два на точку достаточно, чтобы
    // поймать «бронь один раз на цепочку» (второй запрос точки А приходился на
    // первый запрос точки Б, разрыв 0), а полка на восемь запросов растянула бы
    // тест на двадцать секунд чистого сна.
    await shelfCore.getOurCategory({ city: 'moscow', id: 'dairy-fermented' });
    const times = stamps.slice().sort((a, b) => a - b);
    assert.equal(times.length, 6, 'обе точки спросили сеть по три раза');
    const gaps = times.slice(1).map((t, i) => t - (times[i] ?? t));
    // Границы узкие намеренно: контракт — ≥1200 мс между стартами, и 2400 мс
    // (сложение двух пауз) прошли бы «широким» порогом, не поймав регресс.
    assert.ok(
      gaps.every((g) => g >= 1150 && g < 2000),
      `между ЛЮБЫМИ двумя запросами одной сети ровно пауза сети (разрывы ${gaps.join(', ')})`,
    );
  } finally {
    const at = moscow?.findIndex((s) => s.externalStoreId === extra.externalStoreId) ?? -1;
    if (moscow && at >= 0) moscow.splice(at, 1);
  }
}

// --- Пауза между точками одной сети в списке разделов ----------------------
// Каталог сетей тоже ходит в сеть, и две точки одной сети дают два
// fetchCategories подряд в один домен — ровно то, за что банят.
{
  const moscow = CITY_STORES['moscow'];
  const extra = {
    storeId: 'magnit' as const,
    name: 'Магнит, каталог',
    externalStoreId: '999006',
    ready: true,
  };
  moscow?.push(extra);
  try {
    const stamps: number[] = [];
    const spy: StoreAdapter = {
      storeId: 'magnit',
      async search() {
        return [];
      },
      async fetchProduct(id: string, _ctx: ProductCtx) {
        return product(id, 'Молоко', 100);
      },
      async fetchCategories() {
        stamps.push(Date.now());
        return [{ id: 'c1', name: 'Молоко', url: 'https://magnit.ru/catalog/1-' }];
      },
    };
    const catalogCore = createCore({
      ...deps,
      adapters: new Map<string, StoreAdapter>([['magnit', spy]]),
      closeBrowsers: async () => {},
    });
    await catalogCore.getCatalogs({ city: 'moscow' });
    assert.equal(stamps.length, 2, 'обе точки сети спросили каталог');
    const gap = (stamps[1] ?? 0) - (stamps[0] ?? 0);
    assert.ok(gap >= 1150 && gap < 2000, `между точками одной сети пауза и в каталоге (разрыв ${gap} мс)`);
  } finally {
    const at = moscow?.findIndex((s) => s.externalStoreId === extra.externalStoreId) ?? -1;
    if (moscow && at >= 0) moscow.splice(at, 1);
  }
}

// --- Перенесённая отметка: цена живая, подпись внятная. -------------------
// Отметка, доставшаяся из базы 1.3.x, помечена '?' — точки не знает. Код
// точки в ней нет, поэтому уведомление обязано назвать сеть (или товар), но не
// молчать: молчание читается как «уведомлений больше не будет».
{
  const notif: string[] = [];
  const twoPointAdapter: StoreAdapter = {
    storeId: 'magnit',
    async search(_q: string, _ctx: SearchCtx) {
      return [product('m-gone', 'Масло перенесённой отметки', 150)];
    },
    async fetchProduct(id: string, _ctx: ProductCtx) {
      return product(id, 'Масло перенесённой отметки', 150);
    },
  };
  const goneCore = createCore({
    ...deps,
    shell: { ...deps.shell, notify: (t: string) => void notif.push(t) },
    adapters: new Map([['magnit', twoPointAdapter], ['lenta', lenta]]),
    closeBrowsers: async () => {},
  });
  goneCore.setCurrentCity('moscow');
  // Отметка перенесена: код точки неизвестен.
  saveFavorite(
    db,
    { canonicalId: 'm-gone', storeId: 'magnit', city: 'moscow', storeCode: UNKNOWN_STORE_CODE },
    200,
  );
  // Цена приходит уже по настоящему коду точки (её записал опрос после
  // переноса) — и перенесённая отметка должна увидеть именно её.
  savePriceIfChanged(db, product('m-gone', 'Масло перенесённой отметки', 150));
  const hits = await goneCore.checkTargets('moscow');
  assert.equal(hits.length, 1, 'перенесённая отметка сработала по свежей цене точки');
  assert.equal(hits[0]?.storeCode, UNKNOWN_STORE_CODE, 'и сработала как отметка без точки');
  notif.length = 0;
  await goneCore.runScheduler({ city: 'moscow' });
  assert.ok(
    notif.length > 0,
    'опрос при отметке без точки всё равно что-то сообщил, а не промолчал',
  );
  // Подпись места обязана говорить, что точка не указана: цена пришла по
  // настоящему коду точки, и «в Магнит, Пушкинская» вводила бы в заблуждение.
  assert.ok(
    notif.some((t) => /точка не указана/.test(t)),
    `уведомление о перенесённой отметке не выдаёт цену за цену названной точки: ${notif.join(' | ')}`,
  );
}

// --- Сеть не подтвердила код точки: товар получает код запрошенной. -------
// Sentinel «?» в товаре означает «сеть не смогла подтвердить, что это за
// магазин». Ядро тогда доверяет запрошенной точке: иначе две точки одной сети
// дали бы товары с одинаковым ключом «сеть + canonicalId», и склейка (шаг 6)
// проглотила бы вторую точку как дубль.
{
  const noCodeCore = createCore({
    ...deps,
    adapters: new Map<string, StoreAdapter>([
      [
        'magnit',
        {
          storeId: 'magnit',
          // Сеть ответила, но код магазина не подтвердила: в товаре sentinel.
          async search(_q: string, ctx: SearchCtx): Promise<ScrapedProduct[]> {
            return [product('m-nocode', 'Молоко без кода', 80, { storeCode: UNKNOWN_STORE_CODE, city: ctx.city })];
          },
          async fetchProduct(): Promise<ScrapedProduct> {
            throw new Error('не используется');
          },
        },
      ],
    ]),
  });
  const res = await noCodeCore.searchPrices({ city: 'moscow', query: 'без кода' });
  const entry = res.find((r) => r.storeId === 'magnit');
  assert.equal(entry?.storeCode, MAGNIT_CODE, 'точка в ответе — та, которую просили');
  assert.equal(
    entry?.items[0]?.storeCode,
    MAGNIT_CODE,
    'товар без подтверждённого кода несёт код запрошенной точки',
  );
}
// --- Сеть ответила за чужую точку: цена не пишется. ----------------------
// Инвариант домена на коде точки: сеть подтверждает, ЧТО это за магазин, и
// если подтверждение не совпало с запрошенной точкой, запись запрещена. Раньше
// код просто перебивался на запрошенный, и цены чужой точки тихо уезжали бы в
// нашу историю — то есть в график точки А попала бы точка Б.
{
  const errs: string[] = [];
  const lyingCore = createCore({
    ...deps,
    log: { error: (m: string, ...rest: unknown[]) => void errs.push(`${m} ${rest.join(' ')}`), warn: () => {}, info: () => {} },
    adapters: new Map<string, StoreAdapter>([
      [
        'magnit',
        {
          storeId: 'magnit',
          // Отвечает за точку 777777, хотя просили нашу.
          async search() {
            return [product('m-chuzhaya', 'Молоко чужой точки', 100, { storeCode: '777777' })];
          },
          async fetchProduct(id: string) {
            return product(id, 'Молоко чужой точки', 100, { storeCode: '777777' });
          },
          async fetchCategoryProducts() {
            return [product('m-chuzhaya-vitrina', 'Молоко чужой точки на витрине', 100, { storeCode: '777777' })];
          },
        },
      ],
      ['lenta', lenta],
    ]),
    closeBrowsers: async () => {},
  });
  const res = await lyingCore.searchPrices({ city: 'moscow', query: 'молоко' });
  assert.equal(res.find((b) => b.storeId === 'magnit')?.items.length, 1, 'интерфейс видит ответ сети как есть');
  assert.match(
    res.find((b) => b.storeId === 'magnit')?.error ?? '',
    /другую точку/,
    'и интерфейс говорит, что это не наш магазин, а не молча показывает цену',
  );
  assert.ok(
    errs.some((e) => e.includes('777777')),
    `ядро отказалось писать цену чужой точки и объяснило почему: ${errs.join(' | ').slice(0, 160)}`,
  );
  assert.deepEqual(
    getPriceHistory(db, {
      canonicalId: 'm-chuzhaya',
      storeId: 'magnit',
      city: 'moscow',
      storeCode: MAGNIT_CODE,
    }),
    [],
    'в истории нашей точки чужих цен нет',
  );

  // Тот же отказ на витрине и на полке: пользователь видит товар, значит
  // интерфейс обязан сказать, что это не наш магазин.
  const lyingShelf = await lyingCore.getCategoryProducts({
    city: 'moscow',
    url: 'https://magnit.ru/catalog/1-',
  });
  assert.match(
    lyingShelf.find((b) => b.storeId === 'magnit')?.error ?? '',
    /другую точку/,
    'витрина чужой точки помечена',
  );
  const lyingOur = await lyingCore.getOurCategory({ city: 'moscow', id: 'dairy-milk' });
  assert.match(
    lyingOur.find((b) => b.storeId === 'magnit')?.error ?? '',
    /другую точку/,
    'полка чужой точки помечена',
  );
}

// --- Регрессия P0: перенесённые цены видны и не теряются с полки. ---------
// Строки, перенесённые со старой версии базы, не знают точки ('?'). Раньше
// полка их отдавала одним блоком с кодом названной точки (цена чужой точки
// выдавалась за цену своей), а выбор магазинов в интерфейсе этот блок
// отбрасывал целиком — товары пропадали из выдачи без единой записи в лог.
{
  savePriceIfChanged(
    db,
    product('m-perenes', 'Гвозди оцинкованные', 250, { storeCode: UNKNOWN_STORE_CODE }),
  );
  savePriceIfChanged(
    db,
    product('m-svoy-nopolka', 'Гвозди медные', 300, { storeCode: MAGNIT_CODE }),
  );
  // Свежий инстанс ядра: полка кэшируется на TTL, и проверять надо именно то,
  // что читается из базы сейчас, а не то, что осталось в кэше полки.
  const freshCore = createCore({
    ...deps,
    adapters: new Map<string, StoreAdapter>([
      ['magnit', magnit],
      ['lenta', lenta],
    ]),
    closeBrowsers: async () => {},
  });
  const shelf = await freshCore.getOurCategory({ city: 'moscow', id: UNASSIGNED_ID });
  const unknownBlock = shelf.find((b) => b.storeCode === UNKNOWN_STORE_CODE);
  assert.ok(unknownBlock, 'перенесённые строки отдаются отдельным блоком с честным «точка неизвестна»');
  assert.ok(
    unknownBlock.items.some((i) => i.canonicalId === 'm-perenes'),
    'товар перенесённой строки на полке, а не потерян',
  );
  assert.ok(
    unknownBlock.items.every((i) => i.storeCode === UNKNOWN_STORE_CODE),
    'и весь блок честный: чужих кодов точки в нём нет',
  );
  const ownBlock = shelf.find((b) => b.storeCode === MAGNIT_CODE);
  assert.ok(
    ownBlock?.items.some((i) => i.canonicalId === 'm-svoy-nopolka'),
    'свои строки точки не теряются рядом с перенесёнными',
  );
  assert.equal(
    shelf.filter((b) => b.storeId === 'magnit').length,
    2,
    'у точки два блока: свой и перенесённый, а не один смешанный',
  );

  // Отказ сети на полке при кэше, который целиком перенесённый: блок остаётся с
  // кодом '?'. Прежний код отдавал эти цены в блоке НАЗВАННОЙ точки — то есть
  // приписывал их магазину, которому они не принадлежат.
  saveProductCategory(db, [
    {
      canonicalId: 'm-moloko-perenes',
      storeId: 'magnit',
      city: 'moscow',
      storeCode: UNKNOWN_STORE_CODE,
      categoryId: 'dairy-milk',
    },
  ]);
  savePriceIfChanged(
    db,
    product('m-moloko-perenes', 'Молоко ПРАВИЛЬНОЕ 3,2%, 930мл', 119, {
      storeCode: UNKNOWN_STORE_CODE,
    }),
  );
  const failing: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      throw new Error('сеть молчит');
    },
    async fetchProduct(id: string, _ctx: ProductCtx) {
      return product(id, 'Молоко', 119);
    },
  };
  const degradedCore = createCore({
    ...deps,
    adapters: new Map<string, StoreAdapter>([
      ['magnit', failing],
      ['lenta', lenta],
    ]),
    closeBrowsers: async () => {},
  });
  const degradedShelf = await degradedCore.getOurCategory({ city: 'moscow', id: 'dairy-milk' });
  const migrated = degradedShelf.find((b) => b.storeCode === UNKNOWN_STORE_CODE);
  assert.ok(
    migrated?.items.some((i) => i.canonicalId === 'm-moloko-perenes'),
    'перенесённый кэш показан, когда своя точка молчит',
  );
  assert.match(migrated?.error ?? '', /перенесённые цены/, 'и честно назван перенесённым');
  assert.equal(
    degradedShelf.some((b) => b.storeCode === MAGNIT_CODE && b.items.some((i) => i.storeCode !== MAGNIT_CODE)),
    false,
    'в блоке названной точки нет цен чужой точки',
  );

  // Точка, у которой нет НИ СВОИХ строк в кэше: перенесённые всё равно должны
  // до неё дойти — своим блоком с кодом '?', а не пустым.
  const QUIET = '999005';
  const moscowStores = CITY_STORES['moscow'];
  moscowStores?.push({
    storeId: 'magnit' as const,
    name: 'Магнит, молчащий',
    externalStoreId: QUIET,
    ready: true,
  });
  try {
    const quietCore = createCore({
      ...deps,
      adapters: new Map<string, StoreAdapter>([
        ['magnit', failing],
        ['lenta', lenta],
      ]),
      closeBrowsers: async () => {},
    });
    const quietShelf = await quietCore.getOurCategory({ city: 'moscow', id: 'dairy-milk' });
    const quiet = quietShelf.find((b) => b.storeCode === UNKNOWN_STORE_CODE);
    assert.ok(
      quiet?.items.some((i) => i.canonicalId === 'm-moloko-perenes'),
      'у молчащей точки перенесённый кэш не пропадает',
    );
    assert.equal(
      quietShelf.some((b) => b.storeCode === QUIET && b.items.length > 0),
      false,
      'и чужие цены не выдаются за цены этой точки',
    );
  } finally {
    const at = moscowStores?.findIndex((s) => s.externalStoreId === QUIET) ?? -1;
    if (moscowStores && at >= 0) moscowStores.splice(at, 1);
  }
}

// --- Отказ сети назван честно: запросы отработали, товары не подошли. -----
// Счётчик ошибок в двух случаях одинаков, а виноваты разные стороны: сеть
// молчала (не отвечала ни разу) или сеть ответила, но под полку ничего не
// подошло. Прежний текст звал второе «ни один запрос не сработал», то есть
// обвинял сеть в том, в чём виновата полка.
{
  let calls = 0;
  const halfBroken: StoreAdapter = {
    storeId: 'magnit',
    async search(_q: string, _ctx: SearchCtx) {
      calls += 1;
      // Первый запрос молчит, второй отвечает — но товар не про полку.
      if (calls === 1) throw new Error('сеть молчит');
      return [product('m-not-milk', 'Гвозди строительные', 40)];
    },
    async fetchProduct(id: string, _ctx: ProductCtx) {
      return product(id, 'Гвозди строительные', 40);
    },
  };
  const halfCore = createCore({
    ...deps,
    // Своя база: полка наполняется кэшем автораскладки, и на общей базе из
    // предыдущих тестов ветка «сеть ответила, но не подошло» была бы
    // недостижима — там показывался бы кэш.
    storage: fileStorageAt(path.join(tmpDir, 'half-empty.db')),
    adapters: new Map<string, StoreAdapter>([
      ['magnit', halfBroken],
      ['lenta', lenta],
    ]),
    closeBrowsers: async () => {},
  });
  // Полка с несколькими запросами: у «Молока» он один, и там «ни один запрос
  // не сработал» — правда (сеть молчала). Нужен случай, где запросы идут дальше
  // первого отказа.
  const shelf = await halfCore.getOurCategory({ city: 'moscow', id: 'dairy-fermented' });
  const row = shelf.find((b) => b.storeId === 'magnit');
  assert.equal(row?.items.length, 0, 'ни один товар не подошёл под полку');
  assert.match(
    row?.error ?? '',
    /ответила, но ни один товар не подошёл/,
    'и полка сказала правду: сеть ответила, виновата полка, а не сеть',
  );
  assert.doesNotMatch(row?.error ?? '', /ни один запрос не сработал/, 'а не обвинила сеть в молчании');
}

closeDb();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('core api: ALL GREEN — поиск, каталоги, витрина, полки, история, избранное, разрывы, опрос');
