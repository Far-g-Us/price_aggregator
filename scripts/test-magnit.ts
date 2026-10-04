import assert from 'node:assert';
import { CITY_STORES } from '../src/shared/catalog.js';
import fs from 'node:fs';
import {

  assertCardsOwnStore,
  shopCodesInProductLinks,
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
} from '../src/core/adapters/magnit.js';

// Коды магазинов приходят от пользователя строкой, и единственная защита от
// опечатки (`%22277027%22` вместо `277027`) — рантайм-проверка в адаптере.
// Держим все коды из конфига валидными на каждом прогоне тестов.
for (const [city, stores] of Object.entries(CITY_STORES)) {
  const magnit = stores.find((s) => s.storeId === 'magnit');
  if (!magnit) continue;
  assert.match(
    magnit.externalStoreId,
    /^\d+$/,
    `${city}: код магазина Магнита «${magnit.externalStoreId}» — только цифры, без кавычек и %22`,
  );
  assert.equal(magnit.ready, true, `${city}: Магнит включен (проверен живым поиском)`);
}

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
// Регрессия 2026-09-30: пятое поле записи категории в __NUXT_DATA__ — это
// ссылка на картинку, а не мусор. Раньше оно отбрасывалось, и плитки категорий
// оставались без картинок, хотя сеть её отдаёт.
assert.equal(
  cats[0]?.imageUrl,
  'https://images-foodtech.magnit.ru/fDaCzEYETDNF1ti6B3iGkHCIYCRiD9pBxwHkcX92jpA/rs:fit:318:384/plain/s3://img-dostavka/pim/category/65247/gallery/a6b485186af77c86d5683c0585d4c54b.png@webp',
  'картинка категории берётся из пятого поля и с \\u002F разэкранируется',
);
const noImage = parseMagnitCategories(catHtml.replace(/images-foodtech[^"]*/, ''), '473996');
assert.equal(noImage[0]?.imageUrl, undefined, 'без ссылки на картинку полка остаётся без неё');
assert.ok(noImage[0]?.url.startsWith('https://magnit.ru/catalog/'), 'ссылка на категорию не пострадала');
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

// Страница без ссылок на товары: проверить нечем, доверяем эху URL.
assert.equal(hasShopCode('x?shopCode=473996&y', '473996'), true);
assert.equal(hasShopCode('x?shopCode=4739961&y', '473996'), false);
assert.equal(hasShopCode('noshop', '473996'), false);
// Регрессия 2026-10-01: эха URL недостаточно. Сайт подставляет строку с нашим
// кодом даже для несуществующего кода, и ссылки при этом ведут в чужой магазин.
// Прежняя проверка такой случай принимала — цены чужой точки уехали бы в
// историю (инвариант домена: успешный ответ ≠ наш магазин).
const foreign = `<a href="/product/1-moloko?shopCode=992301&amp;shopType=dostavka">x</a>`;
assert.equal(
  hasShopCode(`shopCode=473996 ${foreign}`, '473996'),
  false,
  'чужой магазин в ссылках не проходит, даже если код есть в HTML',
);
const own = `<a href="/product/1-moloko?shopCode=473996&amp;shopType=dostavka">x</a>`;
assert.equal(hasShopCode(`shopCode=473996 ${own}`, '473996'), true, 'наш магазин в ссылках проходит');
// Экранированная форма из пейлоада Nuxt: на странице поиска буквальных
// ссылок `/product/` нет вовсе, и проверка, ловившая только её, молча уходила
// в фолбэк, который принимает любой код. ВНИМАНИЕ: обратный слэш обязателен —
// в пейлоаде именно `\u002F`, а не `u002F` без слеша. С такой опечаткой тест
// проходил бы вовсе не по той ветке, которую проверяет.
// В обычном строковом литерале `\\u002F` даёт именно «слеш + u002F».
const nuxtLink = (code: string) => `\\u002Fproduct\\u002F1-moloko?shopCode=${code}`;
assert.equal(
  hasShopCode(nuxtLink('473996'), '473996'),
  true,
  'экранированная ссылка на наш магазин, даже когда строки с кодом в HTML нет',
);
// Ловушка на откат правки: тут в HTML нет НИКАКОГО упоминания нашего кода,
// поэтому фолбэк по куке не может выручить — если удалить экранированную
// альтернативу из regex, тест обязан покраснеть.
const onlyForeign = nuxtLink('992301');
assert.ok(!onlyForeign.includes('473996'), 'фикстура не должна содержать наш код');
assert.equal(
  hasShopCode(onlyForeign, '473996'),
  false,
  'ссылки только на чужой магазин отвергаются без опоры на куку',
);
// Граница числа: 4739961 — это другой магазин, а не наш с хвостом.
assert.equal(
  hasShopCode(nuxtLink('4739961'), '473996'),
  false,
  'код с лишней цифрой не считается нашим',
);
// Смешанная выдача: наш код среди чужих ссылок — наш магазин.
assert.equal(
  hasShopCode(`${nuxtLink('992301')} ${nuxtLink('473996')}`, '473996'),
  true,
  'наш магазин среди прочих ссылок принимается',
);
// JSON-эскейп внутри пейлоада: `shopCode=\"473996\"` — после `=` идёт слэш.
// Именно этот случай единственный, где старый фолбэк по куке бессилен (он не
// понимает `\"`), поэтому только он доказывает, что работает ИМЕННО новая
// ветка, а не фолбэк. Ниже — самопроверка невакуумности этой фикстуры.
const escapedQuoted = '\\u002Fproduct\\u002F1-moloko?shopCode=\\"473996\\"';
assert.equal(
  hasShopCode(escapedQuoted, '473996'),
  true,
  'экранированная ссылка с эскейпленными кавычками',
);
// Доказательство, что фикстура выше не проходит «по старому пути»: в ней нет
// ни буквальной ссылки `/product/`, ни строки, которую поймал бы фолбэк по
// куке. Если эти две проверки перестанут выполняться, тест выше стал бы
// проверять не то исправление, ради которого написан.
assert.equal(
  /\/product\/[^"']*?shopCode=(%22|")?(\d+)(?!\d)/g.test(escapedQuoted),
  false,
  'в фикстуре нет буквальных ссылок — старая проверка её не увидит',
);
assert.equal(
  new RegExp(`shopCode=(%22|")?473996(%22|"|&|$)`).test(escapedQuoted),
  false,
  'фикстура недоступна фолбэку по куке — зелёный тест не может идти по нему',
);

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

// Общий экспорт сверки (его же использует зонд npm run magnit:store) —
// ветви, добавленные в этом круге, обязаны быть покрыты, иначе зонд может
// разойтись с адаптером молча.
assert.deepEqual(
  shopCodesInProductLinks('/product/1?shopCode=%22473996%22'),
  ['473996'],
  'URL-кодированные кавычки в ссылке',
);
assert.deepEqual(
  shopCodesInProductLinks('\\u002Fproduct\\u002F1?shopCode=\\u0022473996\\u0022'),
  ['473996'],
  'эскейп \u0022 в ссылке',
);
assert.deepEqual(
  shopCodesInProductLinks('/product/1?shopCode=4739961 /product/2?shopCode=303857'),
  ['4739961', '303857'],
  'литеральные ссылки: (?!\\d) и порядок не важны',
);
assert.deepEqual(
  shopCodesInProductLinks(nuxtLink('473996')),
  ['473996'],
  'экранированная ссылка без кавычек',
);
assert.deepEqual(
  shopCodesInProductLinks('shopCode=473996'),
  [],
  'одна кука сама по себе ссылкой на товар не является',
);

// Сверка по ссылкам карточек — единственная защита в Playwright-путях, где
// сверять можно только по href (эхо куки в DOM доказывает лишь, что кука
// дошла). Правило повторяет hasShopCode: нет кодов — не выдумываем вины,
// есть чужие и нет нашего — отказ.
const card = (href: string) => ({ name: 'x', href, img: '', texts: [] as string[] });
assertCardsOwnStore([card('/product/1-moloko?shopCode=473996')], '473996');
assertCardsOwnStore([card('')], '473996');
// Ссылки есть, но кода в них нет — это уже не «нечем сверять», а смена
// формата ссылок, и сказать об этом надо вслух.
assert.throws(
  () => assertCardsOwnStore([card('/product/1-moloko'), card('/product/2-kefir')], '473996'),
  /нет shopCode/,
  'ссылки без shopCode — громкая ошибка, а не тихий пропуск',
);
assertCardsOwnStore(
  [card('/product/1?shopCode=992301'), card('/product/2?shopCode=473996')],
  '473996',
),
'наш среди чужих принимается (смешанная страница)';
assert.throws(
  () => assertCardsOwnStore([card('/product/1?shopCode=992301')], '473996'),
  /чужого магазина/,
  'только чужие ссылки — отказ',
);
assert.throws(
  () => assertCardsOwnStore([card('/product/1?shopCode=4739961')], '473996'),
  /чужого магазина/,
  'код с лишней цифрой — тоже чужой',
);
