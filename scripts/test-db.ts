import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildStoreLabels,
  CITIES,
  CITY_STORES,
  networksForCity,
  pointKey,
  pointKeysForCity,
  pointLabel,
  readyStoresForCity,
  resultBlockVisible,
  storeByCode,
  UNKNOWN_POINT_LABEL,
  storeIdsForCity,
  storesForCity,
  uniqueByNetwork,
  unknownPointLabel,
} from '../src/shared/catalog.js';
import type { PointKey } from '../src/shared/catalog.js';
import {
  SCHEMA_VERSION,
  closeDb,
  clearPollChecklist,
  getLastRun,
  getPriceHistory,
  isFavorite,
  latestPrices,
  listCategoryProducts,
  listFavorites,
  listFavoritesAll,
  listTrackedProducts,
  loadPollChecklist,
  markPollChecked,
  openDb,
  persistDb,
  removeFavorite,
  removeSplit,
  saveFavorite,
  saveLastRun,
  saveNotifiedPrices,
  savePriceIfChanged,
  saveProductCategory,
  saveSplit,
  splitPairsFor,
  toPriceInput,
} from '../src/core/db/db.js';
import { groupByProduct, matchSplitKey } from '../src/shared/matching.js';
import type { ScrapedProduct } from '../src/shared/types.js';
import initSqlJs from 'sql.js';
import { fileStorageAt } from '../electron/node-files.js';
import { SCHEMA } from '../src/core/db/schema.js';

// Схема попадает в сборку только через сгенерированный schema.ts. Если
// править schema.sql и забыть npm run gen:schema, приложение соберётся с
// устаревшей схемой, и это должен ронять тест, а не прод.
execFileSync(process.execPath, ['scripts/gen-schema.mjs', '--check'], { stdio: 'pipe' });

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-db-')), 't.db');
// let, а не const: блок проверки миграции закрывает базу и открывает заново.
let db = await openDb(fileStorageAt(file));

const seededStores = (): Map<string, string> => {
  const rows = db.exec(`SELECT id, city, external_store_id FROM stores`)[0]?.values ?? [];
  return new Map(rows.map((r) => [`${String(r[0])}:${String(r[1])}`, String(r[2])]));
};
// Ключ с кодом: одна сеть в городе может иметь несколько точек, и сверять их
// по паре «сеть+город» больше нельзя — вторая точка затёрла бы первую.
const seededPoints = (): Map<string, string> => {
  const rows = db.exec(`SELECT id, city, external_store_id FROM stores`)[0]?.values ?? [];
  return new Map(rows.map((r) => [`${String(r[0])}:${String(r[1])}:${String(r[2])}`, String(r[2])]));
};
// ВСЕ магазины из конфига, включая ready:false: сид в schema.sql тоже держит
// выключенные строки (так же, как Пятёрку вне Москвы), и сверка обязана видеть
// расхождение, если кто-то добавит город в конфиг, но забудет про SQL.
// Готовность магазина проверяется отдельно, см. проверку ready ниже.
const expectedStores = (): Map<string, string> =>
  new Map(
    Object.entries(CITY_STORES).flatMap(([city, stores]) =>
      stores.map((s) => [`${s.storeId}:${city}`, s.externalStoreId]),
    ),
  );
// Тот же справочник, но ключ с кодом точки: по паре «сеть+город» несколько
// точек уже не различить.
const expectedPoints = (): Set<string> =>
  new Set(
    Object.entries(CITY_STORES).flatMap(([city, stores]) =>
      stores.map((s) => `${s.storeId}:${city}:${s.externalStoreId}`),
    ),
  );

const seeded = seededStores();
const expected = expectedStores();
for (const [key, id] of expected) {
  assert.equal(seeded.get(key), id, `stores.external_store_id синхронен с catalog.ts: ${key}`);
}
assert.equal(seeded.size, expected.size, 'в stores нет лишних строк');

// Смена кода в справочнике больше НЕ обновляет строку: код точки входит в
// первичный ключ, поэтому новый код — это новая точка, а старая остаётся со
// своим кодом и своей историей. Иначе кривые двух магазинов склеились бы в одну.
db.run(`UPDATE stores SET external_store_id = 'stale'`);
db.exec(SCHEMA);
const reseeded = seededPoints();
for (const key of expectedPoints()) {
  assert.ok(reseeded.has(key), `повторный seed не затирает точку ${key}`);
  assert.ok(
    reseeded.has(`${key.split(':').slice(0, 2).join(':')}:stale`),
    `старая точка осталась в сиде отдельной строкой: ${key}`,
  );
}

const seededCities = db.exec(`SELECT id FROM cities`)[0]?.values.map((r) => String(r[0])) ?? [];
for (const c of CITIES) {
  assert.ok(seededCities.includes(c.id), `город засеян: ${c.id}`);
  assert.ok(storesForCity(c.id).length > 0, `у города есть магазины: ${c.id}`);
}
assert.equal(seededCities.length, CITIES.length, 'в cities нет лишних строк');

