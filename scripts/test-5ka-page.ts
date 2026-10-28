// Юнит-цикл транспорта «страница-читалка» Пятёрки (Фаза 7в) на мок-ридере.
//
// Честные отказы обязательны: без зарегистрированного загрузчика адаптер
// обязан падать с объяснением (это реальный случай Electron), WAF-страница и
// пустое тело не могут выглядеть как «пустая выдача» (иначе опрос снимет это
// как «цена не изменилась» — write-on-change молча замрёт), а коды магазина
// со страницы обязаны сверяться с настроенным (защита истории от чужих цен).
//
// Фикстуры живые: tests/fixtures/5ka-search.json (выдача) и 5ka-product.json
// (карточка), сняты в браузере юзера — сами цены здесь не сверяются, это
// делает test:5ka на normalize.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PyaterochkaPageAdapter } from '../src/core/adapters/5ka-page.js';
import {
  __setPageReaderForTests,
  injectedPageReader,
  loadPageReader,
  setPageReaderLoader,
  type PageReader,
} from '../src/core/adapters/page-reader-port.js';
import type { ScrapedProduct } from '../src/shared/types.js';

const FIXTURES = resolve(import.meta.dirname, '..', 'tests', 'fixtures');
const SEARCH_FIXTURE = readFileSync(resolve(FIXTURES, '5ka-search.json'), 'utf8');
const PRODUCT_FIXTURE = JSON.parse(readFileSync(resolve(FIXTURES, '5ka-product.json'), 'utf8'));

const SEARCH_BODY = JSON.stringify(JSON.parse(SEARCH_FIXTURE));
const SAP = '35XY';
const CTX = { city: 'moscow', externalStoreId: SAP };

interface Calls {
  warmups: string[];
  pages: string[];
  next: { url: string; plu: string }[];
}

const newCalls = (): Calls => ({ warmups: [], pages: [], next: [] });

// Очередь ответов: shift, пока есть больше одного, далее последний повторяется.
const repeat = (count: number, answer: string): string[] =>
  Array.from({ length: count }, () => answer);

const makeReader = (calls: Calls, pageAnswers: string[], nextAnswers: string[]): PageReader => ({
  probe: async () => 'тестовый мост',
  readPage: async (opts) => {
    calls.pages.push(opts.url);
    return pageAnswers.length > 1 ? (pageAnswers.shift() as string) : pageAnswers[0]!;
  },
  readNextData: async (opts) => {
    calls.next.push(opts);
    return nextAnswers.length > 1 ? (nextAnswers.shift() as string) : nextAnswers[0]!;
  },
  warmup: async (opts) => {
    calls.warmups.push(opts.url);
  },
});

// ─── 1. Без загрузчика и без подмены — честный отказ с причиной ─────────────
__setPageReaderForTests(null);
setPageReaderLoader(null);
await assert.rejects(
  () => loadPageReader(),
  /чтение страниц недоступно в этой сборке/,
  'без моста падает не «неизвестная ошибка», а объяснение, почему чтения нет',
);
await assert.rejects(
  () => loadPageReader(),
  /Android/,
  'и названо место, где транспорт существует',
);

// ─── 2. Зарегистрированный загрузчик возвращает свой мост ────────────────────
const fake = makeReader(newCalls(), [''], ['']);
setPageReaderLoader(async () => fake);
assert.equal(await loadPageReader(), fake, 'загрузчик оболочки отдаёт свой мост');
assert.equal(await loadPageReader(), fake, 'повторный вызов не пересоздаёт мост');
setPageReaderLoader(null);

// ─── 3. Отказ загрузчика пересказан с сохранением причины ────────────────────
setPageReaderLoader(async () => {
  throw new Error('native bridge gone');
});
await assert.rejects(
  () => loadPageReader(),
  /не удалось поднять чтение страниц/,
  'сбой сбора моста превращается в понятный текст',
);
let readerFailure = '';
try {
  await loadPageReader();
} catch (err) {
  readerFailure = String(err);
}
assert.match(readerFailure, /native bridge gone/, 'и причина сохранена');
setPageReaderLoader(null);

// ─── 4. Подмена для тестов побеждает загрузчик ───────────────────────────────
const injectedBridge = makeReader(newCalls(), [''], ['']);
__setPageReaderForTests(injectedBridge);
assert.equal(injectedPageReader(), injectedBridge, 'подмена видна');
assert.equal(await loadPageReader(), injectedBridge, 'и берётся вместо загрузчика');
__setPageReaderForTests(null);
assert.equal(injectedPageReader(), null, 'подмена снята');

