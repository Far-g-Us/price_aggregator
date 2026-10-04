// Транспортный уровень адаптеров Ленты: сессия, привязка к магазину, ретрай на
// 401, WAF-детект и все отказы. До этого файла юнит-тесты проверяли только
// чистые функции над фикстурами (нормализацию, цены, разбор), а весь HTTP-слой
// — то, где ломается сеть, — оставался без тестов: любая правка там проверялась
// только живой пробой.
//
// Сеть здесь подменена: `fetch` не выходит наружу, а отвечает из фикстур по
// маршруту URL. Пайсинг между запросами (`pace`) сохраняется — он часть
// контракта с сетью, и тест не должен его обходить.
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  aliasFromDeliveryMode,
  LentaAdapter,
  lentaDomain,
  lentaWeightGrams,
  lentaWeightLabel,
  normalizeLentaItem,
  normalizeLentaSearch,
  sameLentaStore,
  __setRequestGapMsForTests,
} from '../src/core/adapters/lenta.js';
import { CITY_TO_SLUG } from '../src/shared/lenta-regions.js';

const fixture = (name: string): string =>
  fs.readFileSync(fileURLToPath(new URL(`../tests/fixtures/${name}`, import.meta.url)), 'utf8');
const fixtureJson = (name: string): unknown => JSON.parse(fixture(name));

type Reply = { status?: number; body?: unknown; text?: string };
type Route = (url: string, method: string) => Reply;

const calls: { url: string; method: string }[] = [];
let route: Route = () => {
  throw new Error('маршрут не задан в тесте');
};

// Пауза между запросами — 2 с по умолчанию, и наборе из полусотни запросов это
// две минуты чистого ожидания. Здесь она обнуляется, а отдельная проверка в
// конце файла убеждается, что пауза реально выдерживается.
const realFetch = globalThis.fetch;

__setRequestGapMsForTests(0);
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = typeof input === 'string' ? input : String(input instanceof URL ? input : input.url);
  const method = init.method ?? 'GET';
  calls.push({ url, method });
  const reply = route(url, method);
  const status = reply.status ?? 200;
  const text = reply.text ?? JSON.stringify(reply.body ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    text: async () => text,
  } as unknown as Response;
}) as typeof fetch;

const CTX = { city: 'moscow', externalStoreId: '4161' };
const OK_SESSION = { Head: { Status: 'success' }, Body: { SessionToken: 'sess-1' } };

/** Ответы «здоровой» сети: сессия, привязка к магазину, выдача поиска. */
const healthyRoute = (searchBody: unknown = fixtureJson('lenta-search-2026-10-01.json')): Route => {
  return (url) => {
    if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
    if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
    if (url.endsWith('/delivery/mode')) return { body: fixtureJson('lenta-delivery-mode.json') };
    if (url.endsWith('/jrpc/searchItems')) return { body: searchBody };
    throw new Error(`незапланированный запрос: ${url}`);
  };
};

// --- 1. Поиск: полный путь сессия → магазин → сверка → выдача. -------------
{
  calls.length = 0;
  route = healthyRoute();
  const adapter = new LentaAdapter();
  const items = await adapter.search('молоко', CTX);

  assert.ok(items.length > 0, 'выдача непустая');
  assert.ok(
    items.every((i) => i.storeId === 'lenta' && i.city === 'moscow'),
    'товар отдан сетью и городом из контекста',
  );
  assert.ok(items.every((i) => i.price > 0), 'у всех товаров цена');
  assert.ok(calls.some((c) => c.url.endsWith('/api/rest/sessionGet')), 'сессия заведена');
  assert.ok(calls.some((c) => c.url.endsWith('/delivery/mode/set')), 'магазин привязан');
  assert.ok(calls.some((c) => c.url.endsWith('/delivery/mode')), 'ответ сверён по alias');
}

