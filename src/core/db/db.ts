import initSqlJs, { type Database } from 'sql.js';
import type { HistoryPoint } from '../../shared/api.js';
import { matchSplitKey } from '../../shared/matching.js';
import { UNKNOWN_STORE_CODE, type ScrapedProduct } from '../../shared/types.js';
import type { AppStorage } from '../platform.js';
import { SCHEMA } from './schema.js';

let db: Database | null = null;
let storage: AppStorage | null = null;

/**
 * Ключ цены. Сеть, город И код точки: цена принадлежит конкретному магазину, а
 * не «магазину вообще». Без кода две точки одной сети в городе делят и цену, и
 * историю — именно такое и случилось при смене кода магазина в СПб.
 */
export interface PriceKey {
  canonicalId: string;
  storeId: string;
  city: string;
  storeCode: string;
}

/** Строковый вид ключа для Map: код точки обязателен, иначе точки слипаются. */
export function priceKeyId(k: PriceKey): string {
  return `${k.storeId}:${k.canonicalId}:${k.city}:${k.storeCode}`;
}

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
export const SCHEMA_VERSION = 3;

/**
 * Колонки, которых в старой базе не было, и значения для них при переносе.
 * Ключ должен совпадать с тем, чем колонка объявлена в schema.sql, иначе
 * миграция напишет в базу значение, которого сама схема не вправе принять.
 */
const COLUMN_DEFAULTS: Readonly<Record<string, string>> = {
  store_code: `'?'`,
  city: `''`,
  store_id: `''`,
};

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
    stmt.bind([table]);
    return stmt.step();
  } finally {
    stmt.free();
  }
}

/**
 * DDL таблицы берётся ИЗ СХЕМЫ, а не пишется здесь руками.
 *
 * Почему так: миграция обязана создавать ровно ту же таблицу, что и свежая
 * база. Две копии DDL разъезжаются при первой же правке схемы, и тогда
 * предикаты формы решают, что уже пересобранная база «ещё не в новой форме», и
 * пересобирают её при каждом запуске — то есть на каждом старте приложения.
 */
function createTableDdl(table: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const at = SCHEMA.indexOf(marker);
  /* c8 ignore start — схема вшита в сборку, а таблицы перечислены в коде
     рядом: отсутствие таблицы означает правку схемы без правки кода. Ветка
     недостижима в рантайме, но оставлена внятной ошибкой, а не undefined. */
  if (at < 0) throw new Error(`db: в схеме нет таблицы ${table}`);
  // Конец ищем по БАЛАНСУ скобок, а не по первому `);`: будущий CHECK или
  // DEFAULT с `);` внутри дал бы молча обрезанную таблицу без ключа, и
  // перенос сломался бы на данных, а не на схеме.
  let depth = 0;
  for (let i = at + marker.length - 1; i < SCHEMA.length; i++) {
    const ch = SCHEMA[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return SCHEMA.slice(at, i + 1);
    }
  }
  throw new Error(`db: не нашёлся конец CREATE TABLE для ${table}`);
  /* c8 ignore stop */
}

/** Все индексы таблицы — тоже из схемы, по той же причине. */
function indexDdl(table: string): string[] {
  // `\s+`, а не пробел: в schema.sql индексы записаны в две строки («CREATE
  // INDEX … \n  ON таблица (…);»), и регулярка с одним пробелом молча находила
  // бы только однострочные — то есть на перенесённой базе старый индекс
  // остался бы навсегда, а CREATE INDEX IF NOT EXISTS его бы не починил.
  const re = new RegExp(`CREATE INDEX IF NOT EXISTS \\w+\\s+ON ${table} \\([^;]*;`, 'g');
  return SCHEMA.match(re) ?? [];
}

function recreateIndexes(database: Database, table: string): void {
  for (const ddl of indexDdl(table)) {
    const name = ddl.match(/CREATE INDEX IF NOT EXISTS (\w+)/)?.[1];
    // CREATE INDEX IF NOT EXISTS оставил бы СТАРОЕ определение, поэтому
    // старый индекс сносим явно: иначе он остался бы без колонки точки.
    if (name) database.run(`DROP INDEX IF EXISTS ${name}`);
    database.run(ddl);
  }
}

/**
 * Пересборка таблицы под новую форму. Порядок операций здесь не косметика:
 *
 * 1. `PRAGMA foreign_keys = OFF` — и ДО BEGIN, потому что внутри транзакции
 *    SQLite эту настройку игнорирует. При включённых ключах одна сирота
 *    (canonical_id без строки в products) роняет перенос, исключение
 *    пробрасывается из openDb, а openDatabase() его глотает и отдаёт
 *    `database: null`: цены на экране есть, а история, полки и избранное мертвы.
 * 2. Сами сироты проверяются ДО переноса (assertNoBrokenForeignKeys), а не
 *    после каждой таблицы: проверка после переноса увидела бы сироту в ещё не
 *    пересобранной таблице и остановила перенос там, где он не виноват.
 */
