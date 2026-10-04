// Транспорт Пятёрочки в режиме PA5KA_TRANSPORT=fetch: прямой fetch вместо
// браузера. Этот путь в приложении запасной (основной — браузерный, потому что
// X5 режет всё, что не браузер), но именно он содержит всю диагностику отказов:
// как отличать WAF-страницу от дрейфа формата и от HTTP-ошибки. Без тестов эти
// ветки проверялись только живой пробой.
import assert from 'node:assert';
import fs from 'node:fs';
import { normalize, PyaterochkaAdapter } from '../src/core/adapters/pyaterochka.js';

const json = (name: string): unknown => JSON.parse(fs.readFileSync(`tests/fixtures/${name}`, 'utf8'));
const searchFixture = json('5ka-search.json') as { products: Record<string, unknown>[] };
const productFixture = json('5ka-product.json') as Record<string, unknown>;

// Режим fetch выбирается переменной окружения — так он включается и в жизни.
process.env.PA5KA_TRANSPORT = 'fetch';

type Reply = { status?: number; body?: string };
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
    url,
    text: async () => reply.body ?? '',
  } as unknown as Response;
}) as typeof fetch;

const CTX = { city: 'moscow', externalStoreId: '35XY' };
const adapter = new PyaterochkaAdapter();

// --- 1. Поиск: заголовки браузерные, товары нормализованы. -----------------
{
  seen.length = 0;
  reply = { body: JSON.stringify({ products: searchFixture.products.slice(0, 3) }) };
  const items = await adapter.search('молоко', CTX);
  assert.ok(items.length > 0, 'выдача непустая');
  assert.ok(items.every((i) => i.storeId === 'pyaterochka'), 'сеть проставлена');
  assert.match(seen[0]?.url ?? '', /\/catalog\/v3\/stores\/35XY\/search\?/, 'путь и код магазина в URL');
  assert.match(seen[0]?.url ?? '', /mode=store/, 'режим магазина, а не сети');
  assert.match(seen[0]?.headers['x-device-id'] ?? '', /\S/, 'без device-id сеть отвечает 200 с отказом');
  assert.match(seen[0]?.headers['x-platform'] ?? '', /web/, 'платформа объявлена');
}

// --- 2. Пустой products — пустая выдача, а не ошибка. ----------------------
{
  reply = { body: JSON.stringify({}) };
  assert.deepEqual(await adapter.search('молоко', CTX), [], 'нет products — нет товаров');
}

// --- 3. WAF-страница на 403: это не «формат сломался». --------------------
{
  reply = { status: 403, body: '<html>Проблемы со связью. Проверьте настройки интернета и VPN. request id abc</html>' };
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /WAF режет запрос вне браузера/,
    'WAF-страница опознана и сказано, что нужен браузер',
  );
}

// --- 4. 403 без WAF-страницы и 401: разные сообщения. --------------------
{
  reply = { status: 403, body: '{"error":"forbidden"}' };
  await assert.rejects(() => adapter.search('молоко', CTX), /WAF не пускает запросы вне браузера/);

  reply = { status: 401, body: '{"error":"unauthorized"}' };
  await assert.rejects(() => adapter.search('молоко', CTX), /WAF не пускает запросы вне браузера/);
}

// --- 5. Прочие HTTP-статусы и не-JSON. -------------------------------------
{
  reply = { status: 500, body: 'oops' };
  await assert.rejects(() => adapter.search('молоко', CTX), /5ka search HTTP 500/);

  reply = { body: '<html>каталог</html>' };
  await assert.rejects(() => adapter.search('молоко', CTX), /ответ не JSON/);
}

// --- 6. Код магазина и canonicalId проверяются до похода в сеть. -----------
{
  seen.length = 0;
  // Допустимы буквы, цифры, дефис и подчёркивание — пробел недопустим.
  await assert.rejects(
    () => adapter.search('молоко', { city: 'moscow', externalStoreId: '35 XY' }),
    /bad sapCode 35 XY/,
    'мусор в коде точки отвергается',
  );
  await assert.rejects(() => adapter.fetchProduct('5ka-abc', CTX), /bad canonicalId/);
  assert.equal(seen.length, 0, 'до сети дело не дошло');
}

