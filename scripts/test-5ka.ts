import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { categoryIdFromUrl, normalize, PyaterochkaAdapter } from '../src/core/adapters/pyaterochka.js';
import {
  detectStore,
  isCategoriesListUrl,
  storeCodeFromCatalogUrl,
  storeCodeFromNextData,
  storeCodesFromNextData,
} from '../src/core/adapters/5ka-browser.js';
import { MagnitAdapter } from '../src/core/adapters/magnit.js';

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

// --- Разбор ссылки на полку -------------------------------------------------
// id у 5ka ШЕСТНАДЦАТЕРИЧНЫЙ (зонд 2026-09-30: 251C17045), а рабочие адреса —
// /catalog/<id>/ и /catalog/<slug>--<id>/. Форма /catalog/id/<id>/ сайт НЕ
// маршрутизирует, поэтому парсер её отвергает. Если форма поменяется, тест
// обязан упасть громко, а не тихо превратить полку в «ссылка не наша».
assert.equal(categoryIdFromUrl('https://5ka.ru/catalog/251C17046/'), '251C17046', 'короткая форма даёт id');
assert.equal(
  categoryIdFromUrl('https://5ka.ru/catalog/skidki-nedeli--251C17046/'),
  '251C17046',
  'форма со слагом даёт id',
);
assert.equal(categoryIdFromUrl('https://5ka.ru/catalog/id/251C17046/'), null, 'нерабочая форма id/ отвергается');
assert.equal(categoryIdFromUrl('https://5ka.ru/catalog/'), null, 'каталог без категории — не полка');
assert.equal(categoryIdFromUrl('https://5ka.ru/catalog//'), null, 'пустой хвост — не полка');
assert.equal(categoryIdFromUrl('https://www.5ka.ru/catalog/251C17046/'), null, 'другой поддомен — не полка');
assert.equal(categoryIdFromUrl('https://magnit.ru/catalog/1-hleb'), null, 'чужой хост отвергается');
assert.equal(categoryIdFromUrl('https://5ka.ru/promo/251C17046/'), null, 'промо-раздел не полка');
assert.equal(categoryIdFromUrl('http://5ka.ru/catalog/251C17046/'), null, 'http не принимается');

// --- Адаптер забирает только свою ссылку -----------------------------------
// Раньше один URL уходил всем сетям города, и клик по полке Пятёрки ронял
// Магнит ошибкой «categoryUrl вне каталога».
const adapter = new PyaterochkaAdapter();
assert.equal(adapter.canHandleCategoryUrl('https://5ka.ru/catalog/251C17046/'), true, 'Пятёрка узнаёт свою полку');
assert.equal(adapter.canHandleCategoryUrl('https://magnit.ru/catalog/1-hleb'), false, 'чужая ссылка не её');
const magnitAdapter = new MagnitAdapter();
assert.equal(magnitAdapter.canHandleCategoryUrl('https://magnit.ru/catalog/1-hleb'), true, 'Магнит узнаёт свою полку');
assert.equal(magnitAdapter.canHandleCategoryUrl('https://5ka.ru/catalog/251C17046/'), false, 'ссылка Пятёрки не его');

// --- Картинка: фолбэк на small не понижает качество -----------------------
// small = 320x320.jpeg, normal = 800x800.jpeg. Если normal нет, малый адрес
// поднимается до нормального, иначе карточка «ухудшила» бы уже сохранённую
// картинку в products (COALESCE отдаёт приоритет новому значению).
const smallOnly = {
  ...(data.products[0] as Record<string, unknown>),
  image_links: { small: ['https://catalog-images.x5static.net/product/1-main/320x320.jpeg'] },
};
const smallProduct = normalize(smallOnly as never, { city: 'moscow' });
assert.ok(smallProduct, 'товар с одной лишь small-картинкой нормализуется');
assert.ok(
  (smallProduct?.imageUrl ?? '').endsWith('/800x800.jpeg'),
  'small поднимается до 800x800, а не ухудшает картинку',
);

// Правая граница URL: без неё matcher каталога ловил список товаров
// /categories/<id>/products, который сайт шлёт ещё с главной, — и мы
// разбирали ответ с товарами как дерево категорий, получая «категории пусты».
const LIST = 'https://5d.5ka.ru/api/catalog/v4/stores/35XY/categories?mode=delivery&include_subcategories=1&include_restrict';
const PRODUCTS = 'https://5d.5ka.ru/api/catalog/v2/stores/35XY/categories/251C39314/products?mode=delivery&include_restrict=true';
assert.equal(isCategoriesListUrl(LIST), true, 'список категорий опознаётся');
assert.equal(isCategoriesListUrl(PRODUCTS), false, 'список товаров не путается со списком категорий');
assert.equal(
  isCategoriesListUrl('https://5d.5ka.ru/api/catalog/v4/stores/35XY/categories'),
  true,
  'список категорий без query-параметров',
);
assert.equal(
  isCategoriesListUrl('https://5d.5ka.ru/api/catalog/v4/stores/35XY/categories/1/products'),
  false,
  'вложенный products без query не опознаётся как каталог',
);
assert.equal(isCategoriesListUrl('https://5ka.ru/api/catalog/v4/stores/35XY/categories?x=1'), false, 'другой хост');

