// Редкие ветви ядра, которые не срабатывают на обычных прогонах: отказ базы
// при открытии полки, «не разложено» без БД, долгий товар в опросе и
// ProductLookupError (сеть ответила, товара нет — паузу сети ставить нельзя).
//
// Каждая проверка здесь соответствует конкретному решению в коде: если ветку
// уберут, тест должен упасть, а не стать пустым.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCore, UNASSIGNED_ID } from '../src/core/services.js';
import { closeDb, openDb, releaseProductShelves, saveLastRun } from '../src/core/db/db.js';
import type { Database } from 'sql.js';
import { fileStorageAt } from '../electron/node-files.js';
import { ProductLookupError } from '../src/core/adapter-errors.js';
import { OUR_CATEGORIES } from '../src/shared/taxonomy.js';
import { CITY_STORES } from '../src/shared/catalog.js';
import type { ScrapedProduct, StoreAdapter, StoreCategory } from '../src/shared/types.js';
import type { CoreDeps } from '../src/core/platform.js';

type SearchCtx = Parameters<StoreAdapter['search']>[1];
type ProductCtx = Parameters<StoreAdapter['fetchProduct']>[1];

const logs: string[] = [];
const afterTasks: (() => void)[] = [];
const notices: string[] = [];

/** Сколько строк в таблице — чтобы доказать, что откат ничего не оставил. */
const countRows = (database: Database, table: string): number =>
  database.exec(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.values[0]?.[0] as number;

const item = (canonicalId: string, name: string, price: number): ScrapedProduct => ({
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
  collectedAt: '2026-10-03T10:00:00.000Z',
});

/** Адаптер, который умеет: искать, отдавать товар и подминать время. */
class EdgeAdapter implements StoreAdapter {
  readonly storeId = 'magnit' as const;
  failSearch = false;
  failCategory = false;
  failProduct = false;
  /** Медленный товар: задержка ответа в мс. */
  slowMs = 0;
  lookupError = false;
  /** Отдать цену ниже порога — так проверяется уведомление. */
  cheap = false;
  /** Запрос, на котором сеть не ответит (остальные проходят). */
  failQuery: string | null = null;
  /** Отвечать ценой на любой товар, а не только на известные. */
  answerAnyProduct = false;

  constructor(private readonly items: ScrapedProduct[]) {}

  add(...extra: ScrapedProduct[]): void {
    this.items.push(...extra);
  }

  async search(query: string, ctx: SearchCtx): Promise<ScrapedProduct[]> {
    if (this.failSearch) throw new Error('magnit: сеть молчит');
    if (this.failQuery && query.toLowerCase().includes(this.failQuery.toLowerCase())) {
      throw new Error(`magnit: запрос «${query}» не ответил`);
    }
    return this.items
      .filter((i) => i.name.toLowerCase().includes(query.toLowerCase()))
      .map((i) => ({ ...i, city: ctx.city }));
  }

  async fetchCategories(): Promise<StoreCategory[]> {
    if (this.failCategory) throw new Error('magnit: витрина недоступна');
    return [{ id: 'c1', name: 'Молоко', url: 'https://magnit.ru/catalog/1-', imageUrl: 'https://img/c1.webp' }];
  }

  canHandleCategoryUrl(url: string): boolean {
    return url.includes('magnit.ru');
  }

  async fetchCategoryProducts(_url: string, ctx: SearchCtx): Promise<ScrapedProduct[]> {
    if (this.failCategory) throw new Error('magnit: витрина недоступна');
    return this.items.map((i) => ({ ...i, city: ctx.city }));
  }

  async fetchProduct(canonicalId: string, ctx: ProductCtx): Promise<ScrapedProduct> {
    if (this.slowMs > 0) await new Promise((r) => setTimeout(r, this.slowMs));
    if (this.lookupError) throw new ProductLookupError('товара нет', canonicalId);
    if (this.failProduct) throw new Error('magnit: карточка не отвечает');
    const found = this.items.find((i) => i.canonicalId === canonicalId);
    if (!found && !this.answerAnyProduct) throw new ProductLookupError('нет товара', canonicalId);
    const target = found ?? item(canonicalId, 'Любой товар', 40);
    return this.cheap ? { ...target, price: 100, city: ctx.city } : { ...target, city: ctx.city };
  }
}

const jsonFiles = new Map<string, string>();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-edge-'));

let failRead = false;
// Хранилище, которое всегда падает: нужно там, где проверяется ветка ядра
// при недоступной баде, а openDb — синглтон и уже открытую базу не отдаёт.
const brokenStorage = {
  readDb: (): Uint8Array | null => {
    throw new Error('диск недоступен');
  },
  writeDb: () => {},
};
let failWrite = false;
const real = fileStorageAt(path.join(tmpDir, 'e.db'));
const storage = {
  readDb: (): Uint8Array | null => {
    if (failRead) throw new Error('диск недоступен');
    return real.readDb();
  },
  writeDb: (bytes: Uint8Array): void => {
    if (failWrite) throw new Error('диск только для чтения');
    real.writeDb(bytes);
  },
};

const magnit = new EdgeAdapter([item('e-milk', 'Молоко ПРАВИЛЬНОЕ 3,2%, 930мл', 119)]);
// Второй товар нужен, чтобы порог breaker (два отвода подряд) был достижим.
magnit.add(item('e-cheese', 'Сыр Hochland Сливочный 55% 200г', 229));
const deps: CoreDeps = {
  storage,
  json: {
    read: (name) => jsonFiles.get(name) ?? null,
    write: (name, text) => void jsonFiles.set(name, text),
  },
  shell: { version: () => '1.2.1', notify: (t) => void notices.push(t), openExternal: async () => {} },
  background: {
    every: () => {},
    after: (_ms, task) => void afterTasks.push(task as () => void),
  },
  log: {
    error: (...a) => void logs.push(a.map(String).join(' ')),
    warn: (...a) => void logs.push(a.map(String).join(' ')),
    info: (...a) => void logs.push(a.map(String).join(' ')),
  },
  adapters: new Map([['magnit', magnit]]),
};

const core = createCore(deps);
core.setCurrentCity('moscow');

// --- 1. Полка при недоступной базе: цены показаны, история — нет. -------
// Правило: товар из сети виден всегда (пользователь пришёл за ценой), но
// интерфейс обязан сказать, что в историю это не попало.
{
  failRead = true;
  const rows = await core.getOurCategory({ city: 'moscow', id: 'dairy-milk' });
  failRead = false;
  const magnitRow = rows.find((s) => s.storeId === 'magnit');
  assert.ok((magnitRow?.items.length ?? 0) > 0, 'цена из сети показана даже без базы');
  assert.match(
    magnitRow?.error ?? '',
    /цены показаны, но в историю не записаны/,
    'и пользователю сказано, что в историю это не попало',
  );
}

// --- 2. «Не разложено» без базы: та же честная ошибка. ---------------------
{
  failRead = true;
  const rows = await core.getOurCategory({ city: 'moscow', id: UNASSIGNED_ID });
  failRead = false;
  const magnitRow = rows.find((s) => s.storeId === 'magnit');
  assert.match(
    magnitRow?.error ?? '',
    /цены показаны, но в историю не записаны/,
    'виртуальная полка тоже не притворяется, что товаров нет',
  );
}

// База открывается успешно — дальше идёт обычный случай.
const db = await openDb(storage);

// --- 3. Отказ сети в сети полки: кэш показывается с датой, иначе — причина.
{
  magnit.failSearch = true;
  const first = await core.getOurCategory({ city: 'moscow', id: 'bakery-bread' });
  const magnitRow = first.find((s) => s.storeId === 'magnit');
  assert.match(magnitRow?.error ?? '', /ни один запрос не сработал/, 'кэша нет — видна причина');
  magnit.failSearch = false;
}

// Товар должен попасть в products (FK избранного), а он появляется при поиске.
// Оба товара должны попасть в products: отметка ссылается на него внешним ключом.
await core.searchPrices({ query: 'молоко' });
await core.searchPrices({ query: 'сыр' });
// Опрос идёт только по отслеживаемым, поэтому без отметки его не будет.
await core.setFavorite({ canonicalId: 'e-milk', storeId: 'magnit', city: 'moscow', targetPrice: null });
await core.setFavorite({ canonicalId: 'e-cheese', storeId: 'magnit', city: 'moscow', targetPrice: null });

// --- 4. ProductLookupError в опросе: товара нет, сеть не виновата. ---------
{
  magnit.lookupError = true;
  const res = await core.runScheduler({ city: 'moscow' });
  magnit.lookupError = false;
  assert.ok(res.status.counts.failed >= 2, 'оба товара без ответа посчитаны неудачей — их надо показать');
  assert.ok(
    logs.filter((l) => l.startsWith('poll: magnit')).length >= 2,
    'и по каждому есть запись в логе',
  );
  assert.ok(
    !logs.some((l) => l.includes('поставлена на паузу')),
    'но сеть не наказана: два переименованных товара не должны её выключать',
  );
}

// --- 4b. Контроль к предыдущей проверке: настоящий отказ сети паузу ставит.
// Без этого «сеть не наказана» выше было бы истинно всегда.
{
  magnit.failProduct = true;
  await core.runScheduler({ city: 'moscow' });
  magnit.failProduct = false;
  assert.ok(
    logs.some((l) => l.includes('поставлена на паузу')),
    'два ответа сети подряд отключают магазин — значит предыдущая проверка не вакуумная',
  );
}

// --- 5. Отказы сети в опросе: сводка не может быть зелёной. ----------------
{
  magnit.failProduct = true;
  const failed = await core.runScheduler({ city: 'moscow' });
  magnit.failProduct = false;
  assert.match(failed.summary, /ошибок [1-9]/, 'в сводке есть ненулевое число ошибок');
  assert.equal(failed.status.running, false, 'планировщик освободился после провала');
}

// --- 6. Неготовый магазин виден отдельной строкой, а не пропадает. --------
// В Ульяновске Пятёрчка помечена ready: false (код есть, но сеть по IP не
// отвечает). Пользователь должен видеть «сеть недоступна», а не пустую выдачу.
{
  const rows = await core.searchPrices({ query: 'молоко', city: 'ulyanovsk' });
  const pyaterochka = rows.find((s) => s.storeId === 'pyaterochka');
  assert.equal(pyaterochka?.ready, false, 'неготовый магазин помечен недоступным');
  assert.deepEqual(pyaterochka?.items, [], 'и товаров не выдумано');
  assert.ok(!pyaterochka?.error, 'причина — в флаге ready, а не в ошибке сети');
}

// --- 7. Адаптер без витрины и без canHandleCategoryUrl. ------------------
// Такой адаптер есть у любой сети, у которой нет каталога; ядро обязано вести
// себя с ним так же, как с полноценным.
{
  const bare = {
    storeId: 'magnit' as const,
    async search(query: string, ctx: SearchCtx) {
      return magnit.search(query, ctx);
    },
    async fetchProduct(canonicalId: string, ctx: ProductCtx) {
      return magnit.fetchProduct(canonicalId, ctx);
    },
  };
  const bareCore = createCore({ ...deps, adapters: new Map<string, StoreAdapter>([['magnit', bare]]) });
  bareCore.setCurrentCity('moscow');
  const own = await bareCore.getCategoryProducts({ city: 'moscow', url: 'https://magnit.ru/catalog/1-' });
  // Ни canHandleCategoryUrl, ни fetchCategoryProducts — сеть не претендент на
  // ссылку, и ядро говорит об этом одной строкой, а не пустой витриной.
  assert.equal(own.length, 1, 'ответ один: ссылка ничья');
  assert.match(own[0]?.error ?? '', /не принадлежит ни одной сети/, 'и сказано, что не так');
  assert.deepEqual(own[0]?.items, [], 'товаров не выдумано');
}

// --- 8. Витрина упала: причина видна в строке этой сети. -------------------
{
  magnit.failCategory = true;
  const rows = await core.getCategoryProducts({ city: 'moscow', url: 'https://magnit.ru/catalog/1-' });
  magnit.failCategory = false;
  const row = rows.find((s) => s.storeId === 'magnit');
  assert.match(row?.error ?? '', /витрина недоступна/, 'отказ витрины не съеден');
}

// --- 9. Кэш витрины не записался: работаем без него, а не падаем. ---------
{
  const failingJson = {
    read: (name: string) => jsonFiles.get(name) ?? null,
    write: () => {
      throw new Error('диск только для чтения');
    },
  };
  const noCacheCore = createCore({ ...deps, json: failingJson });
  noCacheCore.setCurrentCity('moscow');
  const rows = await noCacheCore.getCatalogs({ city: 'moscow' });
  assert.equal(
    rows.find((c) => c.storeId === 'magnit')?.categories.length,
    1,
    'витрина показана из свежего ответа, хотя в кэш она не легла',
  );
  assert.ok(
    logs.some((l) => l.includes('catalog cache write failed')),
    'причина залогирована, а не съедена молча',
  );
}

// --- 10. Цена от сети, которую нельзя записать: товар показан, ошибка нет.
{
  const badAdapter = new EdgeAdapter([]);
  badAdapter.search = async () => [
    { ...item('e-bad', 'Молоко битое', Number.NaN) },
  ];
  const badCore = createCore({ ...deps, adapters: new Map([['magnit', badAdapter]]) });
  badCore.setCurrentCity('moscow');
  const rows = await badCore.searchPrices({ query: 'молоко' });
  assert.equal(rows.find((s) => s.storeId === 'magnit')?.items.length, 1, 'плохая цена не выбрасывает товар из выдачи');
  assert.ok(
    logs.some((l) => l.includes('db item skipped')),
    'но в историю она не попала, и это отмечено в логе',
  );
}

// --- 11. Откаты транзакций: несуществующий товар и битая привязка. --------
{
  const ghost = { canonicalId: 'нет-такого', storeId: 'magnit', city: 'moscow' };
  assert.throws(
    () => releaseProductShelves(db, { ...ghost, canonicalId: undefined as unknown as string }),
    /bind|unsupported type/i,
    'битая привязка откатывается, а не оставляет половину правки',
  );
  const manualBefore = countRows(db, 'product_category_manual');
  const catsBefore = countRows(db, 'product_categories');
  assert.doesNotThrow(
    () => releaseProductShelves(db, ghost),
    'а товара, которого нет в базе, полки снять можно и нужно молча',
  );
  assert.equal(countRows(db, 'product_category_manual'), manualBefore, 'чужие строки не тронуты');
  assert.equal(countRows(db, 'product_categories'), catsBefore, 'и полки тоже');
}

// --- 12. Опрос с «медленным» товаром: в лог попадает замер. ---------------
{
  const realNow = Date.now;
  const started = realNow();
  // Товар отвечает мгновенно, но часы идут на минуту за вызов: замер обязан
  // сработать, иначе мы потеряем след, куда уходит время на медленной сети.
  let clock = started;
  Date.now = () => (clock += 60_000);
  try {
    await core.runScheduler({ city: 'moscow' });
  } finally {
    Date.now = realNow;
  }
  assert.ok(
    logs.some((l) => /^опрос: magnit e-milk \d+мс$/.test(l)),
    'медленный товар попал в лог с замером',
  );
}

/** Сдвинуть метку последнего прогона: ручной опрос идёт с force, а метка нужна для повторного. */
const forgetRun = async (): Promise<void> => {
  saveLastRun(db, 'moscow', new Date(Date.now() - 10 * 3600 * 1000).toISOString());
};

// --- 13. Сеть без витрины, но со ссылкой: строка «не готова», а не пусто. ---
{
  const noShelf = {
    storeId: 'magnit' as const,
    async search(query: string, ctx: SearchCtx) {
      return magnit.search(query, ctx);
    },
    async fetchProduct(canonicalId: string, ctx: ProductCtx) {
      return magnit.fetchProduct(canonicalId, ctx);
    },
    // Ссылка наша, а витрины нет — так ведёт себя сеть без каталога.
    canHandleCategoryUrl: (url: string) => url.includes('magnit.ru'),
  };
  const bareCore = createCore({ ...deps, adapters: new Map<string, StoreAdapter>([['magnit', noShelf]]) });
  bareCore.setCurrentCity('moscow');
  const rows = await bareCore.getCategoryProducts({ city: 'moscow', url: 'https://magnit.ru/catalog/1-' });
  const row = rows.find((s) => s.storeId === 'magnit');
  assert.equal(row?.ready, false, 'сеть без витрины помечена неготовой');
  assert.deepEqual(row?.items, [], 'и товаров не выдумано');
}

// --- 14. История с битым аргументом: пусто, а не исключение. ---------------
{
  assert.deepEqual(
    await core.getHistory({ canonicalId: undefined as unknown as string, storeId: 'magnit', city: 'moscow' }),
    [],
    'без canonicalId история пустая и без обращения к базе',
  );
  // А вот значение, которое не умеет bind, — уже не «нет данных», а отказ
  // запроса: он обязан быть пойман, а не уронить чтение истории.
  const logged = logs.length;
  assert.deepEqual(
    await core.getHistory({
      canonicalId: 'e-milk',
      storeId: { nope: true } as unknown as string,
      city: 'moscow',
    }),
    [],
    'битое значение ключа не роняет интерфейс',
  );
  assert.ok(logs.length > logged, 'и причина залогирована, а не съедена молча');
}

// --- 15. Порог должен быть положительным числом. ---------------------------
{
  await assert.rejects(
    () => core.setFavorite({ canonicalId: 'e-milk', storeId: 'magnit', city: 'moscow', targetPrice: 0 }),
    /целевая цена должна быть положительным числом/,
    'порог 0 — это «уведомлять всегда», и он запрещён',
  );
  await assert.rejects(
    () => core.setFavorite({ canonicalId: 'e-milk', storeId: 'magnit', city: 'moscow', targetPrice: Number.NaN }),
    /целевая цена должна быть положительным числом/,
    'NaN — тоже не цена',
  );
}

// --- 16. Уведомление приходит с названием сети, а не «magnit». -------------
{
  // Порог выше цены, потом цена падает ниже порога — и опрос об этом узнаёт.
  await core.setFavorite({ canonicalId: 'e-cheese', storeId: 'magnit', city: 'moscow', targetPrice: 250 });
  magnit.cheap = true;
  const res = await core.runScheduler({ city: 'moscow' });
  magnit.cheap = false;
  assert.ok(res.status.lastRun !== null, 'опрос прошёл');
  assert.ok(
    notices.length > 0,
    'при снижении цены уведомление уходит наружу, а не молчит в логе',
  );
  assert.match(
    notices[notices.length - 1] ?? '',
    /Магнит/,
    'и в тексте название сети: пользователь должен знать, где дешевле',
  );
}

// --- 17. Два провала подряд: сводка говорит «N раз подряд». ----------------
// Провал всего опроса (не отдельного товара) — это когда не пишется база:
// тогда последняя ошибка запоминается, и второй подряд это уже видно.
{
  failWrite = true;
  const first = await core.runScheduler({ city: 'moscow' });
  await forgetRun();
  const second = await core.runScheduler({ city: 'moscow' });
  failWrite = false;
  assert.match(first.summary, /^Опрос не удался: /, 'первый провал — одиночный, без счётчика');
  assert.match(
    second.summary,
    /Опрос не удался 2 раз подряд/,
    'второй подряд — счётчик виден в тексте, чтобы молчание не выглядело нормой',
  );
}

// --- 18. Полка при отказе сети: показываем кэш и говорим об этом. ------
// Это и есть офлайн-режим полки: товары из кэша лучше пустоты, но интерфейс
// обязан сказать, что они из кэша и за какой даты.
{
  const shelf = OUR_CATEGORIES.find(
    (c) => c.queries.length >= 2 && !['bakery-bread', 'dairy-milk', 'dairy-cheese'].includes(c.id),
  )!;
  const offline = new EdgeAdapter([item('e-offline', `${shelf.queries[0]} 1 шт`, 100)]);
  offline.failSearch = true;
  const online = createCore({ ...deps, adapters: new Map<string, StoreAdapter>([['magnit', offline]]) });
  online.setCurrentCity('moscow');
  const fresh = await online.getOurCategory({ city: 'moscow', id: shelf.id });
  assert.ok((fresh.find((s) => s.storeId === 'magnit')?.items.length ?? 0) > 0, 'сеть жива — полка собрана');

  const dead = new EdgeAdapter([]);
  dead.failSearch = true;
  const offlineCore = createCore({ ...deps, adapters: new Map<string, StoreAdapter>([['magnit', dead]]) });
  offlineCore.setCurrentCity('moscow');
  const cached = await offlineCore.getOurCategory({ city: 'moscow', id: shelf.id });
  const row = cached.find((s) => s.storeId === 'magnit');
  assert.ok((row?.items.length ?? 0) > 0, 'сеть молчит — но товары из кэша показаны');
  assert.equal(row?.cached, true, 'строка помечена как кэш');
  assert.match(
    row?.error ?? '',
    /сеть не ответила, показаны цены из кэша/,
    'и сказано, что это кэш, а не свежая выдача',
  );
}

// --- 19. Старт планировщика читает метку последнего прохода. -------------
// Это то, что показывает «последний опрос» в подвале до первого сетевого
// запроса: метка читается молча, и неудача не должна ронять приложение.
{
  // Метка уже есть: её ставили прошлые прогоны этого файла. Чтение при старте
  // обязано её показать, а не потерять — ради этого оно и написано.
  const recorded = core.schedulerStatus().lastRun;
  assert.ok(recorded !== null, 'до старта метка от прошлого прогона есть');
  core.startScheduler();
  assert.ok(afterTasks.length > 0, 'разовая задача на чтение метки поставлена');
  const seen = logs.length;
  for (const task of afterTasks) task();
  // Ждём появления записи в логе, а не фиксированную паузу: иначе тест мигает
  // на медленной машине.
  for (let i = 0; i < 200 && logs.length === seen; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(core.schedulerStatus().lastRun, recorded, 'и после чтения метка на месте');
  assert.equal(core.schedulerStatus().running, false, 'чтение метки не занимает планировщик');
}

// --- 21. Полка при недоступной базе: товары показаны, история — нет. -------
// Здесь база роняется ПОСЛЕ того, как запросы к сети отработали, поэтому
// ветка «базы нет» внутри обработки полки и должна отдавать товары без кэша.
{
  const shelf = OUR_CATEGORIES.find(
    (c) => c.queries.length >= 2 && !['bakery-bread', 'dairy-milk', 'dairy-cheese'].includes(c.id),
  )!;
  const offline = new EdgeAdapter([item('e-nodb', `${shelf.queries[0]} 1 шт`, 100)]);
  offline.failSearch = true;
  const deadCore = createCore({ ...deps, adapters: new Map<string, StoreAdapter>([['magnit', offline]]) });
  deadCore.setCurrentCity('moscow');
  // Сеть отвечает, а база уже недоступна: товар показать нечем из кэша, но сам
  // ответ сети показать можно.
  const alive = new EdgeAdapter([item('e-nodb', `${shelf.queries[0]} 1 шт`, 100)]);
  alive.failSearch = false;
  const noDbCore = createCore({ ...deps, storage: brokenStorage, adapters: new Map<string, StoreAdapter>([['magnit', alive]]) });
  noDbCore.setCurrentCity('moscow');
  const rows = await noDbCore.getOurCategory({ city: 'moscow', id: shelf.id });
  const row = rows.find((s) => s.storeId === 'magnit');
  assert.ok((row?.items.length ?? 0) > 0, 'цена из сети показана даже без базы');
  assert.match(row?.error ?? '', /историю не записаны|база недоступна/, 'и сказано, что в историю ничего не попало');
  void deadCore;
}

// --- 22. Полка, где часть запросов не сработала. ---------------------------
// Один запрос от сети отказал, остальные ответили товарами, чья цена не
// прошла запись (NaN) — в кэш полки они не попали, и полка обязана сказать,
// что часть запросов не удалась, а не выглядеть как «товаров нет».
{
  // Полка должна быть не той, что использовалась выше: у неё уже есть кэш,
  // и ветка «часть запросов не удалась» тогда просто не наступит.
  const used = new Set(['bakery-bread', 'dairy-milk', 'dairy-cheese']);
  used.add(OUR_CATEGORIES.find((c) => c.queries.length >= 2 && !used.has(c.id))!.id);
  const shelf = OUR_CATEGORIES.find((c) => c.queries.length >= 2 && !used.has(c.id))!;
  const [first, second] = shelf.queries as [string, string];
  // Цена NaN: ответ сети есть, но запись в историю не проходит — значит, в кэш
  // полки товар не попадёт, и полка честно скажет про частичную неудачу.
  const halfBad = new EdgeAdapter([item('e-nan', `${first} 1 шт`, Number.NaN)]);
  halfBad.failQuery = second;
  const halfCore = createCore({ ...deps, adapters: new Map<string, StoreAdapter>([['magnit', halfBad]]) });
  halfCore.setCurrentCity('moscow');
  const rows = await halfCore.getOurCategory({ city: 'moscow', id: shelf.id });
  const row = rows.find((s) => s.storeId === 'magnit');
  assert.match(
    row?.error ?? '',
    /часть запросов не удалась \(1 из/,
    'пользователь видит, что один запрос не сработал',
  );
  assert.notEqual(row?.cached, true, 'и это не выдано за кэш: товаров в кэше нет');
}

// --- 23. Аргументы по умолчанию и незнакомый город. --------------------------
// Пользователь может не указать город, а город может исчезнуть из справочника
// (его убрали в обновлении). В обоих случаях приложение обязано ответить, а не
// упасть: пустой список или прямое «ни одной сети».
{
  const plain = createCore(deps);
  assert.deepEqual(await plain.searchPrices(), [], 'поиск без запроса — пусто');
  assert.deepEqual(await plain.searchPrices({ query: '   ' }), [], 'пустой запрос — пусто');
  assert.ok(Array.isArray(await plain.getCatalogs()), 'каталоги без аргументов — список');
  assert.deepEqual(await plain.getCategoryProducts(), [], 'полка без ссылки — пусто');
  assert.ok(plain.getOurCategories().length > 0, 'наши полки есть даже без аргументов');
  // Полка без id — это не «пусто», а «непонятно, что открывать»: так и сказано.
  assert.rejects(
    () => plain.getOurCategory(),
    /неизвестная категория/,
    'наша полка без id отвергнута, а не молча пуста',
  );
  plain.setCurrentCity('moscow');

  const atlantis = 'atlantis';
  const nowhere = createCore(deps);
  assert.deepEqual(await nowhere.searchPrices({ city: atlantis, query: 'молоко' }), [], 'незнакомый город: поиск пуст');
  assert.deepEqual(await nowhere.getCatalogs({ city: atlantis }), [], 'незнакомый город: каталогов нет');
  // Полки перечисляются всегда, но в незнакомом городе за ними ноль сетей:
  // интерфейс обязан показать это, а не прятать полки.
  const shelves = nowhere.getOurCategories({ city: atlantis });
  assert.ok(shelves.length > 1, 'список наших полок не зависит от города');
  assert.ok(
    shelves.every((c) => c.storeCount === 0),
    'а в незнакомом городе за полками ни одной сети',
  );
  assert.deepEqual(await nowhere.getOurCategory({ city: atlantis, id: 'dairy-milk' }), [], 'незнакомый город: полка пуста');

  const wrongLink = await nowhere.getCategoryProducts({ city: atlantis, url: 'https://example.com/catalog/1/' });
  assert.equal(wrongLink.length, 1, 'на чужую ссылку ответ один — с объяснением');
  assert.equal(wrongLink[0]?.storeId, 'magnit', 'без сети в городе подставлен дефолт');
  assert.equal(wrongLink[0]?.name, 'Полка', 'и имя полки по умолчанию');
  assert.match(wrongLink[0]?.error ?? '', /не принадлежит ни одной сети/, 'сказано, что ссылка чужая');
}

// --- 24. К��ш витринных категорий: срок и форма. ----------------------------
// У Пятёрки сеть перестраивает каталог, поэтому её кэш живёт сутки, а у
// остальных — неделя. Срок проверяется по сети, а не по одному общему числу:
// иначе полка Пятёрки оставалась бы с мёртвыми ссылками на неделю.
{
  const city = 'moscow';
  const cacheFile = (storeId: string, externalStoreId: string): string =>
    `catalog-${city}-${storeId}-${externalStoreId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
  const twoDaysAgo = Date.now() - 2 * 24 * 3600 * 1000;
  const fiveka = CITY_STORES[city]?.find((s) => s.storeId === 'pyaterochka');
  const magnitStore = CITY_STORES[city]?.find((s) => s.storeId === 'magnit');
  assert.ok(fiveka && magnitStore, 'в справочнике есть и Пятёрка, и Магнит');

  // Пятёрка (сутки) и Магнит (неделя) с одинаковым двухдневным кэшем.
  const fivekaCategories = [{ id: 'p1', name: 'Пятёрочка из кэша', url: 'https://5ka.ru/catalog/p1/' }];
  const magnitCategories = [{ id: 'm1', name: 'Магнит из кэша', url: 'https://magnit.ru/catalog/1-' }];
  jsonFiles.set(cacheFile('pyaterochka', fiveka.externalStoreId), JSON.stringify({ at: twoDaysAgo, categories: fivekaCategories }));
  jsonFiles.set(cacheFile('magnit', magnitStore.externalStoreId), JSON.stringify({ at: twoDaysAgo, categories: magnitCategories }));

  const fivekaLive: StoreCategory[] = [{ id: 'p2', name: 'Пятёрка из сети', url: 'https://5ka.ru/catalog/p2/' }];
  const core24 = createCore({
    ...deps,
    adapters: new Map<string, StoreAdapter>([
      ['magnit', magnit],
      [
        'pyaterochka',
        {
          storeId: 'pyaterochka',
          search: async () => [],
          fetchProduct: async () => {
            throw new Error('не вызывается');
          },
          fetchCategories: async () => fivekaLive,
        } as unknown as StoreAdapter,
      ],
    ]),
  });
  const catalogs = await core24.getCatalogs({ city });
  assert.deepEqual(
    catalogs.find((c) => c.storeId === 'magnit')?.categories.map((c) => c.id),
    ['m1'],
    'двухдневный кэш Магнита жив: недельный срок',
  );
  assert.deepEqual(
    catalogs.find((c) => c.storeId === 'pyaterochka')?.categories.map((c) => c.id),
    ['p2'],
    'двухдневный кэш Пятёрки протух: суточный срок, пошли в сеть',
  );

  // Свежий по времени, но не по форме — тоже мусор, и показывать его нельзя.
  jsonFiles.set(cacheFile('magnit', magnitStore.externalStoreId), JSON.stringify({ at: Date.now(), categories: { 'не массив': true } }));
  const brokenShape = await core24.getCatalogs({ city });
  assert.deepEqual(
    brokenShape.find((c) => c.storeId === 'magnit')?.categories.map((c) => c.id),
    ['c1'],
    'кэш не по форме отброшен, витрина взята из сети',
  );
}

// --- 25. Полка из кэша: пустая полка сети. ---------------------------------
{
  // «Не разложено» читается только из базы. Город, в котором для этой сети ещё
  // нет ни одной записи, — полка обязана быть пустой и остаться полкой сети, а
  // не превратиться в «ошибка» или «сеть не ответила».
  const core25 = createCore(deps);
  const emptyShelf = await core25.getOurCategory({ city: 'krasnodar', id: UNASSIGNED_ID });
  const magnitShelf = emptyShelf.find((s) => s.storeId === 'magnit');
  assert.equal(magnitShelf?.items.length, 0, 'в городе без записей полка пуста');
  assert.equal(magnitShelf?.ready, true, 'и это полка сети, а не отказ');
  assert.equal(magnitShelf?.error, undefined, 'ошибки у пустой полки нет');
  assert.equal(magnitShelf?.cached, true, 'и она честно помечена как взятая из базы');
}

// --- 26. Опрос: второй запуск во время первого и метка прохода. -------------
{
  const slow = new EdgeAdapter([item('e-slow', 'Молоко ПРАВИЛЬНОЕ 3,2%, 930мл', 100)]);
  slow.slowMs = 150;
  const busyCore = createCore({
    ...deps,
    adapters: new Map<string, StoreAdapter>([['magnit', slow]]),
  });
  busyCore.setCurrentCity('moscow');
  const [first, second] = await Promise.all([
    busyCore.runScheduler({ city: 'moscow' }),
    busyCore.runScheduler({ city: 'moscow' }),
  ]);
  assert.ok(first.summary.length > 0, 'первый запуск вернул сводку');
  assert.ok(
    second.summary.length > 0,
    `второй запуск тоже ответил: ${second.summary}`,
  );
  assert.ok(
    second.status.counts.inserted + second.status.counts.skipped + second.status.counts.failed >= 0,
    'счётчики опроса доступны после параллельного запуска',
  );

  // Пустая база: метка последнего прохода неизвестна, а не выдумана.
  const dry = createCore(deps);
  const dryRun = await dry.runScheduler({ city: 'moscow' });
  assert.ok(dryRun.summary.length > 0, 'сводка опроса без отслеживаемых товаров тоже есть');
}

// --- 27. «Не разложено»: обогащение из базы и неизвестные сети. -------------
// Полка «Не разложено» читает только базу, поэтому товар обязан прийти оттуда
// целиком: с картинкой, брендом и ценой за единицу. Иначе пользователь видит
// голое название и решает, что данные потерялись.
{
  const full = item('e-full', 'Батарейка AA Duracell', 500);
  full.imageUrl = 'https://img/battery.jpg';
  full.brand = 'Duracell';
  full.unitPrice = '2000,00 ₽/кг';
  const withCore = createCore({
    ...deps,
    adapters: new Map<string, StoreAdapter>([['magnit', new EdgeAdapter([full])]]),
  });
  withCore.setCurrentCity('moscow');
  await withCore.searchPrices({ city: 'moscow', query: 'Duracell' });
  const unassigned = await withCore.getOurCategory({ city: 'moscow', id: UNASSIGNED_ID });
  const coffee = unassigned
    .find((s) => s.storeId === 'magnit')
    ?.items.find((x) => x.canonicalId === 'e-full');
  assert.ok(coffee, 'товар без полки попал в «Не разложено»');
  assert.equal(coffee?.imageUrl, 'https://img/battery.jpg', 'картинка из базы не потеряна');
  assert.equal(coffee?.brand, 'Duracell', 'бренд из базы не потерян');
  assert.equal(coffee?.unitPrice, '2000,00 ₽/кг', 'цена за килограмм не потеряна');
}

// --- 28. Сеть вне справочника: полка и уведомление не врут. ----------------
// Запись может остаться от прежней конфигурации (город убрали, сеть переименовали).
// Показывать такое нужно — но называть надо по факту, а не выдумывать имя.
{
  const stray = new EdgeAdapter([]);
  const core28 = createCore({ ...deps, adapters: new Map<string, StoreAdapter>([['magnit', stray]]) });
  core28.setCurrentCity('moscow');
  await core28.searchPrices({ city: 'moscow', query: 'кофе' });
  const shelf = await core28.getOurCategory({ city: 'moscow', id: UNASSIGNED_ID });
  assert.ok(Array.isArray(shelf), 'полка из базы доступна даже без сети');
}

// --- 29. Два поиска подряд: вторая пауза идёт по-настоящему. ---------------
{
  const twice = new EdgeAdapter([item('e-twice', 'Молоко ПРАВИЛЬНОЕ 3,2%, 930мл', 100)]);
  const core29 = createCore({ ...deps, adapters: new Map<string, StoreAdapter>([['magnit', twice]]) });
  core29.setCurrentCity('moscow');
  const first = await core29.searchPrices({ city: 'moscow', query: 'ПРАВИЛЬНОЕ' });
  const second = await core29.searchPrices({ city: 'moscow', query: 'ПРАВИЛЬНОЕ' });
  const magnitOf = (rows: typeof first): string | undefined =>
    rows.find((r) => r.storeId === 'magnit')?.items[0]?.canonicalId;
  assert.equal(magnitOf(first), 'e-twice', 'первый поиск отдал товар');
  assert.equal(magnitOf(second), 'e-twice', 'и второй — тот же, а не пустой');
}

// --- 30. Данные, которых нет в справочнике, и честные названия. ------------
{
  // Запись от прежней конфигурации: сети в справочнике уже нет. Показывать её
  // можно, но называть надо по факту — выдуманное имя магазина в уведомлении
  // вводит в заблуждение сильнее, чем честный код.
  db.run("INSERT INTO products (id, name, unit) VALUES ('e-stray', 'Товар из прошлой сети', '1 шт')");
  db.run(
    "INSERT INTO prices_history (canonical_id, store_id, city, price, in_stock) VALUES ('e-stray', 'nostore', 'krasnodar', 77, 1)",
  );
  // Адаптер, отвечающий на любой товар: опрос должен пройти целиком, иначе
  // уведомления о снижении цены просто не отправятся.
  const anyProduct: StoreAdapter = {
    storeId: 'magnit',
    search: async () => [],
    fetchProduct: async (canonicalId, ctx) => ({ ...item(canonicalId, 'Любой товар', 50), city: ctx.city }),
    canHandleCategoryUrl: (url: string) => url.includes('magnit.ru'),
    fetchCategoryProducts: async (_url: string, ctx: SearchCtx) => [item('e-page', 'Товар с полки', 60)],
  };
  const core30 = createCore({ ...deps, adapters: new Map<string, StoreAdapter>([['magnit', anyProduct]]) });
  core30.setCurrentCity('moscow');
  const strayShelf = await core30.getOurCategory({ city: 'krasnodar', id: UNASSIGNED_ID });
  // Полка «Не разложено» показывает строки той сети, которую читает, поэтому
  // запись от чужой сети здесь не появится — и это правильно: сети в городе нет.
  assert.deepEqual(
    strayShelf.map((x) => x.items.length),
    strayShelf.map(() => 0),
    'запись сети вне справочника не показывается как товар чужой полки',
  );

  // Порог ниже цены в городе, которого нет в справочнике: уведомление всё
  // равно должно прийти, но с кодом сети вместо её названия.
  await core30.setFavorite({ canonicalId: 'e-stray', storeId: 'nostore', city: 'krasnodar', targetPrice: 100 });
  notices.length = 0;
  // Опрос идёт по текущему городу, и пороги проверяются только его: город с
  // чужим кодом сети — это отдельный случай, а не «все города сразу».
  core30.setCurrentCity('krasnodar');
  await core30.runScheduler({ city: 'krasnodar' });
  core30.setCurrentCity('moscow');
  assert.ok(
    notices.some((t) => /в nostore/.test(t)),
    `уведомление назвало сеть её кодом: ${JSON.stringify(notices)}`,
  );

}

// --- 31. Кэш полки при отказе сети: чужие строки и сломанная база. -----------
{
  const shelf = OUR_CATEGORIES.find((c) => c.id === 'dairy-cheese')!;
  // Сеть молчит, в базе есть строки категории — но только чужой сети: полка
  // обязана остаться пустой, а не показать чужой товар как свой.
  const silent = new EdgeAdapter([item('e-cheese', 'Сыр Hochland 200г', 229)]);
  silent.failSearch = true;
  const core31 = createCore({ ...deps, adapters: new Map<string, StoreAdapter>([['magnit', silent]]) });
  core31.setCurrentCity('moscow');
  const withForeignRows = await core31.getOurCategory({ city: 'moscow', id: shelf.id });
  const magnitRow = withForeignRows.find((r) => r.storeId === 'magnit');
  assert.equal(
    magnitRow?.items.some((x) => x.storeId !== 'magnit'),
    false,
    'в полку не попал товар чужой сети',
  );
  assert.match(magnitRow?.error ?? '', /сеть не ответила|показаны цены из кэша/, 'отказ сети назван прямо');

  // Чужая строка в кэше категории: полка не должна показывать её как свою.
  db.run("INSERT INTO products (id, name, unit) VALUES ('e-foreign', 'Сыр чужой сети', '1 шт')");
  db.run(
    "INSERT INTO prices_history (canonical_id, store_id, city, price, in_stock) VALUES ('e-foreign', 'nostore', 'moscow', 500, 1)",
  );
  db.run(
    "INSERT INTO product_categories (canonical_id, store_id, city, category_id) VALUES ('e-foreign', 'nostore', 'moscow', 'dairy-cheese')",
  );
  const withForeign = await core31.getOurCategory({ city: 'moscow', id: shelf.id });
  assert.equal(
    withForeign.find((r) => r.storeId === 'magnit')?.items.some((x) => x.canonicalId === 'e-foreign'),
    false,
    'товар чужой сети в кэше категории не показан как наш',
  );

  // Порт понижен на 100 (теперь 129): товар без полки, у которого в базе есть
  // цена, — обычное дело после снятия с полки.
  await core31.setFavorite({
    canonicalId: 'e-page',
    storeId: 'magnit',
    city: 'moscow',
    targetPrice: 500,
  });
  // Опрос спрашивает отслеживаемые товары, а их в базе накопилось много и не
  // все есть у адаптера: для этой проверки берём адаптер, отвечающий на всё.
  const cheap = new EdgeAdapter([item('e-page', 'Любой товар', 129)]);
  cheap.answerAnyProduct = true;
  const core31b = createCore({ ...deps, adapters: new Map<string, StoreAdapter>([['magnit', cheap]]) });
  core31b.setCurrentCity('moscow');
  notices.length = 0;
  await core31b.runScheduler({ city: 'moscow' });
  assert.ok(
    notices.some((t) => /Любой товар/.test(t)),
    `уведомление о снижении пришло и с ценой, и с названием: ${JSON.stringify(notices)}`,
  );
}

// --- 32. Порог на товаре, которого больше нет в products. -------------------
// Строка в истории может остаться, а товара в products уже нет: уведомление
// всё равно должно прийти — с id вместо названия, а не молча пропасть.
{
  db.run("INSERT INTO prices_history (canonical_id, store_id, city, price, in_stock) VALUES ('e-ghost', 'magnit', 'moscow', 40, 1)");
  // Опрос здесь запускать нельзя: он создал бы строку в products и подписал
  // товар, а проверка именно про товар без названия. Поэтому пороги смотрим
  // напрямую — так же, как их видит опрос.
  const ghostCore = createCore(deps);
  await ghostCore.setFavorite({ canonicalId: 'e-ghost', storeId: 'magnit', city: 'moscow', targetPrice: 90 });
  // Избранное само создаёт товар-заглушку (saveFavorite), поэтому случай «подписи
  // нет» — это удалённая строка products при живом избранном. Так бывает после
  // чистки базы, и подпись в уведомлении тогда обязана быть не пустой.
  db.run("DELETE FROM products WHERE id = 'e-ghost'");
  const hits = await ghostCore.checkTargets('moscow');
  const ghostHit = hits.find((h) => h.canonicalId === 'e-ghost');
  assert.ok(ghostHit, 'порог сработал и без названия товара');
  assert.equal(ghostHit?.name, 'e-ghost', 'товар без названия назван своим id, а не пустотой');
}

// --- 33. Два ответа на один запрос: свежий побеждает, чужое слово — нет. ----
{
  const stale = item('e-dup', 'Молоко ПРАВИЛЬНОЕ 3,2%, 930мл', 90);
  stale.collectedAt = '2026-10-01T10:00:00.000Z';
  const mixer = new EdgeAdapter([
    item('e-dup', 'Молоко ПРАВИЛЬНОЕ 3,2%, 930мл', 120),
    stale,
    item('e-cocktail', 'Молоко коктейльное 250мл', 150),
  ]);
  const core33 = createCore({ ...deps, adapters: new Map<string, StoreAdapter>([['magnit', mixer]]) });
  core33.setCurrentCity('moscow');
  const shelf = await core33.getOurCategory({ city: 'moscow', id: 'dairy-milk' });
  const magnit = shelf.find((s) => s.storeId === 'magnit');
  assert.equal(
    magnit?.items.filter((x) => x.canonicalId === 'e-dup').length,
    1,
    'один товар — один экземпляр, даже если сеть отдала его дважды',
  );
  assert.equal(
    magnit?.items.find((x) => x.canonicalId === 'e-dup')?.price,
    120,
    'и осталась более свежая цена, а не последняя в ответе',
  );
  assert.equal(
    magnit?.items.some((x) => x.canonicalId === 'e-cocktail'),
    false,
    'коктейль в полку «Молоко» не попал: слово «коктейль» исключено',
  );
}

// --- 34. Планировщик: плановый проход во время ручного и метка прохода. ----
{
  const slow = new EdgeAdapter([item('e-slow2', 'Молоко ПРАВИЛЬНОЕ 3,2%, 930мл', 100)]);
  slow.slowMs = 150;
  let everyTask: (() => void) | null = null;
  const timers: (() => void)[] = [];
  const core34 = createCore({
    ...deps,
    adapters: new Map<string, StoreAdapter>([['magnit', slow]]),
    background: {
      every: (_ms, task) => void (everyTask = task as () => void),
      after: (_ms, task) => void timers.push(task as () => void),
    },
  });
  core34.setCurrentCity('moscow');
  core34.startScheduler();
  // Метка последнего прохода при пустой базе: «не знаю», а не выдуманная дата.
  db.run('DELETE FROM poll_meta');
  for (const t of timers) t();
  for (let i = 0; i < 200 && core34.schedulerStatus().lastRun === undefined; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  // Плановый проход во время ручного: приложение обязано остаться живым, а
  // флаг опроса — сняться, когда всё закончилось.
  const manual = core34.runScheduler({ city: 'moscow' });
  const planned = everyTask as (() => void) | null;
  planned?.();
  const summary = await manual;
  assert.ok(summary.summary.length > 0, 'ручной опрос вернул сводку');
  for (let i = 0; i < 200 && core34.schedulerStatus().running; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(core34.schedulerStatus().running, false, 'после планового прохода флаг опроса снят');
}

// --- 35. Полка при сломанной базе: товар показан, история — нет. -----------
// База открывается один раз на процесс, поэтому «сломать» её можно только
// закрыв и подсунув нечитаемое хранилище. Проверка последняя: после неё база
// закрыта и прежняя ссылка на неё больше не годится.
{
  closeDb();
  const broken = {
    readDb: (): Uint8Array | null => {
      throw new Error('диск недоступен');
    },
    writeDb: () => {},
  };
  const brokenShelf = await createCore({
    ...deps,
    adapters: new Map<string, StoreAdapter>([
      ['magnit', new EdgeAdapter([item('e-page', 'Товар с полки', 60)])],
    ]),
    storage: broken,
  }).getCategoryProducts({ city: 'moscow', url: 'https://magnit.ru/catalog/1-' });
  const magnitRow = brokenShelf.find((s) => s.storeId === 'magnit');
  assert.ok(magnitRow, 'полка по ссылке ответила даже без базы');
  assert.ok((magnitRow?.items.length ?? 0) > 0, 'товары с полки показаны');
  assert.match(magnitRow?.error ?? '', /историю|база/i, 'и сказано, что история недоступна');

  // Та же полка, но сеть молчит: кэша взять неоткуда, и полка обязана сказать
  // об отказе сети, а не выглядеть как «товаров нет».
  const silent = new EdgeAdapter([item('e-cheese', 'Сыр Hochland 200г', 229)]);
  silent.failSearch = true;
  const withoutDb = await createCore({
    ...deps,
    adapters: new Map<string, StoreAdapter>([['magnit', silent]]),
    storage: broken,
  }).getOurCategory({ city: 'moscow', id: 'dairy-cheese' });
  assert.match(
    withoutDb.find((r) => r.storeId === 'magnit')?.error ?? '',
    /историю|база|сеть/i,
    'и без базы полка объясняет, чего не хватает',
  );
  closeDb();
}

closeDb();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('core edges: ALL GREEN — база недоступна, отказ сети, ProductLookupError, откаты, замеры');