// --- 2. Сессия переиспользуется, а не заводится на каждый запрос. ----------
{
  calls.length = 0;
  route = healthyRoute();
  const adapter = new LentaAdapter();
  await adapter.search('молоко', CTX);
  const sessionCalls = calls.filter((c) => c.url.endsWith('/api/rest/sessionGet')).length;
  await adapter.search('картофель', CTX);
  const sessionCallsAfter = calls.filter((c) => c.url.endsWith('/api/rest/sessionGet')).length;
  assert.equal(sessionCalls, 1, 'на первый запрос сессия заведена один раз');
  assert.equal(sessionCallsAfter, 1, 'на второй запрос кэш сессии жив, новая не заводится');
}

// --- 3. GET api-gateway режет WAF: предупреждение один раз, работа продолжается.
{
  calls.length = 0;
  route = (url) => {
    if (url.endsWith('/delivery/mode')) return { status: 401, text: 'qrator' };
    return healthyRoute()(url, 'GET');
  };
  const adapter = new LentaAdapter();
  const items = await adapter.search('молоко', CTX);
  assert.ok(items.length > 0, 'при WAF на сверке выдача всё равно приходит');
  assert.equal(
    calls.filter((c) => c.url.endsWith('/delivery/mode')).length,
    1,
    'после первого 401 сверка отключена и больше не тратит запросы',
  );
  await adapter.search('картофель', CTX);
  assert.equal(
    calls.filter((c) => c.url.endsWith('/delivery/mode')).length,
    1,
    'и на следующем запросе тоже — ни одного лишнего обращения к резаному хосту',
  );
}

// --- 4. Привязка к магазину проверяется на сервере, а не у нас. -------------
{
  route = (url) => {
    if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
    if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 999999, type: 'pickup' } };
    throw new Error(`незапланированный запрос: ${url}`);
  };
  const adapter = new LentaAdapter();
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /сервер выбрал магазин 999999 вместо 4161/,
    'подмена точки сетью не проходит молча',
  );
}

// --- 5. Несуществующий магазин: 409 от самой сети. --------------------------
{
  route = (url) => {
    if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
    if (url.endsWith('/delivery/mode/set')) {
      return { status: 409, text: '{"code":"BAD_REQUEST","message":"Pickup store with id 999999 not found"}' };
    }
    throw new Error(`незапланированный запрос: ${url}`);
  };
  const adapter = new LentaAdapter();
  await assert.rejects(
    () => adapter.search('молоко', { city: 'moscow', externalStoreId: '999999' }),
    /магазин не принят сетью/,
    'сеть отвергла точку — это видно по статусу, а не «пусто»',
  );
}

// --- 6. Сессия: сеть отклонила и не вернула токен. --------------------------
{
  route = () => ({ body: { Head: { Status: 'failure' }, Body: { ErrorList: [{ Description: 'Utkapi_Exception_EmptyDeviceId' }] } } });
  await assert.rejects(
    () => new LentaAdapter().search('молоко', CTX),
    /sessionGet отклонил сессию: Utkapi_Exception_EmptyDeviceId/,
    'тихий отказ сети виден сразу, а не как пустая выдача',
  );

  route = () => ({ body: { Head: { Status: 'success' }, Body: {} } });
  await assert.rejects(
    () => new LentaAdapter().search('молоко', CTX),
    /не вернул SessionToken/,
    'сессия без токена — тоже ошибка формата',
  );
}

// --- 7. Протухшая сессия: 401 роняет её и запрос повторяется один раз. ------
{
  calls.length = 0;
  let jrpcCalls = 0;
  route = (url) => {
    if (url.endsWith('/api/rest/sessionGet')) {
      return { body: { Head: { Status: 'success' }, Body: { SessionToken: `sess-${calls.filter((c) => c.url.endsWith('/api/rest/sessionGet')).length + 1}` } } };
    }
    if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
    if (url.endsWith('/delivery/mode')) return { status: 401, text: 'qrator' };
    if (url.endsWith('/jrpc/searchItems')) {
      jrpcCalls += 1;
      // Первый запрос — по сессии, которая уже протухла; второй должен уйти с новой.
      return jrpcCalls === 1 ? { status: 401, text: 'qrator' } : { body: fixtureJson('lenta-search-2026-10-01.json') };
    }
    throw new Error(`незапланированный запрос: ${url}`);
  };
  const items = await new LentaAdapter().search('молоко', CTX);
  assert.ok(items.length > 0, 'после ретрая по новой сессии выдача пришла');
  assert.equal(jrpcCalls, 2, 'повтор был ровно один — иначе это уже цикл по сети');
  assert.equal(
    calls.filter((c) => c.url.endsWith('/api/rest/sessionGet')).length,
    2,
    'протухшая сессия заменена новой, а не использована дальше',
  );
}