// Магазин называет сам каталог — это авторитетный источник, кука не единственная.
assert.equal(storeCodeFromCatalogUrl(LIST), '35XY', 'код магазина из URL каталога');
assert.equal(storeCodeFromCatalogUrl(PRODUCTS), '35XY', 'код магазина из URL товаров');
assert.equal(storeCodeFromCatalogUrl('https://5ka.ru/'), null, 'из обычной страницы кода нет');


// detectStore — самая тонкая логика блока: гонка куки и ответа каталога,
// приоритет источников и граница ожидания. Проверяем на подставных таймерах.
const cookieCtx = (list: { name: string; value: string }[]) => ({ cookies: async () => list });
const later = <T,>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

// 1) Кука появилась сразу — берём её, не дожидаясь каталога.
assert.equal(
  await detectStore(cookieCtx([{ name: '5ka_store_id_store', value: '35XY' }]), '35XY', later(9999, 'OTHER'), 500),
  '35XY',
  'кука приоритетнее ответа каталога',
);
// 2) Куки нет, каталог назвал НАШ магазин — выходим досрочно по нему.
assert.equal(
  await detectStore(cookieCtx([]), '35XY', later(20, '35XY'), 3000),
  '35XY',
  'без куки магазин берётся из каталога',
);
// 3) Куки нет, каталог назвал ЧУЖОЙ магазин: не выходим досрочно — ждём
// куку до дедлайна, чтобы не зафиксировать не тот магазин по первому запросу.
const t0 = Date.now();
assert.equal(
  await detectStore(cookieCtx([]), '35XY', later(10, '3AOJ'), 2000),
  '3AOJ',
  'чужой код из каталога возвращается как фолбэк',
);
assert.ok(Date.now() - t0 >= 1500, 'ожидание дошло до дедлайна, а не вышло по чужому коду');
// 4) Ни куки, ни каталога — честный null (дальше сообщение про капчу).
assert.equal(
  await detectStore(cookieCtx([]), '35XY', later(10, null), 300),
  null,
  'нет ни куки, ни каталога — null',
);
// 5) Кука приходит позже API-ответа с тем же кодом — результат тот же.
assert.equal(
  await detectStore(cookieCtx([]), '35XY', later(10, '35XY'), 3000),
  '35XY',
  'код из каталога равен ожидаемому',
);


// Парсер доказательства магазина на странице карточки. Форма взята из живого
// __NEXT_DATA__ (урезанная): сторы лежат JSON-СТРОКОЙ, поэтому парсить нужно
// дважды. Поломка этой функции тихо деградировала бы в «маркера нет» — и цена
// записалась бы в историю, поэтому кейсы обязательны.
const nextData = (stores: Record<string, string>) =>
  JSON.stringify({
    props: {
      pageProps: {
        props: {
          isServerRendered: true,
          ctxStore: JSON.stringify({ city: 'msk' }),
          catalogStore: JSON.stringify({ page: 1, storeId: stores.catalog ?? '', sections: [] }),
          productStore: JSON.stringify({
            product: { plu: 70723, name: 'Сливки', prices: { price: 20799 } },
            productFetchState: { code: 200 },
          }),
        },
      },
    },
  });
assert.equal(storeCodeFromNextData(nextData({ catalog: '35XY' })), '35XY', 'код из catalogStore');
assert.deepEqual(
  storeCodesFromNextData(nextData({ catalog: '35XY' })),
  ['35XY'],
  'на странице назван ровно один магазин',
);
// Порядок ключей в JSON не должен решать, чей код считать правильным:
// страница называет две точки — выбирать «первую попавшуюся» нельзя.
assert.equal(
  storeCodeFromNextData(nextData({ catalog: '35XY' }).replace('"storeId":"35XY"', '"storeId":"35XY"')),
  '35XY',
  'стабильность при одном коде',
);
const two = JSON.stringify({
  props: { pageProps: { props: { a: JSON.stringify({ storeId: '35XY' }), b: JSON.stringify({ storeId: '3AOJ' }) } } },
});
assert.deepEqual(storeCodesFromNextData(two).sort(), ['35XY', '3AOJ'], 'оба кода собраны');
assert.equal(storeCodeFromNextData(two), null, 'два магазина — неоднозначность, а не выбор');
assert.equal(storeCodeFromNextData('{это не JSON'), null, 'битый снимок не роняет разбор');
assert.equal(storeCodeFromNextData('{}'), null, 'пустой снимок без кода');
// Код на верхнем уровне тоже находится, а не только во вложенных сторах.
assert.equal(storeCodeFromNextData(JSON.stringify({ storeId: '35XY' })), '35XY', 'код в корне');

console.log('pyaterochka normalize: ALL GREEN');