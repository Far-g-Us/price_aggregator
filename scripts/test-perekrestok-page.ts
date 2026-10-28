// Юнит-цикл транспорта «страница-читалка» Перекрёстка (Фаза 7г) на мок-ридере.
//
// Проверяется то, что можно сломать кодом, а не сетью: честные отказы без
// зарегистрированного моста и без post() (старый APK), классификация статусов
// (PageFailure против дрейфа), отсутствие немедленного ретрая (одна ходка =
// одна страница + один POST, догоняет scheduler), одинарный JSON в POST-теле
// (двойное экранирование — тест-ловушка 7в), сверки strict-поиска и sapId.
//
// Фикстуры живые: tests/fixtures/perekrestok/feed-*.json, сняты браузером
// юзера 2026-10-10; цены здесь не сверяются, это делает test-perekrestok
// на normalize.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isStaleStoreError } from '../src/core/adapter-errors.js';
import { PerekrestokPageAdapter } from '../src/core/adapters/perekrestok-page.js';
import {
  __setPageReaderForTests,
  injectedPageReader,
  loadPageReader,
  setPageReaderLoader,
  type PageReader,
} from '../src/core/adapters/page-reader-port.js';

const FIXTURES = resolve(import.meta.dirname, '..', 'tests', 'fixtures', 'perekrestok');
const read = (name: string): unknown => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));
const FEED = read('feed-moloko.json') as Record<string, unknown>;

const SAP = '2053';
const CTX = { city: 'moscow', externalStoreId: SAP };
const DONOR = 'https://www.perekrestok.ru/catalog/';
const FEED_URL = 'https://www.perekrestok.ru/api/customer/1.4.1.0/catalog/product/feed';

interface PostCall {
  pageUrl: string;
  apiUrl: string;
  bodyJson?: string;
  httpMethod?: string;
}

interface Calls {
  posts: PostCall[];
  warmups: string[];
  pages: string[];
}

const newCalls = (): Calls => ({ posts: [], warmups: [], pages: [] });

/** Очередь ответов: последний повторяется, пока есть ходки. */
const repeat = (count: number, answer: unknown): unknown[] =>
  Array.from({ length: count }, () => answer);

const makeReader = (calls: Calls, answers: unknown[]): PageReader => ({
  probe: async () => 'тестовый мост',
  readPage: async (opts) => {
    calls.pages.push(opts.url);
    return '';
  },
  readNextData: async () => '',
  warmup: async (opts) => {
    calls.warmups.push(opts.url);
  },
  post: async (opts) => {
    calls.posts.push(opts);
    const answer = answers.length > 1 ? (answers.shift() as unknown) : answers[0];
    if (answer instanceof Error) throw answer;
    return answer as { status: number; body: string };
  },
});

const FEED_BODY = JSON.stringify(FEED);
const ok = (body: string): unknown => ({ status: 200, body });
const pageFailure = (err: unknown): boolean =>
  err instanceof Error && err.name === 'PageFailure';

// ─── 1. Без загрузчика — честный отказ с причиной и местом ──────────────────
__setPageReaderForTests(null);
setPageReaderLoader(null);
await assert.rejects(
  () => loadPageReader(),
  /чтение страниц недоступно в этой сборке/,
  'без моста падает объяснением, почему чтения нет',
);
await assert.rejects(() => loadPageReader(), /Android/, 'и названо место, где транспорт живёт');

// ─── 2. Мост БЕЗ post() — громкий отказ ДО сети ─────────────────────────────
{
  const calls = newCalls();
  __setPageReaderForTests(
    {
      probe: async () => 'старый APK',
      readPage: async () => '',
      readNextData: async () => '',
      warmup: async () => {},
    } as unknown as PageReader,
  );
  await assert.rejects(
    () => new PerekrestokPageAdapter().search('молоко', CTX),
    /мост читалки без post\(\)/,
    'старый APK назван честно: post-транспорт появился только в Фазе 7г',
  );
  assert.deepEqual(calls.posts, [], 'в сеть не позвонили — метода post у моста нет');
}
__setPageReaderForTests(null);

