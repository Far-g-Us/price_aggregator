import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs, { type Database } from 'sql.js';
import type { HistoryPoint } from '../../shared/api.js';
import type { ScrapedProduct } from '../../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: Database | null = null;
let dbFile = '';

export async function openDb(dbPath?: string): Promise<Database> {
  if (db) return db;
  const SQL = await initSqlJs();
  dbFile = dbPath ?? path.join(__dirname, '../../../app-data/prices.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  db = fs.existsSync(dbFile)
    ? new SQL.Database(new Uint8Array(fs.readFileSync(dbFile)))
    : new SQL.Database();
  // SQLite выключает внешние ключи по умолчанию — без этого REFERENCES в
  // схеме декоративны и product_categories мог бы ссылаться в пустоту.
  db.run('PRAGMA foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);
  return db;
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
}

export function listTrackedProducts(database: Database): TrackedProduct[] {
  const stmt = database.prepare(
    `SELECT DISTINCT canonical_id, store_id, city FROM prices_history`,
  );
  const rows: TrackedProduct[] = [];
  try {
    while (stmt.step()) {
      const o = stmt.getAsObject() as unknown as {
        canonical_id: string;
        store_id: string;
        city: string;
      };
      rows.push({ canonicalId: o.canonical_id, storeId: o.store_id, city: o.city });
    }
  } finally {
    stmt.free();
  }
  return rows;
}

export function persistDb(database?: Database): void {
  const target = database ?? db;
  if (!target || !dbFile) return;
  fs.writeFileSync(dbFile, Buffer.from(target.export()));
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
}

export function listCategoryProducts(
  database: Database,
  args: { city: string; categoryId: string; limit?: number },
): CachedCategoryRow[] {
  const stmt = database.prepare(
    `SELECT pc.canonical_id, pc.store_id, p.name, p.image_url, p.unit, p.brand, pl.url,
            last.price, last.promo_price, last.old_price, last.in_stock, last.collected_at
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
            h.price, h.promo_price, h.old_price, h.in_stock, h.collected_at
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

export function closeDb(): void {
  if (!db) return;
  try {
    db.close();
  } finally {
    db = null;
    dbFile = '';
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
    `SELECT price, promo_price, old_price, in_stock FROM prices_history
     WHERE canonical_id = ? AND store_id = ? AND city = ?
     ORDER BY collected_at DESC, id DESC LIMIT 1`,
  );
  let last:
    | { price: number; promo_price: number | null; old_price: number | null; in_stock: number }
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
  const promoPrice = validPromoPrice(rawPromo, p.price);
  const oldPrice = validOldPrice(rawOld, p.price) ? rawOld : null;
  if (
    last &&
    last.price === p.price &&
    last.promo_price === promoPrice &&
    last.old_price === oldPrice &&
    last.in_stock === (inStock ? 1 : 0)
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
      p.unitPrice ?? null,
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