// ─── 5. Поиск: прогрев ленивый, URL с sapCode и параметрами прямого пути ─────
{
  const calls = newCalls();
  __setPageReaderForTests(makeReader(calls, [SEARCH_BODY], []));
  const out = await new PyaterochkaPageAdapter().search('молоко', CTX);
  assert.deepEqual(calls.warmups, ['https://5ka.ru/'], 'первый вызов начинается с прогрева сети');
  assert.equal(calls.pages.length, 1, 'поиск — одно чтение страницы');
  assert.equal(
    calls.pages[0],
    'https://5d.5ka.ru/api/catalog/v3/stores/35XY/' +
      `search?mode=store&include_restrict=true&q=${encodeURIComponent('молоко')}&limit=12`,
    'sapCode вшит в URL нами самими — маркера в теле выдачи нет',
  );
  assert.ok(out.length > 0, 'выдача нормализовалась в товары');
  const first = out[0] as ScrapedProduct;
  assert.match(first.canonicalId, /^5ka-\d+$/, 'canonicalId сети Пятёрки');
  assert.equal(first.storeId, 'pyaterochka', 'storeId сети');
  assert.equal(first.storeCode, SAP, 'цена привязана к коду сетевого магазина');
  assert.ok(
    (first.url ?? '').startsWith('https://5ka.ru/product/'),
    'короткая ссылка карточки',
  );
}

// ─── 6. WAF-страница: честный отказ, ≤2 попытки, повтор с прогревом ──────────
{
  const calls = newCalls();
  const WAF_BODY =
    '<html><body>Проблемы со связью. Проверьте настройки интернета и VPN (request id: 7f2)</body></html>';
  __setPageReaderForTests(makeReader(calls, repeat(4, WAF_BODY), []));
  await assert.rejects(
    () => new PyaterochkaPageAdapter().search('молоко', CTX),
    /WAF отдал заглушку/,
    'WAF-страница не «пустая выдача» — причина честная',
  );
  assert.equal(calls.pages.length, 2, 'на адрес максимум 2 попытки');
  assert.equal(calls.warmups.length, 2, 'повтору предшествует повторный прогрев');
  const adapter = new PyaterochkaPageAdapter();
  await assert.rejects(() => adapter.search('молоко', CTX), /WAF отдал заглушку/);
  assert.equal(calls.pages.length, 4, 'протокол повторов не наращивается от вызова к вызову');
}

// ─── 7. Пустое тело: честный отказ с повтором ────────────────────────────────
{
  const calls = newCalls();
  __setPageReaderForTests(makeReader(calls, repeat(2, ''), []));
  await assert.rejects(
    () => new PyaterochkaPageAdapter().search('молоко', CTX),
    /тело ответа на поиск пустое/,
    'пустое тело ≠ пустая выдача',
  );
  assert.equal(calls.pages.length, 2, 'и пустое тело — максимум 2 попытки');
}

// ─── 8. Двойная JSON-обёртка evaluateJavascript: слои снимаются ──────────────
{
  const calls = newCalls();
  __setPageReaderForTests(makeReader(calls, [JSON.stringify(JSON.stringify(SEARCH_BODY))], []));
  const out = await new PyaterochkaPageAdapter().search('молоко', CTX);
  assert.ok(out.length > 0, 'двойное экранирование не роняет разбор');
}

// ─── 9. products: [] при живой сети — отказ деградации, не «пусто» ───────────
{
  const calls = newCalls();
  const EMPTY = JSON.stringify({ products: [] });
  __setPageReaderForTests(makeReader(calls, repeat(2, EMPTY), []));
  await assert.rejects(
    () => new PyaterochkaPageAdapter().search('молоко', CTX),
    /отдал 0 товаров при живой сети/,
    'пустая выдача при живой сети не может называться успехом',
  );
  assert.equal(calls.pages.length, 2, 'и деградация — максимум 2 попытки');
}

// ─── 10. Не-JSON и дрейф формы — наружу сразу, повтор не тратится ────────────
{
  const calls = newCalls();
  __setPageReaderForTests(makeReader(calls, ['hello, not json'], []));
  await assert.rejects(
    () => new PyaterochkaPageAdapter().search('молоко', CTX),
    /ответ не JSON/,
    'не-JSON — честная причина',
  );
  assert.equal(calls.pages.length, 1, 'на априорный отказ повтор не тратится');
  assert.equal(calls.warmups.length, 1, 'и повторного прогрева нет');
}
{
  const calls = newCalls();
  const DRIFT = JSON.stringify({
    search_query_id: 'x',
    query_type: 'search',
    products: 'gone',
  });
  __setPageReaderForTests(makeReader(calls, [DRIFT], []));
  await assert.rejects(
    () => new PyaterochkaPageAdapter().search('молоко', CTX),
    /нет списка товаров/,
    'дрейф формы ответа не проходит без объяснения',
  );
  assert.equal(calls.pages.length, 1, 'дрейф формы повтору не поддаётся');
}

