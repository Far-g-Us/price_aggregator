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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cardsToProducts,
  extractCategoryOffers,
  goodsToProducts,
  MagnitAdapter,
  directPhaseLeftMs,
  normalizeMagnitOffer,
  normalizeMagnitProduct,
  parseMagnitCategories,
  parseMagnitCategoryPromos,
  parseMagnitPrice,
  visibleText,
  __setDirectPhaseBudgetForTests,
} from '../src/core/adapters/magnit.js';
import { ProductLookupError } from '../src/core/adapter-errors.js';
import { __setPlaywrightForTests } from '../src/core/adapters/playwright-port.js';
// печатает ошибки — в тестах это шум, мешающий прочитать результат.

const html = (name: string): string => fs.readFileSync(`tests/fixtures/${name}`, 'utf8');
const json = (name: string): unknown => JSON.parse(fs.readFileSync(`tests/fixtures/${name}`, 'utf8'));

const SHOP = '473996';
/** Магазин, под которым снята живая фикстура главной (tests/fixtures/magnit-home.html). */
const LIVE_HOME_SHOP = '992301';
const CTX = { city: 'moscow', externalStoreId: SHOP };

type Reply = { status?: number; body?: string; url?: string; byUrl?: Record<string, { status?: number; body?: string }> };
let reply: Reply = {};
const seen: { url: string; headers: Record<string, string> }[] = [];
const realFetch = globalThis.fetch;

const mockedFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = typeof input === 'string' ? input : String(input instanceof URL ? input : input.url);
  seen.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
  // Ответы по URL: витрина Магнита берётся из HTML-главной, а запасной путь —
  // из API-дерева, и в тесте это должны быть РАЗНЫЕ ответы.
  const specific = reply.byUrl
    ? Object.entries(reply.byUrl).find(([k]) => url.includes(k))?.[1]
    : undefined;
  const status = specific?.status ?? reply.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    url: reply.url ?? url,
    text: async () => specific?.body ?? reply.body ?? '',
  } as unknown as Response;
}) as typeof fetch;

globalThis.fetch = mockedFetch;

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
  // Первый запрос — это уже webgate-API, а HTML-страница поиска разбирается
  // только фолбэком. Ищем нужный по URL, а не по индексу: порядок запросов —
  // деталь реализации, а проверять надо сам факт «по term, не по query».
  const searchReq = seen.find((r) => /\/search\?term=/.test(r.url));
  assert.ok(searchReq, 'HTML-путь поиска должен быть среди запросов');
  assert.match(searchReq!.headers.Cookie ?? '', /shopCode/, 'кука магазина ушла и в HTML-путь');
}

// --- 1a. webgate-API — ПЕРВЫЙ путь, и он дешевле HTML-оболочки. -------------
{
  seen.length = 0;
  const apiBody = {
    items: [
      {
        id: 3422154710,
        productId: 3422154710,
        name: 'Молоко Алексеевское 8%',
        price: 14900,
        promotion: { isPromotion: true, oldPrice: 19999 },
        quantity: 24,
        storeCode: SHOP,
        seoCode: 'moloko-alekseevskoe',
        gallery: [{ type: 'IMAGE', url: 'https://images-foodtech.magnit.ru/x.jpeg@webp' }],
      },
    ],
    pagination: { totalCount: 1, hasMore: false },
  };
  reply = { body: JSON.stringify(apiBody) };
  const items = await adapter.search('молоко', CTX);
  assert.strictEqual(seen.length, 1, 'при живом API HTML-фолбэк не трогаем — это лишний запрос к сети');
  assert.match(seen[0]!.url, /webgate\/v2\/goods\/search/, 'первым идёт JSON-API, а не HTML-страница');
  assert.strictEqual(seen[0]!.headers['Content-Type'], 'application/json');
  assert.match(seen[0]!.headers.Cookie ?? '', /shopCode/, 'кука точки уходит в API');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0]!.price, 149, 'копейки делятся на 100');
  // ПРЕФИКС `magnit-` обязателен: `fetchProduct` сверяет нормализованный
  // canonicalId с пришедшим и строит адрес из `canonicalId.replace(/^magnit-/,
  // '')`. Без префикса КАЖДЫЙ товар из поиска падал бы на опросе с «JSON-LD не
  // найден», плюс дубль строк в истории против товара, найденного полкой.
  assert.strictEqual(items[0]!.canonicalId, 'magnit-3422154710', 'canonicalId с префиксом сети');
  assert.strictEqual(items[0]!.oldPrice, 199.99, 'зачёркнутая цена из promotion.oldPrice');
  assert.strictEqual(items[0]!.storeCode, SHOP, 'в товар едёт код, который ОТДАЛА сеть');
  assert.strictEqual(items[0]!.promoPrice, undefined, 'promoPrice не выдумываем: акция живёт в price/oldPrice');
  assert.strictEqual(items[0]!.inStock, true, 'quantity 24 → в наличии');
}

// --- 1a-3. Пустой терм и «наличие неизвестно» — без лишнего запроса к сети.
// Пустой `term` — та же ловушка, что была с `?query=`: сеть молча отдаёт
// популярные товары. Наличие при отсутствии поля обязано остаться
// НЕИЗВЕСТНЫМ (поле не ставится), а не превратиться в «есть».
{
  seen.length = 0;
  reply = { body: '{"items":[]}' };
  assert.deepStrictEqual(await adapter.search('   ', CTX), [], 'пустой терм даёт пусто');
  assert.strictEqual(seen.length, 0, 'на пустой терм сеть не опрашиваем вовсе');

  reply = {
    body: JSON.stringify({ items: [{ id: 9, productId: 9, name: 'Хлеб', price: 1000, storeCode: SHOP }] }),
  };
  const [item] = await adapter.search('хлеб', CTX);
  assert.ok(item);
  assert.ok(!('inStock' in item!), 'quantity нет → поле inStock не ставится вообще');
}
{
  reply = {
    body: JSON.stringify({
      items: [{ id: 5, productId: 5, name: 'Хлеб', price: 1000, quantity: 1, storeCode: SHOP, gallery: [] }],
    }),
  };
  const [item] = await adapter.search('хлеб', CTX);
  assert.ok(item);
  assert.ok(!('imageUrl' in item!), 'нет картинки — нет и поля, а не imageUrl: undefined');
}

// --- 1b. webgate ответил чужим магазином — громкий отказ, не silent skip. ---
{
  reply = {
    body: JSON.stringify({
      items: [{ id: 1, productId: 1, name: 'Хлеб', price: 1000, quantity: 1, storeCode: '992301' }],
    }),
  };
  await assert.rejects(
    () => adapter.search('хлеб', CTX),
    /чужого магазина/,
    'цены чужого магазина не возвращаются даже после HTML-фолбэка',
  );
}

// --- 1c. webgate 5xx — идём в HTML-фолбэк, а не падаем. ----------------------
{
  seen.length = 0;
  reply = { status: 503, body: 'upstream' };
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    () => true,
    '5xx без HTML-данных обязан дойти до отказа, а не вернуть пустую выдачу',
  );
  assert.ok(
    seen.some((r) => /webgate\/v2\/goods\/search/.test(r.url)),
    'сначала пробуем API даже при его отказе',
  );
}

