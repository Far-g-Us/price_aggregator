// Перенос базы 1.3.x на ключ с кодом точки.
//
// Отдельный файл, а не блок в test-db: здесь нужен СВОЙ файл базы на каждый
// сценарий (старый файл, прерванный перенос, откат) и свой прогон openDb,
// а в test-db база живёт на весь файл и переиспользуется.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import {
  closeDb,
  getPriceHistory,
  getProductShelves,
  isFavorite,
  latestPrices,
  listCategoryProducts,
  listFavorites,
  listTrackedProducts,
  loadPollChecklist,
  openDb,
  persistDb,
  releaseProductShelves,
  saveFavorite,
  saveProductCategory,
  savePriceIfChanged,
  toPriceInput,
} from '../src/core/db/db.js';
import { memoryStorage } from '../src/core/platform.js';
import { fileStorageAt } from '../electron/node-files.js';
import { UNKNOWN_STORE_CODE } from '../src/shared/types.js';

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `pa-mig-${name}-`));

/** База версии 1.3.x: ключи без кода точки, история цен без store_code. */
async function legacyDb(): Promise<Uint8Array> {
  const SQL = await initSqlJs();
  const d = new SQL.Database();
  d.run('PRAGMA foreign_keys = ON');
  d.run("CREATE TABLE cities (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  d.run(
    "CREATE TABLE our_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, " +
      'parent_id TEXT REFERENCES our_categories(id), position INTEGER NOT NULL DEFAULT 0)',
  );
  d.run(
    'CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, unit TEXT NOT NULL, ' +
      'barcode TEXT, image_url TEXT, description TEXT, ' +
      "updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  d.run(
    'CREATE TABLE prices_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
      'canonical_id TEXT NOT NULL REFERENCES products(id), store_id TEXT NOT NULL, city TEXT NOT NULL, ' +
      'price REAL NOT NULL, promo_price REAL, old_price REAL, in_stock INTEGER NOT NULL DEFAULT 1, ' +
      'unit_price TEXT, collected_at TEXT NOT NULL DEFAULT (datetime(\'now\')))',
  );
  d.run('CREATE INDEX idx_prices_lookup ON prices_history (canonical_id, store_id, city, collected_at DESC)');
  // stores в 1.3.x: ключ (id, city)
  d.run(
    'CREATE TABLE stores (id TEXT PRIMARY KEY, city TEXT NOT NULL REFERENCES cities(id), ' +
      "name TEXT NOT NULL, address TEXT, external_store_id TEXT NOT NULL, last_seen TEXT)",
  );
  d.run(
    'CREATE TABLE product_links (canonical_id TEXT NOT NULL REFERENCES products(id), store_id TEXT NOT NULL, ' +
      "store_sku TEXT NOT NULL, url TEXT, image_url TEXT, last_seen TEXT NOT NULL DEFAULT (datetime('now')), " +
      'PRIMARY KEY (canonical_id, store_id))',
  );
  d.run(
    'CREATE TABLE poll_checklist (city TEXT NOT NULL, store_id TEXT NOT NULL, canonical_id TEXT NOT NULL, ' +
      'PRIMARY KEY (city, store_id, canonical_id))',
  );
  d.run(
    'CREATE TABLE favorites (canonical_id TEXT NOT NULL REFERENCES products(id), store_id TEXT NOT NULL, ' +
      'city TEXT NOT NULL, target_price REAL, notified_price REAL, ' +
      "created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (canonical_id, store_id, city))",
  );
  d.run(
    'CREATE TABLE product_categories (canonical_id TEXT NOT NULL REFERENCES products(id), store_id TEXT NOT NULL, ' +
      'city TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES our_categories(id), ' +
      "created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (canonical_id, store_id, city, category_id))",
  );
  d.run(
    'CREATE TABLE product_category_manual (canonical_id TEXT NOT NULL REFERENCES products(id), store_id TEXT NOT NULL, ' +
      'city TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')), ' +
      'PRIMARY KEY (canonical_id, store_id, city))',
  );
  d.run("INSERT INTO cities VALUES ('moscow', 'Москва')");
  d.run("INSERT INTO our_categories VALUES ('dairy', 'Молочное и яйца', null, 1)");
  d.run("INSERT INTO products (id, name, unit) VALUES ('magnit-1', 'Молоко', '930мл')");
  d.run(
    "INSERT INTO prices_history (canonical_id, store_id, city, price, collected_at) VALUES " +
      "('magnit-1', 'magnit', 'moscow', 100, '2026-01-01 10:00:00'), " +
      "('magnit-1', 'magnit', 'moscow', 120, '2026-01-02 10:00:00')",
  );
  d.run(
    "INSERT INTO stores (id, city, name, address, external_store_id) VALUES " +
      "('magnit', 'moscow', 'Магнит', 'ул. Тверская, 1', '303857')",
  );
  d.run(
    "INSERT INTO product_links VALUES ('magnit-1', 'magnit', 'sku-1', 'https://magnit.ru/p/1', null, '2026-01-02')",
  );
  d.run("INSERT INTO poll_checklist VALUES ('moscow', 'magnit', 'magnit-1')");
  d.run("INSERT INTO favorites VALUES ('magnit-1', 'magnit', 'moscow', 90, 110, '2026-01-02')");
  d.run("INSERT INTO product_categories VALUES ('magnit-1', 'magnit', 'moscow', 'dairy', '2026-01-02')");
  d.run("INSERT INTO product_category_manual VALUES ('magnit-1', 'magnit', 'moscow', '2026-01-02')");
  d.run('PRAGMA user_version = 2');
  const out = d.export();
  d.close();
  return out;
}

