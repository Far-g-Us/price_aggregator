import assert from 'node:assert';
import fs from 'node:fs';
import {
  cardsToProducts,
  extractCategoryOffers,
  goodsToProducts,
  hasShopCode,
  magnitSearchUrl,
  normalizeMagnitOffer,
  normalizeMagnitProduct,
  parseMagnitCategories,
  parseMagnitCategoryPromos,
  parseMagnitPrice,
  parseMagnitSearchGoods,
} from '../src/main/adapters/magnit.js';

// Регрессия 2026-09: адаптер ходил на /search?query=, сайт параметр
// игнорирует и отдаёт популярные товары вместо выдачи. Откат на `query=`
// не ловился никакими тестами — фикстура проверялась на содержимом.
// Здесь фиксируем сам URL.
assert.equal(
  magnitSearchUrl('молоко'),
  'https://magnit.ru/search?term=%D0%BC%D0%BE%D0%BB%D0%BE%D0%BA%D0%BE',
  'поиск Магнита — только ?term=, не ?query=',
);
assert.ok(!magnitSearchUrl('x').includes('query='), 'никаких ?query= в поиске');

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

const catHtml = fs.readFileSync('tests/fixtures/magnit-categories.html', 'utf-8');
const cats = parseMagnitCategories(catHtml, '473996');
assert.equal(cats.length, 3);
assert.ok(cats[0]?.url.startsWith('https://magnit.ru/catalog/'), 'clean catalog url');
assert.ok(!cats[0]?.url.includes('?'), 'no query leak');
assert.equal(cats[0]?.imageUrl, undefined, 'category images are not pulled');
assert.throws(() => parseMagnitCategories(catHtml, '000000'), /чужого магазина/);

const promoHtml = fs.readFileSync('tests/fixtures/magnit-category-promo.html', 'utf-8');
const promos = parseMagnitCategoryPromos(promoHtml, '473996');
assert.ok(promos.size >= 3, `promos parsed from payload: ${promos.size}`);
for (const [id, old] of promos) {
  assert.ok(/^\d{7,}$/.test(id), `promo id is product id: ${id}`);
  assert.ok(old > 0, 'old price positive');
}
const promoOffers = extractCategoryOffers(promoHtml, { city: 'moscow', shopCode: '473996' });
assert.equal(promoOffers.length, 8, 'all category offers from JSON-LD');
const discounted = promoOffers.filter((p) => p.oldPrice != null);
assert.ok(discounted.length >= 3, `discounted offers: ${discounted.length}`);
for (const p of discounted) {
  assert.ok((p.oldPrice ?? 0) > p.price, 'old price above current');
  assert.ok((p.oldPrice ?? 0) / p.price < 5, 'old price sane ratio');
}
const plain = promoOffers.filter((p) => p.oldPrice == null);
assert.ok(plain.length >= 1, 'non-promo offers keep oldPrice=null');
assert.throws(() => parseMagnitCategoryPromos(promoHtml, '000000'), /чужого магазина/);
assert.equal(
  normalizeMagnitOffer(
    { name: 'X', url: 'https://magnit.ru/product/1-a', price: '100' },
    { city: 'moscow' },
    90,
  )?.oldPrice,
  null,
  'old price below current rejected',
);

const searchHtml = fs.readFileSync('tests/fixtures/magnit-search.html', 'utf-8');
const goods = parseMagnitSearchGoods(searchHtml, '473996');
assert.ok(goods.length >= 2, 'goods parsed');
assert.equal(goods[0]?.id, '9072651501');
assert.equal(goodsToProducts(goods, { city: 'moscow' })[0]?.oldPrice, 199.99);

