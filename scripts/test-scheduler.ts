import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScrapedProduct, StoreAdapter } from '../src/shared/types.js';
import { getPriceHistory, openDb } from '../src/main/db/db.js';
import { pollOnce } from '../src/main/scheduler.js';

let price = 100;
const fake: StoreAdapter = {
  storeId: 'magnit',
  async search() {
    return [];
  },
  async fetchProduct(canonicalId: string, ctx: { city: string; externalStoreId: string }) {
    assert.equal(ctx.externalStoreId, '473996');
    const p: ScrapedProduct = {
      canonicalId,
      storeId: 'magnit',
      city: ctx.city,
      name: 'Тест',
      price,
      promoPrice: null,
      oldPrice: null,
      collectedAt: new Date().toISOString(),
    };
    return p;
  },
};

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sch-')), 't.db');
const db = await openDb(file);
db.run(
  `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('magnit-1', 'magnit', 'moscow', 100)`,
);

const r1 = await pollOnce(db, new Map([['magnit', fake]]), 0);
assert.deepEqual(r1, { inserted: 0, skipped: 1, failed: 0, notReady: 0 });

price = 120;
const r2 = await pollOnce(db, new Map([['magnit', fake]]), 0);
assert.deepEqual(r2, { inserted: 1, skipped: 0, failed: 0, notReady: 0 });

const hist = getPriceHistory(db, { canonicalId: 'magnit-1', storeId: 'magnit', city: 'moscow' });
assert.equal(hist.length, 2);
assert.equal(hist[0]?.price, 100);
assert.equal(hist[1]?.price, 120);
assert.ok(fs.existsSync(file), 'persisted after poll');

const failing: StoreAdapter = {
  storeId: 'magnit',
  async search() {
    return [];
  },
  async fetchProduct(canonicalId: string, ctx: { city: string; externalStoreId: string }) {
    if (canonicalId === 'magnit-1') throw new Error('boom');
    return fake.fetchProduct(canonicalId, ctx);
  },
};
db.run(
  `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('magnit-2', 'magnit', 'moscow', 120)`,
);
db.run(
  `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('x-1', 'nostore', 'moscow', 5)`,
);
const r3 = await pollOnce(db, new Map([['magnit', failing]]), 0);
assert.equal(r3.failed, 1, 'one item error isolated');
assert.equal(r3.notReady, 1, 'unknown store counted as notReady');
assert.equal(r3.skipped, 1, 'rest of batch processed');

console.log('scheduler: ALL GREEN');