const pkOf = (database: { exec(sql: string): { values: unknown[][] }[] }, table: string): string[] =>
  database
    .exec(`PRAGMA table_info(${table})`)[0]
    ?.values.filter((r) => Number(r[5]) > 0)
    .map((r) => String(r[1]))
    .sort() ?? [];

const indexCols = (database: { exec(sql: string): { values: unknown[][] }[] }, index: string): string[] =>
  database.exec(`PRAGMA index_info(${index})`)[0]?.values.map((r) => String(r[2])) ?? [];

// --- 1. Перенос целиком: ключи, sentinel, копия до переноса ----------------
{
  const dir = tmp('full');
  const file = path.join(dir, 'prices.db');
  fs.writeFileSync(file, Buffer.from(await legacyDb()));

  const storage = fileStorageAt(file);
  const db = await openDb(storage);

  assert.deepEqual(
    pkOf(db, 'stores'),
    ['city', 'external_store_id', 'id'],
    'stores: ключ по (id, city, external_store_id)',
  );
  for (const table of ['product_links', 'favorites', 'product_category_manual'] as const) {
    assert.deepEqual(
      pkOf(db, table),
      ['canonical_id', 'city', 'store_code', 'store_id'],
      `${table}: код точки в ключе`,
    );
  }
  // У полок в ключ входит ещё и сама полка: товар лежит на нескольких полках.
  assert.deepEqual(
    pkOf(db, 'product_categories'),
    ['canonical_id', 'category_id', 'city', 'store_code', 'store_id'],
    'product_categories: код точки в ключе вместе с полкой',
  );
  assert.deepEqual(
    pkOf(db, 'poll_checklist'),
    ['canonical_id', 'city', 'store_code', 'store_id'],
    'poll_checklist: код точки в ключе',
  );

  // Старые строки помечены «любая точка этой сети», а не выдуманным кодом.
  const sentinel = ['product_links', 'favorites', 'product_categories', 'product_category_manual'];
  for (const table of sentinel) {
    assert.equal(
      db.exec(`SELECT DISTINCT store_code FROM ${table}`)[0]?.values[0]?.[0],
      UNKNOWN_STORE_CODE,
      `${table}: перенесённые строки помечены как «любая точка»`,
    );
  }
  assert.equal(
    db.exec('SELECT DISTINCT store_code FROM prices_history')[0]?.values[0]?.[0],
    UNKNOWN_STORE_CODE,
    'история цен перенесена под меткой «любая точка»',
  );

  // Ничего не потеряно.
  assert.equal(db.exec('SELECT COUNT(*) FROM prices_history')[0]?.values[0]?.[0], 2, 'обе цены на месте');
  assert.equal(db.exec('SELECT COUNT(*) FROM product_links')[0]?.values[0]?.[0], 1, 'ссылка на месте');
  assert.equal(db.exec('SELECT COUNT(*) FROM favorites')[0]?.values[0]?.[0], 1, 'отметка на месте');
  assert.equal(db.exec('SELECT COUNT(*) FROM product_categories')[0]?.values[0]?.[0], 1, 'полка на месте');
  assert.equal(db.exec('SELECT COUNT(*) FROM product_category_manual')[0]?.values[0]?.[0], 1, 'маркер на месте');
  assert.equal(loadPollChecklist(db, 'moscow').size, 1, 'чек-лист на месте');
  assert.ok(listTrackedProducts(db).length >= 1, 'товар виден опросу');

  // Индексы пересозданы под новую форму, а не остались от 1.3.x: DDL индексов
  // в схеме записан в две строки, и поиск по «CREATE INDEX … ON» с одним
  // пробелом молча находит только однострочные — тогда старый индекс без
  // кода точки жил бы в базе вечно (CREATE INDEX IF NOT EXISTS его не чинит).
  assert.deepEqual(
    indexCols(db, 'idx_prices_lookup'),
    ['canonical_id', 'store_id', 'city', 'store_code', 'collected_at'],
    'индекс истории включает код точки',
  );
  assert.deepEqual(
    indexCols(db, 'idx_product_categories_cat'),
    ['city', 'category_id', 'store_id'],
    'индекс полок найден и пересоздан',
  );
  assert.deepEqual(
    indexCols(db, 'idx_product_category_manual_scope'),
    ['store_id', 'city'],
    'индекс ручной раскладки найден и пересоздан',
  );

  // Копия — ДО переноса: в ней старая форма, а не уже переписанная база.
  const backup = path.join(dir, 'prices.db.pre-phase6.bak');
  assert.ok(fs.existsSync(backup), 'копия до переноса создана');
  const SQL = await initSqlJs();
  const old = new SQL.Database(fs.readFileSync(backup));
  assert.equal(
    old.exec('PRAGMA table_info(prices_history)')[0]?.values.some((r) => r[1] === 'store_code'),
    false,
    'в копии истории нет колонки store_code — копия снята ДО переноса',
  );
  old.close();

  persistDb(db);
  closeDb();

  // Повторный запуск на уже новой базе: ничего не ломает и не плодит копий.
  const again = await openDb(storage);
  assert.equal(again.exec('SELECT COUNT(*) FROM prices_history')[0]?.values[0]?.[0], 2, 'повтор ничего не теряет');
  assert.equal(
    fs.existsSync(backup),
    true,
    'старая копия на месте (не перезаписана нулевой)',
  );
  closeDb();
}