// Живая выдача со скидками (Москва 303857, 2026-09): скидка приходит в
// хвосте записи как пара "<oldPrice>","-<N>%", у части товаров её нет.
const searchPromoHtml = fs.readFileSync('tests/fixtures/magnit-search-promo.html', 'utf-8');
const promoGoods = parseMagnitSearchGoods(searchPromoHtml, '303857');
const promoProducts = goodsToProducts(promoGoods, { city: 'moscow' });
const saleItems = promoProducts.filter((p) => p.oldPrice != null);
const plainItems = promoProducts.filter((p) => p.oldPrice == null);
assert.ok(saleItems.length >= 3, `скидок в живой выдаче: ${saleItems.length}`);
assert.ok(plainItems.length >= 3, `обычных товаров в живой выдаче: ${plainItems.length}`);
for (const p of saleItems) {
  assert.ok((p.oldPrice ?? 0) > p.price, 'старая цена выше текущей');
  assert.ok((p.oldPrice ?? 0) / p.price < 5, 'старая цена не выходит за ratio 5');
  assert.equal(p.promoPrice, null, 'у Магнита промо выражено старой ценой');
}
assert.equal(
  promoProducts.find((p) => p.canonicalId === 'magnit-1000316961')?.oldPrice,
  269.99,
  'сыр Брест-Литовск 169.99 со старой 269.99',
);
assert.equal(
  promoProducts.find((p) => p.canonicalId === 'magnit-1000517535')?.oldPrice,
  509.97,
  'балык Станицыно 389.97 со старой 509.97',
);
assert.throws(() => parseMagnitSearchGoods(searchPromoHtml, '000000'), /чужого магазина/);

// Раньше адаптер ходил на /search?query=, который сайт игнорирует: в ответ
// приходили популярные товары (бананы на запрос «молоко»). Теперь только
// ?term=, и это проверяется на живой выдаче — фикстура снята именно по нему.
assert.ok(
  promoProducts.some((p) => p.name.toLowerCase().includes('сыр')),
  'фикстура — реальный ответ поиска, а не популярные товары',
);

assert.equal(hasShopCode('x?shopCode=473996&y', '473996'), true);
assert.equal(hasShopCode('x?shopCode=4739961&y', '473996'), false);
assert.equal(hasShopCode('noshop', '473996'), false);

const cards = cardsToProducts(
  [
    { name: 'Молоко 1л', href: '/product/111-a?shopCode=1', img: 'https://x/y.png', texts: ['100 ₽', '120 ₽', '100 ₽ · 1л'] },
    { name: 'Без цены', href: '/product/222-b', img: '', texts: [] },
    { name: 'Мусор', href: '/other', img: '', texts: ['5 ₽'] },
  ],
  { city: 'moscow' },
  12,
);
assert.equal(cards.length, 1);
assert.equal(cards[0]?.canonicalId, 'magnit-111');
assert.equal(cards[0]?.oldPrice, 120);
assert.equal(cards[0]?.unitPrice, '100 ₽ · 1л');

const noisyCards = cardsToProducts(
  [
    { name: 'Клубная цена ниже', href: '/product/300-a', img: '', texts: ['200 ₽', '150 ₽'] },
    { name: 'Завышенная старая', href: '/product/301-a', img: '', texts: ['200 ₽', '5000 ₽'] },
  ],
  { city: 'moscow' },
  12,
);
assert.equal(noisyCards[0]?.oldPrice, null, 'oldPrice ниже цены отбрасывается');
assert.equal(noisyCards[1]?.oldPrice, null, 'несоразмерный oldPrice отбрасывается');

assert.ok(promos.size >= 3, `в фикстуре есть акционные товары: ${promos.size}`);
const noBadgePromos = (badge: string) =>
  parseMagnitCategoryPromos(
    promoHtml.replace(/"(\d+(?:[.,]\d+)?)","(-\d+%|74\.99)"/g, `"${badge}"`),
    '473996',
  );
assert.equal(noBadgePromos('#3B5803').size, 0, 'цвет бейджа не принимается за старую цену');
assert.equal(noBadgePromos('Только у нас').size, 0, 'подпись бейджа не принимается за старую цену');
assert.equal(noBadgePromos('4.7').size, 0, 'рейтинг не принимается за старую цену');

console.log('magnit normalize: ALL GREEN');