function rebuildTable(
  database: Database,
  table: string,
  cols: string[],
  where: string | null,
): void {
  const legacy = `${table}__legacy_fix`;
  const list = cols.join(', ');
  database.run('PRAGMA foreign_keys = OFF');
  // BEGIN — ДО try. Если он сам падает, откатывать нечего, а вложенный
  // try/catch вокруг ROLLBACK был бы мёртвым кодом: в закрытой транзакции
  // SQLite бросает на ROLLBACK, и этим затиралась бы исходная ошибка.
  database.run('BEGIN');
  try {
    database.run(`ALTER TABLE ${table} RENAME TO ${legacy}`);
    database.run(createTableDdl(table));
    // Копируем не «те же имена», а выражения: колонки, которых в старой
    // таблице не было, в SELECT из legacy не существуют. Без алиаса с
    // заглушкой перенос падал бы «no such column: store_code» на первой же
    // старой базе — то есть ровно там, где миграция нужна.
    const legacyCols = columns(database, legacy);
    /* c8 ignore start -- заглушка 'NULL' недостижима: copiedColumns отдаёт
       только колонки, для которых в COLUMN_DEFAULTS есть значение. Если
       когда-нибудь появится колонка без значения по умолчанию, вставка в
       NOT NULL упадёт сама — громко и без потери строк. */
    const selectList = cols
      .map((c) => (legacyCols.has(c) ? c : `${COLUMN_DEFAULTS[c] ?? 'NULL'} AS ${c}`))
      .join(', ');
    /* c8 ignore stop */
    const filter = where ? ` WHERE ${where}` : '';
    database.run(`INSERT INTO ${table} (${list}) SELECT ${selectList} FROM ${legacy}${filter}`);
    database.run(`DROP TABLE ${legacy}`);
    recreateIndexes(database, table);
    database.run('COMMIT');
  } catch (err) {
    database.run('ROLLBACK');
    throw err;
  } finally {
    database.run('PRAGMA foreign_keys = ON');
  }
}

/** Таблица уже новой формы — пересборка не нужна. */
function pkIs(database: Database, table: string, expected: string[]): boolean {
  const pk = primaryKey(database, table);
  return expected.every((c) => pk.includes(c)) && pk.length === expected.length;
}

/**
 * Отказ до переноса, если в базе есть строки с нарушенными ссылками.
 *
 * Ошибка называет конкретную таблицу и товар: иначе пользователь видел бы
 * «миграция остановлена» без указания, что именно чинить, а база оставалась
 * бы в старой форме навсегда.
 */
function assertNoBrokenForeignKeys(database: Database): void {
  const broken = database.exec('PRAGMA foreign_key_check');
  // Колонки отчёта: таблица, rowid строки, ЧЕМУ ССЫЛАЕТСЯ (родительская
  // таблица), идентификатор ограничения. Третий столбец — не «товар»:
  // печатать его значило бы врать в сообщении об ошибке.
  const first = broken[0]?.values?.[0] as unknown[] | undefined;
  if (!first) return;
  throw new Error(
    `db: перенос на ключ с кодом точки остановлен — в таблице ${String(first[0])} строка #${String(
      first[1],
    )} ссылается на отсутствующую запись в ${String(first[2])}. База не тронута, копия сохранена.`,
  );
}

/** Значение по умолчанию для колонок, которых в старой таблице не было. */
function copiedColumns(old: Set<string>, wanted: string[]): string[] {
  return wanted.filter((c) => old.has(c) || COLUMN_DEFAULTS[c] !== undefined);
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
  //
  // DDL здесь написан руками, а не берётся из SCHEMA как в rebuildTable: эта
  // ветка чинит базу 1.0.0, где у favorites ещё НЕТ колонок store_id/city, а
  // схема их требует. Пересборка из схемы требовала бы предварительно
  // создавать эти колонки — то есть снова две копии DDL, которых правило выше
  // и охотится. Шаг 2 Фазы 6 доведёт эту таблицу до формы схемы через
  // migrateStoreCodes, который DDL уже берёт из SCHEMA.
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
  // Индекс пересоздаём: после переименования таблицы он уехал вместе с
  // ней, а новая таблица создаётся уже с новым именем.
  recreateIndexes(database, 'favorites');
}

/**
 * Перевод БД на схему с кодами точек (фаза 6, шаг 2).
 *
 * Правило простое и оно единственное: `store_code` становится частью ключа
 * везде, где ключ описывает цену или раскладку. Перенесённые строки получают
 * `'?'` — «любая точка этой сети в этом городе» для избранного и раскладки,
 * «точка неизвестна» для истории цен. Историю не размножаем: новая точка — это
 * новая линия, а не продолжение старой, иначе смена кода в справочнике склеила бы
 * кривые разных магазинов.
 */
