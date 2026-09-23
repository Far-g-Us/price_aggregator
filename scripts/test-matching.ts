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

console.log('matching: ALL GREEN');
