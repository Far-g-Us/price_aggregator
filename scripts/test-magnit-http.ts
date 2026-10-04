// Транспортный слой Магнита: поиск, карточка, витрина и каталог поверх настоящих
// HTML-фикстур. Чистые функции разбора уже покрыты в test-magnit.ts, а вот сам
// `fetch`-слой (куки, коды ответа, редиректы, сверка «свой ли магазин»)
// не был закрыт ни одним тестом — при этом именно он ломается при смене вёрстки
// или при подмене магазина.
//
// Сеть подменена: `fetch` не выходит наружу. Ветки с откатом в Playwright здесь
// намеренно не трогаются: им нужен настоящий браузер, и они проверяются живой
// пробой.
import assert from 'node:assert';
import fs from 'node:fs';
import {
  cardsToProducts,
  goodsToProducts,
  MagnitAdapter,
  normalizeMagnitOffer,
  normalizeMagnitProduct,
  parseMagnitCategories,
  parseMagnitCategoryPromos,
  parseMagnitPrice,
} from '../src/core/adapters/magnit.js';
import { __setPlaywrightForTests } from '../src/core/adapters/playwright-port.js';

const html = (name: string): string => fs.readFileSync(`tests/fixtures/${name}`, 'utf8');
const json = (name: string): unknown => JSON.parse(fs.readFileSync(`tests/fixtures/${name}`, 'utf8'));

const SHOP = '473996';
const CTX = { city: 'moscow', externalStoreId: SHOP };

type Reply = { status?: number; body?: string; url?: string };
let reply: Reply = {};
const seen: { url: string; headers: Record<string, string> }[] = [];
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = typeof input === 'string' ? input : String(input instanceof URL ? input : input.url);
  seen.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
  const status = reply.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    url: reply.url ?? url,
    text: async () => reply.body ?? '',
  } as unknown as Response;
}) as typeof fetch;

const productHtml = (ld: unknown): string =>
  `<html><head><link rel="canonical" href="https://magnit.ru/catalog/?shopCode=${SHOP}" /><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><a href="/catalog/?shopCode=${SHOP}">Молоко</a></body></html>`;

const adapter = new MagnitAdapter();

// --- 1. Поиск: кука с кодом магазина ушла, товары разобраны. ----------------
{
  seen.length = 0;
  reply = { body: html('magnit-search.html') };
  const items = await adapter.search('молоко', CTX);
  assert.ok(items.length > 0, 'выдача непустая');
  assert.ok(items.every((i) => i.storeId === 'magnit' && i.city === 'moscow'), 'сеть и город из контекста');
  assert.match(seen[0]?.headers.Cookie ?? '', /shopCode/, 'кука магазина обязана уйти в запрос');
  assert.match(seen[0]?.url ?? '', /\/search\?term=/, 'поиск идёт по term, не по query');
}

// --- 2. Поиск с чужого кода: сеть отвечает, но товары не наши. ------------
{
  // Тот же HTML, но магазин другой — сверка обязана это отвергнуть.
  reply = { body: html('magnit-search-promo.html') };
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /ответ от чужого магазина/,
    'выдача чужого магазина не превращается в наши цены',
  );
}

// --- 3. Разбор пуст: это дрейф вёрстки, а не «пусто». ----------------------
{
  // Код магазина в ссылке есть (значит ответ наш), но карточек товара нет —
  // это ровно тот случай, когда вёрстка поменялась, а сеть жива.
  reply = { body: '<html><body><a href="/product/?shopCode=473996">витрина</a></body></html>' };
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /смена вёрстки/,
    'пустой разбор с живым кодом магазина — сигнал о смене вёрстки, и он пробрасывается дальше',
  );
}

// --- 4. Код магазина проверяется до похода в сеть. -------------------------
{
  seen.length = 0;
  reply = { body: html('magnit-search.html') };
  await assert.rejects(
    () => adapter.search('молоко', { city: 'moscow', externalStoreId: '30-3857' }),
    /bad shopCode/,
    'код с нецифрами отвергается',
  );
  await assert.rejects(
    () => adapter.fetchCategories({ city: 'moscow', externalStoreId: 'XYZ' }),
    /bad shopCode/,
    'и каталог тоже',
  );
  assert.equal(seen.length, 0, 'до сети дело не дошло');
}

