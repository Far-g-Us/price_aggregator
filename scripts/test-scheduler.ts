import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScrapedProduct, StoreAdapter } from '../src/shared/types.js';
import { CITY_STORES } from '../src/shared/catalog.js';
import { getPriceHistory, openDb } from '../src/core/db/db.js';
import { fileStorageAt } from '../electron/node-files.js';
import { pollOnce } from '../src/core/scheduler.js';

const magnitMoscow = CITY_STORES.moscow?.find((s) => s.storeId === 'magnit')?.externalStoreId ?? '';

let price = 100;
const fake: StoreAdapter = {
  storeId: 'magnit',
  async search() {
    return [];
  },
  async fetchProduct(canonicalId: string, ctx: { city: string; externalStoreId: string }) {
    assert.equal(ctx.externalStoreId, magnitMoscow);
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
const db = await openDb(fileStorageAt(file));
db.run(
  `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('magnit-1', 'magnit', 'moscow', 100)`,
);

const r1 = await pollOnce(db, new Map([['magnit', fake]]), { delayMs: 0 });
assert.deepEqual(r1, { inserted: 0, skipped: 1, failed: 0, notReady: 0, failedStores: [] });

price = 120;
const r2 = await pollOnce(db, new Map([['magnit', fake]]), { delayMs: 0 });
assert.deepEqual(r2, { inserted: 1, skipped: 0, failed: 0, notReady: 0, failedStores: [] });

const hist = getPriceHistory(db, { canonicalId: 'magnit-1', storeId: 'magnit', city: 'moscow' });
assert.equal(hist.length, 2);
assert.equal(hist[0]?.price, 100);
assert.equal(hist[1]?.price, 120);
assert.ok(fs.existsSync(file), 'persisted after poll');

// Опрос бьёт только по выбранному городу. Цена привязана к магазину города,
// поэтому обход всех городов одной кнопкой — это запросы туда, куда
// пользователь не смотрел (и лишние обращения к сети).
{
  const magnitUlyanovsk = CITY_STORES.ulyanovsk?.find((s) => s.storeId === 'magnit')?.externalStoreId ?? '';
  db.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('magnit-uly', 'magnit', 'ulyanovsk', 500)`,
  );
  const asked: string[] = [];
  const spy: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string, ctx: { city: string; externalStoreId: string }) {
      asked.push(`${canonicalId}@${ctx.city}`);
      return {
        canonicalId,
        storeId: 'magnit',
        city: ctx.city,
        name: 'Тест',
        price: 777,
        promoPrice: null,
        oldPrice: null,
        collectedAt: new Date().toISOString(),
      };
    },
  };
  assert.equal(magnitUlyanovsk, '730159', 'эталонный код Ульяновска на месте');

  const onlyMoscow = await pollOnce(db, new Map([['magnit', spy]]), { delayMs: 0, city: 'moscow' });
  assert.ok(
    asked.every((a) => a.endsWith('@moscow')),
    `опрос ограничен городом, а видел: ${asked.join(', ')}`,
  );
  assert.ok(onlyMoscow.skipped + onlyMoscow.inserted > 0, 'цели Москвы обработаны');

  asked.length = 0;
  const onlyUlyanovsk = await pollOnce(db, new Map([['magnit', spy]]), { delayMs: 0, city: 'ulyanovsk' });
  assert.ok(
    asked.every((a) => a.endsWith('@ulyanovsk')),
    `опрос ограничен городом, а видел: ${asked.join(', ')}`,
  );
  assert.equal(onlyUlyanovsk.inserted, 1, 'цена Ульяновска обновилась');

  // Пустой город: целей нет — опрос ничего не делает, а не считает чужие.
  asked.length = 0;
  const none = await pollOnce(db, new Map([['magnit', spy]]), { delayMs: 0, city: 'kazan' });
  assert.deepEqual(none, { inserted: 0, skipped: 0, failed: 0, notReady: 0, failedStores: [] }, 'город без целей — пустой отчёт');
  assert.equal(asked.length, 0, 'сеть не дёргалась ради города без целей');

  // Без фильтра — все города (прежнее поведение, нужно ручному запуску).
  asked.length = 0;
  await pollOnce(db, new Map([['magnit', spy]]), { delayMs: 0 });
  assert.ok(asked.length >= 2, `без фильтра опрошены все города, видел: ${asked.join(', ')}`);

  // Убираем добавленную цель: дальше идут тесты с адаптером, который
  // утверждает, что внешний код МОСКОВСКИЙ, и чужая строка его бы уронила.
  db.run(`DELETE FROM prices_history WHERE canonical_id = 'magnit-uly'`);
}

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
const r3 = await pollOnce(db, new Map([['magnit', failing]]), { delayMs: 0 });
assert.equal(r3.failed, 1, 'one item error isolated');
assert.equal(r3.notReady, 1, 'unknown store counted as notReady');
assert.equal(r3.skipped, 1, 'rest of batch processed');

console.log('scheduler: ALL GREEN');