// ─── 3. Поиск: адреса донора и API, одинарный JSON, нормализация ─────────────
{
  const calls = newCalls();
  __setPageReaderForTests(makeReader(calls, [ok(FEED_BODY)]));
  const out = await new PerekrestokPageAdapter().search('молоко', CTX);
  assert.equal(calls.posts.length, 1, 'search — одна ходка (донор + POST)');
  assert.equal(calls.warmups.length, 0, 'прогрева нет — донор сам грузится внутри post');
  assert.deepEqual(calls.posts[0]!.pageUrl, DONOR, 'донор — каталог, тот же адрес, что у живых пользователей');
  assert.equal(calls.posts[0]!.apiUrl, FEED_URL, 'API-адрес ровно десктопный');
  const raw = calls.posts[0]!.bodyJson ?? '';
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(raw, JSON.stringify(parsed), 'bodyJson — один JSON-литерал, без слоёв');
  assert.equal(parsed.page, 1, 'page как у десктопа');
  assert.equal(parsed.perPage, 100, 'perPage 100 — потолок сети, лишних параметров нет');
  assert.deepEqual(parsed.filter, { textQuery: 'молоко' }, 'фильтр ровно десктопный');
  assert.ok(out.length > 0, 'выдача нормализовалась в товары');
  const first = out[0]!;
  assert.match(first.canonicalId, /^perekrestok:\d+$/, 'canonicalId сети Перекрёстка');
  assert.equal(first.storeId, 'perekrestok', 'storeId сети');
  assert.equal(first.storeCode, SAP, 'цена привязана к коду точки');
}
__setPageReaderForTests(null);

// ─── 4. Status 401/403 — PageFailure, БЕЗ немедленного ретрая ────────────────
for (const status of [401, 403]) {
  const calls = newCalls();
  __setPageReaderForTests(makeReader(calls, repeat(5, { status, body: 'антибот не пускает' })));
  await assert.rejects(
    () => new PerekrestokPageAdapter().search('молоко', CTX),
    (err: unknown) =>
      pageFailure(err) &&
      new RegExp(`отдал ${status} — креды не устоялись`).test((err as Error).message),
    `статус ${status} — повторяемый отказ, назван честно`,
  );
  assert.equal(calls.posts.length, 1, 'повтора в транспорте нет — догоняет scheduler');
}
__setPageReaderForTests(null);

// ─── 5. Status 0 — fetch не доехал, PageFailure без ретрая ───────────────────
{
  const calls = newCalls();
  __setPageReaderForTests(
    makeReader(calls, repeat(5, { status: 0, body: '<<fetch не удался: network changed>>' })),
  );
  await assert.rejects(
    () => new PerekrestokPageAdapter().search('молоко', CTX),
    (err: unknown) =>
      pageFailure(err) &&
      /POST на \/catalog\/product\/feed не доехал/.test((err as Error).message),
    'несостоявшийся POST — PageFailure',
  );
  assert.equal(calls.posts.length, 1, 'и тут повтор только по расписанию');
}
__setPageReaderForTests(null);

// ─── 6. HTML вместо JSON при 200 — челлендж встал на POST ────────────────────
{
  const calls = newCalls();
  const CHALLENGE = '<html><body>function get_cookie_spsn() { return "spsn=1_"; }</body></html>';
  __setPageReaderForTests(makeReader(calls, repeat(5, ok(CHALLENGE))));
  await assert.rejects(
    () => new PerekrestokPageAdapter().search('молоко', CTX),
    (err: unknown) =>
      pageFailure(err) && /вернул страницу вместо JSON/.test((err as Error).message),
    'html-челлендж на POST — повторяемый отказ',
  );
  assert.equal(calls.posts.length, 1, 'без немедленного ретрая');
}
__setPageReaderForTests(null);

// ─── 7. Пустое тело при 200 — провисность антибота, PageFailure ──────────────
{
  const calls = newCalls();
  __setPageReaderForTests(makeReader(calls, repeat(5, ok(''))));
  await assert.rejects(
    () => new PerekrestokPageAdapter().search('молоко', CTX),
    (err: unknown) => pageFailure(err) && /пустое тело при 200/.test((err as Error).message),
    'пустое тело антибота ≠ пустая выдача',
  );
  assert.equal(calls.posts.length, 1, 'провисность проходит сама — паузой, не ретраем');
}
__setPageReaderForTests(null);