// Код точки уникален внутри пары (сеть, город). Это опора фазы 6: две записи с
// одинаковым кодом — это одна и та же точка, записанная дважды, и цены такой
// пары склеились бы в одну линию, как будто точек две, а на самом деле одна.
// Проверка ловит ошибку в справочнике, а не в базе.
for (const [city, stores] of Object.entries(CITY_STORES)) {
  const codes = stores.map((s) => `${s.storeId}:${s.externalStoreId}`);
  const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
  assert.deepEqual(
    dupes,
    [],
    `в городе ${city} повторяется код точки: ${[...new Set(dupes)].join(', ')}`,
  );
  const names = new Set(stores.map((s) => `${s.storeId}:${s.name}`));
  assert.equal(
    names.size,
    stores.length,
    `у точек одной сети в городе ${city} разные имена — иначе в UI они неразличимы`,
  );
  // storeByCode обязан находить каждую точку и не путать точки разных сетей,
  // даже если коды у них совпадают.
  for (const s of stores) {
    assert.equal(
      storeByCode(s.storeId, city, s.externalStoreId)?.externalStoreId,
      s.externalStoreId,
      `storeByCode находит точку ${s.storeId}:${s.externalStoreId} в городе ${city}`,
    );
  }
  assert.deepEqual(
    storeIdsForCity(city),
    [...new Set(stores.map((s) => s.storeId))],
    'сети города перечислены без повторов',
  );
  // Сетевой уровень: по одной записи на сеть, и это первая точка. Renderer вне
  // покрытия, поэтому проверяем здесь — иначе функция осталась бы непроверенной
  // до появления второй точки, где она как раз и нужна.
  assert.deepEqual(
    networksForCity(city).map((s) => s.storeId),
    [...new Set(stores.map((s) => s.storeId))],
    `networksForCity даёт по одной записи на сеть в городе ${city}`,
  );
  for (const n of networksForCity(city)) {
    assert.equal(
      n.externalStoreId,
      stores.find((s) => s.storeId === n.storeId)?.externalStoreId,
      `networksForCity берёт ПЕРВУЮ точку сети ${n.storeId} в городе ${city}`,
    );
  }
}

// Синтетическая пара точек одной сети — настоящий случай шага 3, которого в
// справочнике пока нет (второй точки СПб у нас нет). Проверяем правило прямо на нём.
{
  const city = 'moscow';
  const saved = [...(CITY_STORES[city] ?? [])];
CITY_STORES[city] = [
    { storeId: 'magnit' as const, name: 'Магнит, Пушкинская', externalStoreId: '990901', ready: true },
    { storeId: 'magnit' as const, name: 'Магнит, Невский', externalStoreId: '990902', ready: true },
    { storeId: 'lenta' as const, name: 'Лента, тестовая', externalStoreId: '9999', ready: false },
  ];
  try {
    const labels = buildStoreLabels();
    // Плашка прогресса ищет подпись по «сеть + код». Словарь, собранный по
    // networksForCity, вторую точку сети не содержал бы вовсе — и подпись двух
    // разных точек была бы одинаковой, то есть плашка врала бы ровно там,
    // ради чего поточечная поддержка и заводилась.
    assert.equal(labels.byPoint['magnit:990901'], 'Магнит, Пушкинская', 'подпись первой точки есть');
    assert.equal(labels.byPoint['magnit:990902'], 'Магнит, Невский', 'и второй точки тоже — по коду, а не по сети');
    assert.equal(labels.byPoint['lenta:9999'], 'Лента, тестовая', 'у другой сети своя точка со своим ключом');
    // Подпись сети — одна запись на сеть, и берётся она из первого города
    // списка: проверка не зависит от порядка ключей объекта справочника.
    assert.equal(
      labels.byStore['magnit'],
      networksForCity(CITIES[0]!.id)[0]?.name,
      'подпись сети берётся из первой точки первого города списка',
    );

    // Ключи точек города — то, чем помечаются галочки в шапке и что приходит в
    // ядро как «выбранные магазины». Сеть с двумя точками даёт два ключа: одна
    // галочка означала бы, что вторую точку нельзя снять отдельно.
    assert.deepEqual(
      pointKeysForCity(city),
      ['magnit:990901', 'magnit:990902', 'lenta:9999'],
      'ключи точек города — по одной на точку',
    );
    assert.deepEqual(
      pointKeysForCity(city, true),
      ['magnit:990901', 'magnit:990902'],
      'в отбор галочек попадают только готовые точки',
    );

    // Адрес хранится БЕЗ города: город стоит в шапке приложения, и «Москва,
    // ул. Саянская» рядом с «Москва» в заголовке читается как сбой вёрстки.
    for (const s of storesForCity(city)) {
      assert.ok(
        s.address === undefined || !/Москва|Санкт-Петербург|Питер|Казань/.test(s.address),
        `адрес точки ${s.externalStoreId} без города: ${s.address ?? ''}`,
      );
    }

    // Подпись точки: адрес из сети, когда сеть его отдала, иначе имя точки.
    assert.equal(
      pointLabel({ ...CITY_STORES[city]![0]!, address: 'ул. Саянская, 11Б' }),
      'Магнит, Пушкинская — ул. Саянская, 11Б',
      'подпись единая: имя точки, потом адрес из сети',
    );
    assert.equal(
      pointLabel(CITY_STORES[city]![2]!),
      'Лента, тестовая',
      'у точки без адреса подпись — одно имя, без пустого хвоста',
    );
  } finally {
    CITY_STORES[city] = saved;
  }
  const twoPoints = [
    { storeId: 'magnit' as const, name: 'Магнит, Пушкинская', externalStoreId: '990901', ready: true },
    { storeId: 'magnit' as const, name: 'Магнит, Невский', externalStoreId: '990902', ready: true },
    { storeId: 'lenta' as const, name: 'Лента', externalStoreId: '3311', ready: true },
  ];
  assert.deepEqual(
    uniqueByNetwork(twoPoints).map((s) => s.externalStoreId),
    ['990901', '3311'],
    'две точки одной сети схлопываются в одну, и берётся первая',
  );
  // Первая точка не готова, вторая готова: сетевой список обязан показать
  // готовую, иначе UI напишет «(скоро)» про сеть, которую опрос всё равно ходит.
  assert.deepEqual(
    uniqueByNetwork([
      { storeId: 'svetofor' as const, name: 'Светофор А', externalStoreId: '1', ready: false },
      { storeId: 'svetofor' as const, name: 'Светофор Б', externalStoreId: '2', ready: true },
    ])[0]?.externalStoreId,
    '2',
    'готовая точка приоритетнее неготовой',
  );
  assert.equal(
    storeByCode('magnit', 'moscow', '501478'),
    undefined,
    'чужой код точки в этом городе не находится — код привязан к городу',
  );
}

