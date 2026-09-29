import assert from 'node:assert';
import { groupByProduct, normalizeName, sameProduct } from '../src/shared/matching.js';
import type { ScrapedProduct } from '../src/shared/types.js';

function item(over: Partial<ScrapedProduct> & { name: string }): ScrapedProduct {
  return {
    canonicalId: 't-1',
    storeId: 'magnit',
    city: 'moscow',
    price: 100,
    promoPrice: null,
    oldPrice: null,
    collectedAt: new Date(0).toISOString(),
    ...over,
  };
}

assert.equal(normalizeName('Молоко «Домик в деревне» 3,2% 1л!'), 'молоко домик в деревне 3 2 1л');

const milkA = item({ canonicalId: 'magnit-1', name: 'Молоко Домик в деревне 3.2% 930мл', brand: 'Домик', unit: '930мл' });
const milkB = item({ canonicalId: '5ka-9', storeId: 'pyaterochka', name: 'Молоко Домик в деревне 3,2% 930 мл', brand: 'домик', unit: '930мл' });
assert.equal(sameProduct(milkA, milkB), true);

const other = item({ canonicalId: 'magnit-2', name: 'Кефир Простоквашино 1% 900г', brand: 'Простоквашино' });
assert.equal(sameProduct(milkA, other), false);

const diffBrand = item({ canonicalId: 'magnit-3', name: 'Молоко Домик в деревне 3.2% 930мл', brand: 'Другой' });
assert.equal(sameProduct(milkA, diffBrand), false);

const bcA = item({ canonicalId: 'magnit-4', name: 'А', barcode: '4601234567890' });
const bcB = item({ canonicalId: '5ka-5', storeId: 'pyaterochka', name: 'Совсем другое название', barcode: '4601234567890' });
assert.equal(sameProduct(bcA, bcB), true);

const bcDiff = item({ canonicalId: 'magnit-6', name: 'Молоко Домик в деревне 3.2% 930мл', brand: 'Домик', barcode: '4000000000000' });
const bcDiff2 = item({ canonicalId: '5ka-7', storeId: 'pyaterochka', name: 'Молоко Домик в деревне 3.2% 930мл', brand: 'Домик', barcode: '4000000000001' });
assert.equal(sameProduct(bcDiff, bcDiff2), false);

const fat32 = item({ canonicalId: 'magnit-8', name: 'Молоко Домик в деревне 3.2% 930мл', brand: 'Домик', unit: '930мл' });
const fat25 = item({ canonicalId: 'magnit-9', name: 'Молоко Домик в деревне 2.5% 930мл', brand: 'Домик', unit: '930мл' });
assert.equal(sameProduct(fat32, fat25), false);

const groups = groupByProduct([milkA, milkB, other]);
assert.equal(groups.length, 2);
assert.equal(groups.find((g) => g.name.includes('Молоко'))?.offers.length, 2);

const dupA = item({ canonicalId: 'magnit-10', name: 'Молоко 3.2% 1л', price: 100 });
const dupB = item({ canonicalId: 'magnit-10', name: 'Молоко пастеризованное 3.2% 1л', price: 100 });
const dupGroups = groupByProduct([dupA, dupB, dupA]);
assert.equal(dupGroups.length, 1, 'same canonical merges despite name drift');
assert.equal(dupGroups[0]?.offers.length, 1, 'no offer duplication');
assert.equal(dupGroups[0]?.offers[0]?.product.price, 100);

const pie1 = item({ canonicalId: 'magnit-100', name: 'Пирожок слоеный вишня Дом выпечки 70г', price: 44.99 });
const pie2 = item({ canonicalId: 'magnit-200', name: 'Пирожок слоеный с вишной Дом выпечки 70г', price: 44.99 });
const pie5ka = item({
  canonicalId: '5ka-300',
  storeId: 'pyaterochka',
  name: 'Пирожок слоеный вишня Дом выпечки 70г',
  price: 39.99,
});
const pieGroups = groupByProduct([pie1, pie2, pie5ka]);
for (const g of pieGroups) {
  const ids = g.offers.map((o) => o.storeId);
  assert.equal(new Set(ids).size, ids.length, `one offer per store in ${g.key}`);
}
assert.equal(pieGroups.length, 2, 'похожие товары одного магазина не сливаются в одну карточку');
assert.equal(
  pieGroups.find((g) => g.offers.length === 2)?.offers.length,
  2,
  'cross-store merge intact',
);
const offerTotal = pieGroups.reduce((n, g) => n + g.offers.length, 0);
assert.equal(offerTotal, 3, 'ни один товар не потерян');
assert.equal(
  pieGroups.filter((g) => g.offers[0]?.product.canonicalId === 'magnit-200').length,
  1,
  'дубль canonicalId не сеет вторую цену',
);

console.log('matching: ALL GREEN');