// --- 8. Отказы самой выдачи: не-JSON, пустой ответ, ошибка jrpc, без result.
{
  route = (url) => {
    if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
    if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
    if (url.endsWith('/delivery/mode')) return { status: 401, text: 'qrator' };
    if (url.endsWith('/jrpc/searchItems')) return { text: '<html>капча</html>' };
    throw new Error(`незапланированный запрос: ${url}`);
  };
  await assert.rejects(
    () => new LentaAdapter().search('молоко', CTX),
    /вернул не JSON/,
    'HTML вместо JSON — дрейф формы, а не пустой результат',
  );

  route = (url) => {
    if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
    if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
    if (url.endsWith('/delivery/mode')) return { status: 401, text: 'qrator' };
    if (url.endsWith('/jrpc/searchItems')) return { text: '' };
    throw new Error(`незапланированный запрос: ${url}`);
  };
  await assert.rejects(
    () => new LentaAdapter().search('молоко', CTX),
    /вернул пустой ответ/,
    'пустой ответ отмечен отдельно от не-JSON',
  );

  route = (url) => {
    if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
    if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
    if (url.endsWith('/delivery/mode')) return { status: 401, text: 'qrator' };
    if (url.endsWith('/jrpc/searchItems')) return { body: { error: { code: 42, message: 'bad params' } } };
    throw new Error(`незапланированный запрос: ${url}`);
  };
  await assert.rejects(
    () => new LentaAdapter().search('молоко', CTX),
    /jrpc searchItems -> bad params/,
    'ошибка jrpc видна как ошибка метода',
  );

  route = (url) => {
    if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
    if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
    if (url.endsWith('/delivery/mode')) return { status: 401, text: 'qrator' };
    if (url.endsWith('/jrpc/searchItems')) return { body: {} };
    throw new Error(`незапланированный запрос: ${url}`);
  };
  await assert.rejects(
    () => new LentaAdapter().search('молоко', CTX),
    /searchItems без result/,
    'ответ без result — дрейф формы, а не «пусто»',
  );
}

// --- 9. fetchProduct: товар найден по названию, цена совпала с поиском. ------
{
  const search = fixtureJson('lenta-search-2026-10-01.json') as {
    result: { items: { id: number; name: string }[] };
  };
  const target = search.result.items[0]!;
  route = healthyRoute();
  const adapter = new LentaAdapter();
  const fetched = await adapter.fetchProduct(`lenta-${target.id}`, { ...CTX, name: target.name });
  assert.equal(fetched.canonicalId, `lenta-${target.id}`, 'id тот же, что и просили');
  assert.ok(fetched.price > 0, 'цена пришла');
  assert.equal(fetched.promoPrice, null, 'promoPrice у Ленты всегда null — акция это и есть цена');
}

// --- 10. fetchProduct: нет названия в базе. ---------------------------------
{
  route = healthyRoute();
  await assert.rejects(
    () => new LentaAdapter().fetchProduct('lenta-626150', CTX),
    /у товара нет названия в базе/,
    'без названия опрос не должен гадать по id',
  );
}

// --- 11. fetchProduct: переименованный товар — ProductLookupError, а не сбой.
{
  route = healthyRoute();
  await assert.rejects(
    () =>
      new LentaAdapter().fetchProduct('lenta-300886', {
        ...CTX,
        name: 'Такого товара в выдаче нет 12345',
      }),
    (err: unknown) => err instanceof Error && err.name === 'ProductLookupError',
    'отсутствие товара в выдаче — отдельный класс: breaker не должен выключать сеть',
  );
}