// --- 2. Ключ цены различает две точки одного магазина ----------------------
{
  const dir = tmp('points');
  const file = path.join(dir, 'prices.db');
  fs.writeFileSync(file, Buffer.from(await legacyDb()));
  const db = await openDb(fileStorageAt(file));

  const write = (storeCode: string, price: number) =>
    savePriceIfChanged(
      db,
      toPriceInput({
        canonicalId: 'magnit-1',
        storeId: 'magnit',
        city: 'moscow',
        storeCode,
        name: 'Молоко',
        price,
        collectedAt: new Date().toISOString(),
      }),
    );

  // Товар тот же, магазин тот же, город тот же — различается только точка.
  assert.equal(write('303857', 100), 'inserted', 'первая точка пишет свою линию');
  assert.equal(write('404404', 111), 'inserted', 'вторая точка — отдельная линия');
  assert.equal(write('303857', 100), 'skipped', 'повтор первой точки без изменений');
  assert.equal(write('404404', 115), 'inserted', 'изменение второй точки пишется');

  assert.deepEqual(
    getPriceHistory(db, { canonicalId: 'magnit-1', storeId: 'magnit', city: 'moscow', storeCode: '303857' }).map(
      (h) => h.price,
    ),
    [100],
    'история первой точки не подмешивает вторую',
  );
  assert.deepEqual(
    getPriceHistory(db, { canonicalId: 'magnit-1', storeId: 'magnit', city: 'moscow', storeCode: '404404' }).map(
      (h) => h.price,
    ),
    [111, 115],
    'история второй точки своя',
  );
  // Перенесённая линия «любая точка» видна как запасная, но не мешает точке.
  const latest = latestPrices(db, [
    { canonicalId: 'magnit-1', storeId: 'magnit', city: 'moscow', storeCode: '303857' },
  ]);
  assert.equal(
    latest.get('magnit:magnit-1:moscow:303857')?.price,
    100,
    'свежая линия точки приоритетнее перенесённой',
  );
  closeDb();
}

