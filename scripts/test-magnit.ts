import assert from 'node:assert';
import fs from 'node:fs';
import {
  normalizeMagnitOffer,
  normalizeMagnitProduct,
  parseMagnitPrice,
} from '../src/main/adapters/magnit.js';

assert.equal(parseMagnitPrice('159.99 ₽'), 159.99);
assert.equal(parseMagnitPrice('1 299 ₽'), 1299);
assert.equal(parseMagnitPrice('119'), 119);
assert.equal(parseMagnitPrice('нет цены'), null);
assert.equal(parseMagnitPrice('0 ₽'), 0);
assert.equal(parseMagnitPrice('2 шт · 159 ₽'), 159);
assert.equal(parseMagnitPrice('Скидка 20% 119 ₽'), 119);

const category = JSON.parse(fs.readFileSync('tests/fixtures/magnit-category.json', 'utf-8'));
assert.ok(category.offers.length >= 2, 'fixture: >= 2 offers');
const first = normalizeMagnitOffer(category.offers[0], { city: 'moscow' });
assert.ok(first, 'first offer normalized');
assert.equal(first?.canonicalId, 'magnit-1000483001');
assert.equal(first?.storeId, 'magnit');
assert.equal(first?.price, 119);
assert.ok(first?.imageUrl?.startsWith('https://'), 'image https');
assert.ok(first?.url?.startsWith('https://magnit.ru/product/'), 'url');
assert.equal(first?.inStock, true);

assert.equal(normalizeMagnitOffer({ name: 'X' }, { city: 'moscow' }), null);
assert.equal(
  normalizeMagnitOffer(
    { name: 'X', url: 'https://magnit.ru/product/1-a', price: '0' },
    { city: 'moscow' },
  ),
  null,
  'zero price rejected',
);

const product = JSON.parse(fs.readFileSync('tests/fixtures/magnit-product.json', 'utf-8'));
const full = normalizeMagnitProduct(product, { city: 'moscow', url: product.url });
assert.ok(full, 'product normalized');
assert.equal(full?.canonicalId, 'magnit-1000483001');
assert.equal(full?.price, 119);
assert.equal(full?.brand, 'Vici');
assert.ok((full?.description?.length ?? 0) > 50, 'real description');
assert.ok(full?.imageUrl?.includes('1600'), 'first (largest) image');
assert.equal(full?.unit, '0.17кг');

const gram = normalizeMagnitProduct(
  { name: 'Y', sku: '2', offers: { price: '50' }, weight: '170 г' },
  { city: 'moscow', url: 'https://magnit.ru/product/2' },
);
assert.equal(gram?.unit, '170 г');

const brandObj = normalizeMagnitProduct(
  { name: 'Z', sku: '3', offers: { price: '10' }, brand: { name: 'B' } },
  { city: 'moscow', url: 'https://magnit.ru/product/3' },
);
assert.equal(brandObj?.brand, 'B');

console.log('magnit normalize: ALL GREEN');
