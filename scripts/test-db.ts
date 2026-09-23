import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, openDb, persistDb, savePriceIfChanged } from '../src/main/db/db.js';

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-db-')), 't.db');
const db = await openDb(file);
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

const rows = db.exec('SELECT COUNT(*) AS n FROM prices_history')[0]?.values[0];
assert.equal(rows?.[0], 3);
persistDb(db);
assert.ok(fs.existsSync(file), 'db file persisted');
closeDb();
console.log('db write-on-change: ALL GREEN');
