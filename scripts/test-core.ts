// Доказательство, что ядро живёт без Electron и без диска: тот же createCore,
// что у оболочки, но с фейк-адаптером, хранилищем в памяти и без единого
// импорта electron/node:fs. Плюс статический guard: в src/core/** не должно
// появляться ни Electron, ни node:-API, иначе вторая оболочка (Android)
// развалится тихо.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScrapedProduct, StoreAdapter, StoreCategory } from '../src/shared/types.js';
import { progressEmitter, createCore, UNASSIGNED_ID } from '../src/core/services.js';
import { closeDb, getLastRun, openDb, saveFavorite, saveLastRun, saveNotifiedPrices, savePriceIfChanged, toPriceInput } from '../src/core/db/db.js';
import {
  consoleLogger,
  memoryJsonStore,
  memoryStorage,
  type BackgroundTasks,
  type CoreDeps,
} from '../src/core/platform.js';

// 1. Статический guard: ядро не знает про Electron и про Node-файлы.
const coreDir = fileURLToPath(new URL('../src/core', import.meta.url));
const sharedDir = fileURLToPath(new URL('../src/shared', import.meta.url));
const banned = [
  /from ['"]electron(-updater|-log)?['"]/,
  /import\(\s*['"]electron/,
  /from ['"]node:[a-z_]+['"]/,
  /import\(\s*['"]node:/,
  /require\(/,
];
// process читаем ровно в одном месте — platform.ts, как ОПЦИОНАЛЬНЫЙ глобал:
// в Android process не существует, и чтение не должно ронять ядро.
const envAllowed = new Set(['platform.ts']);
const files: string[] = [];
const walk = (dir: string): void => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
};
walk(coreDir);
walk(sharedDir);
assert.ok(files.length >= 6, `нашли файлы ядра: ${files.length}`);
for (const file of files) {
  const text = fs.readFileSync(file, 'utf-8');
  const rel = path.relative(coreDir, file);
  for (const re of banned) {
    assert.ok(!re.test(text), `ядро без Electron/Node-API: ${rel} не должен содержать ${re}`);
  }
  if (/\bprocess\s*\.\s*(env|versions|platform)\b/.test(text)) {
    assert.ok(envAllowed.has(path.basename(file)), `process читаем только в platform.ts, а не в ${rel}`);
  }
  // playwright-core замораживает реестр браузеров (PLAYWRIGHT_BROWSERS_PATH) на
  // первом импорте, а переменную ставит оболочка позже, в whenReady. Статический
  // импорт в ядре значит, что Firefox ищется не там. Поэтому в ядре только
  // динамический import('playwright') и type-only — они код не грузят.
  // Комментарии и type-only вырезаем: в этом файле примеры импортов встречаются
  // как раз в комментариях, и они не должны ронять тест.
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/import\s+type\s+[^;]*?from\s*['"][^'"]+['"];?/g, '');
  const staticPlaywright = [/from\s*['"]playwright(-core)?(\/[^'"]*)?['"]/, /^import\s*['"]playwright(-core)?(\/[^'"]*)?['"]/m];
  for (const re of staticPlaywright) {
    assert.ok(!re.test(code), `playwright только динамическим импортом (иначе реестр браузеров заморозится до PLAYWRIGHT_BROWSERS_PATH): ${rel}`);
  }
}

// 2. Фейк-адаптер: цена ползёт на 1 рубль за вызов, второй поиск падает.
class FakeAdapter implements StoreAdapter {
  readonly storeId = 'magnit' as const;
  calls = 0;
  categoryCalls = 0;
  productCalls = 0;
  failSecond = false;
  withCategoryImage = true;

  async search(query: string, ctx: { city: string; externalStoreId: string }): Promise<ScrapedProduct[]> {
    this.calls += 1;
    if (this.failSecond && this.calls > 1) throw new Error('сеть молчит');
    return [
      {
        canonicalId: `magnit-${query}-1`,
        storeId: 'magnit',
        city: ctx.city,
        name: `Молоко ПРАВИЛЬНОЕ 3,2%, ${900}мл`,
        price: 100 + this.calls,
        promoPrice: null,
        oldPrice: null,
        inStock: true,
        collectedAt: new Date(Date.now() - this.calls * 1000).toISOString(),
      },
    ];
  }

  async fetchProduct(canonicalId: string, ctx: { city: string; externalStoreId: string }): Promise<ScrapedProduct> {
    this.productCalls += 1;
    const price = Number(canonicalId.split('-').pop());
    return {
      canonicalId,
      storeId: 'magnit',
      city: ctx.city,
      name: 'Молоко ПРАВИЛЬНОЕ 3,2%, 900мл',
      price,
      promoPrice: null,
      oldPrice: null,
      inStock: true,
      collectedAt: new Date().toISOString(),
    };
  }

  async fetchCategories(): Promise<StoreCategory[]> {
    this.categoryCalls += 1;
    return [
      {
        id: 'c1',
        name: 'Молоко',
        url: 'https://magnit.ru/catalog/1-',
        ...(this.withCategoryImage ? { imageUrl: 'https://img/c1.webp' } : {}),
      },
    ];
  }
}

const storage = memoryStorage();
const json = memoryJsonStore();
const events: { channel: string; payload: unknown }[] = [];
// task сохраняем: иначе таймеры можно только перечислить, но не запустить, и
// проверки поведения «что будет через 30 секунд» останутся непроверяемыми.
const timers: { ms: number; task: () => void }[] = [];
const background: BackgroundTasks = {
  every: (ms, task) => timers.push({ ms, task }),
  after: (ms, task) => timers.push({ ms, task }),
};
const fake = new FakeAdapter();
const deps: CoreDeps = {
  storage,
  json,
  shell: { version: () => '0.0.0-test', notify: () => {}, openExternal: async () => {} },
  background,
  log: consoleLogger,
  adapters: new Map([['magnit', fake as StoreAdapter]]),
  emit: (channel, payload) => events.push({ channel, payload }),
};
const core = createCore(deps);

// 3. Поиск пишет цены в БД и раскладывает товар по нашим полкам.
const found = await core.searchPrices({ city: 'moscow', query: 'молоко' });
const magnit = found.find((r) => r.storeId === 'magnit');
assert.equal(magnit?.ready, true, 'сеть ответила');
assert.equal(magnit?.items.length, 1);
assert.equal(magnit?.items[0]?.price, 101, 'цена из фейк-адаптера дошла до UI');

const hist = await core.getHistory({ canonicalId: magnit?.items[0]?.canonicalId ?? '', storeId: 'magnit', city: 'moscow' });
assert.equal(hist.length, 1, 'запись в историю появилась без Electron и без файла');
assert.equal(hist[0]?.price, 101);
assert.ok((storage.dump()?.length ?? 0) > 0, 'в хранилище оболочки лежат непустые байты базы');

// 4. Наши категории: полки строятся, товар попадает в «Молочное и яйца».
const cats = core.getOurCategories({ city: 'moscow' });
assert.ok(cats.length > 0, 'список наших категорий непустой');
assert.ok(cats.some((c) => c.id === UNASSIGNED_ID && c.virtual === true), 'есть виртуальная полка');
const dairy = cats.find((c) => c.id === 'dairy');
assert.ok(dairy, 'есть полка «Молочное и яйца»');

// 5. Витринные категории кэшируются в JsonStore, а не в файле.
const catalogs = await core.getCatalogs({ city: 'moscow' });
const catEntry = catalogs.find((c) => c.storeId === 'magnit');
assert.equal(catEntry?.categories.length, 1, 'категория витрины получена');
assert.ok(Object.keys(json.dump()).some((f) => f.startsWith('catalog-moscow-magnit-')), 'кэш витрины лежит в JsonStore');
// Второй раз сеть опрашиваться не должна: считаем ВЫЗОВЫ адаптера, а не
// количество файлов (имя файла детерминировано, счётчик не отличил бы попадание
// в кэш от похода в сеть).
const categoryCalls = fake.categoryCalls;
await core.getCatalogs({ city: 'moscow' });
assert.equal(fake.categoryCalls, categoryCalls, 'второй раз пошли в кэш, а не в сеть');
// Пустой кэш — промах: сеть должна быть опрошена, иначе разъехавшаяся форма
// заблокирует витрину на весь TTL.
for (const key of Object.keys(json.dump())) {
  if (key.startsWith('catalog-')) json.write(key, JSON.stringify({ at: Date.now(), categories: [] }));
}
await core.getCatalogs({ city: 'moscow' });
assert.ok(fake.categoryCalls > categoryCalls, 'пустой кэш не считается попаданием — сеть опрошена');

// Витрина без картинок в кэш не пишется (30.09, Магнит 303857: недельной TTL
// закрепил пустые плитки на семь суток). Кэш делаем ПРОТУХШИМ, иначе до сети
// не дойдём, и проверяем, что он остался нетронутым.
for (const key of Object.keys(json.dump())) {
  if (!key.startsWith('catalog-')) continue;
  const parsed = JSON.parse(json.dump()[key] as string) as { at: number; categories: object[] };
  json.write(
    key,
    JSON.stringify({
      at: 0,
      categories: parsed.categories.map((c, i) => ({ ...c, imageUrl: `https://img/${i}.webp` })),
    }),
  );
}
const callsBeforeNoImages = fake.categoryCalls;
fake.withCategoryImage = false;
await core.getCatalogs({ city: 'moscow' });
assert.ok(fake.categoryCalls > callsBeforeNoImages, 'протухший кэш вызвал сеть');
const cacheAfterNoImages = JSON.parse(
  json.dump()['catalog-moscow-magnit-303857.json'] as string,
) as { at: number; categories: { imageUrl?: string }[] };
assert.equal(cacheAfterNoImages.at, 0, 'витрина без картинок не перезаписала кэш');
assert.ok(
  cacheAfterNoImages.categories.every((c) => c.imageUrl),
  'в кэше остались картинки, а не пустая витрина из сети',
);

// С картинками — пишется.
fake.withCategoryImage = true;
await core.getCatalogs({ city: 'moscow' });
const cacheAfterImages = JSON.parse(
  json.dump()['catalog-moscow-magnit-303857.json'] as string,
) as { at: number; categories: { imageUrl?: string }[] };
assert.ok(cacheAfterImages.at > 0, 'витрина с картинками записана в кэш');

// 6. Сеть отвалилась — отдаём кэш и честно говорим, что он из кэша.
fake.failSecond = true;
const ourCat = await core.getOurCategory({ city: 'moscow', id: 'dairy' });
const ourMagnit = ourCat.find((r) => r.storeId === 'magnit');
assert.ok(ourMagnit, 'полка вернулась');
assert.equal(ourMagnit?.cached, true, 'сеть молчала — отдан кэш с пометкой');
assert.match(String(ourMagnit?.error ?? ''), /кэш/);

// 7. Фоновые таймеры заводятся оболочкой, а не ядром молча.
core.startScheduler();
assert.equal(timers.length, 2, 'таймеры созданы через порт background');
// Порядок: сначала короткий таймер, потом интервал. Короткий НЕ делает опроса
// по сети — он лишь подтягивает из БД метку «последний опрос», чтобы дата в
// подвале была свежей при старте. Сетевой опрос начинается только через
// интервал: на старте пользователь обычно ничего не просил, а у каждой сети
// есть своя защита.
assert.equal(timers[0]?.ms, 30000, 'через полминуты — только чтение метки');
assert.equal(timers[1]?.ms, 6 * 3600 * 1000, 'интервал опроса 6ч');

// 8. Опрос пишет историю и шлёт события наружу.
const fetchesBefore = fake.productCalls;
const poll = await core.runScheduler();
assert.ok(events.some((e) => e.channel === 'scheduler:done'), 'событие завершения опроса ушло в оболочку');
assert.ok(fake.productCalls > fetchesBefore, 'опрос дёргал fetchProduct по отслеживаемым товарам');
assert.ok(poll.status.counts.inserted > 0, `опрос вставил цены: ${JSON.stringify(poll.status.counts)}`);
assert.ok(!/не удался/.test(poll.summary), `успешный опрос не должен выглядеть провалом: ${poll.summary}`);

// 9. Запись в БД: повтор без изменений не добавляет строку (write-on-change).
const database = await openDb(storage);
const price: ScrapedProduct = {
  canonicalId: 'magnit-core-1',
  storeId: 'magnit',
  city: 'moscow',
  name: 'Молоко',
  price: 100,
  promoPrice: null,
  collectedAt: new Date().toISOString(),
};
assert.equal(savePriceIfChanged(database, toPriceInput(price)), 'inserted');
assert.equal(savePriceIfChanged(database, toPriceInput(price)), 'skipped', 'повтор без изменений не пишет');
assert.equal(
  savePriceIfChanged(database, toPriceInput({ ...price, price: 90 })),
  'inserted',
  'изменение цены пишет',
);

// 10. Ручная раскладка: пользователь забирает товар под управление.
fake.failSecond = false;
const scope = { canonicalId: 'magnit-молоко-1', storeId: 'magnit', city: 'moscow' };
const autoShelves = await core.getShelves(scope);
assert.equal(autoShelves.manual, false, 'до правки раскладка автоматическая');
assert.ok(autoShelves.categoryIds.includes('dairy'), `автораскладка положила товар на полку: ${JSON.stringify(autoShelves.categoryIds)}`);

// Неизвестная полка не должна уносить с собой текущий выбор: валидация до
// транзакции, иначе откат съел бы и удаления, и вставки.
await assert.rejects(
  () => core.setShelves({ ...scope, categoryIds: ['нет-такой-полки'] }),
  /неизвестная полка/,
  'неизвестная полка отклоняется',
);
const afterReject = await core.getShelves(scope);
assert.deepEqual(afterReject.categoryIds, autoShelves.categoryIds, 'отказ не изменил раскладку');

// Пользователь переносит товар на другую полку.
const moved = await core.setShelves({ ...scope, categoryIds: ['household'] });
assert.equal(moved.manual, true, 'после правки раскладка ручная');
assert.deepEqual(moved.categoryIds, ['household']);

// Автораскладка больше не вмешивается — ни на поиске, ни на полке.
await core.searchPrices({ city: 'moscow', query: 'молоко' });
await core.getOurCategory({ city: 'moscow', id: 'dairy' });
const afterAuto = await core.getShelves(scope);
assert.deepEqual(afterAuto.categoryIds, ['household'], 'автопроход не вернул товар на «Молочное и яйца»');
assert.equal(afterAuto.manual, true);

// «Убрать со всех полок» представимо: пустой набор не должен быть отменён
// ближайшим автопроходом, а товар обязан уехать в «Не разложено».
const cleared = await core.setShelves({ ...scope, categoryIds: [] });
assert.deepEqual(cleared.categoryIds, [], 'сняли со всех полок');
assert.equal(cleared.manual, true, 'пустой набор всё равно ручной');
await core.searchPrices({ city: 'moscow', query: 'молоко' });
const afterClearAuto = await core.getShelves(scope);
assert.deepEqual(afterClearAuto.categoryIds, [], 'автопроход не вернул снятый товар на полки');
const unassigned = await core.getOurCategory({ city: 'moscow', id: UNASSIGNED_ID });
assert.ok(
  unassigned.some((s) => s.items.some((i) => i.canonicalId === scope.canonicalId)),
  'снятый с полок товар виден в «Не разложено»',
);

// Выход из ручного режима: автораскладка снова решает.
const released = await core.releaseShelves(scope);
assert.equal(released.manual, false, 'товар вернулся под автораскладку');
await core.searchPrices({ city: 'moscow', query: 'молоко' });
const afterRelease = await core.getShelves(scope);
assert.equal(afterRelease.manual, false);
assert.ok(afterRelease.categoryIds.includes('dairy'), `автораскладка разложила товар заново: ${JSON.stringify(afterRelease.categoryIds)}`);

// 9b. Порог избранного уведомляет один раз и только про новое снижение.
// Проверка на живом ядре: без метки notified_price одна и та же цена ниже
// порога слала бы уведомление на каждом опросе (каждые 6 ч).
{
  const scope = { canonicalId: 'fav-t', storeId: 'magnit', city: 'moscow' as const };
  await core.setFavorite({ ...scope, targetPrice: 1000 });
  // История с ценой ниже порога: сообщить надо.
  savePriceIfChanged(
    await openDb(storage),
    toPriceInput({
      canonicalId: 'fav-t',
      storeId: 'magnit',
      city: 'moscow',
      name: 'Пороговый',
      price: 90,
      inStock: true,
      collectedAt: new Date().toISOString(),
    }),
  );
  assert.equal((await core.checkTargets('moscow')).length, 1, 'цена ниже порога уведомляется');
  await core.markNotifiedForTest([
    { canonicalId: 'fav-t', storeId: 'magnit', city: 'moscow', price: 90 },
  ]);
  assert.equal(
    (await core.checkTargets('moscow')).length,
    0,
    'та же цена второй раз не уведомляется',
  );
  // Новое снижение — сообщаем.
  savePriceIfChanged(
    await openDb(storage),
    toPriceInput({
      canonicalId: 'fav-t',
      storeId: 'magnit',
      city: 'moscow',
      name: 'Пороговый',
      price: 70,
      inStock: true,
      collectedAt: new Date().toISOString(),
    }),
  );
  assert.equal((await core.checkTargets('moscow')).length, 1, 'новое снижение уведомляется');
  await core.markNotifiedForTest([
    { canonicalId: 'fav-t', storeId: 'magnit', city: 'moscow', price: 70 },
  ]);
  // Цена ровно равна порогу — молчим: это не «упала ниже».
  saveFavorite(await openDb(storage), scope, 70);
  saveNotifiedPrices(await openDb(storage), [{ ...scope, price: 70 }]);
  assert.equal((await core.checkTargets('moscow')).length, 0, 'цена равна порогу не уведомляется');
  // Нет в наличии: уведомлять не о чем.
  savePriceIfChanged(
    await openDb(storage),
    toPriceInput({
      canonicalId: 'fav-t',
      storeId: 'magnit',
      city: 'moscow',
      name: 'Пороговый',
      price: 50,
      inStock: false,
      collectedAt: new Date().toISOString(),
    }),
  );
  saveNotifiedPrices(await openDb(storage), [{ ...scope, price: 70 }]);
  assert.equal((await core.checkTargets('moscow')).length, 0, 'товар не в наличии не уведомляется');
  await core.removeFavorite(scope);
}

// 9. Метка опроса переживает перезапуск, а автоопрос не повторяет свежий.
// Ответ на вопрос «запустил опрос, перезашёл — он снова опросил?». Метка держа-
// лась только в памяти процесса, а у portable каждый запуск это новый процесс.
{
  // Ядро должно знать город: без setCurrentCity автоопрос пошёл бы по всем
  // городам разом, и проверка свежей метки была бы невозможна.
  core.setCurrentCity('moscow');
  const before = fake.productCalls;
  await core.runScheduler({ city: 'moscow' });
  assert.ok(fake.productCalls > before, 'ручной опрос дошёл до сети');
  const stamped = getLastRun(await openDb(storage), 'moscow');
  assert.ok(stamped, 'метка опроса записана в БД, а не только в память');

  // Тот же процесс: интервальный таймер при свежей метке обязан НЕ ходить в сеть.
  const fresh = fake.productCalls;
  for (const t of timers) if (t.ms === 6 * 3600 * 1000) await t.task();
  assert.equal(fake.productCalls, fresh, 'интервальный таймер не повторяет свежий опрос');

  // Метка старше интервала — опрос состояться должен.
  saveLastRun(await openDb(storage), 'moscow', new Date(Date.now() - 7 * 3600 * 1000).toISOString());
  for (const t of timers) if (t.ms === 6 * 3600 * 1000) await t.task();
  assert.ok(fake.productCalls > fresh, 'протухшая метка разрешает опрос');
}

// 10. Коалесценция прогресса — ровно тот случай, который вешал renderer.
// Раньше событие уходило на КАЖДЫЙ товар, а ветки пропуска в scheduler зовут
// onProgress без паузы: когда сеть встаёт на паузу breaker'а, все её
// оставшиеся товары пролетают за миллисекунды. Renderer на этой пачке писал
// [Violation] 'message' handler took 521ms.
{
  const sent: { channel: string; payload: unknown }[] = [];
  const collect = (channel: string, payload: unknown): void => {
    sent.push({ channel, payload });
  };
  const p = progressEmitter(collect, 250);

  // Пачка из 200 событий подряд — как от breaker'а.
  for (let i = 1; i <= 200; i++) p.onProgress(i, 237);
  assert.equal(sent.length, 1, `пачка схлопывается в одно событие, а не 200 (получено ${sent.length})`);
  assert.deepEqual(sent[0]?.payload, { done: 1, total: 237 }, 'первое событие уходит сразу, без задержки');

  // Состояние не застывает: flush отдаёт последнее, иначе счётчик не дошёл бы до N/N.
  p.flush();
  assert.equal(sent.length, 2, 'финальное состояние уходит обязательно');
  assert.deepEqual(sent[1]?.payload, { done: 200, total: 237 }, 'в финале — последнее состояние');

  // Пустой прогресс не должен ничем шуметь.
  const quiet = progressEmitter(collect, 250);
  quiet.flush();
  assert.equal(sent.length, 2, 'flush без событий ничего не отправляет');

  // Штатный темп (пауза 1с между живыми товарами) события не теряет.
  const paced = progressEmitter(collect, 250);
  paced.onProgress(1, 10);
  paced.onProgress(2, 10);
  assert.equal(sent.length, 3, 'два события подряд с разницей меньше minGapMs не теряются полностью: первый ушёл сразу, второй ждёт flush');
}

closeDb();
console.log('core: OK — ядро без Electron и без диска, кэш и таймеры через порты');
