import initSqlJs, { type Database } from 'sql.js';
import type { HistoryPoint } from '../../shared/api.js';
import { matchSplitKey } from '../../shared/matching.js';
import type { ScrapedProduct } from '../../shared/types.js';
import type { AppStorage } from '../platform.js';
import { SCHEMA } from './schema.js';

let db: Database | null = null;
let storage: AppStorage | null = null;

// Путь к файлу и его существование знает оболочка (electron/node-platform.ts),
// ядро работает с байтами. Так БД одинаково живёт в userData, в андроидных
// prefs и в памяти теста.
/**
 * Приведение БД к текущей схеме. Идёт ДО exec(SCHEMA), потому что
 * `CREATE TABLE IF NOT EXISTS` не трогает существующую таблицу, а следующая
 * же строка схемы — `CREATE INDEX ... ON favorites (city, store_id)` — на
 * старой favorites падает с «no such column: city».
 *
 * Здесь это не косметика: openDb на такой базе ронял весь запуск, и
 * openDatabase() глотал ошибку, отдавая database: null. То есть у человека
 * цены на экране были, а история, полки и избранное молча не работали.
 *
 * Правки идут ПО ФОРМЕ таблицы, а не по номеру версии. Номер в user_version
 * хранится в самой базе, но доверять ему нельзя: прошлая редакция добавляла
 * колонки favorites только внутри ветки `version < 1`, а метку ставила сразу на
 * SCHEMA_VERSION. База с user_version = 1 и без store_id/city/notified_price
 * получала метку 2 и навсегда оставалась в старой форме — CREATE TABLE IF NOT
 * EXISTS её не чинит, и любое обращение к favorites.city или notified_price
 * падало на «no such column», то есть ломалось всё избранное. Поэтому сверяем
 * реальные колонки и первичный ключ и чиним форму при любом user_version.
 *
 * Номер версии оставлен: он полезен как отметка «схема актуальна» и как
 * сигнал в логе. Проверки он больше не делает.
 */
const SCHEMA_VERSION = 2;

/** Колонки favorites, которых может не быть, с их объявлением для ALTER. */
const FAVORITES_COLUMNS: readonly (readonly [string, string])[] = [
  ['store_id', "TEXT NOT NULL DEFAULT ''"],
  ['city', "TEXT NOT NULL DEFAULT ''"],
  ['target_price', 'REAL'],
  ['notified_price', 'REAL'],
];

function columns(database: Database, table: string): Set<string> {
  const stmt = database.prepare(`PRAGMA table_info(${table})`);
  const names = new Set<string>();
  try {
    while (stmt.step()) {
      const o = stmt.getAsObject() as unknown as { name: string };
      names.add(o.name);
    }
  } finally {
    stmt.free();
  }
  return names;
}

/** Порядок колонок первичного ключа по PRAGMA table_info: pk = 1, 2, 3… */
function primaryKey(database: Database, table: string): string[] {
  const stmt = database.prepare(`PRAGMA table_info(${table})`);
  const parts: { pk: number; name: string }[] = [];
  try {
    while (stmt.step()) {
      const o = stmt.getAsObject() as unknown as { name: string; pk: number };
      if (o.pk > 0) parts.push({ pk: o.pk, name: o.name });
    }
  } finally {
    stmt.free();
  }
  return parts.sort((a, b) => a.pk - b.pk).map((p) => p.name);
}

function tableExists(database: Database, table: string): boolean {
  const stmt = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  try {
    return !!stmt.bind([table]) && stmt.step();
  } finally {
    stmt.free();
  }
}

/**
 * Приводит favorites к форме, на которой работает весь остальной код.
 * Идемпотентна: повторный выпуск на уже правильной базе ничего не делает.
 */