// Фильтры каталога не должны превратиться в no-op: иначе все проверки выше
// проходили бы на «все точки одного города». Проверяем на настоящих данных.
{
  const moscowMagnit = storesForCity('moscow', 'magnit');
  assert.ok(moscowMagnit.length >= 1, 'у Магнита в Москве есть точка');
  assert.ok(
    moscowMagnit.every((s) => s.storeId === 'magnit'),
    'storesForCity сужает по сети, а не отдаёт весь город',
  );
  assert.ok(
    storesForCity('moscow').length > moscowMagnit.length,
    'город без фильтра содержит и другие сети',
  );
  // Пятёрка вне Москвы не готова — это реальная запись с ready: false.
  assert.ok(
    readyStoresForCity('saint-petersburg').every((s) => s.ready),
    'readyStoresForCity отдаёт только готовые точки',
  );
  assert.ok(
    readyStoresForCity('saint-petersburg').every((s) => s.storeId !== 'pyaterochka'),
    'неготовая Пятёрка СПб не попадает в список готовых',
  );
  assert.ok(
    readyStoresForCity('saint-petersburg').length < storesForCity('saint-petersburg').length,
    'в СПб есть неготовые точки — фильтр по ready что-то отбрасывает',
  );
}
const base = {
  canonicalId: 'magnit-1',
  storeId: 'magnit',
  city: 'moscow',
  storeCode: 'TEST',
  name: 'Молоко',
  price: 100,
};

assert.equal(savePriceIfChanged(db, base), 'inserted');
assert.equal(savePriceIfChanged(db, base), 'skipped');
assert.equal(savePriceIfChanged(db, { ...base, price: 100 }), 'skipped');
assert.equal(savePriceIfChanged(db, { ...base, price: 120 }), 'inserted');
assert.equal(savePriceIfChanged(db, { ...base, price: 120, promoPrice: 110 }), 'inserted');
assert.equal(savePriceIfChanged(db, { ...base, price: 120, promoPrice: 110 }), 'skipped');
assert.equal(savePriceIfChanged(db, { ...base, price: 120, promoPrice: 110, oldPrice: 150 }), 'inserted');
assert.equal(savePriceIfChanged(db, { ...base, price: 120, promoPrice: 110, oldPrice: 150 }), 'skipped');
assert.equal(savePriceIfChanged(db, { ...base, price: 120, promoPrice: 110, oldPrice: 150, inStock: false }), 'inserted');

const rows = db.exec('SELECT COUNT(*) AS n FROM prices_history')[0]?.values[0];
assert.equal(rows?.[0], 5);

const lastPrices = (id: string): { promo: number | null; old: number | null } => {
  const v = db.exec(
    `SELECT promo_price, old_price FROM prices_history
     WHERE canonical_id = ? ORDER BY id DESC LIMIT 1`,
    [id],
  )[0]?.values[0] ?? [];
  const asNumber = (x: unknown): number | null => (x === null || x === undefined ? null : Number(x));
  return { promo: asNumber(v[0]), old: asNumber(v[1]) };
};

// oldPrice undefined = «путь скидку не отдаёт» (fetchProduct у Магнита):
// прежнее значение сохраняется, но только для той же цены. null = «скидки
// нет, наблюдал» — пишется как есть. Наследованное перепроверяется против
// новой цены, иначе конец акции остался бы в истории навсегда.
const blind = { ...base, canonicalId: 'magnit-blind' };
assert.equal(
  savePriceIfChanged(db, { ...blind, price: 200, oldPrice: 260 }),
  'inserted',
  'запись с зачёркнутой ценой',
);
assert.equal(
  savePriceIfChanged(db, { ...blind, price: 200, oldPrice: undefined }),
  'skipped',
  'путь без скидки не плодит строки',
);
assert.equal(lastPrices('magnit-blind').old, 260, 'старая цена сохранилась');
assert.equal(
  savePriceIfChanged(db, { ...blind, price: 340, oldPrice: undefined }),
  'inserted',
  'цена выросла до обычной — конец акции',
);
assert.equal(lastPrices('magnit-blind').old, null, 'наследованная скидка не пережила рост цены');

const sale = { ...base, canonicalId: '5ka-sale' };
assert.equal(
  savePriceIfChanged(db, { ...sale, price: 219.99, promoPrice: 179.99, oldPrice: null }),
  'inserted',
  'акция 5ka: цена со скидкой',
);
assert.equal(lastPrices('5ka-sale').promo, 179.99, 'скидка записана');
assert.equal(
  savePriceIfChanged(db, { ...sale, price: 219.99, promoPrice: null, oldPrice: null }),
  'inserted',
  'скидка снята ПРИ ТОЙ ЖЕ цене — наблюдающий путь обязан записать null',
);
assert.equal(lastPrices('5ka-sale').promo, null, 'фальш-скидки в истории не осталось');