// --- 5. Карточка товара: JSON-LD из HTML. ----------------------------------
{
  const ld = json('magnit-product.json') as Record<string, unknown>;
  reply = { body: productHtml(ld) };
  const product = await adapter.fetchProduct('magnit-1000483001', CTX);
  assert.equal(product.canonicalId, 'magnit-1000483001', 'id из карточки');
  assert.equal(product.price, 119, 'цена из offers');
  assert.equal(product.storeId, 'magnit', 'сеть проставлена адаптером');
}

// --- 6. Карточка: ответ без JSON-LD. --------------------------------------
{
  // Наш магазин, но без разметки товара: сверка проходит, разбирать нечего.
  reply = { body: `<html><body><a href="/catalog/?shopCode=${SHOP}">Молоко</a></body></html>` };
  await assert.rejects(
    () => adapter.fetchProduct('magnit-1000483001', CTX),
    /Product JSON-LD не найден/,
    'без разметки товар не выдумывается',
  );
}

// --- 7. Карточка: сеть увела нас с /product/. ------------------------------
{
  const ld = json('magnit-product.json') as Record<string, unknown>;
  reply = {
    body: productHtml(ld),
    url: 'https://magnit.ru/login',
  };
  await assert.rejects(
    () => adapter.fetchProduct('magnit-1000483001', CTX),
    /ушёл с \/product\//,
    'редирект на логин — это не товар, и цена бы записалась чужая',
  );
}

// --- 8. Каталог магазина: витрина приехала. --------------------------------
{
  seen.length = 0;
  reply = { body: html('magnit-categories.html') };
  const categories = await adapter.fetchCategories(CTX);
  assert.ok(categories.length > 0, 'каталог непустой');
  assert.ok(
    categories.every((c) => c.url.startsWith('https://magnit.ru/catalog/')),
    'ссылки каталога чистые, без утечки query',
  );
  assert.match(seen[0]?.headers.Cookie ?? '', /shopCode/, 'каталог тоже за своим магазином');
}

// --- 9. Витрина по ссылке: товары из OfferCatalog. -------------------------
{
  reply = { body: html('magnit-category-promo.html') };
  const items = await adapter.fetchCategoryProducts('https://magnit.ru/catalog/1-', CTX);
  assert.ok(items.length > 0, 'витрина вернула товары');
  assert.ok(items.every((i) => i.city === 'moscow'), 'город из контекста');
}

// --- 10. Витрина: ссылка не наша и уход с домена. -------------------------
{
  await assert.rejects(
    () => adapter.fetchCategoryProducts('https://example.com/catalog/1-', CTX),
    /categoryUrl вне каталога/,
    'чужая ссылка не отправляется в сеть',
  );
  assert.equal(adapter.canHandleCategoryUrl('https://example.com/catalog/1-'), false, 'и не считается нашей');
  assert.equal(adapter.canHandleCategoryUrl('https://magnit.ru/promo-catalog/1-'), true, 'промо-каталог наш');
  assert.equal(adapter.canHandleCategoryUrl('https://magnit.ru/product/1'), false, 'карточка — не витрина');

  reply = { body: html('magnit-category-promo.html'), url: 'https://magnit.ru.evil.example/catalog/1-' };
  await assert.rejects(
    () => adapter.fetchCategoryProducts('https://magnit.ru/catalog/1-', CTX),
    /ушёл с magnit\.ru/,
    'уход с домена замечается, а не молча отдаёт пустую витрину',
  );
}