function migrateFavorites(database: Database): void {
  // Свежая база: таблицы ещё нет, нужную форму создаст schema.sql.
  if (!tableExists(database, 'favorites')) return;

  const cols = columns(database, 'favorites');
  const pk = primaryKey(database, 'favorites');
  const keyOk =
    pk.length === 3 && pk.includes('canonical_id') && pk.includes('store_id') && pk.includes('city');

  if (keyOk) {
    // Ключ верный — недостающие колонки добавляются на месте, без пересборки.
    for (const [name, decl] of FAVORITES_COLUMNS) {
      if (!cols.has(name)) database.run(`ALTER TABLE favorites ADD COLUMN ${name} ${decl}`);
    }
    return;
  }

  // Ключ неверный (у 1.0.0 он был один canonical_id), а PK в SQLite не
  // меняется ALTER'ом — нужна пересборка таблицы.
  database.run('ALTER TABLE favorites RENAME TO favorites_legacy_fix');
  database.run(
    `CREATE TABLE favorites (
       canonical_id TEXT NOT NULL REFERENCES products(id),
       store_id TEXT NOT NULL DEFAULT '',
       city TEXT NOT NULL DEFAULT '',
       target_price REAL,
       notified_price REAL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (canonical_id, store_id, city)
     )`,
  );

  // Старые отметки не привязаны ни к магазину, ни к городу, поэтому переносятся
  // в тот вид, который даёт тот же ключ, что и раньше: один товар — одна
  // строка. Молча размножать их по всем сетям значило бы завести избранное там,
  // где человек его не выбирал.
  //
  // Переносим только отметки существующих товаров: сирота (canonical_id без
  // строки в products) под включённым внешним ключом роняет всю миграцию, а
  // openDatabase() глотает ошибку и отдаёт database: null — то есть история,
  // полки и избранное умирают до удаления файла вручную.
  const columnsToCopy: string[] = ['canonical_id'];
  const values: string[] = ['canonical_id'];
  for (const [name, decl] of FAVORITES_COLUMNS) {
    if (cols.has(name)) {
      columnsToCopy.push(name);
      values.push(name);
    } else if (decl.includes("DEFAULT ''")) {
      // Строковая колонка без дефолта сделала бы старую строку валидной только
      // с выдуманным ключом — берём тот же пустой вид, что и перенос строк.
      columnsToCopy.push(name);
      values.push("''");
    }
  }
  if (cols.has('created_at')) {
    columnsToCopy.push('created_at');
    values.push('created_at');
  }
  if (tableExists(database, 'products')) {
    database.run(
      `INSERT INTO favorites (${columnsToCopy.join(', ')})
       SELECT ${values.join(', ')} FROM favorites_legacy_fix
       WHERE canonical_id IN (SELECT id FROM products)`,
    );
  }
  database.run('DROP TABLE favorites_legacy_fix');
}

function migrate(database: Database): void {
  migrateFavorites(database);
  database.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export async function openDb(store: AppStorage): Promise<Database> {
  if (db) {
    // Два разных хранилища в одном процессе — это два разных приложения
    // (или два теста). Молча отдать чужую базу значит писать цены не туда.
    if (storage !== store) throw new Error('db: база уже открыта на другом хранилище (closeDb() прежде)');
    return db;
  }
  const SQL = await initSqlJs();
  const existing = store.readDb();
  const loaded = existing ? new SQL.Database(existing) : new SQL.Database();
  // SQLite выключает внешние ключи по умолчанию — без этого REFERENCES в
  // схеме декоративны и product_categories мог бы ссылать в пустоту.
  loaded.run('PRAGMA foreign_keys = ON');
  try {
    migrate(loaded);
    loaded.exec(SCHEMA);
  } catch (err) {
    // Раньше объект присваивался до exec: после провала следующий вызов
    // openDb отдавал базу без таблиц, и всё падало на «no such table».
    loaded.close();
    throw err;
  }
  db = loaded;
  storage = store;
  return db;
}

/**
 * Последняя записанная цена по набору ключей (canonicalId, storeId, city).
 *
 * Нужна избранному и проверке порогов: там интересует ТОЛЬКО текущая цена,
 * а getPriceHistory отдаёт первые N строк по возрастанию — на товаре с историей
 * длиннее N это была бы цена из далёкого прошлого, и уведомление о снижении
 * пришло бы по цене, которой уже нет (и наоборот, реальное снижение
 * пропускалось). Форма запроса — как у последней строки в savePriceIfChanged.
 */
export function latestPrices(
  database: Database,
  keys: { canonicalId: string; storeId: string; city: string }[],
): Map<string, HistoryPoint> {
  const out = new Map<string, HistoryPoint>();
  if (keys.length === 0) return out;
  // Читаем одним запросом на ключ: их десятки, а не тысячи, и sqlite.js
  // заметно дешевле одного prepare на каждый отмеченный товар.
  const stmt = database.prepare(
    `SELECT price, promo_price, old_price, in_stock, collected_at FROM prices_history
     WHERE canonical_id = ? AND store_id = ? AND city = ?
     ORDER BY collected_at DESC, id DESC LIMIT 1`,
  );
  try {
    for (const k of keys) {
      if (!stmt.bind([k.canonicalId, k.storeId, k.city])) continue;
      if (stmt.step()) {
        const o = stmt.getAsObject() as unknown as HistoryPoint;
        out.set(`${k.storeId}:${k.canonicalId}:${k.city}`, o);
      }
    }
  } finally {
    stmt.free();
  }
  return out;
}

export function getPriceHistory(
  database: Database,
  args: { canonicalId: string; storeId: string; city: string; limit?: number },
): HistoryPoint[] {
  const stmt = database.prepare(
    `SELECT price, promo_price, old_price, in_stock, collected_at FROM prices_history
     WHERE canonical_id = ? AND store_id = ? AND city = ?
     ORDER BY collected_at ASC, id ASC LIMIT ?`,
  );
  const rows: HistoryPoint[] = [];
  try {
    stmt.bind([args.canonicalId, args.storeId, args.city, args.limit ?? 500]);
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as HistoryPoint);
  } finally {
    stmt.free();
  }
  return rows;
}