// ─── 8. Прочий не-200 — обычная ошибка С ТЕЛОМ ответа ────────────────────────
{
  const calls = newCalls();
  __setPageReaderForTests(makeReader(calls, [{ status: 429, body: 'rate limit exceeded' }]));
  await assert.rejects(
    () => new PerekrestokPageAdapter().search('молоко', CTX),
    /ответил 429: rate limit/,
    'не-200 не молчит: причина в теле, обычная ошибка (strike сети)',
  );
  assert.equal(calls.posts.length, 1, 'дрейф-ошибка повтору не поддаётся');
}
__setPageReaderForTests(null);

// ─── 9. Не-JSON при 200 — дрейф формы сети, наружу сразу ─────────────────────
{
  const calls = newCalls();
  __setPageReaderForTests(makeReader(calls, [ok('hello, not json')]));
  await assert.rejects(
    () => new PerekrestokPageAdapter().search('молоко', CTX),
    (err: unknown) =>
      !pageFailure(err) && /не JSON \(дрейф формы сети\?\)/.test((err as Error).message),
    'дрейф формы не проходит молча и не PageFailure',
  );
  assert.equal(calls.posts.length, 1, 'дрейф повтору не поддаётся');
}
__setPageReaderForTests(null);

// ─── 10. Не-strict с товарами — громкий отказ, НЕ ProductLookupError ─────────
{
  const calls = newCalls();
  const blur = JSON.parse(FEED_BODY) as { content: Record<string, unknown> };
  blur.content.searchType = 'popular';
  __setPageReaderForTests(makeReader(calls, [ok(JSON.stringify(blur))]));
  await assert.rejects(
    () => new PerekrestokPageAdapter().search('молоко', CTX),
    (err: unknown) =>
      !pageFailure(err) && /искала.+не строго/.test((err as Error).message),
    'замыленная выдача честно названа ловушкой',
  );
  assert.equal(calls.posts.length, 1, 'и повтор такое не чинит');
}
__setPageReaderForTests(null);

// ─── 11. Не-strict с пустой выдачей — допустимо (десктоп-семантика) ──────────
{
  const calls = newCalls();
  const emptyPopular = { content: { items: [], searchType: 'popular', sapId: SAP } };
  __setPageReaderForTests(makeReader(calls, [ok(JSON.stringify(emptyPopular))]));
  const out = await new PerekrestokPageAdapter().search('чудо-юдо', CTX);
  assert.deepEqual(out, [], 'пустая замыленная выдача — пустой результат, не ошибка');
}
__setPageReaderForTests(null);

// ─── 12. Чужой sapId — StaleStoreError, цена в историю не едет ───────────────
{
  const calls = newCalls();
  const other = JSON.parse(FEED_BODY) as { content: Record<string, unknown> };
  other.content.sapId = '9999';
  __setPageReaderForTests(makeReader(calls, [ok(JSON.stringify(other))]));
  await assert.rejects(
    () => new PerekrestokPageAdapter().search('молоко', CTX),
    (err: unknown) => isStaleStoreError(err) && /точки 9999/.test((err as Error).message),
    'чужой магазин назван, без записи цен',
  );
  assert.equal(calls.posts.length, 1, 'чужой магазин повтору не поддаётся');
}
__setPageReaderForTests(null);

// ─── 13. Нет content.sapId (дрейф) — наружу ─────────────────────────────────
{
  const calls = newCalls();
  const noSap = { content: { items: [], searchType: 'strict' } };
  __setPageReaderForTests(makeReader(calls, [ok(JSON.stringify(noSap))]));
  await assert.rejects(
    () => new PerekrestokPageAdapter().search('молоко', CTX),
    /нет sapId/,
    'ответ без sapId не «незачем проверять» — честный отказ',
  );
}
__setPageReaderForTests(null);

// ─── 14. fetchProduct: полный цикл — наход товара по имени ───────────────────
{
  const calls = newCalls();
  __setPageReaderForTests(makeReader(calls, [ok(FEED_BODY)]));
  const NAME = 'Молоко Домик в деревне стерилизованное 3.2%, 950 г';
  const product = await new PerekrestokPageAdapter().fetchProduct('perekrestok:2059346', {
    ...CTX,
    name: NAME,
  });
  assert.equal(product.canonicalId, 'perekrestok:2059346', 'карточка — ровно запрошенный товар');
  assert.equal(product.storeCode, SAP, 'цена привязана к коду точки');
  assert.ok(product.price > 0, 'цена снята из фида');
}