// --- 11. Разбор: края, до которых не доходит ни один живой ответ. ---------
// Каждая защита в normalize* написана для конкретного дрейфа данных. Если для
// неё нет теста, она однажды сработает на живом ответе и уберёт товар молча.
{
  // Цена, которая не помещается в число: 400 девяток — это Infinity, и такой
  // товар не должен превращаться в товар с бесконечной ценой.
  assert.equal(parseMagnitPrice(`${'9'.repeat(400)} ₽`), null, 'бесконечная цена не цена');

  // offer без ссылки: id тогда неоткуда взять, и это не товар.
  assert.equal(normalizeMagnitOffer({ name: 'Молоко' } as never, { city: 'moscow' }), null, 'offer без ссылки и без sku');
  assert.equal(
    normalizeMagnitOffer({ name: 'Молоко', url: 'https://magnit.ru/product/x/' } as never, { city: 'moscow' }),
    null,
    'ссылка без цены — не товар',
  );
  const withPrice = normalizeMagnitOffer(
    { name: 'Молоко', url: 'https://magnit.ru/product/99001/', price: '99 ₽' } as never,
    { city: 'moscow' },
  );
  assert.equal(withPrice?.price, 99, 'цена из строки разобрана');
  assert.equal(withPrice?.inStock, true, 'без статуса наличия товар считаем есть');
  const outOfStock = normalizeMagnitOffer(
    { name: 'Молоко', url: 'https://magnit.ru/product/99001/', price: '99 ₽', availability: 'OutOfStock' } as never,
    { city: 'moscow' },
  );
  assert.equal(outOfStock?.inStock, false, 'явный OutOfStock — товара нет');

  // Карточка: sku нет — id берётся из ссылки, иначе товар не опознан.
  const byUrl = normalizeMagnitProduct(
    { name: 'Молоко', offers: { price: '55 ₽' } } as never,
    { city: 'moscow', url: 'https://magnit.ru/product/77001/' },
  );
  assert.equal(byUrl?.canonicalId, 'magnit-77001', 'id взят из ссылки, когда sku нет');
  assert.equal(normalizeMagnitProduct({ sku: '1', offers: { price: '10 ₽' } } as never, { city: 'moscow', url: '' }), null, 'без имени товар не опознан');
  assert.equal(normalizeMagnitProduct({ sku: '1', name: 'Молоко' } as never, { city: 'moscow', url: '' }), null, 'без цены товар не опознан');

  // Вес приходит и строкой, и объектом; объект без полей не должен давать
  // «шт»-пустышку в поле фасовки.
  const strWeight = normalizeMagnitProduct(
    { sku: '2', name: 'Молоко', offers: [{ price: '10 ₽' }], weight: '930 мл' } as never,
    { city: 'moscow', url: '' },
  );
  assert.equal(strWeight?.unit, '930 мл', 'вес-строка сохранён');
  const emptyWeight = normalizeMagnitProduct(
    { sku: '3', name: 'Молоко', offers: { price: '10 ₽' }, weight: {} } as never,
    { city: 'moscow', url: '' },
  );
  assert.equal(emptyWeight?.unit, undefined, 'объект веса без полей не выдумывает фасовку');
  const partWeight = normalizeMagnitProduct(
    { sku: '4', name: 'Молоко', offers: { price: '10 ₽' }, weight: { value: 500 } } as never,
    { city: 'moscow', url: '' },
  );
  assert.equal(partWeight?.unit, '500кг', 'у объекта веса взято то, что есть, и добавлена единица');

  // Карточки из DOM: без ссылки, без названия и без текста с ценой — не товары.
  assert.deepEqual(
    cardsToProducts(
      [
        { name: 'Молоко', href: '', img: '', texts: ['10 ₽'] },
        { name: '', href: '/product/1/', img: '', texts: ['10 ₽'] },
        { name: 'Молоко', href: '/product/1/', img: '', texts: [] },
      ],
      { city: 'moscow' },
      10,
    ),
    [],
    'карточка без id, без имени или без цены отбрасывается',
  );
  const fromCards = cardsToProducts(
    [{ name: 'Молоко', href: '/product/7700202/?shopCode=473996', img: '', texts: ['99 ₽', '149 ₽', '99 ₽/кг'] }],
    { city: 'moscow' },
    10,
  );
  assert.equal(fromCards[0]?.oldPrice, 149, 'старая цена из карточки');
  assert.equal(fromCards[0]?.unitPrice, '99 ₽/кг', 'цена за кг из карточки сохранена как есть, без выдуманной фасовки');
  assert.equal(fromCards[0]?.unit, undefined, 'а фасовка отсюда не выдумывается');
  assert.equal(fromCards[0]?.url, 'https://magnit.ru/product/7700202/', 'query из ссылки убран');
  assert.equal(
    cardsToProducts([{ name: 'Молоко', href: '/product/77009/', img: '', texts: ['99 ₽'] }], { city: 'moscow' }, 10)[0]?.oldPrice,
    null,
    'без зачёркнутой цены старой цены нет',
  );

  // Товары из __NUXT_DATA__: запись без id, без названия или без цены.
  assert.deepEqual(
    goodsToProducts(
      [
        { id: '', title: 'Молоко', link: '/product/1/', image: '', price: '10 ₽', oldPrice: '' },
        { id: '1', title: '', link: '/product/1/', image: '', price: '10 ₽', oldPrice: '' },
        { id: '2', title: 'Кефир', link: '/product/2/', image: '', price: '', oldPrice: '' },
      ],
      { city: 'moscow' },
    ),
    [],
    'запись без id, названия или цены отбрасывается',
  );
  const fromNuxt = goodsToProducts(
    [{ id: '77003', title: 'Кефир', link: '/product/77003/', image: '', price: '50 ₽', oldPrice: '70 ₽' }],
    { city: 'moscow' },
  );
  assert.equal(fromNuxt[0]?.oldPrice, 70, 'старая цена из __NUXT_DATA__');
}