export interface TrackedProduct {
    canonicalId: string;
    storeId: string;
    city: string;
    /**
     * Название товара из products. Нужно адаптерам, у которых нет карточки по
     * id и которые ищут товар поиском по названию (Лента). Пустая строка —
     * «названия нет», это НЕ то же самое, что «товара нет».
     */
    name: string;
}

export function listTrackedProducts(database: Database): TrackedProduct[] {
    // LEFT JOIN, а не JOIN: у prices_history нет внешнего ключа на products, и
    // INNER JOIN молча выкинул бы из опроса все цели без названия — тихая потеря
    // истории цены. COALESCE даёт '' вместо null, потому что optional-поле в
    // exactOptionalPropertyTypes так не передать.
    const stmt = database.prepare(
      `SELECT DISTINCT h.canonical_id, h.store_id, h.city, COALESCE(p.name, '') AS name
       FROM prices_history h
       LEFT JOIN products p ON p.id = h.canonical_id`,
    );
    const rows: TrackedProduct[] = [];
    try {
      while (stmt.step()) {
        const o = stmt.getAsObject() as unknown as {
          canonical_id: string;
          store_id: string;
          city: string;
          name: string;
        };
        rows.push({ canonicalId: o.canonical_id, storeId: o.store_id, city: o.city, name: o.name });
      }
    } finally {
      stmt.free();
    }
    return rows;
  }

export function persistDb(database?: Database): void {
  const target = database ?? db;
  // Нет открытой базы — сохранять нечего (например, выход до первого
  // openDb). Молчание здесь уместно, а вот упавшая запись — нет: раньше она
  // терялась, и цены оставались только в памяти до выхода из приложения.
  if (!target) return;
  if (!storage) throw new Error('db: persistDb без хранилища (openDb не вызывался?)');
  storage.writeDb(target.export());
}

export function toPriceInput(p: ScrapedProduct) {
  return {
    canonicalId: p.canonicalId,
    storeId: p.storeId,
    city: p.city,
    name: p.name,
    brand: p.brand,
    unit: p.unit,
    barcode: p.barcode,
    price: p.price,
    promoPrice: p.promoPrice,
    oldPrice: p.oldPrice,
    inStock: p.inStock,
    unitPrice: p.unitPrice,
    imageUrl: p.imageUrl,
    description: p.description,
    url: p.url,
  };
}

// Офлайн-источник для наших категорий: то, что уже накоплено в БД по
// этому городу. Сеть враждебная, поэтому категория не должна пустеть при
// недоступной сети — отдаём кэш и честно говорим, что он из кэша.
export interface CachedCategoryRow {
  canonicalId: string;
  storeId: ScrapedProduct['storeId'];
  name: string;
  imageUrl: string | null;
  unit: string | null;
  brand: string | null;
  url: string | null;
    price: number;
    promoPrice: number | null;
    oldPrice: number | null;
    inStock: boolean;
    collectedAt: string;
    // Цена за единицу («250 ₽/кг»). Писалась в prices_history, но не выбиралась
    // ни одним SELECT — из-за этого в UI её не было видно ни на одной полке,
    // собранной из базы.
    unitPrice: string | null;
  }