function migrateStoreCodes(database: Database): void {
  if (tableExists(database, 'stores') && !pkIs(database, 'stores', ['id', 'city', 'external_store_id'])) {
    const old = columns(database, 'stores');
    rebuildTable(
      database,
      'stores',
      copiedColumns(old, ['id', 'city', 'external_store_id', 'name', 'address']),
      null,
    );
  }

  if (tableExists(database, 'product_links') && !pkIs(database, 'product_links', ['canonical_id', 'store_id', 'city', 'store_code'])) {
    const old = columns(database, 'product_links');
    rebuildTable(
      database,
      'product_links',
      copiedColumns(old, ['canonical_id', 'store_id', 'city', 'store_code', 'store_sku', 'url', 'image_url', 'last_seen']),
      'canonical_id IN (SELECT id FROM products)',
    );
    // В 1.3.x у product_links не было города, поэтому перенос подставил бы
    // пустую строку. Но город известен — он есть в истории по той же паре
    // (canonical_id, store_id): ссылка на товар сети относится к тому же
    // городу, где этот товар смотрели. Без этого город в ключе ссылки был бы
    // выдуманным, и запросы по ключу не нашли бы перенесённую строку.
    if (!old.has('city')) {
      database.run(
        `UPDATE product_links SET city = (
           SELECT h.city FROM prices_history h
           WHERE h.canonical_id = product_links.canonical_id AND h.store_id = product_links.store_id
           ORDER BY h.id DESC LIMIT 1)
         WHERE city = ''`,
      );
    }
  }

  if (tableExists(database, 'poll_checklist') && !pkIs(database, 'poll_checklist', ['city', 'store_id', 'store_code', 'canonical_id'])) {
    const old = columns(database, 'poll_checklist');
    rebuildTable(
      database,
      'poll_checklist',
      copiedColumns(old, ['city', 'store_id', 'store_code', 'canonical_id']),
      null,
    );
  }

  if (tableExists(database, 'favorites') && !pkIs(database, 'favorites', ['canonical_id', 'store_id', 'city', 'store_code'])) {
    const old = columns(database, 'favorites');
    rebuildTable(
      database,
      'favorites',
      copiedColumns(old, ['canonical_id', 'store_id', 'city', 'store_code', 'target_price', 'notified_price', 'created_at']),
      'canonical_id IN (SELECT id FROM products)',
    );
  }

  if (tableExists(database, 'product_categories') && !pkIs(database, 'product_categories', ['canonical_id', 'store_id', 'city', 'store_code', 'category_id'])) {
    const old = columns(database, 'product_categories');
    rebuildTable(
      database,
      'product_categories',
      copiedColumns(old, ['canonical_id', 'store_id', 'city', 'store_code', 'category_id', 'created_at']),
      'canonical_id IN (SELECT id FROM products) AND category_id IN (SELECT id FROM our_categories)',
    );
  }

  if (tableExists(database, 'product_category_manual') && !pkIs(database, 'product_category_manual', ['canonical_id', 'store_id', 'city', 'store_code'])) {
    const old = columns(database, 'product_category_manual');
    rebuildTable(
      database,
      'product_category_manual',
      copiedColumns(old, ['canonical_id', 'store_id', 'city', 'store_code', 'created_at']),
      'canonical_id IN (SELECT id FROM products)',
    );
  }

  // prices_history: первичный ключ автоинкрементный и не меняется, поэтому
  // хватает добавления колонки. Индекс приходится сносить и создавать заново:
  // CREATE INDEX IF NOT EXISTS оставил бы прежнее определение без кода точки.
  if (tableExists(database, 'prices_history') && !columns(database, 'prices_history').has('store_code')) {
    database.run(`ALTER TABLE prices_history ADD COLUMN store_code TEXT NOT NULL DEFAULT '?'`);
    recreateIndexes(database, 'prices_history');
  }
}