// Наследование скидки имеет смысл только для той же цены: сменилась цена —
// прежнее наблюдение о скидке к ней отношения не имеет.
assert.equal(
  savePriceIfChanged(db, { ...blind, price: 500, oldPrice: undefined }),
  'inserted',
  'смена цены без скидки',
);
assert.equal(lastPrices('magnit-blind').old, null, 'прежняя зачёркнутая не наследуется на новую цену');

  const total = db.exec('SELECT COUNT(*) AS n FROM prices_history')[0]?.values[0];
  assert.equal(total?.[0], 10);

  // Цена за единицу обязана доезжать до полки: она пишется в prices_history, но
  // если её не выбрать в SELECT, в UI её не видно НИ НА ОДНОЙ полке из базы, и
  // товар выглядит дешевле, чем стоит на самом деле.
  const unitProduct = {
    canonicalId: 'unit-price-1',
    storeId: 'magnit' as const,
    city: 'moscow',
    storeCode: 'TEST',
    name: 'Молоко 3,2%, 930мл',
    price: 119,
    unitPrice: '128.00 ₽/л',
    collectedAt: new Date().toISOString(),
  };
  assert.equal(savePriceIfChanged(db, toPriceInput(unitProduct)), 'inserted');
  saveProductCategory(db, [
    {
      canonicalId: 'unit-price-1',
      storeId: 'magnit',
      city: 'moscow',
      storeCode: 'TEST',
      categoryId: 'dairy-milk',
    },
  ]);
  const onShelf = listCategoryProducts(db, { city: 'moscow', categoryId: 'dairy-milk' });
  assert.equal(onShelf[0]?.unitPrice, '128.00 ₽/л', 'полка отдаёт цену за единицу');

  // Опросу нужно название товара: адаптер Ленты ищет товар поиском по названию,
  // потому что карточка по id закрыта WAF. JOIN обязан быть LEFT — иначе цели
  // без строки в products молча выпали бы из опроса вместе с историей.
  db.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price, collected_at)
     VALUES ('без-товара', 'magnit', 'moscow', 'TEST', 10, datetime('now'))`,
  );
  const tracked = listTrackedProducts(db);
  assert.equal(
    tracked.find((t) => t.canonicalId === 'unit-price-1')?.name,
    'Молоко 3,2%, 930мл',
    'цель опроса отдаёт название',
  );
  const withoutProduct = tracked.find((t) => t.canonicalId === 'без-товара');
  assert.ok(withoutProduct, 'цель без строки в products не потерялась (LEFT JOIN)');
  assert.equal(withoutProduct?.name, '', 'нет названия — пустая строка, а не null/undefined');

  // Товар в двух точках одной сети — это ДВЕ цели опроса, у каждой свой код
  // точки. Одна цель на пару «товар + сеть + город» опрашивала бы только одну
  // точку, и цена второй вечно оставалась бы старой.
  db.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price, collected_at)
     VALUES ('две-точки', 'magnit', 'moscow', 'MK1', 11, datetime('now')),
            ('две-точки', 'magnit', 'moscow', 'MK2', 12, datetime('now'))`,
  );
  const twoPoints = listTrackedProducts(db).filter((t) => t.canonicalId === 'две-точки');
  assert.equal(twoPoints.length, 2, 'две точки одной сети дают две цели опроса');
  assert.deepEqual(
    twoPoints.map((t) => t.storeCode).sort(),
    ['MK1', 'MK2'],
    'и у каждой цели свой код точки',
  );
  assert.equal(
    listTrackedProducts(db).filter((t) => t.canonicalId === 'без-товара').length,
    1,
    'JOIN с products не задваивает цель: products.id — первичный ключ',
  );

  // Цена за единицу наследуется, когда путь не отдаёт её: у Магнита поиск
  // снимает «106,45 ₽/л» из DOM, а fetchProduct (JSON-LD) не отдаёт. Без
  // наследования первый же опрос затирал бы аннотацию, и полка из базы
  // показывала бы «250 ₽/л» как «250 ₽» за упаковку.
  assert.equal(
    savePriceIfChanged(db, toPriceInput({ ...unitProduct, price: 119 })),
    'skipped',
    'цена та же, всё то же — без записи',
  );
  // Ключ unitPrice именно УБРАН, а не равен undefined: так его отдаёт путь,
  // который цены за единицу не знает (fetchProduct Магнита).
  const { unitPrice: _dropped, ...withoutUnit } = unitProduct;
  assert.equal(
    savePriceIfChanged(
      db,
      toPriceInput({ ...withoutUnit, collectedAt: new Date().toISOString() }),
    ),
    'skipped',
    'опрос без unitPrice не стирает аннотацию, найденную поиском',
  );
  assert.equal(
    db.exec(
      `SELECT unit_price AS u FROM prices_history
       WHERE canonical_id = 'unit-price-1' ORDER BY id DESC LIMIT 1`,
    )[0]?.values[0]?.[0] ?? null,
    '128.00 ₽/л',
    'в истории цена за единицу сохранилась',
  );
  // А вот смена цены за килограмм при той же цене фасовки — уже новая запись.
  assert.equal(
    savePriceIfChanged(
      db,
      toPriceInput({ ...unitProduct, unitPrice: '130.00 ₽/л', collectedAt: new Date().toISOString() }),
    ),
    'inserted',
    'изменилась цена за единицу при той же цене — это изменение',
  );

  // --- Избранное ----------------------------------------------------------
