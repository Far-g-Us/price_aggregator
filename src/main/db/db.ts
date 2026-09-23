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
    `INSERT INTO products (id, name, image_url, description, unit, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       image_url = COALESCE(excluded.image_url, products.image_url),
       description = COALESCE(excluded.description, products.description),
       updated_at = datetime('now')`,
    [p.canonicalId, p.name, p.imageUrl ?? null, p.description ?? null, 'шт'],
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
  if (
    last &&
    last.price === p.price &&
    (last.promo_price ?? null) === (p.promoPrice ?? null) &&
    (last.old_price ?? null) === (p.oldPrice ?? null) &&
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
      p.promoPrice ?? null,
      p.oldPrice ?? null,
      inStock ? 1 : 0,
      p.unitPrice ?? null,
    ],
  );
  return 'inserted';
}