// ─── 11. Карточка: сводка ok + свой магазин + запись товара ──────────────────
{
  const calls = newCalls();
  const envelope = JSON.stringify({
    ok: true,
    codes: ['35XY'],
    product: JSON.stringify(PRODUCT_FIXTURE),
  });
  __setPageReaderForTests(makeReader(calls, [], [envelope]));
  const product = await new PyaterochkaPageAdapter().fetchProduct('5ka-3255206', CTX);
  assert.deepEqual(
    calls.next,
    [{ url: 'https://5ka.ru/product/3255206/', plu: '3255206' }],
    'адрес карточки и plu уходят в мост как есть',
  );
  assert.equal(product.canonicalId, '5ka-3255206', 'карточка — ровно запрошенный товар');
  assert.equal(product.storeCode, SAP, 'цена карточки привязана к коду сетевого магазина');
  assert.ok(product.price > 0, 'цена снята из снимка');
  assert.equal(product.url, 'https://5ka.ru/product/3255206/', 'короткая ссылка карточки');
}

// ─── 12. Карточка: чужой магазин — отказ, цена в историю не едет ─────────────
{
  const calls = newCalls();
  const envelope = JSON.stringify({
    ok: true,
    codes: ['ABCD'],
    product: JSON.stringify(PRODUCT_FIXTURE),
  });
  __setPageReaderForTests(makeReader(calls, [], [envelope]));
  await assert.rejects(
    () => new PyaterochkaPageAdapter().fetchProduct('5ka-3255206', CTX),
    /назвала магазины ABCD/,
    'чужой магазин назван честно, без записи цены',
  );
  assert.equal(calls.next.length, 1, 'чужой магазин повтору не поддаётся');
}

// ─── 13. Карточка: несколько кодов, наш среди них — ходят с warn ─────────────
{
  const calls = newCalls();
  const envelope = JSON.stringify({
    ok: true,
    codes: ['35XY', 'X383'],
    product: JSON.stringify(PRODUCT_FIXTURE),
  });
  __setPageReaderForTests(makeReader(calls, [], [envelope]));
  const product = await new PyaterochkaPageAdapter().fetchProduct('5ka-3255206', CTX);
  assert.equal(product.canonicalId, '5ka-3255206', 'наш код назван — цена валидна');
}

// ─── 14. Карточка: запись чужого товара не сойдёт за запрошенную ─────────────
{
  const calls = newCalls();
  const wrongRecord = { ...PRODUCT_FIXTURE, plu: 999999 };
  const envelope = JSON.stringify({
    ok: true,
    codes: ['35XY'],
    product: JSON.stringify(wrongRecord),
  });
  __setPageReaderForTests(makeReader(calls, [], [envelope]));
  await assert.rejects(
    () => new PyaterochkaPageAdapter().fetchProduct('5ka-3255206', CTX),
    /отдала другую запись/,
    'сверка canonicalId обязательна',
  );
}

// ─── 15. Карточка: сбой доставки — ok:false, PageFailure, повтор ─────────────
{
  const calls = newCalls();
  const envelope = JSON.stringify({ ok: false, reason: 'product-missing', codes: [] });
  __setPageReaderForTests(makeReader(calls, [], [envelope, envelope]));
  await assert.rejects(
    () => new PyaterochkaPageAdapter().fetchProduct('5ka-3255206', CTX),
    /товар не появился в данных страницы/,
    'недоставленный товар назван честной ошибкой',
  );
  assert.equal(calls.next.length, 2, 'доставка — максимум 2 попытки');
  assert.equal(calls.warmups.length, 2, 'повтору предшествует повторный прогрев');
}

// ─── 16. Карточка: bad canonicalId — наружу без сети ────────────────────────
{
  const calls = newCalls();
  __setPageReaderForTests(makeReader(calls, [], []));
  await assert.rejects(
    () => new PyaterochkaPageAdapter().fetchProduct('magnit-1', CTX),
    /bad canonicalId/,
    'чужой префикс ловится до сети',
  );
  assert.deepEqual(calls.next, [], 'сеть не потревожена');
}

// ─── 17. Карточка: запись товара без цены — честный отказ normalize ──────────
{
  const calls = newCalls();
  const withoutPrice = { ...PRODUCT_FIXTURE, prices: null };
  const envelope = JSON.stringify({
    ok: true,
    codes: ['35XY'],
    product: JSON.stringify(withoutPrice),
  });
  __setPageReaderForTests(makeReader(calls, [], [envelope]));
  await assert.rejects(
    () => new PyaterochkaPageAdapter().fetchProduct('5ka-3255206', CTX),
    /без цены/,
    'товар без цены назван честно',
  );
}

__setPageReaderForTests(null);
assert.equal(injectedPageReader(), null, 'после теста подмены нет');

console.log('5ka-page: ALL GREEN — мост, честные отказы, identity кодов, цены');
