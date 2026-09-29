import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalize } from '../src/main/adapters/pyaterochka.js';

const fixture = fileURLToPath(new URL('../tests/fixtures/5ka-search.json', import.meta.url));
const cardFixture = fileURLToPath(new URL('../tests/fixtures/5ka-product.json', import.meta.url));
const soldOutFixture = fileURLToPath(
  new URL('../tests/fixtures/5ka-product-soldout.json', import.meta.url),
);
const data = JSON.parse(fs.readFileSync(fixture, 'utf-8')) as {
  products: Record<string, unknown>[];
  categories: unknown[];
};

assert.ok(data.products.length >= 4, 'fixture: >= 4 products');

const first = normalize(data.products[0] as never, { city: 'moscow' });
assert.ok(first, 'first product normalized');
assert.equal(first?.canonicalId, '5ka-3255206');
assert.equal(first?.storeId, 'pyaterochka');
assert.equal(first?.city, 'moscow');
assert.equal(first?.price, 89.99);
assert.equal(first?.promoPrice, null, 'у обычного товара скидки нет');
assert.equal(first?.oldPrice, null);
assert.equal(first?.inStock, true);
assert.equal(first?.unit, '930 мл');
assert.ok(first?.imageUrl?.startsWith('https://catalog-images.x5static.net/'), 'image from x5static');
assert.equal(first?.url, 'https://5ka.ru/product/3255206/', 'короткая ссылка редиректит на slug');
assert.ok(first?.name.includes('Домик в деревне'), 'name kept');

const all = data.products.map((p) => normalize(p as never, { city: 'moscow' }));
assert.equal(all.length, data.products.length, 'все товары нормализовались');
assert.equal(new Set(all.map((p) => p?.canonicalId)).size, data.products.length, 'plu уникальны');
for (const p of all) {
  assert.ok((p?.price ?? 0) > 0, 'цена положительная');
}

// Живая акция из фикстуры: 5ka отдаёт её в cpd_promo_price, а discount
// всегда null. Мультибай («% ко 2-й») в promoPrice не пишется.
interface RawProduct {
  plu: number;
  name: string;
  prices: { regular: string; discount: string | null; cpd_promo_price: string | null };
  promo: { rebate: { units_to_activate: number } } | null;
}
const multibuyRaw = (data.products as unknown[] as RawProduct[]).find((p) => p.plu === 4439523);
assert.ok(multibuyRaw, 'фикстура содержит акционный товар');
const multibuy = normalize(multibuyRaw as never, { city: 'moscow' });
assert.equal(multibuy?.price, 59.99);
assert.equal(multibuy?.promoPrice, null, 'мультибай-скидка не выдаётся как цена товара');
assert.equal(multibuyRaw.prices.cpd_promo_price, '47.99', 'скидка в cpd_promo_price');
assert.equal(multibuyRaw.prices.discount, null, 'discount в живых данных всегда null');
assert.equal(
  normalize({ ...multibuyRaw, promo: null } as never, { city: 'moscow' })?.promoPrice,
  47.99,
  'обычная скидка без rebate становится promoPrice',
);

assert.equal(normalize({ plu: 1, name: 'X' } as never, { city: 'moscow' }), null, 'нет цены');
assert.equal(normalize({ plu: 1, prices: { regular: '0' } } as never, { city: 'moscow' }), null, 'нулевая цена');
assert.equal(normalize({ plu: 'abc', name: 'X', prices: { regular: 10 } } as never, { city: 'moscow' }), null, 'plu не число');
assert.equal(normalize({ plu: 1, name: '', prices: { regular: 10 } } as never, { city: 'moscow' }), null, 'нет имени');

const promo = normalize(
  { plu: 7, name: 'Y', prices: { regular: '100', discount: '79.99', markdown: '120' } } as never,
  { city: 'moscow' },
);
assert.equal(promo?.price, 100);
assert.equal(promo?.promoPrice, 79.99);
assert.equal(promo?.oldPrice, 120);

const dirty = normalize(
  { plu: 9, name: 'W', prices: { regular: '100', discount: '150', markdown: '40' } } as never,
  { city: 'moscow' },
);
assert.equal(dirty?.promoPrice, null, 'discount выше regular не считается акцией');
assert.equal(dirty?.oldPrice, null, 'markdown ниже regular отбрасывается');

const noClarity = normalize(
  { plu: 10, name: 'U', property_clarification: '  ', uom: 'шт', prices: { regular: '10' } } as never,
  { city: 'moscow' },
);
assert.equal(noClarity?.unit, 'шт', 'пустая фасовка не оставляет unit пустым');