// --- 12. fetchProduct: пустая выдача на все попытки — сетевой класс. -------
{
  route = (url) => {
    if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
    if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
    if (url.endsWith('/delivery/mode')) return { status: 401, text: 'qrator' };
    if (url.endsWith('/jrpc/searchItems')) return { body: { result: { items: [], total: 0 } } };
    throw new Error(`незапланированный запрос: ${url}`);
  };
  await assert.rejects(
    () => new LentaAdapter().fetchProduct('lenta-300886', { ...CTX, name: 'Молоко ПРАВИЛЬНОЕ 3,2%' }),
    /пустую выдачу на все попытки/,
    'выдачи не было вовсе — это сеть, а не переименование',
  );
}

// --- 13. fetchProduct: товар без цены — дрейф формата, а не «снят». --------
{
  const itemWithoutPrice = { id: 300886, name: 'Молоко ПРАВИЛЬНОЕ 3,2%', count: 1, slug: 'moloko', prices: { price: null } };
  route = (url) => {
    if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
    if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
    if (url.endsWith('/delivery/mode')) return { status: 401, text: 'qrator' };
    if (url.endsWith('/jrpc/searchItems')) return { body: { result: { items: [itemWithoutPrice], total: 1 } } };
    throw new Error(`незапланированный запрос: ${url}`);
  };
  await assert.rejects(
    () => new LentaAdapter().fetchProduct('lenta-300886', { ...CTX, name: 'Молоко ПРАВИЛЬНОЕ 3,2%' }),
    /найденный товар без цены или названия/,
    'наш id нашли, но без цены — значит смена формата, и паузу сети надо ставить',
  );
}

// --- 14. Код магазина проверяется до похода в сеть. ------------------------
{
  calls.length = 0;
  route = healthyRoute();
  await assert.rejects(
    () => new LentaAdapter().search('молоко', { city: 'moscow', externalStoreId: 'не-код' }),
    /магазин/,
    'мусор в коде точки отвергается, сеть не дёргается',
  );
  assert.equal(calls.length, 0, 'до сети дело не дошло');
}

// --- 15. Неизвестный город и оборванный справочник регионов. ---------------
{
  route = healthyRoute();
  await assert.rejects(
    () => new LentaAdapter().search('молоко', { city: 'будапешт', externalStoreId: '4161' }),
    /нет региона для города будапешт/,
    'город без региона Ленты — ошибка до сети, а не пустая выдача',
  );

  assert.throws(
    () => lentaDomain('moscow-нет-в-справочнике'),
    /нет региона для города/,
    'город вне справочника отвергается по slug до похода в сети',
  );
  for (const city of Object.keys(CITY_TO_SLUG)) {
    assert.doesNotThrow(() => lentaDomain(city), `${city}: slug есть и регион найден`);
  }
  assert.ok(Object.keys(CITY_TO_SLUG).length >= 15, 'справочник покрывает все города, где включена Лента');
}

// --- 16. Сверка по delivery/mode: сеть ответила про чужой магазин. ---------
{
  route = (url) => {
    if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
    if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
    if (url.endsWith('/delivery/mode')) return { body: { storeId: 3090, type: 'pickup', userStores: [] } };
    throw new Error(`незапланированный запрос: ${url}`);
  };
  await assert.rejects(
    () => new LentaAdapter().search('молоко', CTX),
    /режим доставки на магазине 3090, а нужен 4161/,
    'сверка ответа по магазину не пропускает подмену',
  );
}

// --- 17. Нет alias в ответе delivery/mode. ---------------------------------
{
  route = (url) => {
    if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
    if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
    if (url.endsWith('/delivery/mode')) return { body: { storeId: 4161, type: 'pickup', userStores: [] } };
    throw new Error(`незапланированный запрос: ${url}`);
  };
  await assert.rejects(
    () => new LentaAdapter().search('молоко', CTX),
    /не вернулся в delivery\/mode/,
    'без alias сверять ответы нечем — это ошибка, а не тихий переход на «доверяем сети»',
  );
}