function migrate(database: Database): void {
  migrateFavorites(database);
  migrateStoreCodes(database);
  database.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** Хотя бы одна таблица ещё без кода точки — значит нужна пересборка. */
function needsStoreCodeMigration(database: Database): boolean {
  // Проверяются ВСЕ таблицы, а не только цены: перенос мог не довести базу до
  // конца (например, файл собрали из частично перенесённой копии), и тогда цены
  // уже с кодом, а полки и избранное — нет. Предикат по одной таблице молча
  // согласился бы переписать такую базу без копии.
  //
  // Важно: при обычной работе оборванный перенос файла не оставляет — база
  // живёт в памяти (sql.js) и на диск попадает только целиком, из persistDb.
  // Поэтому этот предикат — про состояние файла, а не про сбой при запуске.
  if (tableExists(database, 'prices_history') && !columns(database, 'prices_history').has('store_code')) {
    return true;
  }
  const forms: readonly (readonly [string, readonly string[]])[] = [
    ['stores', ['id', 'city', 'external_store_id']],
    ['product_links', ['canonical_id', 'store_id', 'city', 'store_code']],
    ['poll_checklist', ['city', 'store_id', 'store_code', 'canonical_id']],
    ['favorites', ['canonical_id', 'store_id', 'city', 'store_code']],
    ['product_categories', ['canonical_id', 'store_id', 'city', 'store_code', 'category_id']],
    ['product_category_manual', ['canonical_id', 'store_id', 'city', 'store_code']],
  ];
  return forms.some(([table, pk]) => tableExists(database, table) && !pkIs(database, table, [...pk]));
}

export async function openDb(store: AppStorage): Promise<Database> {
  if (db) {
    // Два разных хранилища в одном процессе — это два разных приложения
    // (или два теста). Молча отдать чужую базу значит писать цены не туда.
    if (storage !== store) throw new Error('db: база уже открыта на другом хранилище (closeDb() прежде)');
    return db;
  }
  // Путь к wasm задаёт оболочка: на Electron это файл в node_modules, на
  // Android — ассет со своим хешем в имени. Без locateFile sql.js ищет wasm
  // рядом с документом и получает 404, то есть база не открывается вовсе.
  const SQL = await initSqlJs(store.wasmUrl ? { locateFile: () => store.wasmUrl! } : {});
  const existing = store.readDb();
  const loaded = existing ? new SQL.Database(existing) : new SQL.Database();
  // SQLite выключает внешние ключи по умолчанию — без этого REFERENCES в
  // схеме декоративны и product_categories мог бы ссылать в пустоту.
  loaded.run('PRAGMA foreign_keys = ON');
  try {
    if (existing && needsStoreCodeMigration(loaded)) {
      // Копия — до первой пересборки, а не после: откатить перенос истории
      // после первой же записи будет нечем.
      store.backupDb(existing);
      // Сироты проверяются только когда перенос действительно начинается:
      // полный FK-скан на каждом старте приложения стоил бы времени на
      // каждой базе, а чинить нарушения, до которых переноса не касается,
      // нечем — перенос их всё равно отбросит фильтрами.
      assertNoBrokenForeignKeys(loaded);
    }
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
 * Последняя записанная цена по набору ключей (canonicalId, storeId, city,
 * storeCode).
 *
 * Нужна избранному и проверке порогов: там интересует ТОЛЬКО текущая цена,
 * а getPriceHistory отдаёт первые N строк по возрастанию — на товаре с историей
 * длиннее N это была бы цена из далёкого прошлого, и уведомление о снижении
 * пришло бы по цене, которой уже нет (и наоборот, реальное снижение
 * пропускалось).
 *
 * Форма запроса отличается от последней строки в savePriceIfChanged: там
 * совпадение по коду точки строгое (иначе новая точка продолжила бы чужую
 * линию), а тут ключ с перенесённым кодом «любая точка» должен увидеть свежую
 * ЛЮБУЮ линию — иначе избранное висело бы на допереносной цене.
 */
export function latestPrices(
  database: Database,
  keys: PriceKey[],
): Map<string, HistoryPoint> {
  const out = new Map<string, HistoryPoint>();
  if (keys.length === 0) return out;
  // Читаем одним запросом на ключ: их десятки, а не тысячи, и sqlite.js
  // заметно дешевле одного prepare на каждый отмеченный товар.
  const stmt = database.prepare(
    `SELECT price, promo_price, old_price, in_stock, collected_at FROM prices_history
     WHERE canonical_id = ? AND store_id = ? AND city = ?
       AND (? = '?' OR store_code = ? OR store_code = '?')
     ORDER BY (store_code = '?') ASC, collected_at DESC, id DESC LIMIT 1`,
  );
  try {
    for (const k of keys) {
      try {
        // Код точки входит в ключ цены. Условие из трёх частей:
        //   `? = '?'` — сам ключ перенесённый («любая точка этой сети»), и тогда
        //     подходит ЛЮБАЯ линия: перенесённая отметка избранного не должна
        //     показывать цену, которая замерялась до появления точек, — иначе в
        //     избранном встала бы мёртвая цена и проверка порога сравнивала бы
        //     её с порогом, то есть слала бы ложное уведомление;
        //   `store_code = ?` — реальная линия самой точки;
        //   `store_code = '?'` — перенесённая строка как запасной вариант.
        // Сортировка выносит реальную линию (store_code <> '?') выше
        // перенесённой, поэтому допереносная строка не перебивает свежую.
        stmt.bind([k.canonicalId, k.storeId, k.city, k.storeCode, k.storeCode]);
        if (stmt.step()) {
          const o = stmt.getAsObject() as unknown as HistoryPoint;
          out.set(priceKeyId(k), o);
        }
      } catch {
        // Непринимаемое значение пропускаем: одно битое поле не должно
        // убирать цены у остальных ключей запроса.
      }
    }
  } finally {
    stmt.free();
  }
  return out;
}

export function getPriceHistory(
  database: Database,
  args: PriceKey & { limit?: number },
): HistoryPoint[] {
  const stmt = database.prepare(
    `SELECT price, promo_price, old_price, in_stock, collected_at FROM prices_history
     WHERE canonical_id = ? AND store_id = ? AND city = ? AND store_code = ?
     ORDER BY collected_at ASC, id ASC LIMIT ?`,
  );
  const rows: HistoryPoint[] = [];
  try {
    // Точное совпадение кода: история точки и перенесённая линия «любая точка»
    // на одном графике — это ровно тот дефект, ради которого фаза и затевалась.
    stmt.bind([args.canonicalId, args.storeId, args.city, args.storeCode, args.limit ?? 500]);
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as HistoryPoint);
  } finally {
    stmt.free();
  }
  return rows;
}

export interface TrackedProduct {
  canonicalId: string;
  storeId: string;
  /**
   * Код ТОЧКИ, к которой относится отслеживание. Именно он делает целью опроса:
   * у двух точек одной сети canonicalId совпадает, и без кода опрос бил бы по
   * первой точке, а цены второй оставались бы вечно старыми.
   *
   * Сентинел `?` — отслеживание без точки (перенесённая запись, товар из
   * локальной базы). Такой товар опрашивается по первой рабочей точке сети
   * города, и цена материализуется в её ключ: точки, к которой он относился,
   * просто нет.
   */
  storeCode: string;
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
    `SELECT DISTINCT h.canonical_id, h.store_id, h.city, h.store_code, COALESCE(p.name, '') AS name
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
        store_code: string;
        name: string;
      };
      rows.push({
        canonicalId: o.canonical_id,
        storeId: o.store_id,
        city: o.city,
        storeCode: o.store_code,
        name: o.name,
      });
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

// storeCode здесь едет из ответа адаптера, но перебивается вызывающим рядом с
// storeId и city — так же, как они перебиваются на ОПРОШЕННУЮ сеть
// (storeItems, scheduler). Источник кода на этом шаге один: справочник точек.
// Подставлять код отсюда нельзя — это эхо конфига, и как только в городе
// появится вторая точка, товар точки А уедет в ключ с кодом точки Б.
// Подтверждение кода сетью появляется на шаге 5 фазы 6.
export function toPriceInput(p: ScrapedProduct) {
  return {
    canonicalId: p.canonicalId,
    storeId: p.storeId,
    city: p.city,
    // Код точки едет из ответа адаптера и перебивается вызывающим рядом с
    // storeId и city — так же, как они перебиваются на ОПРОШЕННУЮ точку.
    // Вызывающий обязан сверить код с запрошенной точкой сам (см. storeItems
    // и pollOnce): sentinel «не подтвердила» заменяется на код точки, чужой
    // код — отбрасывается громко.
    storeCode: p.storeCode,
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
  /**
   * Код точки, к которой относится строка.
   *
   * Обязателен: полка из базы показывается по коду точки в интерфейсе, и блок с
   * sentinel `?` отфильтровывался бы целиком, то есть обычная полка «Не
   * разложено» молча пустела бы, а пустое состояние врало бы «сеть не вернула».
   */
  storeCode: string;
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
    `SELECT pc.canonical_id, pc.store_id, pc.store_code, p.name, p.image_url, p.unit, p.brand,
            (SELECT s.url FROM (
               SELECT pl.url AS url, pl.last_seen AS last_seen,
                      CASE WHEN pc.store_code <> '?' AND pl.store_code = pc.store_code THEN 0
                           WHEN pl.store_code <> '?' THEN 1
                           ELSE 2
                      END AS rank
               FROM product_links pl
               WHERE pl.canonical_id = pc.canonical_id AND pl.store_id = pc.store_id
                 AND pl.city = pc.city
                 AND (pc.store_code = '?' OR pl.store_code = pc.store_code OR pl.store_code = '?')
             ) s ORDER BY s.rank, s.last_seen DESC LIMIT 1) AS url,
            last.price, last.promo_price, last.old_price, last.in_stock, last.collected_at, last.unit_price
     FROM product_categories pc
     JOIN products p ON p.id = pc.canonical_id
     JOIN prices_history last ON last.id = (
       SELECT id FROM prices_history h
       WHERE h.canonical_id = pc.canonical_id AND h.store_id = pc.store_id AND h.city = pc.city
         AND (pc.store_code = '?' OR h.store_code = pc.store_code OR h.store_code = '?')
       ORDER BY (h.store_code = '?') ASC, h.id DESC LIMIT 1
     )
     WHERE pc.city = ? AND pc.category_id = ?
     ORDER BY last.collected_at DESC, pc.canonical_id
     LIMIT ?`,
  );
  const rows: CachedCategoryRow[] = [];
  try {
    stmt.bind([args.city, args.categoryId, args.limit ?? 300]);
    while (stmt.step()) {
      const o = stmt.getAsObject() as unknown as {
        canonical_id: string;
        store_id: ScrapedProduct['storeId'];
        store_code: string;
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
        storeCode: o.store_code,
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
    `SELECT h.canonical_id, h.store_id, h.store_code, p.name, p.image_url, p.unit, p.brand,
            (SELECT s.url FROM (
               SELECT pl.url AS url, pl.last_seen AS last_seen,
                      CASE WHEN h.store_code <> '?' AND pl.store_code = h.store_code THEN 0
                           WHEN pl.store_code <> '?' THEN 1
                           ELSE 2
                      END AS rank
               FROM product_links pl
               WHERE pl.canonical_id = h.canonical_id AND pl.store_id = h.store_id
                 AND pl.city = h.city
                 AND (h.store_code = '?' OR pl.store_code = h.store_code OR pl.store_code = '?')
             ) s ORDER BY s.rank, s.last_seen DESC LIMIT 1) AS url,
            h.price, h.promo_price, h.old_price, h.in_stock, h.collected_at, h.unit_price
     FROM prices_history h
     JOIN products p ON p.id = h.canonical_id
     WHERE h.city = ?
       AND h.id = (SELECT id FROM prices_history h2
                   WHERE h2.canonical_id = h.canonical_id AND h2.store_id = h.store_id AND h2.city = h.city
                     AND (h.store_code = '?' OR h2.store_code = h.store_code OR h2.store_code = '?')
                   ORDER BY (h2.store_code = '?') ASC, h2.id DESC LIMIT 1)
       AND NOT EXISTS (
         SELECT 1 FROM product_categories pc
          WHERE pc.canonical_id = h.canonical_id AND pc.store_id = h.store_id AND pc.city = h.city
            AND pc.store_code = h.store_code
       )
     ORDER BY h.collected_at DESC
     LIMIT ?`,
  );
  const rows: CachedCategoryRow[] = [];
  try {
    stmt.bind([args.city, args.limit ?? 300]);
    while (stmt.step()) {
      const o = stmt.getAsObject() as unknown as {
        canonical_id: string;
        store_id: ScrapedProduct['storeId'];
        store_code: string;
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
        storeCode: o.store_code,
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
  } finally {
    stmt.free();
  }
  return rows;
}

export function saveProductCategory(
  database: Database,
  rows: (PriceKey & { categoryId: string })[],
): void {
  if (rows.length === 0) return;
  database.run('BEGIN');
  try {
    // Перенесённая раскладка лежит под кодом '?'. Автораскладка пишет по
    // конкретной точке, ключи разные, и INSERT OR IGNORE их не бы склеил — товар
    // просто оказался бы на полке дважды. Поэтому сперва поднимаем перенесённые
    // строки по тем же тройкам (товар, сеть, город), что и в этой пачке.
    const lift = database.prepare(
      `DELETE FROM product_categories
       WHERE store_code = '?' AND category_id IN (${[...new Set(rows.map((r) => r.categoryId))]
         .map(() => '?')
         .join(', ')})
         AND (canonical_id, store_id, city) IN (VALUES ${rows.map(() => '(?, ?, ?)').join(', ')})`,
    );
    const stmt = database.prepare(
      `INSERT OR IGNORE INTO product_categories (canonical_id, store_id, city, store_code, category_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    try {
      const triples: (string | number | null)[] = [];
      for (const r of rows) triples.push(r.canonicalId, r.storeId, r.city);
      lift.run([...[...new Set(rows.map((r) => r.categoryId))], ...triples]);
      for (const r of rows) {
        stmt.run([r.canonicalId, r.storeId, r.city, r.storeCode, r.categoryId]);
      }
    } finally {
      lift.free();
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
export type ShelfScope = PriceKey;

/**
 * Какие товары в этой точке и городе под ручным управлением.
 *
 * Ручная раскладка — поточечная (store_code в product_category_manual есть), и
 * фильтр по сети тут был бы ошибкой: автораскладка точки B молча выключалась бы
 * из-за того, что тот же товар руками разложили в точке A. Поэтому сверяем код
 * точки, а строка '?' (раскладка, сделанная до появления точек) действует на все
 * точки сети — как и в остальных местах выборки по scope.
 */
export function manualShelfIds(
  database: Database,
  storeId: string,
  city: string,
  storeCode?: string,
): Set<string> {
  const stmt = database.prepare(
    storeCode === undefined
      ? 'SELECT canonical_id FROM product_category_manual WHERE store_id = ? AND city = ?'
      : "SELECT canonical_id FROM product_category_manual WHERE store_id = ? AND city = ? AND (store_code = ? OR store_code = '?')",
  );
  const ids = new Set<string>();
  try {
    stmt.bind(storeCode === undefined ? [storeId, city] : [storeId, city, storeCode]);
    while (stmt.step()) {
      const o = stmt.getAsObject() as unknown as { canonical_id: string };
      ids.add(o.canonical_id);
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
    // Как в isFavorite: перенесённая строка («любая точка этой сети») —
    // запасной вариант для карточки товара, а не отдельная раскладка. Иначе
    // после переноса товар был бы виден в списке полки, но карточка говорила
    // бы «не разложено» — то есть полка и карточка врали бы друг другу.
    `SELECT category_id FROM product_categories
     WHERE canonical_id = ? AND store_id = ? AND city = ? AND (store_code = ? OR store_code = '?')
     ORDER BY category_id`,
  );
  const categoryIds: string[] = [];
  try {
    read.bind([scope.canonicalId, scope.storeId, scope.city, scope.storeCode]);
    while (read.step()) {
      const o = read.getAsObject() as unknown as { category_id: string };
      categoryIds.push(o.category_id);
    }
  } finally {
    read.free();
  }
  const marker = database.prepare(
    `SELECT 1 FROM product_category_manual
     WHERE canonical_id = ? AND store_id = ? AND city = ? AND (store_code = ? OR store_code = '?')`,
  );
  let manual = false;
  try {
    marker.bind([scope.canonicalId, scope.storeId, scope.city, scope.storeCode]);
    manual = marker.step();
  } finally {
    marker.free();
  }
  return { categoryIds: [...new Set(categoryIds)], manual };
}

/**
 * Перезаписывает набор полок товара. Пишем диффом, а не «удалить всё и вставить
 * заново»: у полок, которые остаются, должен сохраниться created_at — по нему
 * видно, с какого числа товар на этой полке.
 *
 * Исключение — перенесённые строки ('?'): они снимаются всегда. Иначе товар
 * остался бы на полке дважды (строка точки и строка «любая точка»), и снять
 * его было бы нечем. Цена этого решения: дата перенесённой полки не
 * переносится в новую строку, поэтому после первого ручного касания отсчёт
 * «с какого числа на полке» начинается заново.
 */
export function setProductShelves(database: Database, scope: ShelfScope, categoryIds: string[]): void {
  database.run('BEGIN');
  try {
    // Перенесённая строка («любая точка этой сети») — та же самая раскладка,
    // просто без кода точки. Оставлять её рядом с новой значило бы показать
    // товар на полке дважды и не дать убрать его: DELETE по коду точки её не
    // видит. Поэтому снимаем её ВСЕГДА, а запись делаем по своей точке.
    database.run(
      `DELETE FROM product_categories
       WHERE canonical_id = ? AND store_id = ? AND city = ? AND store_code = '?'`,
      [scope.canonicalId, scope.storeId, scope.city],
    );
    database.run(
      `DELETE FROM product_category_manual
       WHERE canonical_id = ? AND store_id = ? AND city = ? AND store_code = '?'`,
      [scope.canonicalId, scope.storeId, scope.city],
    );
    // Пустой набор — это отдельный SQL, а не `NOT IN ()`: в SQLite выражения
    // нет, и подстановка `NOT IN (NULL)` даёт NULL, а не TRUE, то есть не
    // удаляет ничего. Именно на этом «убрать со всех полок» молча сломалось бы.
    const drop = categoryIds.length
      ? database.prepare(
          `DELETE FROM product_categories
           WHERE canonical_id = ? AND store_id = ? AND city = ? AND store_code = ?
             AND category_id NOT IN (${categoryIds.map(() => '?').join(',')})`,
        )
      : database.prepare(
          `DELETE FROM product_categories
           WHERE canonical_id = ? AND store_id = ? AND city = ? AND store_code = ?`,
        );
    const add = database.prepare(
      `INSERT OR IGNORE INTO product_categories (canonical_id, store_id, city, store_code, category_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const mark = database.prepare(
      `INSERT OR IGNORE INTO product_category_manual (canonical_id, store_id, city, store_code)
       VALUES (?, ?, ?, ?)`,
    );
    try {
      drop.run([scope.canonicalId, scope.storeId, scope.city, scope.storeCode, ...categoryIds]);
      for (const categoryId of categoryIds) {
        add.run([scope.canonicalId, scope.storeId, scope.city, scope.storeCode, categoryId]);
      }
      mark.run([scope.canonicalId, scope.storeId, scope.city, scope.storeCode]);
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
    // Перенесённая строка — та же раскладка без кода точки: её тоже надо
    // снять, иначе после возврата под автораскладку товар навсегда остался бы
    // вторым экземпляром на полке, и автораскладка его больше не чинила.
    const dropCats = database.prepare(
      `DELETE FROM product_categories
       WHERE canonical_id = ? AND store_id = ? AND city = ? AND (store_code = ? OR store_code = '?')`,
    );
    const dropMark = database.prepare(
      `DELETE FROM product_category_manual
       WHERE canonical_id = ? AND store_id = ? AND city = ? AND (store_code = ? OR store_code = '?')`,
    );
    try {
      dropCats.run([scope.canonicalId, scope.storeId, scope.city, scope.storeCode]);
      dropMark.run([scope.canonicalId, scope.storeId, scope.city, scope.storeCode]);
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
  storeCode: string;
  targetPrice: number | null;
  /** Цена последнего уведомления: ниже неё сообщаем, выше — молчим. */
  notifiedPrice: number | null;
}

export interface FavoriteScope {
  canonicalId: string;
  storeId: string;
  city: string;
  storeCode: string;
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
    `SELECT canonical_id, store_id, city, store_code, target_price, notified_price FROM favorites ${where} ORDER BY created_at DESC`,
  );
  const rows: FavoriteRow[] = [];
  try {
    // Пустой список параметров — это запрос «вообще без WHERE», а не отказ
    // привязки, поэтому bind вызывается безусловно.
    stmt.bind(params);
    while (stmt.step()) {
      const o = stmt.getAsObject() as unknown as {
        canonical_id: string;
        store_id: string;
        city: string;
        store_code: string;
        target_price: number | null;
        notified_price: number | null;
      };
      rows.push({
        canonicalId: o.canonical_id,
        storeId: o.store_id,
        city: o.city,
        storeCode: o.store_code,
        targetPrice: o.target_price,
        notifiedPrice: o.notified_price,
      });
    }
  } finally {
    stmt.free();
  }
  // Перенесённая отметка и отметка той же пары «товар+сеть+город», сделанная
  // уже по конкретной точке, — это ОДНО предложение, а не два. Показывая обе,
  // избранное дублировало бы товар, причём одна строка навсегда висела бы на
  // допереносной цене. Поэтому точная отметка побеждает, а перенесённая
  // показывается только когда точной ещё нет.
  const exact = new Set(
    rows.filter((r) => r.storeCode !== UNKNOWN_STORE_CODE).map((r) => `${r.storeId}:${r.canonicalId}:${r.city}`),
  );
  return rows.filter(
    (r) => r.storeCode !== UNKNOWN_STORE_CODE || !exact.has(`${r.storeId}:${r.canonicalId}:${r.city}`),
  );
}

/** Помечает цены, по которым уже сообщили, чтобы не сообщать о том же снова. */
export function saveNotifiedPrices(
  database: Database,
  rows: (PriceKey & { price: number })[],
): void {
  if (rows.length === 0) return;
  database.run('BEGIN');
  try {
    const stmt = database.prepare(
      `UPDATE favorites SET notified_price = ?
       WHERE canonical_id = ? AND store_id = ? AND city = ? AND store_code = ?`,
    );
    try {
      for (const r of rows) stmt.run([r.price, r.canonicalId, r.storeId, r.city, r.storeCode]);
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
    // Совпадение по коду точки ИЛИ по перенесённой строке: отметка, поставленная
    // до появления точек, относится ко всем точкам этой сети в городе.
    `SELECT 1 FROM favorites
     WHERE canonical_id = ? AND store_id = ? AND city = ? AND (store_code = ? OR store_code = '?')`,
  );
  try {
    stmt.bind([scope.canonicalId, scope.storeId, scope.city, scope.storeCode]);
    return stmt.step();
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
  database.run('BEGIN');
  try {
    // Заглушка товара — ВНУТРИ транзакции, вместе с самой отметкой: иначе
    // ошибка на шаг позже оставила бы в базе товар-заглушку без отметки.
    database.run(
      `INSERT OR IGNORE INTO products (id, name, unit, updated_at)
       VALUES (?, ?, ?, datetime('now'))`,
      // Имя-заглушка: первый настоящий замер перезапишет его (savePriceIfChanged
      // обновляет name), поэтому в интерфейсе товар не появится под ним.
      [scope.canonicalId, scope.canonicalId, 'шт'],
    );
    // Перенесённая отметка ('?') — та же отметка без кода точки. Переотметка по
    // своей точке заменяет перенесённую: оставить обе строки — значит держать
    // в базе вторую отметку того же товара и потерять notified_price, из-за
    // чего один и тот же порог сработал бы второй раз.
    const prior = database.prepare(
      `SELECT notified_price FROM favorites
       WHERE canonical_id = ? AND store_id = ? AND city = ? AND store_code = '?'`,
    );
    let notified: number | null = null;
    try {
      prior.bind([scope.canonicalId, scope.storeId, scope.city]);
      if (prior.step()) {
        const o = prior.getAsObject() as unknown as { notified_price: number | null };
        notified = o.notified_price;
      }
    } finally {
      prior.free();
    }
    database.run(
      `DELETE FROM favorites
       WHERE canonical_id = ? AND store_id = ? AND city = ? AND store_code = '?'`,
      [scope.canonicalId, scope.storeId, scope.city],
    );
    database.run(
      `INSERT INTO favorites (canonical_id, store_id, city, store_code, target_price, notified_price)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(canonical_id, store_id, city, store_code) DO UPDATE SET
         target_price = excluded.target_price,
         notified_price = COALESCE(favorites.notified_price, excluded.notified_price)`,
      [scope.canonicalId, scope.storeId, scope.city, scope.storeCode, targetPrice, notified],
    );
    database.run('COMMIT');
  } catch (err) {
    database.run('ROLLBACK');
    throw err;
  }
}

export function removeFavorite(database: Database, scope: FavoriteScope): void {
  // Ключ с кодом точки, но удаление должно снимать и перенесённую отметку
  // («любая точка этой сети»): она относится к тому же предложению, иначе
  // кнопка «убрать из избранного» молча ничего не делала бы.
  database.run(
    `DELETE FROM favorites
     WHERE canonical_id = ? AND store_id = ? AND city = ? AND (store_code = ? OR store_code = '?')`,
    [scope.canonicalId, scope.storeId, scope.city, scope.storeCode],
  );
}

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
    stmt.bind([city]);
    if (!stmt.step()) return null;
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

/**
 * Что уже проверено в текущем цикле опроса города.
 *
 * Возвращается ключом `storeId\u0000storeCode\u0000canonicalId`: пара «товар у
 * двух сетей» или «два товара одного магазина» склеились бы в одну строку
 * простым `${storeId}:${canonicalId}` — а id товара у нас начинается как раз с
 * названия сети (`lenta:12345`), то есть склейка не выдуманная, а реальная.
 * Код точки в ключе обязателен по той же причине: у двух точек одной сети
 * товар один и тот же, и без кода отметка первой точки скрыла бы вторую до
 * конца цикла.
 * Разделитель нулевой байт в id товара не встречается.
 *
 * Город фильтруется ДО чтения: без него в память тянулось бы 445 строк всех
 * городов ради 137 нужных.
 */
export function loadPollChecklist(database: Database, city: string): Set<string> {
  const stmt = database.prepare(
    'SELECT store_id, store_code, canonical_id FROM poll_checklist WHERE city = ?',
  );
  const out = new Set<string>();
  try {
    stmt.bind([city]);
    while (stmt.step()) {
      const o = stmt.getAsObject() as unknown as {
        store_id: string;
        store_code: string;
        canonical_id: string;
      };
      // Код точки в ключе обязателен: у двух точек одной сети canonicalId один,
      // и без кода отметка первой точки прятала бы вторую от опроса весь цикл.
      out.add(`${o.store_id}\u0000${o.store_code}\u0000${o.canonical_id}`);
    }
  } finally {
    stmt.free();
  }
  return out;
}

/**
 * Отметка «проверено в этом цикле».
 *
 * INSERT OR IGNORE: отметка ставится один раз на товар, но повтор возможен —
 * товар мог попасть в два вызова одного прогона, и обычный INSERT упал бы на
 * UNIQUE, уронив весь опрос на ровном месте.
 *
 * Роняет ли ошибка записи? Нет: она ловится вызывающим (см. планировщик).
 * Неразрешённая ошибка БД здесь означала бы, что следующий прогон этот товар
 * просто переспросит — цена при этом уже записана и переживёт выход из
 * приложения.
 */
export function markPollChecked(
  database: Database,
  city: string,
  storeId: string,
  storeCode: string,
  canonicalId: string,
): void {
  database.run(
    'INSERT OR IGNORE INTO poll_checklist (city, store_id, store_code, canonical_id) VALUES (?, ?, ?, ?)',
    [city, storeId, storeCode, canonicalId],
  );
}

/**
 * Цикл города пройден до конца — следующий прогон начинается с нуля.
 *
 * Чистит ВСЕ сети города, включая снятые пользователем галочками: сброс означает
 * «сначала», а не «потерять», поэтому фильтровать по текущему выбору здесь
 * незачем. Прерванный прогон сюда не доходит — он докачивает остаток позже.
 */
export function clearPollChecklist(database: Database, city: string): void {
  database.run('DELETE FROM poll_checklist WHERE city = ?', [city]);
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
export function splitPairsFor(database: Database, ids: string[]): Set<string> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const stmt = database.prepare(
    `SELECT left_id, right_id FROM product_splits
     WHERE left_id IN (${placeholders}) OR right_id IN (${placeholders})`,
  );
  try {
    try {
      // Отказ привязки здесь означает «id не из нашей БД» — теоретически
      // невозможно (список приходит из listCategoryProducts), и на практике мы
      // возвращаем пустой набор: разрывов нет — значит, склейка будет обычной.
      // Лучше тихо показать полку, чем уронить открытие интерфейса.
      stmt.bind([...ids, ...ids]);
    } catch {
      return out;
    }
    while (stmt.step()) {
      const o = stmt.getAsObject() as unknown as { left_id: string; right_id: string };
      out.add(matchSplitKey(o.left_id, o.right_id));
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
    storeCode: string;
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
    // Перенесённая ссылка (код '?') — та же ссылка без кода точки. Поднимаем её
    // перед записью: по одной ссылке на товар вместо двух — ссылка по
    // перенесённой строке и по точке. По одной ссылке на КАЖДУЮ точку, наоборот,
    // остаётся: разные точки дают разные адреса, и читающий запрос берёт
    // подходящую по рангу.
    if (p.storeCode !== UNKNOWN_STORE_CODE) {
      database.run(
        `DELETE FROM product_links
         WHERE canonical_id = ? AND store_id = ? AND city = ? AND store_code = '?'`,
        [p.canonicalId, p.storeId, p.city],
      );
    }
    database.run(
      `INSERT INTO product_links (canonical_id, store_id, city, store_code, store_sku, url, image_url, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(canonical_id, store_id, city, store_code) DO UPDATE SET
         store_sku = excluded.store_sku, url = COALESCE(excluded.url, product_links.url),
         image_url = COALESCE(excluded.image_url, product_links.image_url),
         last_seen = datetime('now')`,
      [
        p.canonicalId,
        p.storeId,
        p.city,
        p.storeCode,
        p.storeSku ?? p.canonicalId,
        p.url ?? null,
        p.imageUrl ?? null,
      ],
    );
  }

  const stmt = database.prepare(
    `SELECT price, promo_price, old_price, in_stock, unit_price FROM prices_history
     WHERE canonical_id = ? AND store_id = ? AND city = ? AND store_code = ?
     ORDER BY collected_at DESC, id DESC LIMIT 1`,
  );
  let last:
    | { price: number; promo_price: number | null; old_price: number | null; in_stock: number; unit_price: string | null }
    | undefined;
  try {
    stmt.bind([p.canonicalId, p.storeId, p.city, p.storeCode]);
    if (stmt.step()) last = stmt.getAsObject() as typeof last;
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
     (canonical_id, store_id, city, store_code, price, promo_price, old_price, in_stock, unit_price)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p.canonicalId,
      p.storeId,
      p.city,
      p.storeCode,
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