export function listCategoryProducts(
  database: Database,
  args: { city: string; categoryId: string; limit?: number },
): CachedCategoryRow[] {
  const stmt = database.prepare(
    `SELECT pc.canonical_id, pc.store_id, p.name, p.image_url, p.unit, p.brand, pl.url,
            last.price, last.promo_price, last.old_price, last.in_stock, last.collected_at, last.unit_price
     FROM product_categories pc
     JOIN products p ON p.id = pc.canonical_id
     LEFT JOIN product_links pl ON pl.canonical_id = pc.canonical_id AND pl.store_id = pc.store_id
     JOIN prices_history last ON last.id = (
       SELECT id FROM prices_history h
       WHERE h.canonical_id = pc.canonical_id AND h.store_id = pc.store_id AND h.city = pc.city
       ORDER BY h.id DESC LIMIT 1
     )
     WHERE pc.city = ? AND pc.category_id = ?
     ORDER BY last.collected_at DESC, pc.canonical_id
     LIMIT ?`,
  );
  const rows: CachedCategoryRow[] = [];
  try {
    if (stmt.bind([args.city, args.categoryId, args.limit ?? 300])) {
      while (stmt.step()) {
        const o = stmt.getAsObject() as unknown as {
          canonical_id: string;
          store_id: ScrapedProduct['storeId'];
          name: string;
          image_url: string | null;
          unit: string | null;
          brand: string | null;
          url: string | null;
          price: number;
          promo_price: number | null;
          old_price: number | null;
          in_stock: number;
          collected_at: string;
        unit_price: string | null;
        };
        rows.push({
          canonicalId: o.canonical_id,
          storeId: o.store_id,
          name: o.name,
          imageUrl: o.image_url,
          unit: o.unit,
          brand: o.brand,
          url: o.url,
          price: o.price,
          promoPrice: o.promo_price,
          oldPrice: o.old_price,
          inStock: o.in_stock !== 0,
          collectedAt: o.collected_at,
      unitPrice: o.unit_price,
        });
      }
    }
  } finally {
    stmt.free();
  }
  return rows;
}

// Товары города, которые не попали ни в одну нашу категорию, — их видно
// только тут, поэтому из поиска они в списке не появятся.
export function listUnassignedProducts(
  database: Database,
  args: { city: string; limit?: number },
): CachedCategoryRow[] {
  const stmt = database.prepare(
    `SELECT h.canonical_id, h.store_id, p.name, p.image_url, p.unit, p.brand, pl.url,
            h.price, h.promo_price, h.old_price, h.in_stock, h.collected_at, h.unit_price
     FROM prices_history h
     JOIN products p ON p.id = h.canonical_id
     LEFT JOIN product_links pl ON pl.canonical_id = h.canonical_id AND pl.store_id = h.store_id
     WHERE h.city = ?
       AND h.id = (SELECT id FROM prices_history h2
                   WHERE h2.canonical_id = h.canonical_id AND h2.store_id = h.store_id AND h2.city = h.city
                   ORDER BY h2.id DESC LIMIT 1)
       AND NOT EXISTS (
         SELECT 1 FROM product_categories pc
         WHERE pc.canonical_id = h.canonical_id AND pc.store_id = h.store_id AND pc.city = h.city
       )
     ORDER BY h.collected_at DESC
     LIMIT ?`,
  );
  const rows: CachedCategoryRow[] = [];
  try {
    if (stmt.bind([args.city, args.limit ?? 300])) {
      while (stmt.step()) {
        const o = stmt.getAsObject() as unknown as {
          canonical_id: string;
          store_id: ScrapedProduct['storeId'];
          name: string;
          image_url: string | null;
          unit: string | null;
          brand: string | null;
          url: string | null;
          price: number;
          promo_price: number | null;
          old_price: number | null;
          in_stock: number;
          collected_at: string;
        unit_price: string | null;
        };
        rows.push({
          canonicalId: o.canonical_id,
          storeId: o.store_id,
          name: o.name,
          imageUrl: o.image_url,
          unit: o.unit,
          brand: o.brand,
          url: o.url,
          price: o.price,
          promoPrice: o.promo_price,
          oldPrice: o.old_price,
          inStock: o.in_stock !== 0,
          collectedAt: o.collected_at,
      unitPrice: o.unit_price,
        });
      }
    }
  } finally {
    stmt.free();
  }
  return rows;
}

export function saveProductCategory(
  database: Database,
  rows: { canonicalId: string; storeId: string; city: string; categoryId: string }[],
): void {
  if (rows.length === 0) return;
  database.run('BEGIN');
  try {
    const stmt = database.prepare(
      `INSERT OR IGNORE INTO product_categories (canonical_id, store_id, city, category_id)
       VALUES (?, ?, ?, ?)`,
    );
    try {
      for (const r of rows) {
        stmt.run([r.canonicalId, r.storeId, r.city, r.categoryId]);
      }
    } finally {
      stmt.free();
    }
    database.run('COMMIT');
  } catch (err) {
    database.run('ROLLBACK');
    throw err;
  }
}