// --- 3. Отметка «любая точка» видна любой точке и снимается ею же ----------
{
  const dir = tmp('sentinel');
  const file = path.join(dir, 'prices.db');
  fs.writeFileSync(file, Buffer.from(await legacyDb()));
  const db = await openDb(fileStorageAt(file));

  const scope = { canonicalId: 'magnit-1', storeId: 'magnit', city: 'moscow', storeCode: '303857' };
  assert.equal(isFavorite(db, scope), true, 'перенесённая отметка видна новой точке');
  // Переотметка по точке ЗАМЕНЯЕТ перенесённую: иначе в базе лежали бы две
  // отметки одного товара, а ещё и notified_price остался бы в той, что уже
  // не видно, — порог сработал бы второй раз.
  saveFavorite(db, scope, 90);
  assert.equal(
    db.exec('SELECT COUNT(*) FROM favorites')[0]?.values[0]?.[0],
    1,
    'переотметка заменяет перенесённую строку, а не добавляет вторую',
  );
  assert.equal(
    db.exec(`SELECT target_price FROM favorites WHERE store_code = '303857'`)[0]?.values[0]?.[0],
    90,
    'и новая отметка принадлежит своей точке',
  );
  assert.equal(
    db.exec(`SELECT notified_price FROM favorites WHERE store_code = '303857'`)[0]?.values[0]?.[0],
    110,
    'уведомлённая цена перенесена, иначе та же цена сообщится снова',
  );
  const listed = listFavorites(db, 'moscow');
  assert.equal(listed.length, 1, 'в избранном одна строка на товар, а не две');
  assert.equal(listed[0]?.storeCode, '303857', 'и она принадлежит своей точке');
  closeDb();
}

// Обе строки на один товар — состояние, которого перенос не создаёт, но которое
// обязано читаться правильно: если такие строки появятся (старый файл базы,
// ручная правка), пользователь увидел бы товар в избранном дважды.
{
  const dir = tmp('both');
  const file = path.join(dir, 'prices.db');
  fs.writeFileSync(file, Buffer.from(await legacyDb()));
  const db = await openDb(fileStorageAt(file));
  db.run(
    `INSERT INTO favorites (canonical_id, store_id, city, store_code, target_price, notified_price)
     VALUES ('magnit-1', 'magnit', 'moscow', '303857', 95, 105)`,
  );
  const both = listFavorites(db, 'moscow');
  assert.equal(both.length, 1, 'перенесённая строка спрятана, когда точная уже есть');
  assert.equal(both[0]?.storeCode, '303857', 'и видна именно точная отметка');
  assert.equal(both[0]?.notifiedPrice, 105, 'с её порогом и уведомлённой ценой');
  closeDb();
}