// --- 1d. webgate упал, HTML не сработал с первого раза — повтор спасает. ---
// Порядок «дёшево, потом дорого»: webgate → HTML-попытка 1 → пауза → HTML-попытка 2.
{
  seen.length = 0;
  let apiFailures = 0;
  const flakyFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : String(input instanceof URL ? input : input.url);
    seen.push({ url, headers: {} });
    if (/webgate\/v2\/goods\/search/.test(url)) {
      apiFailures += 1;
      return { ok: false, status: 503, url, text: async () => 'upstream' } as unknown as Response;
    }
    // Первая HTML-попытка отдаёт 503 — это РЕТРАИТЕМЫЙ отрыв, в отличие от
    // пустого тела (оно читается как «чужой магазин» и повтором не лечится).
    // Вторая — живую фикстуру. Так проверяется именно ветка «повтор помог».
    if (/\/search\?term=/.test(url)) {
      const n = seen.filter((r) => /\/search\?term=/.test(r.url)).length;
      if (n === 1) return { ok: false, status: 503, url, text: async () => 'upstream' } as unknown as Response;
      return { ok: true, status: 200, url, text: async () => html('magnit-search.html') } as unknown as Response;
    }
    return { ok: true, status: 200, url, text: async () => '' } as unknown as Response;
  }) as unknown as typeof fetch;
  globalThis.fetch = flakyFetch;
  try {
    const items = await adapter.search('молоко', CTX);
    assert.ok(items.length > 0, 'вторая HTML-попытка вернула выдачу');
    assert.equal(apiFailures, 1, 'webgate не повторяется: повтор живой в HTML-фазе, где он и лечит обрыв');
    assert.equal(
      seen.filter((r) => /\/search\?term=/.test(r.url)).length,
      2,
      'HTML-фаза делает ровно две попытки',
    );
  } finally {
    globalThis.fetch = mockedFetch;
  }
}

// --- 1e. webgate: пустая выдача при totalCount>0 — это сбой сети, а не пусто. --
// Сеть сама говорит, что совпадения есть, — значит, она деградировала.
// Дальше должен идти браузерный путь (клиентский рендер ещё видит товары),
// и только если и он ничего не нашёл — точное сообщение, а не «ничего не
// нашлось».
{
  reply = {
    body: JSON.stringify({ items: [], pagination: { totalCount: 12, hasMore: true } }),
  };
  // Метод приватный, но в рантайме доступен: проверяем именно метку
  // деградации, а не то, что поиск в конце концов упадёт.
  const viaApi = await (
    adapter as unknown as {
      searchViaWebgate: (
        q: string,
        c: typeof CTX,
        s: number,
      ) => Promise<{ products: unknown[]; degradedTotal: number | null }>;
    }
  ).searchViaWebgate('молоко', CTX, Date.now());
  assert.equal(viaApi.products.length, 0, 'товаров webgate не отдал');
  assert.equal(viaApi.degradedTotal, 12, 'деградация помечена числом обещанных совпадений');
}