/**
 * Ручная раскладка товара по нашим полкам.
 *
 * Семантика: строка в product_category_manual означает «товар под ручным
 * управлением» — автораскладка не добавляет и не убирает у него ничего, а
 * product_categories хранит ровно выбранное пользователем. Пустой набор полок
 * означает «убрать со всех полок» (товар уедет в «Не разложено»), и это
 * представимо только благодаря отдельной таблице-маркеру.
 */
export type ShelfScope = { canonicalId: string; storeId: string; city: string };

/** Какие товары в этом магазине и городе под ручным управлением. */
export function manualShelfIds(database: Database, storeId: string, city: string): Set<string> {
  const stmt = database.prepare('SELECT canonical_id FROM product_category_manual WHERE store_id = ? AND city = ?');
  const ids = new Set<string>();
  try {
    if (stmt.bind([storeId, city])) {
      while (stmt.step()) {
        const o = stmt.getAsObject() as unknown as { canonical_id: string };
        ids.add(o.canonical_id);
      }
    }
  } finally {
    stmt.free();
  }
  return ids;
}

export function getProductShelves(
  database: Database,
  scope: ShelfScope,
): { categoryIds: string[]; manual: boolean } {
  const read = database.prepare(
    'SELECT category_id FROM product_categories WHERE canonical_id = ? AND store_id = ? AND city = ? ORDER BY category_id',
  );
  const categoryIds: string[] = [];
  try {
    if (read.bind([scope.canonicalId, scope.storeId, scope.city])) {
      while (read.step()) {
        const o = read.getAsObject() as unknown as { category_id: string };
        categoryIds.push(o.category_id);
      }
    }
  } finally {
    read.free();
  }
  const marker = database.prepare(
    'SELECT 1 FROM product_category_manual WHERE canonical_id = ? AND store_id = ? AND city = ?',
  );
  let manual = false;
  try {
    manual = !!marker.bind([scope.canonicalId, scope.storeId, scope.city]) && marker.step();
  } finally {
    marker.free();
  }
  return { categoryIds, manual };
}

/**
 * Перезаписывает набор полок товара. Пишем диффом, а не «удалить всё и вставить
 * заново»: у полок, которые остаются, должен сохраниться created_at — по нему
 * видно, с какого числа товар на этой полке.
 */
export function setProductShelves(database: Database, scope: ShelfScope, categoryIds: string[]): void {
  database.run('BEGIN');
  try {
    // Пустой набор — это отдельный SQL, а не `NOT IN ()`: в SQLite выражения
    // нет, и подстановка `NOT IN (NULL)` даёт NULL, а не TRUE, то есть не
    // удаляет ничего. Именно на этом «убрать со всех полок» молча сломалось бы.
    const drop = categoryIds.length
      ? database.prepare(
          `DELETE FROM product_categories
           WHERE canonical_id = ? AND store_id = ? AND city = ? AND category_id NOT IN (${categoryIds.map(() => '?').join(',')})`,
        )
      : database.prepare('DELETE FROM product_categories WHERE canonical_id = ? AND store_id = ? AND city = ?');
    const add = database.prepare(
      `INSERT OR IGNORE INTO product_categories (canonical_id, store_id, city, category_id)
       VALUES (?, ?, ?, ?)`,
    );
    const mark = database.prepare(
      `INSERT OR IGNORE INTO product_category_manual (canonical_id, store_id, city) VALUES (?, ?, ?)`,
    );
    try {
      drop.run([scope.canonicalId, scope.storeId, scope.city, ...categoryIds]);
      for (const categoryId of categoryIds) {
        add.run([scope.canonicalId, scope.storeId, scope.city, categoryId]);
      }
      mark.run([scope.canonicalId, scope.storeId, scope.city]);
    } finally {
      drop.free();
      add.free();
      mark.free();
    }
    database.run('COMMIT');
  } catch (err) {
    database.run('ROLLBACK');
    throw err;
  }
}