// --- 12. Каталог: NUXT без категорий, битый JSON-LD, дубли, потолок. -------
{
  // Код магазина обязан быть ВНУТРИ __NUXT_DATA__: сверка идёт по нему, а не по
  // ссылкам страницы, иначе чужой ответ со ссылкой в меню прошёл бы как свой.
  const own = (script: string): string =>
    `<html><body><a href="/catalog/?shopCode=${SHOP}">витрина</a><script id="__NUXT_DATA__" type="application/json">shopCode=${SHOP}&${script}</script></body></html>`;

  // Ответ без __NUXT_DATA__: сверяться не с чем, и код не выдумывает вины —
  // говорит, что это не наш магазин.
  reply = { body: `<html><body><a href="/catalog/?shopCode=${SHOP}">витрина</a></body></html>` };
  await assert.rejects(
    () => adapter.fetchCategories(CTX),
    /нет shopCode/,
    'каталог без данных NUXT не проходит сверку магазина',
  );

  // Данные на месте и магазин наш, а категорий в них нет — это дрейф вёрстки,
  // и сказать об этом нужно прямо, а не молча вернуть пустой каталог.
  reply = { body: own('{"version":"x"}') };
  await assert.rejects(
    () => adapter.fetchCategories(CTX),
    /категории не найдены/,
    'наш магазин без категорий — дрейф вёрстки, а не пустой магазин',
  );

  // Категория без ссылки на каталог и дубликат по id: остаются только
  // пригодные и уникальные.
  const cats = parseMagnitCategories(
    own(
      `"g1","11","Молоко","testmm_1","https://img/a.png","/catalog/11-moloko/","g1","12","Молоко","testmm_1","https://img/a.png","/catalog/12-dubly/","g3","13","Хлеб","testmm_3","data:image/png;base64,AAA","/catalog/13-hleb/","g4","14","Сыр","testmm_4","https://img/d.png",""` +
        Array.from({ length: 45 }, (_, i) => `"g5${i}","${i}","Кат${i}","testmm_5${i}","https://img/x.png","/catalog/${i}-kat-${i}/"`).join(','),
    ),
    SHOP,
  );
  assert.equal(cats.length, 40, 'больше сорока категорий не разбираем: витрина не должна расти бесконечно');
  assert.deepEqual(
    cats.map((c) => c.id),
    [...new Set(cats.map((c) => c.id))],
    'дубликаты категорий не повторяются',
  );
  // id в интерфейсе — цифры из «g3», а не сама метка.
  assert.equal(cats.some((c) => c.id === '3'), true, 'категория со ссылкой взята');
  assert.equal(cats.find((c) => c.id === '3')?.imageUrl, undefined, 'картинка data: не попадает в интерфейс');
  assert.equal(cats.find((c) => c.id === '1')?.url, 'https://magnit.ru/catalog/11-moloko/', 'ссылка категории собрана');
  assert.equal(cats.some((c) => c.id === '4'), false, 'категория без ссылки отброшена');

  // Карточка: JSON-LD есть, но товара в нём нет.
  reply = { body: productHtml([{ '@type': 'BreadcrumbList', itemListElement: [] }]) };
  await assert.rejects(
    () => adapter.fetchProduct('magnit-77001', CTX),
    /Product JSON-LD не найден/,
    'карточка без товара в JSON-LD — дрейф вёрстки',
  );

  // JSON-LD с блоками не-объектами и не-товарами: они обязаны быть пропущены,
  // а товар в том же ответе — найден. Каждый блок приходит своим script-тегом,
  // как их и кладёт сайт.
  const ldPage = (blocks: unknown[]): string =>
    `<html><head><link rel="canonical" href="https://magnit.ru/catalog/?shopCode=${SHOP}" />${blocks
      .map((b) => `<script type="application/ld+json">${typeof b === 'string' ? b : JSON.stringify(b)}</script>`)
      .join('')}</head><body><a href="/catalog/?shopCode=${SHOP}">Молоко</a></body></html>`;
  reply = {
    body: ldPage([
      'строка',
      42,
      null,
      { '@type': 'WebSite', name: 'Магнит' },
      { name: 'Без типа и без sku' },
      { '@type': 'Product', sku: '77001', name: 'Молоко', offers: { price: '99 ₽' } },
    ]),
  };
  const found = await adapter.fetchProduct('magnit-77001', CTX);
  assert.equal(found.price, 99, 'мусор в JSON-LD не мешает найти товар');

  // Витрина: OfferCatalog без списка офферов и оффер без ссылки.
  reply = {
    body: ldPage([
      { '@type': 'OfferCatalog', name: 'каталог без списка' },
      { '@type': 'OfferCatalog', itemListElement: { 'не массив': true } },
      {
        '@type': 'OfferCatalog',
        itemListElement: [
          { name: 'Без ссылки', price: '10 ₽' },
          { '@type': 'Offer', name: 'Молоко', url: 'https://magnit.ru/product/77004/', price: '10 ₽' },
        ],
      },
    ]),
  };
  const shelfItems = await adapter.fetchCategoryProducts('https://magnit.ru/catalog/1-', CTX);
  assert.equal(shelfItems.length, 1, 'оффер без ссылки отброшен, наш собран');
  assert.equal(shelfItems[0]?.canonicalId, 'magnit-77004', 'и это именно он');
}