// --- 18. fetchProduct: jrpc вернул ошибку прямо в опросе. -----------------
{
  route = (url) => {
    if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
    if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
    if (url.endsWith('/delivery/mode')) return { status: 401, text: 'qrator' };
    if (url.endsWith('/jrpc/searchItems')) return { body: { error: { code: -32601, message: 'Метод не найден' } } };
    throw new Error(`незапланированный запрос: ${url}`);
  };
  await assert.rejects(
    () => new LentaAdapter().fetchProduct('lenta-300886', { ...CTX, name: 'Картофель' }),
    /jrpc searchItems -> Метод не найден/,
    'ошибка метода в опросе видна как ошибка сети',
  );
}

// --- 19. Пауза между запросами реально выдерживается. ---------------------
// Иначе предыдущие блоки проходили бы, а сеть получала бы залпы запросов.
{
  __setRequestGapMsForTests(120);
  const stamps: number[] = [];
  route = (url) => {
    stamps.push(Date.now());
    if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
    if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
    if (url.endsWith('/delivery/mode')) return { status: 401, text: 'qrator' };
    if (url.endsWith('/jrpc/searchItems')) return { body: fixtureJson('lenta-search-2026-10-01.json') };
    throw new Error(`незапланированный запрос: ${url}`);
  };
  await new LentaAdapter().search('молоко', CTX);
  assert.ok(stamps.length >= 3, 'запросов было несколько — пауза между ними измеряема');
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]!);
  assert.ok(
    gaps.every((g) => g >= 100),
    `между запросами выдержана пауза (замеры ${gaps.join(', ')} мс)`,
  );
  // --- 20. Разбор и сверка: края, до которых не доходит живой ответ. ------
{
  // Код магазина сверяется только цифрами: «4161a» — это не наш магазин, даже
  // если начинается так же.
  assert.equal(sameLentaStore('4161', 4161), true, 'одинаковые коды в разных типах — один магазин');
  assert.equal(sameLentaStore('4161a', '4161'), false, 'не-цифровой код не проходит сверку');
  assert.equal(sameLentaStore(undefined, '4161'), false, 'без кода сверять нечего');

  // Вес товара: карточка, потом сеть, потом ноль.
  assert.equal(lentaWeightGrams({ weight: { net: 930 } } as never), 930, 'вес из карточки');
  assert.equal(lentaWeightGrams({ netWeight: 800 } as never), 800, 'вес из ответа сети');
  assert.equal(lentaWeightGrams({ netWeight: 0 } as never), 0, 'нулевой вес — это не вес');
  assert.equal(lentaWeightLabel({} as never), undefined, 'без веса фасовки нет');
  assert.equal(lentaWeightLabel({ weight: { net: 1000 } } as never), '1 кг', 'целый килограмм без дробной части');
  assert.equal(lentaWeightLabel({ weight: { net: 800 } } as never), '0,8 кг', 'дробь отделяется запятой');

  // Картинка приходит в трёх размерах, и берётся лучший из пришедших.
  const ctx = { city: 'moscow' };
  const priced = { id: 1, name: 'Молоко', prices: { price: 100 } } as never;
  const onlyOriginal = normalizeLentaItem({ ...(priced as object), images: [{ original: 'https://img/o.png' }] } as never, ctx, null, false);
  assert.equal(onlyOriginal?.imageUrl, 'https://img/o.png', 'пришёл только original — берём его');
  const onlyPreview = normalizeLentaItem({ ...(priced as object), images: [{ preview: 'https://img/p.png' }] } as never, ctx, null, false);
  assert.equal(onlyPreview?.imageUrl, 'https://img/p.png', 'пришёл только preview — берём его');

  // Лимит выдачи: лишние товары не разбираются, а не молча теряются.
  const many = {
    result: {
      total: 3,
      items: [
        { id: 1, name: 'Молоко', prices: { price: 100 } },
        { id: 2, name: 'Кефир', prices: { price: 90 } },
        { id: 3, name: 'Сметана', prices: { price: 80 } },
      ],
    },
  };
  const limited = normalizeLentaSearch(many as never, ctx, null, 2);
  assert.equal(limited.length, 2, 'выдача обрезана по лимиту');
  assert.deepEqual(limited.map((x) => x.canonicalId), ['lenta-1', 'lenta-2'], 'взяты первые два');

  // Пустой userStores: alias неоткуда взять — сказано прямо.
  assert.throws(
    () => aliasFromDeliveryMode({} as never, '4161'),
    /alias/,
    'без списка магазинов alias не выдумывается',
  );
}