const noFlag = normalize(
  { plu: 11, name: 'T', prices: { regular: '10' } } as never,
  { city: 'moscow' },
);
assert.equal(noFlag?.inStock, false, 'без is_available не выдумываем наличие');

const out = normalize(
  { plu: 8, name: 'Z', prices: { regular: '50' }, is_available: false } as never,
  { city: 'moscow' },
);
assert.equal(out?.inStock, false, 'is_available=false -> нет в наличии');

// Карточка товара: prices — МАССИВ, плюс бренд/описание/вес в attributes.
const card = JSON.parse(fs.readFileSync(cardFixture, 'utf-8')) as Record<string, unknown>;
const full = normalize(card as never, { city: 'moscow' });
assert.ok(full, 'product card normalized');
assert.equal(full?.canonicalId, '5ka-3255206');
assert.equal(full?.price, 89.99);
assert.equal(full?.promoPrice, null, 'одна цена в массиве -> без акции');
assert.equal(full?.oldPrice, null);
assert.equal(full?.unit, '930 мл');
assert.equal(full?.brand, 'Домик в деревне', 'бренд из attributes');
assert.ok((full?.description?.length ?? 0) > 100, 'настоящее описание');
assert.equal(full?.inStock, true);

// Тот же товар, но цена по акции: массив из трёх placement_type.
const saleCard = normalize(
  {
    plu: 4414286,
    name: 'Мука премиссмо Экстра пшеничная 2кг',
    is_available: true,
    property_clarification: '2 кг',
    prices: [
      { value: '219.99', placement_type: 'regular_primary' },
      { value: '179.99', placement_type: 'sale_primary' },
    ],
  } as never,
  { city: 'moscow' },
);
assert.equal(saleCard?.price, 219.99);
assert.equal(saleCard?.promoPrice, 179.99, 'цена ниже regular = акция');
assert.equal(saleCard?.oldPrice, null);

const priceWithoutRegular = normalize(
  { plu: 5, name: 'A', prices: [{ value: '10', placement_type: 'sale_primary' }] } as never,
  { city: 'moscow' },
);
assert.equal(priceWithoutRegular?.price, 10, 'без regular_primary берём первый элемент');
assert.equal(priceWithoutRegular?.promoPrice, null);

// Товар без наличия: цены в API НЕТ (prices: []), хотя на сайте скидка.
// Такое выпадает из нормализации — в историю нулевая цена не попадёт.
const soldOut = JSON.parse(
  fs.readFileSync(soldOutFixture, 'utf-8'),
) as Record<string, unknown>;
assert.deepEqual(soldOut.prices, [], 'фикстура: пустой prices у товара вне наличия');
assert.equal(soldOut.is_available, false);
assert.equal(normalize(soldOut as never, { city: 'moscow' }), null, 'без цены товар отбрасывается');

// Живой раздел «Скидки недели» (Москва 35XY, 2026-09, категория
// skidki-nedeli--251C17046): здесь скидка ОБЫЧНАЯ — в `prices.discount`,
// с меткой «-N%» в `labels`. В выдаче поиска тот же мультибай приходил в
// `cpd_promo_price`, поэтому оба поля нужны и не взаимозаменяемы.
const promoFixture = fileURLToPath(
  new URL('../tests/fixtures/5ka-search-promo.json', import.meta.url),
);
const promoData = JSON.parse(fs.readFileSync(promoFixture, 'utf-8')) as {
  products: (RawProduct & { labels?: { label?: string }[] | null })[];
};
const plainSale = promoData.products.find((p) => p.prices.discount != null);
assert.ok(plainSale, 'в разделе скидок есть обычная скидка');
const plain = normalize(plainSale as never, { city: 'moscow' });
assert.equal(plain?.price, Number(plainSale.prices.regular));
assert.equal(plain?.promoPrice, Number(plainSale.prices.discount), 'обычная скидка -> promoPrice');
assert.ok(
  /-\d+%/.test(plainSale.labels?.[0]?.label ?? ''),
  `в фикстуре метка скидки: ${JSON.stringify(plainSale.labels)}`,
);
assert.equal(plain?.oldPrice, null, 'у обычной скидки нет отдельной старой цены');

const multibuySale = promoData.products.find(
  (p) => p.prices.cpd_promo_price != null && p.promo?.rebate != null,
);
if (multibuySale) {
  assert.equal(
    normalize(multibuySale as never, { city: 'moscow' })?.promoPrice,
    null,
    'мультибай не выдаётся как цена товара',
  );
}

console.log('pyaterochka normalize: ALL GREEN');