// Ключ включает магазин и город: одна и та же цена в двух сетях — две отметки.
{
  const scope = { canonicalId: 'fav-1', storeId: 'magnit', city: 'moscow', storeCode: 'TEST' };
  savePriceIfChanged(
    db,
    toPriceInput({
      canonicalId: 'fav-1',
      storeId: 'magnit',
      city: 'moscow',
      storeCode: 'TEST',
      name: 'Молоко Домик в деревне 930мл',
      price: 119.99,
      inStock: true,
      collectedAt: new Date().toISOString(),
    }),
  );
  assert.equal(isFavorite(db, scope), false, 'избранного изначально нет');
  saveFavorite(db, scope, 100);
  assert.equal(isFavorite(db, scope), true, 'отметка поставилась');

  const favs = listFavorites(db, 'moscow');
  const mine = favs.find((f) => f.canonicalId === 'fav-1');
  assert.equal(mine?.targetPrice, 100, 'целевая цена сохранилась');
  assert.equal(mine?.storeId, 'magnit', 'магазин в отметке тот же');

  // Тот же товар в другом городе — ДРУГАЯ отметка.
  assert.equal(
    isFavorite(db, { canonicalId: 'fav-1', storeId: 'magnit', city: 'ulyanovsk', storeCode: 'TEST' }),
    false,
    'отметка не протекает на другой город',
  );
  // И другой магазин тоже.
  assert.equal(
    isFavorite(db, { canonicalId: 'fav-1', storeId: 'lenta', city: 'moscow', storeCode: 'TEST' }),
    false,
    'отметка не протекает на другую сеть',
  );
  assert.equal(
    listFavorites(db, 'ulyanovsk').length,
    0,
    'в чужом городе избранное пустое',
  );

  // Повторная отметка меняет порог, а не плодит строки.
  saveFavorite(db, scope, 90);
  // Повторный порог не должен забыть, о чём уже сообщали: иначе цена, по
  // которой уведомили, снова дала бы уведомление после смены цели.
  assert.equal(
    listFavorites(db, 'moscow').find((f) => f.canonicalId === 'fav-1')?.notifiedPrice,
    null,
    'до уведомлений метка пустая',
  );
  assert.equal(listFavorites(db, 'moscow').filter((f) => f.canonicalId === 'fav-1').length, 1, 'строка одна');
  assert.equal(
    listFavorites(db, 'moscow').find((f) => f.canonicalId === 'fav-1')?.targetPrice,
    90,
    'порог обновился',
  );

  removeFavorite(db, scope);
  assert.equal(isFavorite(db, scope), false, 'снятие отметки работает');

  // Метка уведомления: сообщить надо один раз про ту же цену.
  saveFavorite(db, scope, 100);
  saveNotifiedPrices(db, [{ ...scope, price: 95 }]);
  assert.equal(
    listFavorites(db, 'moscow').find((f) => f.canonicalId === 'fav-1')?.notifiedPrice,
    95,
    'цена уведомления запомнилась',
  );
  saveNotifiedPrices(db, [{ ...scope, price: 80 }]);
  assert.equal(
    listFavorites(db, 'moscow').find((f) => f.canonicalId === 'fav-1')?.notifiedPrice,
    80,
    'новое снижение перезаписало метку',
  );
  // Избранное всех городов: вариант с пустым городом молча вернул бы пусто, и
  // уведомления не сработали бы никогда.
  const all = listFavoritesAll(db);
  assert.ok(all.length >= 1, 'выборка без города не пустая');
  assert.ok(
    all.every((f) => typeof f.city === 'string' && f.city.length > 0),
    'в выборке нет безгородных строк',
  );

  // Отметка раньше первого замера: строки products ещё нет, а внешний ключ
  // favorites → products включён. Без INSERT в saveFavorite звёздочка падала
  // с сырым «FOREIGN KEY constraint failed».
  const fresh = { canonicalId: 'fav-fresh', storeId: 'lenta', city: 'ulyanovsk', storeCode: 'TEST' };
  assert.equal(
    db.exec("SELECT COUNT(*) FROM products WHERE id = 'fav-fresh'")[0]?.values[0]?.[0],
    0,
    'товара ещё нет в products',
  );
  saveFavorite(db, fresh, 50);
  assert.equal(isFavorite(db, fresh), true, 'отметка без предварительного замера работает');
  assert.equal(
    db.exec("SELECT COUNT(*) FROM products WHERE id = 'fav-fresh'")[0]?.values[0]?.[0],
    1,
    'saveFavorite завёл строку товара',
  );
  // Настоящий замер перезаписывает имя-заглушку.
  savePriceIfChanged(
    db,
    toPriceInput({
      canonicalId: 'fav-fresh',
      storeId: 'lenta',
      city: 'ulyanovsk',
      storeCode: 'TEST',
      name: 'Кефир Простоквашино 900г',
      price: 89.9,
      inStock: true,
      collectedAt: new Date().toISOString(),
    }),
  );
  assert.equal(
    db.exec("SELECT name FROM products WHERE id = 'fav-fresh'")[0]?.values[0]?.[0],
    'Кефир Простоквашино 900г',
    'замер переписал имя-заглушку',
  );
  removeFavorite(db, fresh);
}
// --- Метка времени опроса ----------------------------------------------
// Ответ на вопрос «запустил опрос, перезашёл — он снова опросил?». Метка
// обязана лежать в БД: у portable-версии каждый запуск это новый процесс, и
// хранение в памяти её всегда теряло.
{
  assert.equal(getLastRun(db, 'moscow'), null, 'метки до первого опроса нет');
  saveLastRun(db, 'moscow', '2026-10-01T10:00:00.000Z');
  assert.equal(getLastRun(db, 'moscow'), '2026-10-01T10:00:00.000Z', 'метка сохранена');
  assert.equal(getLastRun(db, 'ulyanovsk'), null, 'метка города не протекает на другой');
  saveLastRun(db, 'moscow', '2026-10-01T16:00:00.000Z');
  assert.equal(
    getLastRun(db, 'moscow'),
    '2026-10-01T16:00:00.000Z',
    'повторный опрос обновляет метку, а не плодит строки',
  );
  assert.equal(
    db.exec("SELECT COUNT(*) FROM poll_meta WHERE city = 'moscow'")[0]?.values[0]?.[0],
    1,
    'строка на город одна',
  );
}

// --- Цена для порога: последняя, а не первая -----------------------------
// getPriceHistory отдаёт ПЕРВЫЕ N строк по возрастанию времени, поэтому
// «последняя из них» на длинной истории — это цена из прошлого. Уведомление о
// снижении пришло бы по несуществующей цене, а реальное снижение пропустилось
// бы. Здесь 505 записей и настоящая последняя цена 604.
{
  const many = {
    canonicalId: 'hist-many',
    storeId: 'magnit',
    city: 'moscow',
    storeCode: 'TEST',
    name: 'Долгий товар',
    inStock: true,
    promoPrice: null,
    oldPrice: null,
    url: '',
  };
  for (let i = 100; i < 605; i += 1) {
    savePriceIfChanged(
      db,
      toPriceInput({ ...many, price: i, collectedAt: new Date(2026, 0, 1, 0, 0, i).toISOString() } as ScrapedProduct),
    );
  }
const history = getPriceHistory(db, { canonicalId: 'hist-many', storeId: 'magnit', city: 'moscow', storeCode: 'TEST', limit: 500 });
assert.equal(history.length, 500, 'getPriceHistory отдаёт первые 500 записей');
assert.notEqual(
  history[499]?.price,
  604,
  'последняя из первых 500 НЕ настоящая последняя цена — ровно тот дефект, который чинит latestPrices',
);
  const latest = latestPrices(db, [{ canonicalId: 'hist-many', storeId: 'magnit', city: 'moscow', storeCode: 'TEST' }]);
  assert.equal(
    latest.get('magnit:hist-many:moscow:TEST')?.price,
    604,
    'latestPrices берёт настоящую последнюю цену, а не из середины истории',
  );
  assert.equal(
    latestPrices(db, [{ canonicalId: 'нет-такого', storeId: 'magnit', city: 'moscow', storeCode: 'TEST' }]).size,
    0,
    'по неизвестному ключу пусто, а не ошибка',
  );
}