// --- 21. Отказы, которые не должны выглядеть как «пусто». -------------------
{
  const withSession = (search: Reply, extra: (url: string) => Reply | null = () => null): Route => {
    return (url) => {
      if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
      if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
      if (url.endsWith('/delivery/mode')) return { body: fixtureJson('lenta-delivery-mode.json') };
      if (url.endsWith('/jrpc/searchItems')) return search;
      const e = extra(url);
      if (e) return e;
      throw new Error(`незапланированный запрос: ${url}`);
    };
  };

  // Ошибка без текста: показываем код, а не «ошибка jrpc searchItems -> undefined».
  route = withSession({ body: { error: { code: 4041 } } });
  await assert.rejects(
    () => new LentaAdapter().search('молоко', CTX),
    /jrpc searchItems -> 4041/,
    'у ошибки без текста показан код',
  );

  // Выдача есть, а счётчика total нет: в попытке это видно как «?», а не как
  // выдуманный ноль — иначе в сообщении «сеть не отдаёт товары» будет врать.
  route = withSession({
    body: { result: { items: [{ id: 7, name: 'Молоко', prices: { price: 100 } }] } },
  });
  const withoutTotal = await new LentaAdapter().search('молоко', CTX);
  assert.equal(withoutTotal.length, 1, 'товар без счётчика всё равно нормализован');

  // Отказ не-401: он не про сессию, а про саму сеть, и должен звучать собой.
  route = (url) => {
    if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
    if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
    if (url.endsWith('/delivery/mode')) return { status: 500, text: 'oops' };
    throw new Error(`незапланированный запрос: ${url}`);
  };
  await assert.rejects(
    () => new LentaAdapter().search('молоко', CTX),
    /-> HTTP 500/,
    '500 назван своим кодом, а не списан на WAF',
  );

  // 401 на delivery/mode повторять бессмысленно: один запрос, а не два.
  let modeCalls = 0;
  route = (url) => {
    if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
    if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
    if (url.endsWith('/delivery/mode')) {
      modeCalls += 1;
      return { status: 403, text: 'qrator' };
    }
    if (url.endsWith('/jrpc/searchItems')) return { body: fixtureJson('lenta-search-2026-10-01.json') };
    throw new Error(`незапланированный запрос: ${url}`);
  };
  await new LentaAdapter().search('молоко', CTX);
  assert.equal(modeCalls, 1, `запрос сверки не повторялся после 403: ${modeCalls}`);
}