/** Возвращает товар под управление автораскладки. */
export function releaseProductShelves(database: Database, scope: ShelfScope): void {
  database.run('BEGIN');
  try {
    const dropCats = database.prepare(
      'DELETE FROM product_categories WHERE canonical_id = ? AND store_id = ? AND city = ?',
    );
    const dropMark = database.prepare(
      'DELETE FROM product_category_manual WHERE canonical_id = ? AND store_id = ? AND city = ?',
    );
    try {
      dropCats.run([scope.canonicalId, scope.storeId, scope.city]);
      dropMark.run([scope.canonicalId, scope.storeId, scope.city]);
    } finally {
      dropCats.free();
      dropMark.free();
    }
    database.run('COMMIT');
  } catch (err) {
    database.run('ROLLBACK');
    throw err;
  }
}

/**
 * Избранное предложение. Ключ включает город и магазин: отметка «молоко дешевле
 * 100» относится к конкретной цене конкретной точки.
 */
export interface FavoriteRow {
  canonicalId: string;
  storeId: string;
  city: string;
  targetPrice: number | null;
  /** Цена последнего уведомления: ниже неё сообщаем, выше — молчим. */
  notifiedPrice: number | null;
}

export interface FavoriteScope {
  canonicalId: string;
  storeId: string;
  city: string;
}

/** Все отметки избранного в городе — для списка «Избранное» и проверки порогов. */
export function listFavorites(database: Database, city: string): FavoriteRow[] {
  return readFavorites(database, 'WHERE city = ?', [city]);
}

/**
 * Избранное всех городов. Нужно проверке порогов при запуске без города:
 * вариант listFavorites(db, '') молча вернул бы пусто (в базе городов нет), и
 * уведомления не сработали бы никогда, без единого признака.
 */
export function listFavoritesAll(database: Database): FavoriteRow[] {
  return readFavorites(database, '', []);
}

function readFavorites(database: Database, where: string, params: (string | number | null)[]): FavoriteRow[] {
  const stmt = database.prepare(
    `SELECT canonical_id, store_id, city, target_price, notified_price FROM favorites ${where} ORDER BY created_at DESC`,
  );
  const rows: FavoriteRow[] = [];
  try {
    if (!params.length || stmt.bind(params)) {
      while (stmt.step()) {
        const o = stmt.getAsObject() as unknown as {
          canonical_id: string;
          store_id: string;
          city: string;
          target_price: number | null;
          notified_price: number | null;
        };
        rows.push({
          canonicalId: o.canonical_id,
          storeId: o.store_id,
          city: o.city,
          targetPrice: o.target_price,
          notifiedPrice: o.notified_price,
        });
      }
    }
  } finally {
    stmt.free();
  }
  return rows;
}

/** Помечает цены, по которым уже сообщили, чтобы не сообщать о том же снова. */
export function saveNotifiedPrices(
  database: Database,
  rows: { canonicalId: string; storeId: string; city: string; price: number }[],
): void {
  if (rows.length === 0) return;
  database.run('BEGIN');
  try {
    const stmt = database.prepare(
      `UPDATE favorites SET notified_price = ?
       WHERE canonical_id = ? AND store_id = ? AND city = ?`,
    );
    try {
      for (const r of rows) stmt.run([r.price, r.canonicalId, r.storeId, r.city]);
    } finally {
      stmt.free();
    }
    database.run('COMMIT');
  } catch (err) {
    database.run('ROLLBACK');
    throw err;
  }
}

export function isFavorite(database: Database, scope: FavoriteScope): boolean {
  const stmt = database.prepare(
    'SELECT 1 FROM favorites WHERE canonical_id = ? AND store_id = ? AND city = ?',
  );
  try {
    return !!stmt.bind([scope.canonicalId, scope.storeId, scope.city]) && stmt.step();
  } finally {
    stmt.free();
  }
}

/**
 * Ставит отметку. targetPrice = null означает «без порога» и стирает прежнее
 * значение — это прямо в DO UPDATE, а не COALESCE: иначе порог было бы нечем
 * снять, а молчаливое «оставим как было» удивляло бы в интерфейсе.
 *
 * INSERT в products нужен из-за внешнего ключа: строку products создаёт
 * savePriceIfChanged, а отметку можно поставить раньше первого замера — прямо
 * из выдачи. Без вставки FK рушил звёздочку сырым «FOREIGN KEY constraint
 * failed», и renderer глотал это в консоль.
 */