// --- 13. Отказы по коду ответа: сеть должна звучать, а не молчать. ----------
for (const [label, call, pattern] of [
  ['карточки', () => adapter.fetchProduct('magnit-1', CTX), /magnit product HTTP 503/],
  ['витрины магазина', () => adapter.fetchCategories(CTX), /magnit home HTTP 503/],
  ['витрины по ссылке', () => adapter.fetchCategoryProducts('https://magnit.ru/catalog/1-', CTX), /magnit category HTTP 503/],
] as const) {
  reply = { status: 503, body: 'service unavailable' };
  await assert.rejects(call, pattern, `HTTP-отказ ${label} назван своим кодом`);
}

// Поиск при отказе сети не отдаёт пустую выдачу, а уходит в браузер: фейковый
// Playwright поднимается с ошибкой, и пользователь видит её, а не «ничего не
// нашлось».
reply = { status: 503, body: 'service unavailable' };
const failLaunch = {
  launch: async () => {
    throw new Error('фейковый Playwright: браузер не поднимется');
  },
};
__setPlaywrightForTests({
  firefox: failLaunch,
  chromium: failLaunch,
} as unknown as typeof import('playwright'));
await assert.rejects(
  () => adapter.search('молоко', CTX),
  /фейковый Playwright/,
  'отказ прямого поиска уводит в браузер, а не молча возвращает пустую выдачу',
);
__setPlaywrightForTests(null);
reply = {};

// --- 14. Остатки разбора: пустые поля в данных витрины. --------------------
{
  // offer без цены: id из ссылки есть, а цены нет — это не товар.
  assert.equal(
    normalizeMagnitOffer({ name: 'Молоко', url: 'https://magnit.ru/product/99001/' } as never, { city: 'moscow' }),
    null,
    'offer со ссылкой, но без цены — не товар',
  );

  // Запись витрины с пустой ценой: пропущена, а не превращена в товар с ценой 0.
  // Зачёркнутая цена в пейлоаде идёт ПОСЛЕ цены товара, поэтому вторая запись
  // проверяет, что старая цена оттуда подхватывается.
  const promos = parseMagnitCategoryPromos(
    [
      '<html><body><script id="__NUXT_DATA__" type="application/json">',
      `shopCode=${SHOP}&`,
      '"7700101","Молоко","\\u002Fproduct\\u002F77001","https://img/a.png","",',
      '"7700202","Кефир","\\u002Fproduct\\u002F7700202","https://img/b.png","79 ₽","179 ₽"',
      '</script></body></html>',
    ].join(''),
    SHOP,
  );
  assert.equal(promos.size, 0, 'без зачёркнутой цены подсказок по акции нет вовсе');
}

globalThis.fetch = realFetch;
console.log('magnit http: ALL GREEN — поиск, карточка, каталог, витрина, кука магазина, редиректы');