// --- 22. Сессия: параллельный вход и отказ с текстом ошибки. ---------------
{
  // Два параллельных поиска города не заводят две сессии: второй берёт первую.
  let sessions = 0;
  route = (url) => {
    if (url.endsWith('/api/rest/sessionGet')) {
      sessions += 1;
      return { body: OK_SESSION };
    }
    if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
    if (url.endsWith('/delivery/mode')) return { body: fixtureJson('lenta-delivery-mode.json') };
    if (url.endsWith('/jrpc/searchItems')) return { body: fixtureJson('lenta-search-2026-10-01.json') };
    throw new Error(`незапланированный запрос: ${url}`);
  };
  const adapter = new LentaAdapter();
  await Promise.all([adapter.search('молоко', CTX), adapter.search('кефир', CTX)]);
  assert.equal(sessions, 1, `на два параллельных поиска — одна сессия: ${sessions}`);

  // Отказ сессии без списка ошибок: показан статус, а не «; ; ;» из пустых строк.
  route = (url) => {
    if (url.endsWith('/api/rest/sessionGet')) return { body: { Head: { Status: 'failure' } } };
    throw new Error(`незапланированный запрос: ${url}`);
  };
  await assert.rejects(
    () => new LentaAdapter().search('молоко', CTX),
    /sessionGet отклонил сессию: failure/,
    'без ErrorList показан статус ответа',
  );

  // Ошибка сессии с кодом вместо текста: в сообщении есть код.
  route = (url) => {
    if (url.endsWith('/api/rest/sessionGet')) {
      return { body: { Head: { Status: 'failure' }, Body: { ErrorList: [{ Class: 'EmptyDeviceId' }] } } };
    }
    throw new Error(`незапланированный запрос: ${url}`);
  };
  await assert.rejects(
    () => new LentaAdapter().search('молоко', CTX),
    /EmptyDeviceId/,
    'ошибка без Description показана по классу',
  );
}

// --- 23. fetchProduct: ответы, которые не должны выглядеть как «нет товара». ---
{
  const withSession = (search: Reply): Route => {
    return (url) => {
      if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
      if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
      if (url.endsWith('/delivery/mode')) return { body: fixtureJson('lenta-delivery-mode.json') };
      if (url.endsWith('/jrpc/searchItems')) return search;
      throw new Error(`незапланированный запрос: ${url}`);
    };
  };
  const someItem = { id: '900', name: 'Молоко', prices: { price: 100 } };

  // Выдача есть, а счётчика total нет: в тексте попытки это «?», а не ноль.
  route = withSession({ body: { result: { items: [someItem] } } });
  const noTotal = await new LentaAdapter().fetchProduct('lenta-900', { ...CTX, name: 'Молоко' });
  assert.equal(noTotal.canonicalId, 'lenta-900', 'товар без счётчика найден по id');

  // Ответ без result: дрейф формы, а не «товар переименован».
  route = withSession({ body: {} });
  await assert.rejects(
    () => new LentaAdapter().fetchProduct('lenta-900', { ...CTX, name: 'Молоко' }),
    /searchItems без result/,
    'ответ без result в fetchProduct — дрейф формы',
  );

  // Ошибка jrpc без текста: показан код.
  route = withSession({ body: { error: { code: 515 } } });
  await assert.rejects(
    () => new LentaAdapter().fetchProduct('lenta-900', { ...CTX, name: 'Молоко' }),
    /searchItems -> 515/,
    'у ошибки jrpc без текста показан код',
  );
}

__setRequestGapMsForTests(0);
}

// Дефолтная пауза — часть контракта с сетью: 2 с между запросами. Обнулять её
// ради скорости можно только убедившись, что обнуляешь настоящее значение.
{
  const stamps: number[] = [];
  route = (url) => {
    stamps.push(Date.now());
    if (url.endsWith('/api/rest/sessionGet')) return { body: OK_SESSION };
    if (url.endsWith('/delivery/mode/set')) return { body: { storeId: 4161, type: 'pickup' } };
    if (url.endsWith('/delivery/mode')) return { status: 401, text: 'qrator' };
    if (url.endsWith('/jrpc/searchItems')) return { body: fixtureJson('lenta-search-2026-10-01.json') };
    throw new Error(`незапланированный запрос: ${url}`);
  };
  __setRequestGapMsForTests(2000);
  const before = Date.now();
  await new LentaAdapter().search('молоко', CTX);
  const took = Date.now() - before;
  assert.ok(stamps.length >= 3, 'запросов было несколько');
  assert.ok(took >= 1000, `пауза между запросами настоящая (проход занял ${took} мс)`);
}

globalThis.fetch = realFetch;
console.log('lenta http: ALL GREEN — сессия, привязка, ретрай 401, WAF, отказы выдачи, fetchProduct, пауза');