export function saveFavorite(
  database: Database,
  scope: FavoriteScope,
  targetPrice: number | null,
): void {
  database.run(
    `INSERT OR IGNORE INTO products (id, name, unit, updated_at)
     VALUES (?, ?, ?, datetime('now'))`,
    // Имя-заглушка: первый настоящий замер перезапишет его (savePriceIfChanged
    // обновляет name), поэтому в интерфейсе товар не появится под ним.
    [scope.canonicalId, scope.canonicalId, 'шт'],
  );
  database.run(
    `INSERT INTO favorites (canonical_id, store_id, city, target_price)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(canonical_id, store_id, city) DO UPDATE SET target_price = excluded.target_price`,
    [scope.canonicalId, scope.storeId, scope.city, targetPrice],
  );
}

export function removeFavorite(database: Database, scope: FavoriteScope): void {
  database.run('DELETE FROM favorites WHERE canonical_id = ? AND store_id = ? AND city = ?', [
    scope.canonicalId,
    scope.storeId,
    scope.city,
  ]);
}

/**
 * Ручные разрывы склейки, у которых хотя бы один id встречается в списке.
 *
 * Возвращаем только пары, где хотя бы один id есть в ids: таблица разрывов
 * накапливается месяцами, а выдача — горстка товаров, и тянуть в память все
 * исторические пары незачем.
 *
 * ids обязан быть дедуплицирован вызывающим: он подставляется дважды (left и
 * right), а лимит параметров SQLite — 32766, то есть примерно на 16k
 * значениях запрос перестал бы проходить.
 */
/**
 * Время последнего успешного опроса города.
 *
 * Нужно, чтобы перезапуск приложения не начинал опрос заново: раньше метка
 * жила только в памяти процесса, и открытие portable-версии через час после
 * прошлого опроса снова дёргало все сети.
 */
export function getLastRun(database: Database, city: string): string | null {
  const stmt = database.prepare('SELECT last_run FROM poll_meta WHERE city = ?');
  try {
    if (!stmt.bind([city]) || !stmt.step()) return null;
    const o = stmt.getAsObject() as unknown as { last_run: string | null };
    return o.last_run;
  } finally {
    stmt.free();
  }
}

/**
 * Метка времени опроса города.
 *
 * INSERT OR IGNORE вместо обычного: колонка city ссылается на cities(id), и
 * город из интерфейса может не совпасть с сидом (смена списка городов в новой
 * версии). Тогда обычный INSERT падал бы «FOREIGN KEY constraint failed» —
 * опрос считался бы неудачным, счётчик провалов рос и приложение слало
 * тревожные уведомления при совершенно рабочей базе.
 */
export function saveLastRun(database: Database, city: string, at: string): void {
  database.run(
  `INSERT OR IGNORE INTO poll_meta (city, last_run) VALUES (?, ?)
     ON CONFLICT(city) DO UPDATE SET last_run = excluded.last_run`,
  [city, at],
  );
}

export function splitPairsFor(database: Database, ids: string[]): Set<string> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const stmt = database.prepare(
    `SELECT left_id, right_id FROM product_splits
     WHERE left_id IN (${placeholders}) OR right_id IN (${placeholders})`,
  );
  try {
    if (stmt.bind([...ids, ...ids])) {
      while (stmt.step()) {
        const o = stmt.getAsObject() as unknown as { left_id: string; right_id: string };
        out.add(matchSplitKey(o.left_id, o.right_id));
      }
    }
  } finally {
    stmt.free();
  }
  return out;
}

export function saveSplit(database: Database, a: string, b: string): void {
  if (a === b) throw new Error('db: разрыв склейки с самим собой не имеет смысла');
  const [left, right] = a < b ? [a, b] : [b, a];
  database.run('INSERT OR IGNORE INTO product_splits (left_id, right_id) VALUES (?, ?)', [left, right]);
}

export function removeSplit(database: Database, a: string, b: string): void {
  const [left, right] = a < b ? [a, b] : [b, a];
  database.run('DELETE FROM product_splits WHERE left_id = ? AND right_id = ?', [left, right]);
}

export function closeDb(): void {
  if (!db) return;
  try {
    db.close();
  } finally {
    db = null;
    storage = null;
  }
}