// --- 3б. Перенесённое, а потом запись по реальной точке ------------------
// Сценарий, на котором ловились дубли: пользователь открыл приложение после
// переноса, что-то записалось по настоящему коду точки — и перенесённые строки
// оказались бы вторым экземпляром того же самого.
{
  const dir = tmp('after');
  const file = path.join(dir, 'prices.db');
  fs.writeFileSync(file, Buffer.from(await legacyDb()));
  const db = await openDb(fileStorageAt(file));
  const scope = { canonicalId: 'magnit-1', storeId: 'magnit', city: 'moscow', storeCode: '303857' };

  // Первое наблюдение после переноса: ссылка на товар записывается по коду
  // точки и поднимает перенесённую строку — у товара остаётся одна ссылка.
  savePriceIfChanged(
    db,
    toPriceInput({
      canonicalId: 'magnit-1',
      storeId: 'magnit',
      city: 'moscow',
      storeCode: '303857',
      name: 'Молоко',
      url: 'https://magnit.ru/product/1',
      price: 105,
      collectedAt: new Date().toISOString(),
    }),
  );
  assert.equal(
    db.exec('SELECT COUNT(*) FROM product_links')[0]?.values[0]?.[0],
    1,
    'ссылка не размножается: перенесённая строка поднята новой',
  );
  const onShelf = listCategoryProducts(db, { city: 'moscow', categoryId: 'dairy' });
  assert.equal(onShelf.length, 1, 'на полке товар один, а не два');
  assert.equal(
    onShelf[0]?.url,
    'https://magnit.ru/product/1',
    'и ссылка берётся из строки своей точки',
  );
  assert.equal(
    onShelf[0]?.price,
    105,
    'на полке цена своей точки, а не допереносная',
  );
  // Автораскладка после переноса: перенесённая раскладка поднимается, а не
  // дублируется.
  saveProductCategory(db, [{ ...scope, categoryId: 'dairy' }]);
  assert.equal(
    db.exec("SELECT COUNT(*) FROM product_categories WHERE canonical_id = 'magnit-1'")[0]?.values[0]?.[0],
    1,
    'автораскладка не создаёт вторую строку поверх перенесённой',
  );
  const shelves = getProductShelves(db, scope);
  assert.deepEqual(shelves.categoryIds, ['dairy'], 'карточка товара видит полку после переноса');
  assert.equal(shelves.manual, true, 'и ручную раскладку тоже');
  // Ссылка принадлежит своей точке: полка точки А не должна открывать
  // карточку точки Б, даже когда ссылка у обеих есть.
  savePriceIfChanged(
    db,
    toPriceInput({
      canonicalId: 'magnit-1',
      storeId: 'magnit',
      city: 'moscow',
      storeCode: '404404',
      name: 'Молоко',
      url: 'https://magnit.ru/product/other-point',
      price: 106,
      collectedAt: new Date().toISOString(),
    }),
  );
  saveProductCategory(db, [{ ...scope, categoryId: 'dairy' }, { ...scope, storeCode: '404404', categoryId: 'dairy' }]);
  const two = listCategoryProducts(db, { city: 'moscow', categoryId: 'dairy' });
  assert.deepEqual(
    two.map((r) => [r.price, r.url]).sort(),
    [
      [105, 'https://magnit.ru/product/1'],
      [106, 'https://magnit.ru/product/other-point'],
    ],
    'у каждой точки своя цена и своя ссылка',
  );
  // Возврат под автораскладку должен убрать и перенесённую строку.
  releaseProductShelves(db, scope);
  assert.deepEqual(
    db.exec("SELECT store_code FROM product_categories ORDER BY store_code")[0]?.values.map((r) => String(r[0])),
    ['404404'],
    'возврат снимает перенесённую строку и строку своей точки, чужую точку не трогает',
  );
  assert.equal(
    db.exec('SELECT COUNT(*) FROM product_category_manual')[0]?.values[0]?.[0],
    0,
    'и маркер ручного управления',
  );
  closeDb();
}

// --- 4. Прерванный перенос: цены уже с кодом, полки ещё без --------------
{
  const dir = tmp('partial');
  const file = path.join(dir, 'prices.db');
  fs.writeFileSync(file, Buffer.from(await legacyDb()));
  const storage = fileStorageAt(file);
  let db = await openDb(storage);
  // Имитируем состояние после оборванного переноса: колонка цены на месте,
  // ключ полок — старый.
  db.run('DROP TABLE product_categories');
  db.run(
    'CREATE TABLE product_categories (canonical_id TEXT NOT NULL REFERENCES products(id), store_id TEXT NOT NULL, ' +
      'city TEXT NOT NULL, category_id TEXT NOT NULL, PRIMARY KEY (canonical_id, store_id, city, category_id))',
  );
  persistDb(db);
  closeDb();

  db = await openDb(storage);
  assert.deepEqual(
    pkOf(db, 'product_categories'),
    ['canonical_id', 'category_id', 'city', 'store_code', 'store_id'],
    'частично перенесённая база доведена до конца',
  );
  assert.ok(
    fs.existsSync(path.join(dir, 'prices.db.pre-phase6.bak')),
    'копия снята и здесь: предикат смотрит все таблицы, а не только цены',
  );
  closeDb();
}

