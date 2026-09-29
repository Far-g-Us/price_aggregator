import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CITIES, CITY_STORES } from '../src/shared/catalog.js';
import { closeDb, openDb, persistDb, savePriceIfChanged } from '../src/main/db/db.js';

const schemaPath = fileURLToPath(new URL('../src/main/db/schema.sql', import.meta.url));
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-db-')), 't.db');
const db = await openDb(file);

const seededStores = (): Map<string, string> => {
  const rows = db.exec(`SELECT id, city, external_store_id FROM stores`)[0]?.values ?? [];
  return new Map(rows.map((r) => [`${String(r[0])}:${String(r[1])}`, String(r[2])]));
};
const expectedStores = (): Map<string, string> =>
  new Map(
    Object.entries(CITY_STORES).flatMap(([city, stores]) =>
      stores.map((s) => [`${s.storeId}:${city}`, s.externalStoreId]),
    ),
  );

const seeded = seededStores();
const expected = expectedStores();
for (const [key, id] of expected) {
  assert.equal(seeded.get(key), id, `stores.external_store_id синхронен с catalog.ts: ${key}`);
}
assert.equal(seeded.size, expected.size, 'в stores нет лишних строк');

db.run(`UPDATE stores SET external_store_id = 'stale'`);
db.exec(fs.readFileSync(schemaPath, 'utf-8'));
const reseeded = seededStores();
for (const [key, id] of expected) {
  assert.equal(reseeded.get(key), id, `повторный seed обновляет протухший код: ${key}`);
}

const seededCities = db.exec(`SELECT id FROM cities`)[0]?.values.map((r) => String(r[0])) ?? [];
for (const c of CITIES) {
  assert.ok(seededCities.includes(c.id), `город засеян: ${c.id}`);
  assert.ok((CITY_STORES[c.id] ?? []).length > 0, `у города есть магазины: ${c.id}`);
}
assert.equal(seededCities.length, CITIES.length, 'в cities нет лишних строк');
const base = {
  canonicalId: 'magnit-1',
  storeId: 'magnit',
  city: 'moscow',
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
persistDb(db);
assert.ok(fs.existsSync(file), 'db file persisted');
closeDb();
console.log('db write-on-change: ALL GREEN');