// --- 7. Карточка товара. ---------------------------------------------------
{
  seen.length = 0;
  const plu = String(productFixture.plu);
  reply = { body: JSON.stringify(productFixture) };
  const product = await adapter.fetchProduct(`5ka-${plu}`, CTX);
  assert.equal(product.canonicalId, `5ka-${plu}`, 'id тот же');
  assert.ok(product.price > 0, 'цена пришла');
  assert.match(seen[0]?.url ?? '', /\/catalog\/v2\/stores\/35XY\/products\//, 'карточка идёт по v2 и коду точки');

  // Ответ без цены — дрейф формата, а не «товар снят».
  reply = { body: JSON.stringify({ plu: Number(plu), name: 'Молоко', prices: { regular: null } }) };
  await assert.rejects(() => adapter.fetchProduct(`5ka-${plu}`, CTX), /пустой ответ по товару/);

  // Ответ по чужому plu не принимается: иначе в историю уехала бы чужая цена.
  reply = { body: JSON.stringify({ ...productFixture, plu: 999999 }) };
  await assert.rejects(
    () => adapter.fetchProduct(`5ka-${plu}`, CTX),
    /ответ по другому товару/,
    'чужая карточка отвергается, а не пишется в цену нашего товара',
  );
}

// --- 8. Категории и витрина: в режиме fetch честно отказывают. --------------
{
  reply = { body: '{}' };
  await assert.rejects(
    () => adapter.fetchCategories(CTX),
    /только в браузерном транспорте/,
    'категории Пятёрки живут за браузером — fetch-путь говорит об этом прямо',
  );

  // Формат полки Пятёрки: /catalog/<slug>--<id>/ — слаг может содержать дефисы.
  assert.equal(adapter.canHandleCategoryUrl('https://5ka.ru/catalog/moloko-i-kefir--101112/'), true, 'ссылка на полку наша');
  assert.equal(adapter.canHandleCategoryUrl('https://5ka.ru/product/1/'), false, 'карточка — не полка');

  await assert.rejects(
    () => adapter.fetchCategoryProducts('https://example.com/catalog/1/', CTX),
    /categoryUrl вне каталога/,
    'чужая ссылка не отправляется в сеть',
  );
  await assert.rejects(
    () => adapter.fetchCategoryProducts('https://5ka.ru/catalog/moloko-i-kefir--101112/', CTX),
    /только в браузерном транспорте/,
    'наша ссылка тоже требует браузера, и это сказано прямо',
  );
}

// --- 12. Крайние значения разбора: без них ветки молча остаются мёртвыми. ---
// Числовая цена приходит не только строкой, а нечисловые значения не должны
// становиться ценой: нулевая и отрицательная цена — это не товар.
{
  const base = productFixture;
  const numeric = normalize({ ...base, plu: '111', prices: [{ value: 55, placement_type: 'regular_primary' }] } as never, CTX);
  assert.equal(numeric?.price, 55, 'цена-число принимается');
  const zero = normalize({ ...base, plu: '111', prices: { regular: '0' } } as never, CTX);
  assert.equal(zero, null, 'нулевая цена — не товар');
  const negative = normalize({ ...base, plu: '111', prices: { regular: '-5' } } as never, CTX);
  assert.equal(negative, null, 'отрицательная цена — не товар');

  // Три цены в массиве: акция ниже, старая выше. Если такого ответа не было бы
  // в тестах, ветки promo/old в priceParts остались бы непроверенными.
  const spread = normalize(
    {
      ...base,
      plu: '222',
      prices: [
        { value: 100, placement_type: 'regular_primary' },
        { value: 79 },
        { value: 149 },
      ],
    } as never,
    CTX,
  );
  assert.equal(spread?.price, 100, 'обычная цена взята по метке regular_primary');
  assert.equal(spread?.promoPrice, 79, 'цена ниже обычной ушла в акцию');
  assert.equal(spread?.oldPrice, 149, 'цена выше обычной осталась старой');

  // Ответ без plu: путь карточки знает plu из аргумента — это спасает ответы,
  // где сеть не прислала plu.
  {
    const plu = String(productFixture.plu);
    reply = { body: JSON.stringify({ ...productFixture, plu: undefined }) };
    const byArg = await adapter.fetchProduct(`5ka-${plu}`, CTX);
    assert.equal(byArg.canonicalId, `5ka-${plu}`, 'без plu в ответе id взят из аргумента');
  }

  // А вот прямой вызов разбора без plu обязан честно вернуть «не товар».
  assert.equal(normalize({ ...base, plu: undefined } as never, CTX), null, 'без plu товар не опознан');
  assert.equal(
    normalize({ ...base, plu: '333', image_links: undefined, media: { image_links: { small: ['https://img/x/320x320.jpeg'] } } } as never, CTX)
      ?.imageUrl,
    'https://img/x/800x800.jpeg',
    'картинка из media поднята до большой',
  );
}

globalThis.fetch = realFetch;
console.log('5ka http: ALL GREEN — прямой fetch, WAF-опознание, отказы, карточка, режим transport');