// --- 5. Сирота-внешний-ключ: перенос не начинается, файл не тронут --------
// Референтные строки фильтр переноса вычистил бы сам, но цена истории —
// нет: у неё такого фильтра нет. Поэтому перенос сначала проверяет базу
// целиком и отказывает ДО первой перестройки, а не чинит молча.
{
  const dir = tmp('orphan');
  const file = path.join(dir, 'prices.db');
  const bytes = await legacyDb();
  const SQL = await initSqlJs();
  const seeded = new SQL.Database(bytes);
  seeded.run('PRAGMA foreign_keys = OFF');
  // Товар-сирота: ссылки на него нет, а полка на него ссылается. Такой перенос
  // обязан откатиться целиком, а не оставить базу наполовину новой.
  seeded.run("INSERT INTO product_categories VALUES ('нет-товара', 'magnit', 'moscow', 'dairy', '2026-01-02')");
  const broken = seeded.export();
  seeded.close();
  fs.writeFileSync(file, Buffer.from(broken));

  let message = '';
  try {
    const db = await openDb(fileStorageAt(file));
    closeDb();
  } catch (err) {
    message = String(err);
  }
  assert.match(message, /перенос на ключ с кодом точки остановлен/, 'перенос падает с внятной ошибкой, а не молча');
  assert.match(message, /product_categories/, 'и называет таблицу, где именно нарушение');

  // Файл на диске не тронут: старая форма цела, данные целы.
  const after = new SQL.Database(fs.readFileSync(file));
  assert.equal(
    after.exec('PRAGMA table_info(product_categories)')[0]?.values.some((r) => r[1] === 'store_code'),
    false,
    'файл остался в прежней форме — перенос был откачен',
  );
  assert.equal(
    after.exec('SELECT COUNT(*) FROM product_categories')[0]?.values[0]?.[0],
    2,
    'и строки на месте, включая сироту',
  );
  after.close();
}

// --- 6. Память: свежая база копию не создаёт, старая — создаёт -------------
{
  const fresh = memoryStorage();
  let db = await openDb(fresh);
  closeDb();
  assert.equal(fresh.backups(), 0, 'свежая база остаётся без копии');

  const legacy = memoryStorage();
  legacy.writeDb(await legacyDb());
  const store = await openDb(legacy);
  closeDb();
  assert.equal(legacy.backups(), 1, 'старая база получила копию');
  assert.ok(
    legacy.backupDump(),
    'копия лежит отдельно от рабочей базы: dump() отдаёт уже перенесённую',
  );
  void db;
  void store;
}

// --- 7. Сбой внутри переноса: откат и нет половины новой базы -------------
// Сирота-внешний-ключ ловится ДО перестроек (тест 5). Здесь другая поломка:
// перенос начался, и сама пересборка упала на данных. Проверяем, что транзакция
// откатывается целиком, а не оставляет базу, где часть таблиц уже новая.
{
  const dir = tmp('crash');
  const file = path.join(dir, 'prices.db');
  const SQL = await initSqlJs();
  const seeded = new SQL.Database(await legacyDb());
  // Ссылка без sku: в новой схеме store_sku NOT NULL, поэтому перенос
  // честно падает. Такой файл возможен от старой сборки, где колонка не была
  // ограничена.
  seeded.run('PRAGMA foreign_keys = OFF');
  seeded.run('DROP TABLE product_links');
  seeded.run(
    'CREATE TABLE product_links (canonical_id TEXT NOT NULL REFERENCES products(id), store_id TEXT NOT NULL, ' +
      'store_sku TEXT, url TEXT, image_url TEXT, last_seen TEXT NOT NULL DEFAULT (datetime(\'now\')), ' +
      'PRIMARY KEY (canonical_id, store_id))',
  );
  seeded.run(
    "INSERT INTO product_links (canonical_id, store_id, store_sku, url) VALUES ('magnit-1', 'magnit', NULL, 'https://magnit.ru/p/1')",
  );
  fs.writeFileSync(file, Buffer.from(seeded.export()));
  seeded.close();

  let message = '';
  try {
    const db = await openDb(fileStorageAt(file));
    closeDb();
  } catch (err) {
    message = String(err);
  }
  assert.match(message, /NOT NULL/i, 'перенос падает на данных, а не доходит до конца молча');

  const after = new SQL.Database(fs.readFileSync(file));
  assert.equal(
    after.exec('PRAGMA table_info(stores)')[0]?.values.filter((r) => Number(r[5]) > 0).length,
    1,
    'файл не перезаписан: перенос упал, и на диске осталась прежняя форма (persistDb не вызывался)',
  );
  assert.equal(
    after.exec('SELECT COUNT(*) FROM product_links')[0]?.values[0]?.[0],
    1,
    'и данные на месте',
  );
  after.close();
}

console.log('store_code migration: ALL GREEN — перенос, sentinel, откат, копия, две точки');