// --- 1e-2. Деградация: браузер не нашёл — сообщение остаётся точным. -------
// Сеть молчит, но сама обещает совпадения; браузерный путь отрабатывает и не
// находит. Тогда пользователь должен получить «это сбой сети», а не «ничего
// не нашлось» и не «ошибка разбора HTML».
{
  seen.length = 0;
  // Маркер кода магазина нужен в двух видах: в query-параметре ссылки
  // (`shopCode=473996`) и с кавычками (`"473996"`) — обе проверки ищут свой
  // формат. Видимого текста должно хватать порога «страница не пустая»
  // (200 символов), иначе проверка решит, что страница не догрузилась.
  const emptyShelfHtml = `<html><body><a href="/catalog/?shopCode=${SHOP}" data-store="${SHOP}">витрина магазина: молочное, хлеб, овощи и фрукты, напитки, хозтовары — полный список отделов с названиями</a><p>Отдел молочного: молоко, кефир, йогурты, сыры, масло. Отдел хлеба: хлеб, батоны, булочки. Отдел овощей: овощи, фрукты, зелень. Отдел напитков: вода, соки, чай, кофе. Отдел хозяйственных товаров: бытовая химия, бумага, мыло.</p></body></html>`;
  // А вот РЕАЛЬНАЯ оболочка пустого SPA: ни кода магазина, ни ссылок на
  // товары (живая проверка 2026-10-20: `/search?term=` отдаёт ровно это). Именно
  // она раньше объявлялась «чужим магазином» и обрывала поиск ДО браузера.
  const blankShellHtml =
    '<html><body><script id="__NUXT_DATA__" type="application/json">[{"serverRendered":1},false]</script></body></html>';
  const degradedFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : String(input instanceof URL ? input : input.url);
    seen.push({ url, headers: {} });
    if (url.includes('/webgate/')) {
      return {
        ok: true,
        status: 200,
        url,
        text: async () => JSON.stringify({ items: [], pagination: { totalCount: 12, hasMore: true } }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      url,
      text: async () => blankShellHtml,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  globalThis.fetch = degradedFetch;
  let browserLaunched = 0;
  const fakePage = {
    content: async () => blankShellHtml,
    title: async () => 'Магнит',
    goto: async () => undefined,
    waitForSelector: async () => {
      throw new Error('таймаут: товарных карточек на странице нет');
    },
  };
  const fakeBrowser = {
    newContext: async () => ({
      addCookies: async () => undefined,
      newPage: async () => fakePage,
    }),
    close: async () => undefined,
  };
  __setPlaywrightForTests({
    chromium: {
      launch: async () => {
        browserLaunched += 1;
        return fakeBrowser;
      },
    },
  } as unknown as Parameters<typeof __setPlaywrightForTests>[0]);
  try {
    await assert.rejects(
      () => adapter.search('молоко', CTX),
      /пустую выдачу/,
      'деградация без товара в браузере — точное сообщение, а не «ничего не нашлось»',
    );
    assert.equal(browserLaunched, 1, 'пустая оболочка дошла до браузера, а не умерла на «чужом магазине»');
  } finally {
    __setPlaywrightForTests(null);
    globalThis.fetch = mockedFetch;
  }
}

// --- 1f. webgate: честная пустота (totalCount=0) — пустой выдачей. -----------
{
  reply = {
    body: JSON.stringify({ items: [], pagination: { totalCount: 0, hasMore: false } }),
  };
  const items = await adapter.search('молоко', CTX);
  assert.equal(items.length, 0, 'нет совпадений по запросу — честная пустота');
}

// --- 1e-1. webgate: пустая выдача БЕЗ pagination — дрейф формы, не пусто. ---
// Документированная форма ответа несёт `pagination.totalCount`; если поля нет,
// сеть сменила форму. Молчать об этом нельзя: пользователь увидел бы «нет
// товаров» вместо «сеть сменила ответ».
{
  reply = { body: JSON.stringify({ items: [] }) };
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /pagination\.totalCount/,
    'пропавшее pagination — дрейф формы, а не «ничего не нашлось»',
  );
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

// --- 3. Пустой HTML — это «идём в браузер», а не «смена вёрстки». ----------
// С 2026-10-18 сайт Магнита на клиентском рендере: `/search?term=` отдаёт
// пустую оболочку Nuxt, и товаров в HTML нет ВСЕГДА. Объявлять это поломкой
// значило бы, что поиск Магнита не работает вовсе (он работает через webgate
// и через браузер). Поэтому пустой разбор уводит в браузер, а «смена вёрстки»
// остаётся диагностикой для случая, когда и браузер ничего не нашёл.
{
  reply = { body: '<html><body><a href="/catalog/?shopCode=473996">витрина</a></body></html>' };
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /браузер|vydorf|вёрстк/i,
    'пустой HTML уводит в браузер, а не объявляется сменой вёрстки',
  );
}

// --- 3a. Цены есть, а код магазина ссылками не показан: сверять нечем. -----
// Ответ наш по куке (canonical с `shopCode=%22473996`), но ссылки на товары без
// `shopCode=`, и товары при этом разобрались. Отдавать такое ядру нельзя:
// sentinel в товаре означал бы «доверяй запрошенной точке», и цены
// неподтверждённого магазина уехали бы в историю нашей точки.
{
  seen.length = 0;
  const noLinkCode = html('magnit-search.html')
    .replace(/^/, '<html><head><link rel="canonical" href="https://magnit.ru/catalog/?shopCode=%22473996" /></head><body>')
    .split('?shopCode=473996&shopType=express')
    .join('?shopType=express');
  reply = { body: noLinkCode };
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /сверять точку нечем/,
    'товары без подтверждённого кода магазина не превращаются в наши цены',
  );
  // Два запроса: webgate-API (упал на JSON.parse, потому что подмена отдала
  // HTML) и один HTML-поиск. Повтора и браузерного фолбэка быть НЕ должно —
  // «сверять точку нечем» лечится только громким отказом.
  assert.equal(
    seen.filter((r) => /\/search\?term=/.test(r.url)).length,
    1,
    'отказ не ушёл ни в повтор, ни в браузерный фолбэк',
  );
}

// --- 3b. Витрина: цены есть, кода магазина ссылками нет — пусто, а не цены. -
// JSON-LD витрины и пейлоад __NUXT_DATA__ — два независимых носителя, дрейф
// пейлоада у Магнита уже был. Отказ здесь уронил бы полку целиком, минуя
// браузерный фолбэк, где своя сверка. Поэтому правильный ответ — пусто:
// фолбэк либо найдёт товары со сверкой, либо скажет, что витрины нет.
{
  const promoHtml = readFileSync('tests/fixtures/magnit-category-promo.html', 'utf-8');
  const noLinkCode = promoHtml
    .split('?shopCode=473996&shopType=express')
    .join('?shopType=express')
    // Канонический url несёт код, иначе hasShopCode отвергнет ответ как чужой
    // и проверить будет нечего.
    .replace('<html>', '<html><head><link rel="canonical" href="https://magnit.ru/catalog/?shopCode=%22473996" /></head>');
  assert.ok(
    extractCategoryOffers(promoHtml, { city: 'moscow', shopCode: '473996' }).length > 0,
    'исходная живая фикстура витрины подтверждает код и цены отдаёт',
  );
  assert.deepEqual(
    extractCategoryOffers(noLinkCode, { city: 'moscow', shopCode: '473996' }),
    [],
    'витрина без подтверждённого кода магазина не превращается в наши цены',
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
  const product = await adapter.fetchProduct('magnit-1000483001', { ...CTX, name: 'Молоко' });
  assert.equal(product.canonicalId, 'magnit-1000483001', 'id из карточки');
  assert.equal(product.price, 119, 'цена из offers');
  assert.equal(product.storeId, 'magnit', 'сеть проставлена адаптером');
}

// --- 6. Карточка: ответ без JSON-LD. --------------------------------------
{
  // Наш магазин, но без разметки товара: сверка проходит, разбирать нечего.
  reply = { body: `<html><body><a href="/catalog/?shopCode=${SHOP}">Молоко</a></body></html>` };
  await assert.rejects(
    () => adapter.fetchProduct('magnit-1000483001', { ...CTX, name: 'Молоко' }),
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
    () => adapter.fetchProduct('magnit-1000483001', { ...CTX, name: 'Молоко' }),
    /ушёл с \/product\//,
    'редирект на логин — это не товар, и цена бы записалась чужая',
  );
}

// --- 8. Каталог магазина: витрина приехала. --------------------------------
{
  seen.length = 0;
  // Живой ответ главной: снят 2026-10-08, плитки пришли обычными <a> в HTML.
  // Прежняя фикстура лежала в формате `__NUXT_DATA__` со ссылками `/catalog/…`,
  // которого в живом ответе больше нет (0 вхождений), поэтому она удалена.
  const home = readFileSync(resolve(import.meta.dirname, '../tests/fixtures/magnit-home.html'), 'utf8');
  const liveShop = /shopCode=(\d+)/.exec(home)?.[1] ?? '';
  reply = { body: home };
  const categories = await adapter.fetchCategories({ city: 'moscow', externalStoreId: liveShop });
  assert.ok(categories.length > 0, 'каталог непустой');
  assert.ok(
    categories.every((c) => c.url.startsWith('https://magnit.ru/catalog/')),
    'ссылки каталога чистые, без утечки query',
  );
  assert.ok(
    categories.every((c) => /^\d+$/.test(c.id)),
    'id числовой, как в живых ссылках',
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
  assert.equal(normalizeMagnitOffer({ name: 'Молоко' } as never, { city: 'moscow', externalStoreId: 'TEST' }), null, 'offer без ссылки и без sku');
  assert.equal(
    normalizeMagnitOffer({ name: 'Молоко', url: 'https://magnit.ru/product/x/' } as never, { city: 'moscow', externalStoreId: 'TEST' }),
    null,
    'ссылка без цены — не товар',
  );
  const withPrice = normalizeMagnitOffer(
    { name: 'Молоко', url: 'https://magnit.ru/product/99001/', price: '99 ₽' } as never,
    { city: 'moscow', externalStoreId: 'TEST' },
  );
  assert.equal(withPrice?.price, 99, 'цена из строки разобрана');
  assert.equal(withPrice?.inStock, true, 'без статуса наличия товар считаем есть');
  assert.equal(
    withPrice?.storeCode,
    'TEST',
    'товар несёт код точки, о которой просили: без него две точки сети делят цену',
  );
  const outOfStock = normalizeMagnitOffer(
    { name: 'Молоко', url: 'https://magnit.ru/product/99001/', price: '99 ₽', availability: 'OutOfStock' } as never,
    { city: 'moscow', externalStoreId: 'TEST' },
  );
  assert.equal(outOfStock?.inStock, false, 'явный OutOfStock — товара нет');

  // Карточка: sku нет — id берётся из ссылки, иначе товар не опознан.
  const byUrl = normalizeMagnitProduct(
    { name: 'Молоко', offers: { price: '55 ₽' } } as never,
    { city: 'moscow', url: 'https://magnit.ru/product/77001/', externalStoreId: 'TEST' },
  );
  assert.equal(byUrl?.canonicalId, 'magnit-77001', 'id взят из ссылки, когда sku нет');
  assert.equal(byUrl?.storeCode, 'TEST', 'карточка тоже несёт код точки');
  assert.equal(normalizeMagnitProduct({ sku: '1', offers: { price: '10 ₽' } } as never, { city: 'moscow', url: '', externalStoreId: 'TEST' }), null, 'без имени товар не опознан');
  assert.equal(normalizeMagnitProduct({ sku: '1', name: 'Молоко' } as never, { city: 'moscow', url: '', externalStoreId: 'TEST' }), null, 'без цены товар не опознан');

  // Вес приходит и строкой, и объектом; объект без полей не должен давать
  // «шт»-пустышку в поле фасовки.
  const strWeight = normalizeMagnitProduct(
    { sku: '2', name: 'Молоко', offers: [{ price: '10 ₽' }], weight: '930 мл' } as never,
    { city: 'moscow', url: '', externalStoreId: 'TEST' },
  );
  assert.equal(strWeight?.unit, '930 мл', 'вес-строка сохранён');
  const emptyWeight = normalizeMagnitProduct(
    { sku: '3', name: 'Молоко', offers: { price: '10 ₽' }, weight: {} } as never,
    { city: 'moscow', url: '', externalStoreId: 'TEST' },
  );
  assert.equal(emptyWeight?.unit, undefined, 'объект веса без полей не выдумывает фасовку');
  const partWeight = normalizeMagnitProduct(
    { sku: '4', name: 'Молоко', offers: { price: '10 ₽' }, weight: { value: 500 } } as never,
    { city: 'moscow', url: '', externalStoreId: 'TEST' },
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
      { city: 'moscow', externalStoreId: 'TEST' },
      10,
    ),
    [],
    'карточка без id, без имени или без цены отбрасывается',
  );
  const fromCards = cardsToProducts(
    [{ name: 'Молоко', href: '/product/7700202/?shopCode=473996', img: '', texts: ['99 ₽', '149 ₽', '99 ₽/кг'] }],
    { city: 'moscow', externalStoreId: 'TEST' },
    10,
  );
  assert.equal(fromCards[0]?.oldPrice, 149, 'старая цена из карточки');
  assert.equal(fromCards[0]?.unitPrice, '99 ₽/кг', 'цена за кг из карточки сохранена как есть, без выдуманной фасовки');
  assert.equal(fromCards[0]?.unit, undefined, 'а фасовка отсюда не выдумывается');
  assert.equal(fromCards[0]?.url, 'https://magnit.ru/product/7700202/', 'query из ссылки убран');
  assert.equal(fromCards[0]?.storeCode, 'TEST', 'плитки витрины тоже несут код точки');
  assert.equal(
    cardsToProducts([{ name: 'Молоко', href: '/product/77009/', img: '', texts: ['99 ₽'] }], { city: 'moscow', externalStoreId: 'TEST' }, 10)[0]?.oldPrice,
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
      { city: 'moscow', externalStoreId: 'TEST' },
    ),
    [],
    'запись без id, названия или цены отбрасывается',
  );
  const fromNuxt = goodsToProducts(
    [{ id: '77003', title: 'Кефир', link: '/product/77003/', image: '', price: '50 ₽', oldPrice: '70 ₽' }],
    { city: 'moscow', externalStoreId: 'TEST' },
  );
  assert.equal(fromNuxt[0]?.oldPrice, 70, 'старая цена из __NUXT_DATA__');
}

// --- 12. Категории: разбор живой плитки, дрейф вёрстки, дубли, потолок. ----
{
  // Витрина берётся из HTML-главной: только там у плиток есть картинки.
  // Ответ из другого магазина: сверка идёт по shopCode в теле ответа, иначе
  // чужой магазин прошёл бы как свой. Отказ должен быть громким — пустой
  // каталог значил бы «у магазина нет разделов».
  reply = {
    body: '<html><body><a href="https://magnit.ru/catalog/1">x</a></body></html>',
    byUrl: {
      'magnit.ru/webgate': { status: 200, body: '<html>не json</html>' },
    },
  };
  await assert.rejects(
    () => adapter.fetchCategories(CTX),
    /не JSON|WAF/,
    'ответ без shopCode не проходит сверку магазина, и отказ громкий',
  );

  // Свой магазин, а плиток нет — дрейф вёрстки. Запасной путь (API-дерево)
  // в этот момент отдаёт листья с картинками, значит витрина собирается из
  // него — молчаливого пустого каталога быть не должно.
  reply = {
    body: `<html><body><a href="/catalog/?shopCode=${SHOP}&shopType=express">витрина</a>` +
      `<script id="__NUXT_DATA__" type="application/json">{"shop":"shopCode=${SHOP}"}</script></body></html>`,
    byUrl: {
      'magnit.ru/webgate': {
        status: 200,
        body: JSON.stringify({
          items: [
            {
              id: 1,
              name: 'Раздел',
              image: 'https://img/root.png',
              children: [
                { id: 11, name: 'Бакалея', images: [{ type: 'card', url: 'https://img/11.png' }] },
              ],
            },
          ],
        }),
      },
    },
  };
  const fallback = await adapter.fetchCategories(CTX);
  assert.equal(fallback.length, 1, 'при дрейфе HTML витрина берётся из API-дерева');
  assert.equal(fallback[0]?.name, 'Бакалея', 'лист API-дерева взят');
  assert.equal(fallback[0]?.imageUrl, 'https://img/11.png', 'картинка листа подхвачена');
  assert.equal(fallback[0]?.url, 'https://magnit.ru/catalog/11', 'ссылка собрана из id');

  // Ни HTML, ни API-дерево не дали разбора — громкий отказ, а не пустая
  // витрина: «у магазина нет разделов» — это неправда.
  reply = {
    body: `<html><body><a href="/catalog/?shopCode=${SHOP}">витрина</a></body></html>`,
    byUrl: { 'magnit.ru/webgate': { status: 200, body: '<html>не json</html>' } },
  };
  await assert.rejects(
    () => adapter.fetchCategories(CTX),
    /не JSON|WAF/,
    'когда ни один источник не разобран — отказ, а не пустой каталог',
  );

  // Живой ответ главной (tests/fixtures/magnit-home.html, снят 2026-10-08):
  // плитки приходят обычными <a> в HTML, id числовой, название в alt.
  const home = readFileSync(resolve(import.meta.dirname, '../tests/fixtures/magnit-home.html'), 'utf8');
  const liveShop = /shopCode=(\d+)/.exec(home)?.[1] ?? '';
  assert.ok(liveShop !== '', 'в фикстуре главной есть shopCode');
  const cats = parseMagnitCategories(home, liveShop);
  assert.equal(cats.length, 8, `витрина главной: ${cats.length} верхнеуровневых плиток`);
  assert.deepEqual(
    cats.map((c) => c.name),
    ['Скидки', 'Бакалея', 'Молочное', 'Алкоголь', 'Птица, мясо', 'Сыры', 'Сладкое', 'Чай, кофе'],
    'названия плиток разобраны по alt',
  );
  assert.equal(cats[1]?.id, '64121', 'id — число из ссылки');
  assert.equal(cats[1]?.url, 'https://magnit.ru/catalog/64121', 'ссылка собрана');
  assert.ok((cats[1]?.imageUrl ?? '').startsWith('https://'), 'картинка плитки подхвачена');
  assert.ok(
    cats.every((c) => c.imageUrl === undefined || !c.imageUrl.startsWith('data:')),
    'картинки data: в интерфейс не попадают',
  );

  // Плитка без картинки берёт название из текста подписи, data:-картинка
  // отбрасывается, дубли по id не повторяются, потолок — 40.
  const tile = (id: string, alt: string, span: string, img: string): string =>
    `<a class="catalog-categories-tiles__item pl-hover-base" href="https://magnit.ru/catalog/${id}">` +
    `<img src="${img}" alt="${alt}"><span class="pl-text catalog-categories-tiles__text">${span}</span></a>`;
  const handcrafted = parseMagnitCategories(
    `<html><body><a href="/catalog/?shopCode=${SHOP}&x=1">витрина</a>` +
      tile('11', 'Молоко', 'Молоко', 'https://img/a.png') +
      tile('11', 'Молоко дубль', 'Молоко дубль', 'https://img/a.png') +
      tile('12', '', 'Хлеб без картинки', 'https://img/b.png') +
      tile('13', 'Сыр data:', 'Сыр data', 'data:image/png;base64,AAA') +
      tile('14', '   ', '   ', 'https://img/c.png') +
      // Формы, которые сеть может отдать при смене вёрстки: плитка без картинки
      // (название только в подписи, с SSR-комментариями), плитка без подписи,
      // alt из одних пробелов, другой порядок атрибутов и относительная ссылка.
      '<a href="https://magnit.ru/catalog/15" class="catalog-categories-tiles__item"><span class="pl-text catalog-categories-tiles__text" data-v-1><!--[-->Только подпись<!--]--></span></a>' +
      '<a class="catalog-categories-tiles__item" href="https://magnit.ru/catalog/16"><img src="https://img/d.png" alt="Только alt"></a>' +
      '<a class="catalog-categories-tiles__item" href="/catalog/17"><img src="https://img/e.png" alt="   "><span class="pl-text catalog-categories-tiles__text"><!--[-->Из пробелов в alt<!--]--></span></a>' +
      // Незакрытая плитка не должна съесть следующую.
      '<a class="catalog-categories-tiles__item" href="https://magnit.ru/catalog/18"><img src="https://img/f.png" alt="Незакрытая плитка">' +
      tile('19', 'После незакрытой', 'После незакрытой', 'https://img/g.png') +
      '<a class="catalog-categories-tiles__item" href="https://magnit.ru/promo-catalog">все</a>' +
      Array.from(
        { length: 45 },
        (_, i) => tile(String(100 + i), `Кат${i}`, `Кат${i}`, 'https://img/x.png'),
      ).join('') +
      '</body></html>',
    SHOP,
  );
  assert.equal(handcrafted.length, 40, 'больше сорока категорий не разбираем');
  assert.deepEqual(
    handcrafted.map((c) => c.id),
    [...new Set(handcrafted.map((c) => c.id))],
    'дубликаты категорий не повторяются',
  );
  assert.equal(handcrafted.find((c) => c.id === '11')?.name, 'Молоко', 'первый дубль победил');
  assert.equal(handcrafted.find((c) => c.id === '12')?.name, 'Хлеб без картинки', 'название из подписи');
  assert.equal(handcrafted.find((c) => c.id === '13')?.imageUrl, undefined, 'картинка data: не попадает');
  assert.equal(
    handcrafted.some((c) => c.id === '14'),
    false,
    'пустое имя и в alt, и в подписи — плитка отброшена',
  );
  assert.equal(
    handcrafted.find((c) => c.id === '15')?.name,
    'Только подпись',
    'плитка без картинки берёт название из подписи, SSR-комментария не мешают',
  );
  assert.equal(
    handcrafted.find((c) => c.id === '16')?.name,
    'Только alt',
    'плитка без подписи берёт название из alt',
  );
  assert.equal(
    handcrafted.find((c) => c.id === '17')?.name,
    'Из пробелов в alt',
    'alt из одних пробелов не считается именем — берётся подпись',
  );
  assert.equal(handcrafted.find((c) => c.id === '18')?.name, 'Незакрытая плитка', 'незакрытая плитка разобрана');
  assert.equal(
    handcrafted.find((c) => c.id === '19')?.name,
    'После незакрытой',
    'незакрытая плитка не съела следующую',
  );
  assert.equal(handcrafted.some((c) => c.url.includes('promo-catalog')), false, 'плитка вне каталога не категория');

  // Последняя плитка в документе: следующего `<a` за ней нет вовсе.
  const lastTile = parseMagnitCategories(
    `<html><body><a href="/catalog/?shopCode=${SHOP}&x=1">витрина</a>` +
      tile('40', 'Самая последняя', 'Самая последняя', 'https://img/h.png') +
      '<footer>Магнит</footer></body></html>',
    SHOP,
  );
  assert.equal(lastTile.length, 1, 'плитка, за которой больше ничего нет, разобрана');
  assert.equal(lastTile[0]?.name, 'Самая последняя', 'последняя плитка прочитана');

  // Ответ магазина через настоящий fetch: плитки достаются из живой разметки.
  reply = { body: home };
  const viaHttp = await adapter.fetchCategories({ city: 'moscow', externalStoreId: liveShop });
  assert.equal(viaHttp.length, cats.length, 'живой ответ разобран так же, как фикстура');

  // Карточка: JSON-LD есть, но товара в нём нет.
  reply = { body: productHtml([{ '@type': 'BreadcrumbList', itemListElement: [] }]) };
  await assert.rejects(
    () => adapter.fetchProduct('magnit-77001', { ...CTX, name: 'Молоко' }),
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
  const found = await adapter.fetchProduct('magnit-77001', { ...CTX, name: 'Молоко' });
  assert.equal(found.price, 99, 'мусор в JSON-LD не мешает найти товар');

  // Витрина: OfferCatalog без списка офферов и оффер без ссылки.
  // Ссылка на товар с кодом магазина обязательна: витрина без кода в ссылках —
  // это отказ «сверять точку нечем» (см. блок 3b), а не пустая полка.
  reply = {
    body: `<html><body><a href="/product/77004-moloko?shopCode=${SHOP}">товар</a></body></html>` +
      ldPage([
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
  ['карточки', () => adapter.fetchProduct('magnit-1', { ...CTX, name: 'Хлеб' }), /magnit product HTTP 503/],
  ['витрины магазина', () => adapter.fetchCategories(CTX), /magnit (webgate )?categories HTTP 503/],
  ['витрины по ссылке', () => adapter.fetchCategoryProducts('https://magnit.ru/catalog/1-', CTX), /magnit category HTTP 503/],
] as const) {
  reply = { status: 503, body: 'service unavailable' };
  await assert.rejects(call, pattern, `HTTP-отказ ${label} назван своим кодом`);
}

// --- 3a-4. fetchProduct: товар без картинки и без quantity — поля не ставятся.
{
  seen.length = 0;
  reply = {
    body: JSON.stringify({
      items: [{ id: 77, productId: 77, name: 'Хлеб', price: 4200, storeCode: SHOP }],
    }),
  };
  const [bare] = await adapter.search('хлеб', CTX);
  assert.ok(bare);
  assert.ok(!('inStock' in bare!), 'quantity нет → поле inStock не ставится');
  assert.ok(!('imageUrl' in bare!), 'галереи нет → поле imageUrl не ставится');
}

// --- 3a-4b. fetchProduct: товар без картинки и без quantity — поля не ставятся.
{
  reply = {
    body: JSON.stringify({
      items: [{ id: 77, productId: 77, name: 'Хлеб', price: 4200, storeCode: SHOP }],
    }),
  };
  const bare = await adapter.fetchProduct('magnit-77', { ...CTX, name: 'Хлеб' });
  assert.ok(!('inStock' in bare), 'quantity нет → поле inStock не ставится и в карточке');
  assert.ok(!('imageUrl' in bare), 'галереи нет → поле imageUrl не ставится и в карточке');
  assert.strictEqual(bare.price, 42);
}

// --- 3c. fetchProduct через webgate: карточки по id у Магнита НЕТ.
// Живая проверка 2026-10-18: `/product/<id>` отдаёт 200 и несёт shopCode, но
// блоков `application/ld+json` в нём 0 — оболочка Nuxt. Значит старый путь
// падал бы на КАЖДОМ товаре, а это весь опрос (scheduler бьёт fetchProduct по
// всем отслеживаемым позициям). Ищем товар тем же goods/search по названию из
// БД и отбираем по productId — приём Ленты.
{
  seen.length = 0;
  reply = {
    body: JSON.stringify({
      items: [
        { id: 1, productId: 1, name: 'Другой хлеб', price: 5000, quantity: 2, storeCode: SHOP },
        {
          id: 4242,
          productId: 4242,
          name: 'Хлеб Бородинский 400г',
          price: 6500,
          promotion: { isPromotion: true, oldPrice: 7000 },
          quantity: 3,
          storeCode: SHOP,
          gallery: [{ type: 'IMAGE', url: 'https://images-foodtech.magnit.ru/b.jpeg@webp' }],
        },
      ],
    }),
  };
  const product = await adapter.fetchProduct('magnit-4242', {
    ...CTX,
    name: 'Хлеб Бородинский 400г',
  });
  assert.ok(seen.every((r) => /webgate\/v2\/goods\/search/.test(r.url)), 'HTML-карточка не запрашивается');
  assert.strictEqual(product.canonicalId, 'magnit-4242');
  assert.strictEqual(product.price, 65, 'копейки делятся на 100');
  assert.strictEqual(product.oldPrice, 70, 'зачёркнутая из promotion.oldPrice');
  assert.strictEqual(product.storeCode, SHOP, 'код из ответа сети');
  assert.strictEqual(product.inStock, true);
}

// --- 3a-2. fetchProduct: WAF-страница вместо JSON — тоже отрыв. -------------
// Не-JSON транзиентен (значит, нас заблокировали, а не сеть сломала формат),
// поэтому на него HTML-фолбэк уместен. Громкий дрейф — только на JSON
// неожиданной ФОРМЫ.
{
  seen.length = 0;
  const wafFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : String(input instanceof URL ? input : input.url);
    seen.push({ url, headers: {} });
    if (/webgate\/v2\/goods\/search/.test(url)) {
      return { ok: true, status: 200, url, text: async () => '<html>WAF</html>' } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      url,
      text: async () => productHtml({ '@type': 'Product', sku: '4242', name: 'Хлеб Бородинский 400г' }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  globalThis.fetch = wafFetch;
  try {
    await adapter.fetchProduct('magnit-4242', { ...CTX, name: 'Хлеб Бородинский 400г' }).catch(() => undefined);
    assert.ok(seen.some((r) => /\/product\/4242/.test(r.url)), 'WAF-страница уводит в HTML-фолбэк');
  } finally {
    globalThis.fetch = mockedFetch;
  }
}

// --- 3d. fetchProduct: товара нет в выдаче → ProductLookupError, а не пауза.
// Сеть жива и отвечает, паузу ей ставить незачем — иначе два переименованных
// товара подряд выключили бы Магнит до конца прохода.
{
  reply = {
    body: JSON.stringify({
      items: [{ id: 1, productId: 1, name: 'Совсем другое', price: 5000, quantity: 1, storeCode: SHOP }],
    }),
  };
  await assert.rejects(
    () => adapter.fetchProduct('magnit-4242', { ...CTX, name: 'Хлеб Бородинский 400г' }),
    /не нашёлся в выдаче/,
    'переименованный товар — ProductLookupError, не сетевой отказ',
  );
}

// --- 3e. fetchProduct без названия — ProductLookupError, ни одного запроса. ---
// Дыра в НАШИХ данных, а не отказ сети: искать нечем (сеть ищет по тексту).
// Планировщик не растит за это strike, а зрячий HTML-фолбэк не помог бы — он
// бьёт по id, которого в карточке живого сайта больше нет.
{
  seen.length = 0;
  reply = { body: productHtml({ '@type': 'Product', sku: '1', name: 'Хлеб' }) };
  await assert.rejects(
    () => adapter.fetchProduct('magnit-1', { ...CTX }),
    (err) => err instanceof ProductLookupError && /нет названия/.test(String(err)),
    'нет названия — ProductLookupError, а не сетевая ошибка с паузой',
  );
  assert.strictEqual(seen.length, 0, 'без названия ни webgate, ни HTML не трогаем');
}

// --- 3g-1. Живая карточка: JSON-LD ЕСТЬ, и цена в нём — в РУБЛЯХ. ----------
// Снято 2026-10-19 с живой страницы (scripts/capture-magnit-card.ts).
// Раньше в коде стояло «блоков ld+json — 0», и HTML-фолбэк считали мёртвым;
// живая проверка это опровергла: блок есть, sku и offers.price приходят.
// Важно и другое: здесь цена в РУБЛЯХ, а в webgate — в КОПЕЙКАХ, так что
// два пути нельзя смешивать.
{
  seen.length = 0;
  reply = { body: html('magnit-card-live.html') };
  const product = await adapter.fetchProduct('magnit-1000427075', {
    ...CTX,
    name: 'Молоко сгущенное Алексеевское с сахаром 8.5% 360г',
  });
  assert.equal(product.canonicalId, 'magnit-1000427075', 'id из sku живого JSON-LD');
  assert.equal(product.price, 139.99, 'цена из JSON-LD в рублях — делить на 100 нельзя');
  assert.equal(product.inStock, true, 'наличие из JSON-LD');
  // Код точки из карточки НЕ подтверждается: страница одного товара не несёт
  // ссылок на витрину, поэтому остаётся sentinel — запрошенную точку
  // подставит ядро.
  assert.equal(product.storeCode, '?', 'код точки в карточке не подтверждён — sentinel');
}

// --- 3g. Пустая выдача при totalCount=0 — переименование, не сбой сети. ------
// Сеть отвечает 200 и честно говорит «совпадений ноль»: товара в этом
// названии больше нет. Паузу сети за это ставить нельзя, иначе два
// переименования подряд выключили бы Магнит.
{
  seen.length = 0;
  reply = {
    body: JSON.stringify({ items: [], pagination: { totalCount: 0, hasMore: false } }),
  };
  await assert.rejects(
    () => adapter.fetchProduct('magnit-4242', { ...CTX, name: 'Хлеб' }),
    (err) =>
      err instanceof ProductLookupError && /не нашёлся в выдаче/.test(String(err)),
    'totalCount=0 — ProductLookupError (товар переименован/снят)',
  );
}

// --- 3h. Пустая выдача при ненулевом totalCount — сбой сети, breaker слышит. --
// Сеть утверждает, что результаты ЕСТЬ, но не отдаёт ни одного товара:
// это деградация, а не «товара больше нет», и молчать ей нельзя.
{
  seen.length = 0;
  reply = {
    body: JSON.stringify({ items: [], pagination: { totalCount: 5, hasMore: true } }),
  };
  await assert.rejects(
    () => adapter.fetchProduct('magnit-4242', { ...CTX, name: 'Хлеб' }),
    (err) =>
      !(err instanceof ProductLookupError) && /пустую выдачу при totalCount=5/.test(String(err)),
    'totalCount>0 при пустом items — обычная ошибка (сеть/дрейв), а не переименование',
  );
  assert.strictEqual(seen.length, 1, 'ответ уже получен — в HTML-фолбэк не уходим');
}

// --- 3i. Пустая выдача БЕЗ pagination — форма ответа ушла, тоже не «нету». ---
{
  seen.length = 0;
  seen.length = 0;
  reply = { body: JSON.stringify({ items: [] }) };
  await assert.rejects(
    () => adapter.fetchProduct('magnit-4242', { ...CTX, name: 'Хлеб' }),
    (err) =>
      !(err instanceof ProductLookupError) && /pagination\.totalCount/.test(String(err)),
    'документированная форма несёт pagination — его отсутствие дрейф',
  );
  assert.strictEqual(seen.length, 1, 'дрейф формы не лечится повторным запросом');
}

// --- 3j. Чужая точка в fetchProduct — мгновенный отказ, без HTML-фолбэка. ----
// Пауза 1.5 с и лишний запрос уводили бы причину (подмена точки) под ошибку
// HTML-пути, а breaker видел бы уже её.
{
  seen.length = 0;
  reply = {
    body: JSON.stringify({
      items: [{ id: 1, productId: 1, name: 'Хлеб', price: 1000, storeCode: '992301' }],
    }),
  };
  await assert.rejects(
    () => adapter.fetchProduct('magnit-4242', { ...CTX, name: 'Хлеб' }),
    /чужого магазина/,
    'ответ чужой точки пробрасывается сразу, как и в search',
  );
  assert.strictEqual(seen.length, 1, 'ни паузы, ни второго запроса — ровно один webgate');
  assert.match(seen[0]!.url, /webgate\/v2\/goods\/search/, 'и это запрос API, не HTML');
}

// --- 3f. fetchProduct: 5xx и не-JSON — отрыв, на них HTML-фолбэк уместен. ---
{
  seen.length = 0;
  const flakyProductFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : String(input instanceof URL ? input : input.url);
    seen.push({ url, headers: {} });
    if (/webgate\/v2\/goods\/search/.test(url)) {
      return { ok: false, status: 503, url, text: async () => 'upstream' } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      url,
      text: async () => productHtml({ '@type': 'Product', sku: '4242', name: 'Хлеб Бородинский 400г' }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  globalThis.fetch = flakyProductFetch;
  try {
    await adapter.fetchProduct('magnit-4242', { ...CTX, name: 'Хлеб Бородинский 400г' }).catch(() => undefined);
    assert.ok(seen.some((r) => /webgate\/v2\/goods\/search/.test(r.url)), 'API пробуется первым');
    assert.ok(seen.some((r) => /\/product\/4242/.test(r.url)), 'на 5xx карточка берётся из HTML');
  } finally {
    globalThis.fetch = mockedFetch;
  }
}

// --- 13c. Витрина: первый путь — HTML-главная, в ней у плиток КАРТИНКИ. -----
// Замер с телефона (2026-10-21): HTML-главная отдаёт 200, 1,2 МБ и восемь
// плиток верхнего уровня с картинками и живыми id; API-дерево отдаёт листья
// («Бакалея», «Заморозка»…), у которых картинок нет вовсе. Поэтому витрина
// берётся из HTML, а API — запасной путь.
{
  seen.length = 0;
  const splitFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : String(input instanceof URL ? input : input.url);
    seen.push({ url, headers: {} });
    if (/webgate\/v3\/categories/.test(url)) {
      return { ok: true, status: 200, url, text: async () => '{"unexpected":true}' } as unknown as Response;
    }
    return { ok: true, status: 200, url, text: async () => html('magnit-home.html') } as unknown as Response;
  }) as unknown as typeof fetch;
  globalThis.fetch = splitFetch;
  try {
    const cats = await adapter.fetchCategories({ city: 'moscow', externalStoreId: LIVE_HOME_SHOP });
    assert.equal(cats.length, 8, `витрина главной: ${cats.length} плиток`);
    assert.ok(
      cats.every((c) => typeof c.imageUrl === 'string' && c.imageUrl.startsWith('https://')),
      'у каждой плитки есть картинка — ради неё и берётся HTML-путь',
    );
    assert.ok(
      seen.some((r) => r.url === 'https://magnit.ru/'),
      'HTML-главная запрошена первой',
    );
    assert.equal(seen.length, 1, 'при живом HTML API-дерево не качается зря');
  } finally {
    globalThis.fetch = mockedFetch;
  }
}

// --- 13d. API-дерево — запасной путь: HTML не дал плиток. -------------------
// Картинки листьев приходят массивом ОБЪЕКТОВ (`{type, url}`), а не строк:
// старый разбор искал строки и не находил ни одной, из-за чего витрина
// получалась пустой, а кэш витрины не писался.
{
  seen.length = 0;
  const splitFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : String(input instanceof URL ? input : input.url);
    seen.push({ url, headers: {} });
    if (/webgate\/v3\/categories/.test(url)) {
      return {
        ok: true,
        status: 200,
        url,
        text: async () =>
          JSON.stringify({
            items: [
              {
                id: 10,
                name: 'Молоко',
                images: [],
                children: [
                  { id: 101, name: 'Кефир 3,2%', images: [{ type: 'card', url: 'https://images-foodtech.magnit.ru/k.png' }] },
                  // Та же картинка может прийти и строкой, и отдельным полем
                  // `image` — живые ответы отдают и так, и так.
                  { id: 102, name: 'Молоко 3,2%', images: ['https://images-foodtech.magnit.ru/m.png'] },
                  { id: 103, name: 'Сливки', image: 'https://images-foodtech.magnit.ru/s.png' },
                ],
              },
            ],
          }),
      } as unknown as Response;
    }
    // HTML без плиток: наш магазин, но витрина не разобралась (дрейф вёрстки).
    return {
      ok: true,
      status: 200,
      url,
      text: async () =>
        `<html><body><a href="/catalog/?shopCode=${LIVE_HOME_SHOP}">витрина</a></body></html>`,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  globalThis.fetch = splitFetch;
  try {
    const cats = await adapter.fetchCategories({ city: 'moscow', externalStoreId: LIVE_HOME_SHOP });
    assert.deepStrictEqual(cats, [
      {
        id: '101',
        name: 'Кефир 3,2%',
        url: 'https://magnit.ru/catalog/101',
        imageUrl: 'https://images-foodtech.magnit.ru/k.png',
      },
      {
        id: '102',
        name: 'Молоко 3,2%',
        url: 'https://magnit.ru/catalog/102',
        imageUrl: 'https://images-foodtech.magnit.ru/m.png',
      },
      {
        id: '103',
        name: 'Сливки',
        url: 'https://magnit.ru/catalog/103',
        imageUrl: 'https://images-foodtech.magnit.ru/s.png',
      },
    ]);
    assert.ok(seen.some((r) => r.url === 'https://magnit.ru/'), 'HTML пробуется первым');
    assert.ok(
      seen.some((r) => /webgate\/v3\/categories/.test(r.url)),
      'при дрейфе HTML берётся запасной путь — API-дерево',
    );
  } finally {
    globalThis.fetch = mockedFetch;
  }
}

// --- 13e. Ни один источник не разобран — ГРОМКИЙ ОТКАЗ, а не пустая витрина.
{
  seen.length = 0;
  const splitFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : String(input instanceof URL ? input : input.url);
    seen.push({ url, headers: {} });
    if (/webgate\/v3\/categories/.test(url)) {
      return { ok: true, status: 200, url, text: async () => '{"unexpected":true}' } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      url,
      text: async () =>
        `<html><body><a href="/catalog/?shopCode=${LIVE_HOME_SHOP}">витрина</a></body></html>`,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  globalThis.fetch = splitFetch;
  try {
    await assert.rejects(
      () => adapter.fetchCategories({ city: 'moscow', externalStoreId: LIVE_HOME_SHOP }),
      /нет поля items/,
      'дрейф формата витрины — громкий отказ, а не молчание',
    );
  } finally {
    globalThis.fetch = mockedFetch;
  }
}

// --- 13f. HTML-главная отдала 5xx — запасной путь уместен. -------------------
{
  seen.length = 0;
  const splitFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : String(input instanceof URL ? input : input.url);
    seen.push({ url, headers: {} });
    if (/webgate\/v3\/categories/.test(url)) {
      return {
        ok: true,
        status: 200,
        url,
        text: async () => JSON.stringify({ items: [{ id: 7, name: 'Хлеб', images: [], children: [] }] }),
      } as unknown as Response;
    }
    return { ok: false, status: 503, url, text: async () => 'upstream' } as unknown as Response;
  }) as unknown as typeof fetch;
  globalThis.fetch = splitFetch;
  try {
    const cats = await adapter.fetchCategories({ city: 'moscow', externalStoreId: LIVE_HOME_SHOP });
    assert.deepStrictEqual(cats, [{ id: '7', name: 'Хлеб', url: 'https://magnit.ru/catalog/7' }]);
    assert.ok(seen.some((r) => r.url === 'https://magnit.ru/'), 'на 5xx главной запасной путь разрешён');
  } finally {
    globalThis.fetch = mockedFetch;
  }
}

// --- 13b. Витрина: прямой ответ не подтверждён и браузер ничего не нашёл. ---
// Молча вернуть пустой массив здесь значило бы показать «товаров нет» вместо
// правды: прямой ответ содержал цены, мы их выбросили по инварианту кода
// точки. Значит — громкий отказ с числами.
{
  const promoHtml = readFileSync('tests/fixtures/magnit-category-promo.html', 'utf-8');
  const noLinkCode = promoHtml
    .split('?shopCode=473996&shopType=express')
    .join('?shopType=express')
    .replace(
      '<html>',
      '<html><head><link rel="canonical" href="https://magnit.ru/catalog/?shopCode=%22473996" /></head>',
    );
  reply = { status: 200, body: noLinkCode };
  // Браузер открывается и не находит карточек: страница «живая» (код магазина
  // на месте, текст живой), но товаров в ней нет.
  const emptyPage = {
    waitForSelector: async () => {
      throw new Error('нет карточек');
    },
    content: async () =>
      `<html><head><script>window.shopCode="${SHOP}";</script></head><body>Витрина магазина ${SHOP} в городе Москве, цены на молочные ` +
      'продукты, скидки на сыры и колбасы, хлеб и выпечка каждый день, доставка ' +
      `по городу, магазин работает с восьми утра до десяти вечера, ассортимент ` +
      `обновляется каждый день, заказ оформляется в приложении, оплата картой на кассе. ` +
      `<a href="/product/77004?shopCode=${SHOP}">Молоко</a>` +
      ' </body></html>',
    title: async () => `Магазин ${SHOP}`,
    url: () => 'https://magnit.ru/catalog/0-',
    goto: async () => null,
  };
  __setPlaywrightForTests({
    chromium: {
      launch: async () => ({
        newContext: async () => ({
          addCookies: async () => {},
          newPage: async () => emptyPage,
        }),
        close: async () => {},
      }),
    },
  } as unknown as typeof import('playwright'));
  try {
    await assert.rejects(
      () => adapter.fetchCategoryProducts('https://magnit.ru/catalog/0-', CTX),
      /код магазина ссылками не подтверждён/,
      'выброшенные по инварианту цены не превращаются в тихую пустую полку',
    );
  } finally {
    __setPlaywrightForTests(null);
    reply = {};
  }
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

// --- 13a. Бюджет прямой фазы кончается — вторая попытка не делается --------
// Ждать настоящие 30 секунд ради одной ветки нельзя, поэтому потолок уменьшаем
// крючком, а первую попытку заставляем «повисеть» 700 мс.
{
  let htmlCalls = 0;
  let apiCalls = 0;
  const slowFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : String(input instanceof URL ? input : input.url);
    if (/\/search\?term=/.test(url)) htmlCalls += 1;
    else apiCalls += 1;
    await new Promise((r) => setTimeout(r, 700));
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  globalThis.fetch = slowFetch;
  __setDirectPhaseBudgetForTests(2500);
  const t0 = Date.now();
  try {
    await assert.rejects(
      () => adapter.search('молоко', CTX),
      /фейковый Playwright/,
      'исчерпанный бюджет честно отдаёт запрос браузеру, а не едет дальше',
    );
    // ГЛАВНЫЙ инвариант: бюджет дёшевой фазы покрывает ВСЁ до браузера —
    // webgate (700 мс) + защитная пауза (1.5 с) + HTML-попытки. Если бы
    // отсчёт начинался после webgate, фаза растянулась бы до 51,5 с.
    // Пауза даёт 1.5 с, поэтому ноль HTML-попыток на 2.5-секундном бюджете —
    // верное поведение, а не пропуск.
    assert.equal(apiCalls, 1, 'webgate-API пробуется ровно один раз, повторов у него нет');
    assert.equal(htmlCalls, 0, `в бюджет HTML-фаза уже не помещается, попыток было: ${htmlCalls}`);
    const spent = Date.now() - t0;
    assert.ok(
      spent < 4000,
      `дёшевая фаза уложилась в бюджет (прошло ${spent} мс при бюджете 2500 + пауза)`,
    );
  } finally {
    __setDirectPhaseBudgetForTests(null);
    globalThis.fetch = mockedFetch;
  }
}
__setPlaywrightForTests(null);
reply = {};


// --- 14. Остатки разбора: пустые поля в данных витрины. --------------------
{
  // offer без цены: id из ссылки есть, а цены нет — это не товар.
  assert.equal(
    normalizeMagnitOffer({ name: 'Молоко', url: 'https://magnit.ru/product/99001/' } as never, { city: 'moscow', externalStoreId: 'TEST' }),
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

// --- Видимый текст страницы: служебное содержимое в счёт не идёт -------------
{
  // magnit.ru шлёт инлайновые стили всегда: на живой фикстуре главной «текста»
  // получалось 52 354 символа, из которых 49 752 — CSS. Если бы счёт шёл по
  // тегам, недогруженная страница объявлялась бы полноценной витриной.
  const withStyle = `<html><head><style>${'.a{color:red}'.repeat(80)}</style></head><body>${'Текст товара. '.repeat(10)}</body></html>`;
  // Хвостовой пробел приходит от склейки `<body>` с хвостом документа, поэтому
  // сравниваем по смыслу: многострочный текст должен ужаться в одну строку, а
  // CSS не должен добавить ни одного символа.
  assert.equal(
    visibleText(withStyle).replace(/\s+/g, ' ').trim(),
    'Текст товара. '.repeat(10).trim(),
    'CSS и скрипты в счёт текста не попадают, переносы строк схлопываются',
  );
  assert.equal(
    visibleText('<html><body>   </body></html>'),
    '',
    'пустая страница даёт ноль видимого текста',
  );
  // Обрывок без <body> разбирается целиком: иначе он был бы объявлен пустым.
  assert.equal(visibleText('Просто текст без тегов'), 'Просто текст без тегов', 'HTML без <body> разобран целиком');
}

// --- Бюджет прямой фазы: одна попытка не съедает весь потолок ---------------
{
  assert.equal(directPhaseLeftMs(0), 30000, 'на старте доступен весь бюджет');
  assert.equal(directPhaseLeftMs(1000), 29000, 'после секунды минус секунда');
  assert.equal(directPhaseLeftMs(29000), null, 'двух секунд не хватает на попытку — бюджет исчерпан');
  assert.equal(directPhaseLeftMs(40000), null, 'бюджет не восстанавливается со временем');
}

// --- WebView (Android): поиск без браузера, карточка — с фолбэком ----------
{
  // Мост подставлен — оболочка считается нативной. Это позволяет проверить
  // РАЗНЫЕ пути:
  //   * поиск обязан падать сразу: HTML-выдачи Магнита в оболочке нет (сайт на
  //     клиентском рендере), а браузера в WebView нет тоже — 12–20 с на
  //     заведомо пустой запрос;
  //   * карточка обязана дойти до HTML-фолбэка: он отдаётся обычным
  //     HTTP-клиентом (без браузера и без CORS), то есть на Android рабочий.
  //     Отказываться от него — значит срезать путь сбора цены на телефоне.
  const g = globalThis as { androidBridge?: unknown; Capacitor?: unknown };
  const hadBridge = 'androidBridge' in g;
  const prevBridge = g.androidBridge;
  const hadCap = 'Capacitor' in g;
  const prevCap = g.Capacitor;
  g.androidBridge = {};
  // Нативный слой обходится мимо `fetch` (он идёт через CapacitorHttp), поэтому
  // для проверки веток webgate подменяем плагин: без него нативный запрос падал
  // бы с «Android без плагина CapacitorHttp», и деградация сети была бы
  // неотличима от отказа.
  g.Capacitor = {
    Plugins: {
      CapacitorHttp: {
        request: async () => ({
          status: reply.status ?? 200,
          data: reply.body ?? '',
          headers: { 'Content-Type': 'application/json' },
        }),
      },
    },
  };
  try {
    seen.length = 0;
    reply = { status: 503, body: 'webgate недоступен' };
    await assert.rejects(
      () => adapter.search('молоко', CTX),
      /браузерного пути на этой платформе нет/,
      'в WebView поиск падает сразу, не заводя браузерный путь',
    );
    assert.equal(seen.length, 0, 'нативный слой идёт мимо fetch — мок сети не тронут');

    // Деградация — другой случай и другой текст: сеть ОТВЕТИЛА, но товаров не
    // отдала. Смешивать с «не ответил» нельзя: и breaker-лог, и пользователь
    // должны видеть, что именно сломалось.
    reply = { body: JSON.stringify({ items: [], pagination: { totalCount: 5 } }) };
    await assert.rejects(
      () => adapter.search('молоко', CTX),
      /пустую выдачу \(totalCount=5\)/,
      'в WebView деградация webgate называется своим текстом, а не «не ответил»',
    );

    reply = { status: 503, body: 'webgate недоступен' };
    await assert.rejects(
      () => adapter.fetchProduct('magnit-1000483001', { ...CTX, name: 'Молоко' }),
      /вектор:/,
      'карточка в WebView доходит до HTML-фолбэка (в тексте — причина ухода с webgate)',
    );
    await assert.rejects(
      () => adapter.fetchProduct('magnit-1000483001', { ...CTX, name: 'Молоко' }),
      (err: unknown) => !/бесполезен/.test(String(err)),
      'и не отказывается мгновенно: HTML-карточка берётся обычным запросом и работает',
    );
  } finally {
    if (hadBridge) g.androidBridge = prevBridge;
    else delete g.androidBridge;
    if (hadCap) g.Capacitor = prevCap;
    else delete g.Capacitor;
  }
}

globalThis.fetch = realFetch;
console.log('magnit http: ALL GREEN — поиск, карточка, каталог, витрина, кука магазина, редиректы, бюджет повтора');