// --- Миграция со старой схемы -------------------------------------------
// favorites раньше имела PK только по canonical_id. CREATE TABLE IF NOT EXISTS
// такую таблицу не трогает, а следующая строка схемы (CREATE INDEX ... (city,
// store_id)) на ней падала — то есть openDb ронял весь запуск у того, кто
// уже открывал приложение. Здесь собираем ровно ту старую форму.
{
  const legacyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-legacy-')), 'legacy.db');
  const SQL = await initSqlJs();
  const legacy = new SQL.Database();
  // updated_at нужен saveFavorite: он делает INSERT OR IGNORE в products.
  // Старая схема в приложении тоже была с этим столбцом — расходится только
  // форма favorites.
  legacy.run(
    'CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime(\'now\')))',
  );
  legacy.run(
    `CREATE TABLE favorites (
       canonical_id TEXT PRIMARY KEY REFERENCES products(id),
       target_price REAL,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  legacy.run("INSERT INTO products (id, name, unit) VALUES ('old-1', 'Молоко старое', '930мл')");
  legacy.run("INSERT INTO favorites (canonical_id, target_price) VALUES ('old-1', 77)");
  fs.writeFileSync(legacyFile, Buffer.from(legacy.export()));
  legacy.close();

  closeDb();
  const migrated = await openDb(fileStorageAt(legacyFile));
assert.equal(
Number(migrated.exec('PRAGMA user_version')[0]?.values[0]?.[0] ?? 0) >= 1,
true,
'БД переведена на актуальную версию схемы',
);
  assert.equal(
    migrated.exec('SELECT COUNT(*) FROM favorites')[0]?.values[0]?.[0],
    1,
    'старая отметка не потеряна при миграции',
  );
  // Порог сохранился, а ключ стал полным — дальше отметка работает как обычно.
  assert.equal(
    Number(migrated.exec('SELECT target_price FROM favorites WHERE canonical_id = \'old-1\'')[0]?.values[0]?.[0] ?? 0),
    77,
    'порог перенесён',
  );
  saveFavorite(migrated, { canonicalId: 'old-1', storeId: 'magnit', city: 'moscow', storeCode: 'TEST' }, 60);
  assert.equal(
    migrated.exec("SELECT COUNT(*) FROM favorites WHERE store_id = 'magnit'")[0]?.values[0]?.[0],
    1,
    'saveFavorite работает на миграционной базе (было бы ON CONFLICT mismatch)',
  );
  closeDb();
  // Дальнейшие блоки работают с обычной базой. persistDb здесь обязателен:
  // без него файл остался бы в том виде, где таблицы переименованы, и
  // следующий openDb упал бы на «table favorites_legacy_v0».
  db = await openDb(fileStorageAt(file));
}

// --- Миграция: форма важнее номера версии ------------------------------
// Регрессия на реальный сценарий. Прошлая миграция чинила favorites только
// внутри ветки `version < 1`, а метку ставила сразу на SCHEMA_VERSION. База с
// user_version = 1 и старой формой favorites получала метку 2 и оставалась в
// старой форме навсегда: CREATE TABLE IF NOT EXISTS такую таблицу не чинит, а
// обращение к favorites.city или notified_price падает на «no such column».
// Ниже — ровно эта база и три соседние формы.
const LEGACY_SHAPES: readonly { name: string; stamp: number; ddl: string }[] = [
  {
    name: 'старая форма + user_version = 2',
    stamp: 2,
    ddl:
      "canonical_id TEXT PRIMARY KEY REFERENCES products(id), target_price REAL, " +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))",
  },
  {
    name: 'старая форма + user_version = 1',
    stamp: 1,
    ddl:
      "canonical_id TEXT PRIMARY KEY REFERENCES products(id), target_price REAL, " +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))",
  },
  {
    name: 'колонки на месте, ключ только canonical_id',
    stamp: 0,
    ddl:
      "canonical_id TEXT PRIMARY KEY REFERENCES products(id), target_price REAL, " +
      "store_id TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', " +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))",
  },
  {
    name: 'составной ключ, нет notified_price',
    stamp: 0,
    ddl:
      "canonical_id TEXT NOT NULL REFERENCES products(id), target_price REAL, " +
      "store_id TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', " +
      "created_at TEXT NOT NULL DEFAULT (datetime('now')), " +
      "PRIMARY KEY (canonical_id, store_id, city)",
  },
];

for (const shape of LEGACY_SHAPES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-shape-'));
  const shapeFile = path.join(dir, 'shape.db');
  const SQL = await initSqlJs();
  const legacy = new SQL.Database();
  legacy.run(
    "CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL, " +
      "updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  legacy.run(`CREATE TABLE favorites (${shape.ddl})`);
  legacy.run("INSERT INTO products (id, name, unit) VALUES ('old-1', 'Молоко старое', '930мл')");
  legacy.run("INSERT INTO favorites (canonical_id, target_price) VALUES ('old-1', 77)");
  legacy.run(`PRAGMA user_version = ${shape.stamp}`);
  fs.writeFileSync(shapeFile, Buffer.from(legacy.export()));
  legacy.close();

  closeDb();
  const fixed = await openDb(fileStorageAt(shapeFile));

  const info = fixed.exec('PRAGMA table_info(favorites)')[0]?.values ?? [];
  const cols = info.map((r) => String(r[1]));
  for (const need of ['store_id', 'city', 'notified_price', 'target_price']) {
    assert.ok(cols.includes(need), `[${shape.name}] нет колонки ${need}: ${cols.join(', ')}`);
  }
  const pk = info
    .filter((r) => Number(r[5]) > 0)
    .map((r) => String(r[1]))
    .sort();
  assert.deepEqual(
    pk,
    ['canonical_id', 'city', 'store_code', 'store_id'],
    `[${shape.name}] ключ favorites не четырёхчастный`,
  );
  assert.equal(
    fixed.exec('SELECT COUNT(*) FROM favorites')[0]?.values[0]?.[0],
    1,
    `[${shape.name}] отметка потеряна при миграции`,
  );
  assert.equal(
    String(fixed.exec("SELECT store_code FROM favorites WHERE canonical_id = 'old-1'")[0]?.values[0]?.[0] ?? ''),
    '?',
    `[${shape.name}] перенесённая отметка помечена как «любая точка сети»`,
  );
  assert.equal(
    Number(fixed.exec("SELECT target_price FROM favorites WHERE canonical_id = 'old-1'")[0]?.values[0]?.[0] ?? 0),
    77,
    `[${shape.name}] порог не перенесён`,
  );
  // Реальная запись избранного на такой базе: раньше падала на отсутствии
  // колонки или на несовпадении ключа.
  saveFavorite(fixed, { canonicalId: 'old-1', storeId: 'magnit', city: 'moscow', storeCode: 'TEST' }, 60);
  assert.equal(
    fixed.exec("SELECT COUNT(*) FROM favorites WHERE store_id = 'magnit' AND city = 'moscow'")[0]
      ?.values[0]?.[0],
    1,
    `[${shape.name}] saveFavorite не работает после миграции`,
  );
  assert.equal(
    Number(fixed.exec('PRAGMA user_version')[0]?.values[0]?.[0] ?? 0),
    SCHEMA_VERSION,
    `[${shape.name}] версия схемы не отмечена`,
  );

  // Идемпотентность: повторный запуск на уже правильной базе ничего не ломает.
  const colsBefore = cols.length;
  persistDb(fixed);
  closeDb();
  const again = await openDb(fileStorageAt(shapeFile));
  assert.equal(
    again.exec('PRAGMA table_info(favorites)')[0]?.values.length,
    colsBefore,
    `[${shape.name}] повторный openDb меняет форму таблицы`,
  );
  assert.equal(
    again.exec('SELECT COUNT(*) FROM favorites')[0]?.values[0]?.[0],
    2,
    `[${shape.name}] повторный openDb теряет отметки`,
  );
  persistDb(again);
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
}
// Цикл закрывал базу, а дальше файл работает с рабочей — открываем её обратно,
// иначе остальные блоки падают на «Database closed».
db = await openDb(fileStorageAt(file));


// --- Ручной разрыв склейки ----------------------------------------------
{
  const a = 'split-a';
  const b = 'split-b';
  for (const [id, storeId, city] of [
    [a, 'magnit', 'moscow'],
    [b, 'pyaterochka', 'moscow'],
  ] as const) {
    savePriceIfChanged(
      db,
      toPriceInput({
        canonicalId: id,
        storeId,
        city,
        storeCode: 'TEST',
        name: 'Сыр сливочный 200г',
        price: 100,
        inStock: true,
        collectedAt: new Date().toISOString(),
      }),
    );
  }
  // promoPrice и oldPrice обязательны: без них объект не ScrapedProduct, и тест
  // молча проверял бы groupByProduct на другом типе.
  const mk = (canonicalId: string, storeId: ScrapedProduct['storeId']): ScrapedProduct => ({
    canonicalId,
    storeId,
    city: 'moscow',
    storeCode: 'TEST',
    name: 'Сыр сливочный 200г',
    price: 100,
    promoPrice: null,
    oldPrice: null,
    inStock: true,
    unit: '200г',
    url: 'u',
    collectedAt: new Date().toISOString(),
  });
  // Без разрыва склейка есть — товары одинаковые.
  assert.equal(groupByProduct([mk(a, 'magnit'), mk(b, 'pyaterochka')]).length, 1, 'без разрыва один товар');

  saveSplit(db, b, a);
  assert.ok(
    splitPairsFor(db, [a, b]).has(matchSplitKey(a, b)),
    'пара записана в БД и читается по ключу в любом порядке',
  );

  const grouped = groupByProduct([mk(a, 'magnit'), mk(b, 'pyaterochka')], splitPairsFor(db, [a, b]));
  assert.equal(grouped.length, 2, 'с разрывом это два товара');

  // Порядок аргументов не важен: (b,a) и (a,b) — одна и та же строка.
  saveSplit(db, a, b);
  assert.equal(
    db.exec('SELECT COUNT(*) FROM product_splits')[0]?.values[0]?.[0],
    1,
    'повторная отметка в обратном порядке не создаёт второй строки',
  );

  removeSplit(db, a, b);
  assert.equal(splitPairsFor(db, [a, b]).size, 0, 'снятие разрыва работает');
  assert.equal(
    groupByProduct([mk(a, 'magnit'), mk(b, 'pyaterochka')]).length,
    1,
    'без разрыва снова один товар',
  );

  // Разрыв пары, которых нет в выдаче, не должен попадать в выборку.
  saveSplit(db, 'нет-тут-1', 'нет-тут-2');
  assert.equal(splitPairsFor(db, [a]).size, 0, 'чужая пара не грузится в выдачу');
}

// Пустые аргументы: без раннего выхода они превратились бы в запрос с
// невалидным IN () или в лишнюю транзакцию на ровно ноль строк.
assert.equal(saveNotifiedPrices(db, []), undefined, 'пустой список отметок — без транзакции');
assert.equal(splitPairsFor(db, []).size, 0, 'пустой список id — пустой набор разрывов');
assert.equal(latestPrices(db, []).size, 0, 'пустой список ключей — пустая карта');
assert.equal(
  splitPairsFor(db, [undefined as unknown as string]).size,
  0,
  'непринимаемый id не роняет выборку разрывов',
);

// Ключ, который SQLite не умеет привязать, обязан быть пропущен, а не уронить
// весь запрос: одна битая запись в разметке не должна убирать цены у остальных.
savePriceIfChanged(db, { canonicalId: 'bind-ok', storeId: 'magnit', city: 'moscow', storeCode: 'TEST', name: 'Товар', price: 10 });
const mixed = latestPrices(db, [
  { canonicalId: 'bind-ok', storeId: 'magnit', city: 'moscow', storeCode: 'TEST' },
  { canonicalId: undefined as unknown as string, storeId: 'magnit', city: 'moscow', storeCode: 'TEST' },
]);
assert.equal(mixed.size, 1, 'принимаемый ключ прочитан, непринимаемый пропущен');
assert.equal([...mixed.keys()][0], 'magnit:bind-ok:moscow:TEST', 'в ключе цены есть код точки');

// product_links: sku известен, ссылки нет; sku неизвестен, ссылка есть.
savePriceIfChanged(db, {
  canonicalId: 'link-a',
  storeId: 'magnit',
  city: 'moscow',
  storeCode: 'TEST',
  name: 'Товар A',
  price: 20,
  storeSku: 'sku-a',
});
savePriceIfChanged(db, {
  canonicalId: 'link-b',
  storeId: 'magnit',
  storeCode: 'TEST',
  city: 'moscow',
  name: 'Товар B',
  price: 30,
  url: 'https://shop/p/b',
});
const linkRows = db.exec("SELECT canonical_id, store_sku, url FROM product_links WHERE canonical_id IN ('link-a','link-b') ORDER BY canonical_id");
assert.deepEqual(
  linkRows[0]?.values.map((v) => v.map(String)),
  [
    ['link-a', 'sku-a', 'null'],
    ['link-b', 'link-b', 'https://shop/p/b'],
  ],
  'без sku в ссылку падает id товара, без ссылки — null',
);

// --- Чек-лист цикла опроса --------------------------------------------------
{
  assert.deepEqual(loadPollChecklist(db, 'moscow'), new Set(), 'до первого прогона чек-лист пуст');
  markPollChecked(db, 'moscow', 'magnit', 'MK1', 'magnit-1');
  markPollChecked(db, 'moscow', 'magnit', 'MK2', 'magnit-1');
  markPollChecked(db, 'moscow', 'magnit', 'MK1', 'magnit-2');
  markPollChecked(db, 'moscow', 'lenta', '4161', 'lenta-9');
  markPollChecked(db, 'ulyanovsk', 'magnit', 'UL1', 'magnit-uly');
  // Повторная отметка того же товара: INSERT OR IGNORE, иначе UNIQUE роняет опрос.
  markPollChecked(db, 'moscow', 'magnit', 'MK1', 'magnit-1');
  const moscow = loadPollChecklist(db, 'moscow');
  assert.equal(moscow.size, 4, 'повторная отметка не задваивает строку');
  // Ключ пара «сеть+точка+товар»: склейка была бы не выдумкой, а реальностью —
  // id товара начинается с названия сети (`lenta-9` против сети `lenta`), а у
  // двух точек одной сети товар один и тот же.
  assert.ok(moscow.has('magnit\u0000MK1\u0000magnit-1'), 'товар первой точки Магнита отмечен');
  assert.ok(moscow.has('lenta\u00004161\u0000lenta-9'), 'товар Ленты отмечен отдельно');
  assert.equal(moscow.has('magnit\u00004161\u0000lenta-9'), false, 'товар одной сети не склеивается с id другой');
  assert.equal(
    moscow.has('magnit\u0000MK1\u0000magnit-1') && moscow.has('magnit\u0000MK2\u0000magnit-1'),
    true,
    'один товар в двух точках отмечен дважды: отметка точки А не прячет точку Б',
  );
  // Город в ключе: чужой город не подмешивается.
  assert.equal(loadPollChecklist(db, 'ulyanovsk').size, 1, 'чек-лист пер-городный');
  clearPollChecklist(db, 'moscow');
  assert.equal(loadPollChecklist(db, 'moscow').size, 0, 'очистка цикла работает');
  assert.equal(loadPollChecklist(db, 'ulyanovsk').size, 1, 'очистка одного города не трогает другой');
  // Несуществующий город — пустой список, а не исключение: город из интерфейса
  // может не совпасть с сидом (см. комментарий у saveLastRun).
  assert.deepEqual(loadPollChecklist(db, 'atlantis'), new Set(), 'неизвестный город — пусто');
}

persistDb(db);
assert.ok(fs.existsSync(file), 'db file persisted');

// --- Видимость блока выдачи при выборе магазинов. ---------------------------
// Правило одно и обязано быть единственным (renderer вне покрытия c8, а
// именно точное сравнение ключа один раз съело перенесённые цены вместе с
// товарами): блок своей точки виден по её выбору, блок перенесённых цен ('?' —
// «точка неизвестна») виден, если выбрана хоть одна точка той же сети.
{
  const points = storesForCity('moscow', 'magnit');
  const code = points[0]?.externalStoreId ?? '';
  const on = (keys: PointKey[]): Record<PointKey, boolean> =>
    Object.fromEntries(keys.map((k) => [k, true]));
  assert.equal(
    resultBlockVisible(on([pointKey('magnit', code)]), points, 'magnit', code),
    true,
    'выбранная точка: её блок виден',
  );
  assert.equal(
    resultBlockVisible(on([]), points, 'magnit', code),
    false,
    'невыбранная точка: её блок скрыт',
  );
  assert.equal(
    resultBlockVisible(on([pointKey('magnit', code)]), points, 'magnit', '?'),
    true,
    'перенесённые цены видны, когда выбрана своя точка той же сети',
  );
  assert.equal(
    resultBlockVisible(on([pointKey('lenta', 'lenta-code')]), points, 'magnit', '?'),
    false,
    'перенесённые цены ЧУЖОЙ сети скрыты',
  );
  assert.equal(
    resultBlockVisible(on([pointKey('magnit', code)]), points, 'magnit', '999999'),
    false,
    'несуществующая точка не проходит под выбранную',
  );
  // Подпись перенесённого блока обязана называть неизвестную точку: у всех точек
  // Магнита имя «Магнит», и строка перенесённых цен иначе выглядела бы как цена
  // ВЫБРАННОГО магазина.
  assert.equal(
    unknownPointLabel(points[0]?.name ?? ''),
    `${points[0]?.name ?? ''} — ${UNKNOWN_POINT_LABEL}`,
    'перенесённый блок подписан «точка не указана», а не именем выбранного магазина',
  );
}

closeDb();
console.log('db write-on-change: ALL GREEN');