// ─── 15. fetchProduct: строгая пустая выдача — сеть или дрейф, НЕ rename ─────
{
  const calls = newCalls();
  const empty = { content: { items: [], searchType: 'strict', sapId: SAP } };
  __setPageReaderForTests(makeReader(calls, repeat(4, ok(JSON.stringify(empty)))));
  await assert.rejects(
    () =>
      new PerekrestokPageAdapter().fetchProduct('perekrestok:1', {
        ...CTX,
        name: 'Исчезнувший товар, которого точно нет в каталоге магазина 123',
      }),
    /пустую выдачу на все попытки/,
    'пустая выдача лестницы — честный «сеть или дрейф»',
  );
  assert.equal(calls.posts.length, 3, 'лестница полного имени и срезов 40/25 — три ходки');
}
__setPageReaderForTests(null);

// ─── 16. fetchProduct: есть товары, но не наш — ProductLookupError ───────────
{
  const calls = newCalls();
  assert.ok(
    Array.isArray((FEED as { content?: { items?: unknown[] } }).content?.items),
    'фикстура с товарами',
  );
  __setPageReaderForTests(makeReader(calls, repeat(4, ok(FEED_BODY))));
  await assert.rejects(
    () =>
      new PerekrestokPageAdapter().fetchProduct('perekrestok:1', {
        ...CTX,
        name: 'Такого нет в фикстуре длинное название',
      }),
    /товар не найден поиском по названию/,
    'перенос товара назван честно',
  );
}
__setPageReaderForTests(null);

// ─── 17. fetchProduct без названия — ProductLookupError ДО сети ──────────────
{
  const calls = newCalls();
  __setPageReaderForTests(makeReader(calls, []));
  await assert.rejects(
    () => new PerekrestokPageAdapter().fetchProduct('perekrestok:2059346', CTX),
    /у товара нет названия в базе/,
    'ProductLookupError',
  );
  assert.deepEqual(calls.posts, [], 'в сеть не позвонили');
}
__setPageReaderForTests(null);

// ─── 18. Пустой пользовательский запрос — пусто, сеть не звалась ─────────────
{
  const calls = newCalls();
  __setPageReaderForTests(makeReader(calls, []));
  const out = await new PerekrestokPageAdapter().search('   ', CTX);
  assert.deepEqual(out, [], 'пустой запрос — пустой результат');
  assert.deepEqual(calls.posts, [], 'сеть на пустом запросе без нужды не трогается');
}
__setPageReaderForTests(null);

// ─── 19. Битый canonicalId — чужой префикс ловится до сети ──────────────────
{
  const calls = newCalls();
  __setPageReaderForTests(makeReader(calls, []));
  await assert.rejects(
    () => new PerekrestokPageAdapter().fetchProduct('5ka-1', { ...CTX, name: 'Молоко' }),
    /не наш ключ товара/,
    'чужой префикс не идёт в сеть',
  );
  assert.deepEqual(calls.posts, [], 'в сеть не позвонили');
}
__setPageReaderForTests(null);

// ─── 20. Обёртка тела от моста — слой снимается defensive ────────────────────
{
  const calls = newCalls();
  __setPageReaderForTests(makeReader(calls, [ok(JSON.stringify(FEED_BODY))]));
  const out = await new PerekrestokPageAdapter().search('молоко', CTX);
  assert.ok(out.length > 0, 'остаточная обёртка evaluateJavascript не роняет разбор');
}
__setPageReaderForTests(null);

// ─── 21. Синхронный reject моста — наружу как есть ───────────────────────────
{
  const calls = newCalls();
  __setPageReaderForTests(makeReader(calls, [new Error('apiUrl обязателен и должен быть https')]));
  await assert.rejects(
    () => new PerekrestokPageAdapter().search('молоко', CTX),
    /apiUrl обязателен/,
    'отказ моста доезжает с тем же текстом',
  );
}

__setPageReaderForTests(null);
assert.equal(injectedPageReader(), null, 'после теста подмены нет');

console.log('perekrestok-page: ALL GREEN — классификация, без ретрая, strict/sapId, лестница');