export function savePriceIfChanged(
  database: Database,
  p: {
    canonicalId: string;
    storeId: string;
    city: string;
    name: string;
    brand?: string | undefined;
    unit?: string | undefined;
    barcode?: string | undefined;
    price: number;
    promoPrice?: number | null | undefined;
    oldPrice?: number | null | undefined;
    inStock?: boolean | undefined;
    unitPrice?: string | null | undefined;
    imageUrl?: string | undefined;
    description?: string | undefined;
    url?: string | undefined;
    storeSku?: string | undefined;
  },
): 'inserted' | 'skipped' {
  if (!Number.isFinite(p.price) || p.price <= 0) throw new Error(`db: bad price ${p.price}`);
  database.run(
    `INSERT INTO products (id, name, brand, unit, barcode, image_url, description, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       brand = COALESCE(excluded.brand, products.brand),
       unit = COALESCE(excluded.unit, products.unit),
       barcode = COALESCE(excluded.barcode, products.barcode),
       image_url = COALESCE(excluded.image_url, products.image_url),
       description = COALESCE(excluded.description, products.description),
       updated_at = datetime('now')`,
    [
      p.canonicalId,
      p.name,
      p.brand ?? null,
      p.unit ?? 'шт',
      p.barcode ?? null,
      p.imageUrl ?? null,
      p.description ?? null,
    ],
  );

  if (p.storeSku || p.url) {
    database.run(
      `INSERT INTO product_links (canonical_id, store_id, store_sku, url, image_url, last_seen)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(canonical_id, store_id) DO UPDATE SET
         store_sku = excluded.store_sku, url = COALESCE(excluded.url, product_links.url),
         image_url = COALESCE(excluded.image_url, product_links.image_url),
         last_seen = datetime('now')`,
      [p.canonicalId, p.storeId, p.storeSku ?? p.canonicalId, p.url ?? null, p.imageUrl ?? null],
    );
  }

    const stmt = database.prepare(
      `SELECT price, promo_price, old_price, in_stock, unit_price FROM prices_history
       WHERE canonical_id = ? AND store_id = ? AND city = ?
       ORDER BY collected_at DESC, id DESC LIMIT 1`,
    );
    let last:
      | { price: number; promo_price: number | null; old_price: number | null; in_stock: number; unit_price: string | null }
      | undefined;
  try {
    if (stmt.bind([p.canonicalId, p.storeId, p.city]) && stmt.step())
      last = stmt.getAsObject() as typeof last;
  } finally {
    stmt.free();
  }

  const inStock = p.inStock ?? true;
  // Три состояния: null = «скидки нет, наблюдал», undefined = «этот путь
  // скидку не отдаёт» (у Магнита fetchProduct в JSON-LD её не несёт) —
  // тогда берём прежнее значение, но только для той же цены: наблюдение
  // действительно лишь при той цене, под которой скидку видели. Всё
  // унаследованное перепроверяется против новой цены, иначе конец акции
  // остался бы в истории навсегда.
  const samePrice = last !== undefined && last.price === p.price;
  const rawPromo = p.promoPrice === undefined && samePrice ? (last?.promo_price ?? null) : p.promoPrice ?? null;
  const rawOld = p.oldPrice === undefined && samePrice ? (last?.old_price ?? null) : p.oldPrice ?? null;
  // unitPrice — то же трёхсостояние, иначе поиск Магнита («106,45 ₽/л» из DOM)
  // затирался бы первым же опросом: fetchProduct у него JSON-LD без цены за
  // единицу, то есть undefined, и без наследования в историю уходил NULL —
  // аннотация исчезала бы с полки, собранной из базы.
  const rawUnit = p.unitPrice === undefined && samePrice ? (last?.unit_price ?? null) : p.unitPrice ?? null;
  const promoPrice = validPromoPrice(rawPromo, p.price);
  const oldPrice = validOldPrice(rawOld, p.price) ? rawOld : null;
  if (
    last &&
    last.price === p.price &&
    last.promo_price === promoPrice &&
    last.old_price === oldPrice &&
    last.in_stock === (inStock ? 1 : 0) &&
    // unit_price тоже в условии: у весового товара цена фасовки может не
    // измениться, а цена за килограмм — поменяться (сеть перевесила товар).
    // Без этой строки на полке из кэша лежала бы устаревшая «₽/кг» рядом с
    // верной ценой, и write-on-change этого не замечал.
    last.unit_price === rawUnit
  ) {
    return 'skipped';
  }

  database.run(
    `INSERT INTO prices_history
     (canonical_id, store_id, city, price, promo_price, old_price, in_stock, unit_price)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p.canonicalId,
      p.storeId,
      p.city,
      p.price,
      promoPrice,
      oldPrice,
      inStock ? 1 : 0,
      rawUnit,
    ],
  );
  return 'inserted';
}

function validOldPrice(old: number | null, price: number): old is number {
  return old !== null && old > price && old / price < 5;
}

function validPromoPrice(promo: number | null, price: number): number | null {
  return promo !== null && promo < price ? promo : null;
}
