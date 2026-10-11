// Транспорт и адаптер Чижика без сети: браузер подменён, ответы — живые фикстуры.
//
// Здесь проверяется ровно то, что нельзя увидеть на живом прогоне: какой адрес и с
// какими параметрами уходит в сеть, как разбираются отказы (403, не-JSON,
// антибот-страница), кэшируется ли сессия и повторяется ли её сборка.
//
// Отдельно зафиксирована ошибка, стоившая прогона: транспорт принимает ПУТЬ, а
// не полный URL. Склейка «домен + полный URL» даёт NetworkError в браузере.

import assert from 'node:assert';
import fs from 'node:fs';
import { isProductLookupError, isStaleStoreError } from '../src/core/adapter-errors.js';
import { ChizhikAdapter } from '../src/core/adapters/chizhik.js';
import { closeChizhikBrowser, getChizhikSession } from '../src/core/adapters/chizhik-browser.js';
import { __setPlaywrightForTests } from '../src/core/adapters/playwright-port.js';

const read = (name: string): unknown => JSON.parse(fs.readFileSync(`tests/fixtures/chizhik/${name}`, 'utf8'));
const SEARCH = read('search.json') as { products: Record<string, unknown>[] };
const SHELF = read('category-products.json') as { products: Record<string, unknown>[] };
const CATEGORIES = read('categories.json') as Record<string, unknown>[];

const CTX = { city: 'moscow', externalStoreId: 'HD87' };

// --- Подмена браузера: evaluate исполняется в Node, поэтому in-page fetch ---
// --- ходит в глобальный fetch, который мы же и подменили. --------------------
interface Reply {
  status?: number;
  body?: string;
}
let reply: Reply = { body: JSON.stringify(SEARCH) };
const seen: string[] = [];
let launches = 0;
let closes = 0;
let titleText = 'Чижик';
let gotoThrows: Error | string | null = null;
/** Когда задана строка — fetch бросает её вместо ответа (не-Error в транспорте). */
let fetchThrows: string | null = null;
/**
 * Хук, выполняемый ВНУТРИ очередного fetch. Нужен для детерминированной гонки: окно
 * «сессия занята, а лимит превышен» иначе не поймать никакими таймингами.
 */
let onFetch: (() => Promise<void>) | null = null;
/** Отдавать фейковые страницы с индивидуальными настройками (URL, статус goto). */
let pageTweaks: ((page: FakePage) => void) | null = null;


class FakePage {
  /** URL страницы: transport проверяет, что браузер остался на магазине, который просили. */
  urlText = '';
  /** Подмена адреса: emulates сеть, уводившую браузер на чужой магазин. */
  urlOverride: string | null = null;
  gotoStatus = 200;
  /** goto вернул null (about:blank в Playwright) — статуса нет, и проверять нечего. */
  gotoReturnsNull = false;
  async goto(url: string, _opts?: unknown): Promise<{ status: () => number } | null> {
    if (gotoThrows) throw gotoThrows;
    this.urlText = url;
    if (this.gotoReturnsNull) return null;
    const status = this.gotoStatus;
    return { status: () => status };
  }
  // page.url() в Playwright синхронный — фейк должен повторять и сигнатуру.
  url(): string {
    return this.urlOverride ?? this.urlText;
  }
  async title(): Promise<string> {
    return titleText;
  }
  async waitForTimeout(_ms: number): Promise<void> {}
  async evaluate<T>(fn: (arg: never) => T, arg?: unknown): Promise<T> {
    return (fn as (a: unknown) => T)(arg);
  }
}

class FakeBrowser {
  async newContext(_opts?: unknown): Promise<{ newPage: () => Promise<FakePage> }> {
    return {
      newPage: async () => {
        const page = new FakePage();
        pageTweaks?.(page);
        return page;
      },
    };
  }
  async close(): Promise<void> {
    closes += 1;
  }
}

__setPlaywrightForTests({
  firefox: {
    launch: async () => {
      launches += 1;
      return new FakeBrowser();
    },
  },
} as unknown as typeof import('playwright'));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = typeof input === 'string' ? input : String(input instanceof URL ? input : input.url);
  seen.push(url);
  if (onFetch) {
    const hook = onFetch;
    onFetch = null;
    await hook();
  }
  if (fetchThrows) throw fetchThrows;
  const status = reply.status ?? 200;
  const body = reply.body ?? '';
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    text: async () => body,
  } as unknown as Response;
}) as typeof fetch;

const adapter = new ChizhikAdapter();

// --- 1. Поиск: путь без домена, обязательные параметры, нормализация. ---------
{
  seen.length = 0;
  launches = 0;
  reply = { body: JSON.stringify(SEARCH) };
  const items = await adapter.search('молоко', CTX);
  assert.ok(items.length > 0, 'выдача непустая');
  assert.equal(seen.length, 1, 'один запрос на поиск');
  assert.match(seen[0] ?? '', /stores\/HD87\/search\?/, 'код магазина в пути');
  assert.match(seen[0] ?? '', /mode=delivery/, 'режим доставки: без него сеть отвечает 422');
  assert.match(seen[0] ?? '', /q=%D0%BC%D0%BE%D0%BB%D0%BE%D0%BA%D0%BE/, 'поиск по q, не по query');
  assert.ok(
    (seen[0] ?? '').startsWith('https://app.chizhik.club/delivery/'),
    'транспорт склеил путь с доменом один раз',
  );
  assert.equal(
    (seen[0] ?? '').match(/app\.chizhik\.club/g)?.length,
    1,
    'домен не продублирован: адаптер отдаёт путь, а не полный URL',
  );
  assert.ok(items.every((i) => i.storeId === 'chizhik' && i.city === 'moscow'), 'сеть и город проставлены');
  assert.ok(items.every((i) => /^chizhik-\d+$/.test(i.canonicalId)), 'идентичность товара');
  await closeChizhikBrowser();
}

// --- 2. Сессия кэшируется: два поиска подряд — один браузер. -----------------
{
  launches = 0;
  reply = { body: JSON.stringify(SEARCH) };
  await adapter.search('молоко', CTX);
  await adapter.search('молоко', CTX);
  assert.equal(launches, 1, 'браузер поднят один раз на два запроса');
  await closeChizhikBrowser();
}

// --- 3. Несколько магазинов живут одновременно, лишние закрываются. --------
// Опрос идёт по товарам без сортировки по городу, то есть точки чередуются. При
// одной сессии на всё каждый переход к чужому городу поднимал бы Firefox заново —
// это минута прогрева на КАЖДЫЙ товар. Поэтому держим несколько сессий, а лишние
// закрываем, чтобы не висело 11 Firefox.
{
  launches = 0;
  closes = 0;
  reply = { body: JSON.stringify(SEARCH) };
  await adapter.search('молоко', CTX);
  await adapter.search('молоко', { city: 'novosibirsk', externalStoreId: 'HDJ7' });
  assert.equal(launches, 2, 'две точки — две сессии');
  assert.equal(closes, 0, 'в пределах лимита никто не закрывается');
  // Возврат к первой точке использует её сессию: браузер не переподнимается.
  await adapter.search('молоко', CTX);
  assert.equal(launches, 2, 'чередование городов не пересоздаёт браузеры');
  // Шестая точка вытесняет самую старую — Firefox не копятся. Лимит 5, поэтому
  // на шестой точке закрывается ровно одна сессия.
  const SIX = [
    { city: 'ekaterinburg', externalStoreId: 'HD1W' },
    { city: 'kazan', externalStoreId: 'HDFD' },
    { city: 'perm', externalStoreId: 'HD0J' },
    { city: 'barnaul', externalStoreId: 'HDJT' },
  ];
  for (const ctx of SIX) await adapter.search('молоко', ctx);
  assert.equal(launches, 6, 'каждая точка — свой браузер');
  assert.equal(closes, 1, 'лишняя сессия закрыта, а не забыта');
  // Много сессий разом: вытесняются ВСЕ лишние сразу, а не по одной за запрос, и
  // текущая точка никогда не выгоняет саму себя.
  await adapter.search('молоко', { city: 'kemerovo', externalStoreId: 'HDIG' });
  await adapter.search('молоко', { city: 'ulyanovsk', externalStoreId: 'HDOW' });
  assert.equal(closes, 3, 'вытеснены все лишние сессии сразу, а не по одной за запрос');
  assert.ok(launches <= 8, `браузеров всего ${launches}: каждая точка — один, не больше`);
  // Текущая точка на месте после вытеснений: только что с ней работали.
  await adapter.search('молоко', { city: 'ulyanovsk', externalStoreId: 'HDOW' });
  assert.equal(launches, 8, 'последняя точка жива и не пересоздаётся');
  // LRU: вернулись к давно не использованной точке — она в кэше, браузер не новый.
  await adapter.search('молоко', CTX);
  assert.ok(launches <= 9, `московская точка после возвращения: браузеров ${launches}`);
  await closeChizhikBrowser();
  assert.ok(closes >= 8, 'выход закрывает все сессии');
}

// --- 3a. Параллельные запросы не поднимают второй браузер. ------------------
{
  launches = 0;
  closes = 0;
  reply = { body: JSON.stringify(SEARCH) };
  const both = await Promise.all([
    adapter.search('молоко', CTX),
    adapter.search('молоко', CTX),
  ]);
  assert.ok(both[0]?.length && both[1]?.length, 'оба параллельных запроса получили товары');
  assert.equal(launches, 1, 'на два одновременных запроса — одна сессия');
  assert.equal(closes, 0, 'сессию на оба запроса не закрывали');
  await closeChizhikBrowser();
}

// Параллельные запросы РАЗНЫХ магазинов: каждый ждёт чужую сессию и строит свою.
{
  launches = 0;
  reply = { body: JSON.stringify(SEARCH) };
  await Promise.all([
    adapter.search('молоко', CTX),
    adapter.search('молоко', { city: 'novosibirsk', externalStoreId: 'HDJ7' }),
  ]);
  assert.equal(launches, 2, 'у каждого магазина своя сессия даже при гонке');
  await closeChizhikBrowser();
}

// --- 4. Пустой products — пустая выдача, а не ошибка. -----------------------
{
  // Пустой МАССИВ — честный ответ «ничего не нашлось».
  reply = { body: JSON.stringify({ query_type: 'strict', products: [] }) };
  assert.deepEqual(await adapter.search('молоко', CTX), [], 'пустой products — нет товаров');
  // Отсутствующее поле — уже дрейф формата: молчаливый пустой список здесь означал
  // бы «витрина пуста», а на деле сеть ответила не тем, и breaker бы не сработал.
  reply = { body: JSON.stringify({}) };
  await assert.rejects(() => adapter.search('молоко', CTX), /смена ответа сети/, 'нет products — дрейф, а не пустота');
  reply = { body: JSON.stringify({ query_type: 'strict', products: null }) };
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /смена ответа сети/,
    'products: null — тоже дрейф формата',
  );
  // Товар без plu в выдаче: пропускается, остальные разбираются.
  reply = { body: JSON.stringify({ query_type: 'strict', products: [{ plu: null, name: 'Без plu' }, SEARCH.products[0]] }) };
  const mixed = await adapter.search('молоко', CTX);
  assert.equal(mixed.length, 1, 'товар без plu пропущен, нормальный разобран');
  await closeChizhikBrowser();
}

// --- 3b. Занятую сессию не вытесняем. ---------------------------------------
// Вытеснение закрывает страницу, а параллельный запрос по ней падает в
// «Target closed» — восстановимый отказ с backoff и пересборкой. То есть вместо
// одной лишней пересборки получаем каскад. Поэтому занятую точку оставляем.
//
// Занятость держим висящим запросом, а не «запросом, который уже закончился»:
// раньше проверка выглядела рабочей, но к моменту вытеснения запрос по COLD уже
// отпускал счётчик, то есть точку никогда нельзя было вытеснить «по занятости».
{
  await closeChizhikBrowser();
  launches = 0;
  closes = 0;
  reply = { body: JSON.stringify({ ...SEARCH, query_type: 'strict' }) };
  const COLD = { city: 'moscow', externalStoreId: 'HD87' };
  let releaseFetch: (() => void) | null = null;
  // Через `search` тут звать нельзя: он встал бы в ту же очередь и ждал бы сам
  // себя, поэтому «зависший» запрос делаем фейковым fetch-хуком.
  onFetch = async () =>
    await new Promise<void>((done) => {
      releaseFetch = done;
    });
  const hanging = adapter.search('молоко', COLD);
  let release: () => void = () => {};
  while (releaseFetch === null) {
    await new Promise((done) => void setTimeout(done, 1));
    release = releaseFetch ?? release;
  }
  // Четыре точки строим напрямую: запросов они не делают, поэтому в карте лежат
  // БЕЗ отметки занятости — вытеснить их можно и нужно. Шестая точка упрётся в
  // лимит, и первым в обходе окажется COLD, которую трогать нельзя.
  const WARM = ['HDJ7', 'HD1W', 'HDFD', 'HD0J'];
  for (const sap of WARM) await getChizhikSession(sap);
  const closesBefore = closes;
  await getChizhikSession('HDJT');
  assert.equal(closes, closesBefore + 1, 'вытеснилась свободная сессия, а не занятая COLD');
  release();
  releaseFetch = null;
  onFetch = null;
  const items = await hanging;
  assert.ok(items.length > 0, 'зависший запрос дошёл до ответа после всех вытеснений');
  await closeChizhikBrowser();
}

// --- 3c. Регрессия: счётчик занятости схлопывается в ноль. ------------------
// `release` писал в счётчик запомненное число, а не текущее. При параллельных
// запросах к одной точке первый освободивший уже не «помнит» своё значение, и
// счётчик залипал на 1 навсегда: точка вечно считалась занятой, её нельзя было
// вытеснить, а её Firefox висел до конца процесса.
//
// Утверждение обратное привычному, и это важно. Проверка «осталась ли точка в
// кэше» залипшему счётчику только по нраву: он держит точку в карте даже лучше,
// чем нужно, и такая проверка была зелёной на сломанном коде. Поэтому проверяем
// вытесняемость — после переполнения карты браузер гонки обязан быть закрыт.
{
  await closeChizhikBrowser();
  launches = 0;
  closes = 0;
  reply = { body: JSON.stringify({ ...SEARCH, query_type: 'strict' }) };
  const BUSY = { city: 'moscow', externalStoreId: 'HD87' };
  const COLD = ['HD81', 'HD82', 'HD83', 'HD84'];
  let releaseFetch: (() => void) | null = null;
  onFetch = async () =>
    await new Promise<void>((done) => {
      releaseFetch = done;
    });
  const hanging = adapter.search('молоко', BUSY);
  let release: () => void = () => {};
  while (releaseFetch === null) {
    await new Promise((done) => void setTimeout(done, 1));
    release = releaseFetch ?? release;
  }
  for (const sap of COLD) await getChizhikSession(sap);
  release();
  releaseFetch = null;
  onFetch = null;
  await hanging;
  // В карте 5 сессий (гонка + четыре холодные). Добираем ещё пять — лимит
  // превышен трижды, и очередь на вытеснение доходит до точки из гонки: она
  // первая по возрасту, а её счётчик после фикса равен нулю.
  const feed = JSON.parse(JSON.stringify(SEARCH)) as Record<string, unknown>;
  for (const sap of ['HD86', 'HD85', 'HD80', 'HD79', 'HD78']) {
    reply = { body: JSON.stringify(feed) };
    await getChizhikSession(sap);
  }
  const before = launches;
  reply = { body: JSON.stringify(feed) };
  await adapter.search('молоко', BUSY);
  assert.equal(
    launches,
    before + 1,
    'точка из гонки вытеснена и её браузер закрыт — при залипшем счётчике занятости она осталась бы в карте навсегда',
  );
  await closeChizhikBrowser();
}

// --- 4a. Режим поиска: не strict — выдача размыта, верить ей нельзя. -------
// Ловушка из опыта с параметром поиска у Магнита: сеть может начать отдавать
// популярное вместо нашего товара, и это молча ушло бы в каталог и историю.
{
  reply = { body: JSON.stringify({ ...SEARCH, query_type: 'fuzzy' }) };
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /режиме «fuzzy»/,
    'размытая выдача пользовательского поиска отвергнута',
  );
  // В карточке это НЕ переименование: иначе breaker отключился бы и история цены
  // молча замолчала.
  const found2 = (await adapter.search('молоко', CTX).catch(() => []))[0];
  assert.equal(found2, undefined, 'базовая выдача strict — основа для карточки');
  reply = { body: JSON.stringify(SEARCH) };
  const target2 = (await adapter.search('молоко', CTX))[0];
  assert.ok(target2, 'товар для карточки есть');
  reply = { body: JSON.stringify({ ...SEARCH, query_type: 'fuzzy' }) };
  const fuzzy = await adapter
    .fetchProduct(target2.canonicalId, { ...CTX, name: 'Молоко АМА МАМА' })
    .then(() => null)
    .catch((err: unknown) => err);
  assert.ok(fuzzy && !isProductLookupError(fuzzy), 'размытая выдача в карточке — не «переименование»');
  // Метка НЕ должна молча пропадать: без неё неизвестно, strict ли поиск, а молча
  // записать цены ЧУЖИХ популярных товаров хуже, чем отказать.
  reply = { body: JSON.stringify({ products: SEARCH.products }) };
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /нет метки query_type/,
    'непустая выдача без query_type — дрейф, а не «метка не нужна»',
  );
// Пустая выдача без метки — честна: искать было нечего, и ругаться не на что.
  reply = { body: JSON.stringify({ products: [] }) };
  assert.deepEqual(await adapter.search('молоко', CTX), [], 'пустая выдача без метки допустима');
  // Тело-не-объект: `JSON.parse('null')` даёт null, и без проверки был бы TypeError
  // вместо внятного «смена ответа сети».
  reply = { body: 'null' };
  await assert.rejects(() => adapter.search('молоко', CTX), /не объект/, 'ответ null — дрейф формата');
  reply = { body: '[]' };
  await assert.rejects(() => adapter.search('молоко', CTX), /не объект/, 'ответ-массив — дрейф формата');
  // У полки метки нет вовсе — полка обязана работать.
  reply = { body: JSON.stringify(CATEGORIES) };
  const catsNoType = await adapter.fetchCategories(CTX);
  assert.ok(catsNoType.length > 0, 'категории без query_type разбираются');
  reply = { body: JSON.stringify(SHELF) };
  const shelfNoType = await adapter.fetchCategoryProducts(catsNoType[0]?.url ?? '', CTX);
  assert.ok(shelfNoType.length > 0, 'полка без query_type разбирается');
}

// --- 4b. Непустой ответ, из которого не осталось ни одного товара. ----------
// Тихая пустая витрина — самый опасный отказ: сеть жива, формат поехал, breaker
// молчит, а пользователь видит пустую полку.
{
  await closeChizhikBrowser();
  reply = { body: JSON.stringify({ ...SEARCH, query_type: 'strict', products: SEARCH.products.map((p) => ({ ...p, plu: 'не-число' })) }) };
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /после разбора не осталось ни одного/,
    'все товары без plu — дрейф формата, а не пустой поиск',
  );
  await closeChizhikBrowser();
}

// --- 5. Отказы сети: 403, 422 и не-JSON говорят разные вещи. -----------------
// 403 и 422 переживают пересборку сессии: сессия рвётся, браузер поднимается заново,
// и только потом ошибка доходит до вызывающего (иначе сеть осталась бы мёртвой до
// перезапуска приложения — процесс живёт сутками).
{
  // Сессию предыдущего блока закрываем ДО обнуления счётчиков: иначе поиск возьмёт
  // кэшированную сессию, и launches не вырастет вовсе — проверка прошла бы вхолостую.
  await closeChizhikBrowser();
  launches = 0;
  reply = { status: 403, body: '<html>403 Forbidden</html>' };
  await assert.rejects(() => adapter.search('молоко', CTX), /HTTP 403/, '403 виден в ошибке');
  assert.ok(launches >= 2, `403: сессия пересобрана (браузеров ${launches})`);
  await closeChizhikBrowser();

  launches = 0;
  reply = { status: 422, body: '{"detail":[{"type":"missing","loc":["query","mode"]}]}' };
  await assert.rejects(() => adapter.search('молоко', CTX), /HTTP 422/, '422 виден, но сессия не рвётся');
  assert.equal(launches, 1, '422 — это наш неверный параметр, а не протухшая сессия');
  await closeChizhikBrowser();

  launches = 0;
  reply = { status: 200, body: '<html>не JSON</html>' };
  await assert.rejects(() => adapter.search('молоко', CTX), /не JSON/, 'HTML вместо JSON — дрейф ответа');
  assert.equal(launches, 1, 'не-JSON сессию не трогает: ответ пришёл, просто не того вида');
  await closeChizhikBrowser();

// Сброс сессии, которой уже нет в карте, ничего не делает: сессию могли выбить
  // конкуренты, и повторный сброс не должен закрывать чужую.
  await closeChizhikBrowser();
  reply = { body: JSON.stringify(SEARCH) };
  await adapter.search('молоко', CTX);
  const closedBefore = closes;
  await adapter.search('молоко', { city: 'novosibirsk', externalStoreId: 'HDJ7' });
  assert.equal(closes, closedBefore, 'в пределах лимита сессии не закрываются');
  await closeChizhikBrowser();

// Отказ не-Error (строка) проходит через транспорт и доходит до вызывающего, а не
  // теряется на `err.message`, и сессию не пересобирает: это не протухшее состояние.
  fetchThrows = 'строка-от-транспорта';
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /строка-от-транспорта/,
    'не-Error не проглатывается молча',
  );
  fetchThrows = null;
  await closeChizhikBrowser();

  // Обрыв соединения лечится пересборкой сессии: первый запрос рвёт сессию, второй
// поднимает новый браузер, и если сеть ожила — ответ приходит.
  launches = 0;
  reply = { body: JSON.stringify(SEARCH) };
  await adapter.search('молоко', CTX);
  assert.equal(launches, 1, 'первый запрос построил сессию');
  fetchThrows = 'NetworkError when attempting to fetch resource.';
  await assert.rejects(() => adapter.search('молоко', CTX), /NetworkError/, 'обрыв дойдёт до вызывающего');
  assert.equal(launches, 2, 'после обрыва сессия пересобрана ровно один раз');
  fetchThrows = null;
  const afterDrop = await adapter.search('молоко', CTX);
  assert.ok(afterDrop.length > 0, 'сеть ожила после обрыва');
  // Третий запуск — это и есть восстановление: сессия, отдавшая обрыв, в кэше не
  // остаётся, поэтому следующий запрос строит свою. Держать в кэше битую нельзя —
  // она не отвечает и пересобиралась бы только на следующем 401/403.
  assert.equal(launches, 3, 'после неудачной пересборки битая сессия не остаётся в кэше');
  // Упавший браузер (Target closed) — тоже пересобирается, а не ждёт перезапуска.
  launches = 0;
  await adapter.search('молоко', CTX);
  fetchThrows = 'Target closed';
  await assert.rejects(() => adapter.search('молоко', CTX), /Target closed/, 'упавший браузер дойдёт до вызывающего');
  assert.equal(launches, 1, 'упавший браузер пересобран один раз');
  fetchThrows = null;
  await closeChizhikBrowser();
}

// --- 6. Антибот-страница: падаем сразу, а не после таймаута запроса. -------
{
  launches = 0;
  titleText = 'Доступ ограничен';
  gotoThrows = null;
  reply = { body: JSON.stringify(SEARCH) };
  await assert.rejects(() => adapter.search('молоко', CTX), /антиботом/, 'антибот опознан по заголовку');
  assert.equal(launches, 2, 'первая попытка и повтор внутри транспорта');
  assert.ok(closes >= 1, 'браузер закрыт, а не оставлен висеть');
  titleText = 'Чижик';
  await closeChizhikBrowser();
}

// --- 6a. Страница магазина отдала 403 или ушла на другой магазин. ---------
// У X5 неизвестный код молча подменяется дефолтным (так же ведёт себя Пятёрка).
// Цены у Чижика общие, но наличие — нет, поэтому подмена точки тихо записала бы
// чужое наличие в историю нашего города. Ловим оба признака.
{
  gotoThrows = null;
  pageTweaks = (page) => {
    page.gotoStatus = 403;
  };
  reply = { body: JSON.stringify(SEARCH) };
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /страница магазина HD87 — HTTP 403/,
    '403 на самой странице магазина — антибот, а не пустая витрина',
  );
  pageTweaks = (page) => {
    page.urlOverride = 'https://app.chizhik.club/shop/ZZZZ';
  };
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /сеть подменила точку/,
    'сеть перебросила браузер на другой магазин — цены пришли бы не оттуда',
  );
  // goto без ответа (null): статуса нет — и это не повод считать страницу битой.
  pageTweaks = (page) => {
    page.gotoReturnsNull = true;
  };
  reply = { body: JSON.stringify(SEARCH) };
  const items = await adapter.search('молоко', CTX);
  assert.ok(items.length > 0, 'без статуса goto сессия всё равно работает');
  pageTweaks = null;
  await closeChizhikBrowser();
}

// --- 7. Ошибка навигации: сессия строится с повтором и не течёт браузером. --
{
  launches = 0;
  closes = 0;
  gotoThrows = new Error('net::ERR_CONNECTION_RESET');
  await assert.rejects(() => getChizhikSession('HD87'), /ERR_CONNECTION_RESET/, 'ошибка goto не проглочена');
  assert.equal(launches, 2, 'повтор попытки есть');
  assert.equal(closes, 2, 'каждая неудачная попытка закрывает свой браузер');
  // Отказ может прийти и не Error: тогда в ошибку педётся текст, а не потеряется.
  gotoThrows = 'plain string failure';
  await assert.rejects(
    () => getChizhikSession('HD87'),
    /plain string failure/,
    'не-Error не проглатывается молча',
  );
  gotoThrows = null;
  await closeChizhikBrowser();
}

// --- 8. Карточка по названию: нашли, переименовали, сеть молчит. ------------
{
  seen.length = 0;
  reply = { body: JSON.stringify(SEARCH) };
  const found = (await adapter.search('молоко', CTX))[0];
  assert.ok(found, 'товар для карточки есть');

  // Полное имя совпадает — одна попытка, plu совпал.
  seen.length = 0;
  reply = { body: JSON.stringify(SEARCH) };
  const card = await adapter.fetchProduct(found.canonicalId, { ...CTX, name: 'Молоко АМА МАМА' });
  assert.equal(card.canonicalId, found.canonicalId, 'карточка того же товара');
  assert.equal(card.price, found.price, 'цена карточки совпала с поиском');
  assert.equal(seen.length, 1, 'короткое имя — один запрос');

  // Товары без plu в выдаче не ломают поиск нашего.
  reply = { body: JSON.stringify({ query_type: 'strict', products: [{ plu: null, name: 'Без plu', prices: { regular: '10' } }, SEARCH.products[0]] }) };
  const withBlank = await adapter.fetchProduct(found.canonicalId, { ...CTX, name: 'Молоко АМА МАМА' });
  assert.equal(withBlank.canonicalId, found.canonicalId, 'товар без plu пропущен, наш найден');

  // Выдача есть, нашего plu нет → переименование (ProductLookupError).
  reply = { body: JSON.stringify({ query_type: 'strict', products: [{ plu: 999, name: 'Другое', prices: { regular: '10' } }] }) };
  const renamed = await adapter
    .fetchProduct(found.canonicalId, { ...CTX, name: 'Молоко АМА МАМА' })
    .then(() => null)
    .catch((err: unknown) => err);
  assert.ok(renamed && isProductLookupError(renamed), 'выдача была, товара нет — переименование');

  // Пустая выдача на всех попытках → обычная ошибка, breaker должен сработать.
  reply = { body: JSON.stringify({ query_type: 'strict', products: [] }) };
  const silent = await adapter
    .fetchProduct(found.canonicalId, { ...CTX, name: 'Молоко АМА МАМА' })
    .then(() => null)
    .catch((err: unknown) => err);
  assert.ok(silent && !isProductLookupError(silent), 'пустая выдача — не переименование');
  assert.match(String((silent as Error).message), /пустую выдачу/, 'сказано, что сеть молчит');

  // То же при products: null — это тоже молчание сети, а не переименование.
  reply = { body: JSON.stringify({ query_type: 'strict', products: null }) };
  const silentNull = await adapter
    .fetchProduct(found.canonicalId, { ...CTX, name: 'Молоко АМА МАМА' })
    .then(() => null)
    .catch((err: unknown) => err);
  assert.ok(
    silentNull && !isProductLookupError(silentNull),
    'products: null не молчание, а дрейф формата: переименование тут быть не может',
  );

  // Длинное имя: лестница длин даёт три попытки, и наш товар находится на одной
// из них — сначала по полному имени, потом по укороченным.
  const longName = `${SEARCH.products[0]?.name ?? ''} ${'до'.repeat(30)}`;
  assert.ok(longName.length > 40, 'имя для лестницы длин действительно длинное');
  seen.length = 0;
  reply = { body: JSON.stringify({ query_type: 'strict', products: [{ plu: 424242, name: 'Похожее', prices: { regular: '10' } }] }) };
  const notFound = await adapter
    .fetchProduct(found.canonicalId, { ...CTX, name: longName })
    .then(() => null)
    .catch((err: unknown) => err);
  assert.ok(notFound && isProductLookupError(notFound), 'длинное имя без нашего plu — переименование');
  assert.equal(seen.length, 3, 'длинное имя проверяется тремя запросами (лестница длин)');
  // Укороченное имя находит товар с первой попытки — запросов ровно столько, сколько нужно.
  seen.length = 0;
  reply = { body: JSON.stringify(SEARCH) };
  await adapter.fetchProduct(found.canonicalId, { ...CTX, name: longName.slice(0, 25) });
  assert.equal(seen.length, 1, 'укороченное имя находит товар сразу');

  // Без имени в базе карточку не ищем вовсе.
  await assert.rejects(
    () => adapter.fetchProduct(found.canonicalId, { ...CTX }),
    /нет названия в базе/,
    'без названия товар не ищется',
  );
  const noName = await adapter
    .fetchProduct(found.canonicalId, { ...CTX })
    .then(() => null)
    .catch((err: unknown) => err);
  assert.ok(noName && isProductLookupError(noName), 'без названия в базе — ProductLookupError с советом найти поиском');

  // Нашли plu, но у него нет цены: это не молчание сети, а наш отказ.
  const target = SEARCH.products[0];
  assert.ok(target, 'первый товар фикстуры есть');
  reply = { body: JSON.stringify({ query_type: 'strict', products: [{ ...target, prices: null }] }) };
  await assert.rejects(
    () => adapter.fetchProduct(`chizhik-${String(target.plu)}`, { ...CTX, name: 'Молоко АМА МАМА' }),
    /без цены или имени/,
    'товар без цены не проходит нормализацию',
  );
  await closeChizhikBrowser();
}

// --- 9. Код магазина: формат, справочник и соответствие городу. -------------
{
  await assert.rejects(() => adapter.search('молоко', { ...CTX, externalStoreId: 'HD-87' }), /bad sap_id/, 'формат кода');
  await assert.rejects(
    () => adapter.search('молоко', { ...CTX, externalStoreId: 'ZZZZ' }),
    /не из нашего справочника/,
    'чужой код не опрашиваем: цены пришли бы не из того города',
  );
  await assert.rejects(() => adapter.search('молоко', { ...CTX, externalStoreId: '' }), /bad sap_id/, 'пустой код');
  // Код из справочника, но ЧУЖОГО города: у сети цены общие, и такая ошибка
  // записала бы цену соседнего города под нашим. Это главная защита, а не формальность.
  reply = { body: JSON.stringify(SEARCH) };
  // Расхождение кода со справочником — наша неверная настройка точки, поэтому
  // StaleStoreError: он не даёт strike и паузу ВСЕЙ сети (сеть-то жива).
  const stale = await adapter
    .search('молоко', { city: 'perm', externalStoreId: 'HD87' })
    .then(() => null)
    .catch((err: unknown) => err);
  assert.ok(stale && isStaleStoreError(stale), 'чужой код города — StaleStoreError, а не отказ сети');
  assert.match(String((stale as Error).message), /цены придут из чужого города/, 'сказано, в чём дело');
  await assert.rejects(
    () => adapter.search('молоко', { city: 'moscow', externalStoreId: 'HDJ7' }),
    isStaleStoreError,
    'и наоборот',
  );
  // Города без сети: сообщение внятное, а не «undefined».
  await assert.rejects(
    () => adapter.search('молоко', { city: 'irkutsk', externalStoreId: 'HD87' }),
    /нет магазина для города/,
    'город без магазина Чижика',
  );
  // Мусор в canonical id — тоже до запроса.
  await assert.rejects(
    () => adapter.fetchProduct('chizhik-abc', { ...CTX, name: 'X' }),
    /не plu/,
    'plu обязателен',
  );
  await closeChizhikBrowser();
}

// --- 10. Категории: обёртка развёрнута, полки живые, чужие адреса отбиты. --
{
  seen.length = 0;
  reply = { body: JSON.stringify(CATEGORIES) };
  const cats = await adapter.fetchCategories(CTX);
  assert.ok(cats.length >= 20, `полок ${cats.length}, а не одна служебная`);
  assert.match(seen[0] ?? '', /categories\?mode=delivery/, 'категории с mode');
  assert.match(seen[0] ?? '', /include_subcategories=1/, 'дерево, а не верхний уровень');
  assert.ok(cats.every((c) => adapter.canHandleCategoryUrl(c.url)), 'каждая полка узнаётся своим адресом');
  assert.equal(adapter.canHandleCategoryUrl('https://app.chizhik.club/shop/HD87'), false, 'адрес магазина — не полка');

  reply = { body: JSON.stringify(SHELF) };
  seen.length = 0;
  const shelf = await adapter.fetchCategoryProducts(cats[0]?.url ?? '', CTX);
  // В живой полке часть товаров приходит с `prices: null` (косметика без цены).
  // Такие в историю не пишутся: цены нет — нечего сравнивать, и без цены товар
  // выглядел бы как «распродан», что врёт.
  const priced = SHELF.products.filter((p) => {
    const prices = p.prices as { regular?: string | null } | null;
    const regular = Number(String(prices?.regular ?? '').replace(',', '.'));
    return prices !== null && Number.isFinite(regular) && regular > 0;
  });
  assert.ok(
    SHELF.products.some((p) => p.prices === null),
    'в фикстуре есть товары без цены — иначе проверка отбрасывания ничего не значит',
  );
  assert.equal(shelf.length, priced.length, 'взяты все товары с ценой, безценные отброшены');
  assert.match(seen[0] ?? '', /categories\/[^/]+\/products\?mode=delivery/, 'товары полки с mode');
  // Полка с products: null — дрейф формата (не «пустая полка»): поле есть, но не
// список товаров. Молчаливый пустой результат здесь убрал бы полку из витрины.
  reply = { body: JSON.stringify({ query_type: 'strict', products: null }) };
  await assert.rejects(
    () => adapter.fetchCategoryProducts(cats[0]?.url ?? '', CTX),
    /смена ответа сети/,
    'products: null на полке — дрейф формата',
  );
  reply = { body: JSON.stringify({ query_type: 'strict', products: [] }) };
  assert.deepEqual(
    await adapter.fetchCategoryProducts(cats[0]?.url ?? '', CTX),
    [],
    'пустой массив на полке — честная пустая полка',
  );
  reply = { body: JSON.stringify(SHELF) };
  // Дрейф формата: поле переехало или сеть обернула ответ. Молчаливый пустой
  // список тут означал бы «витрина пуста», а на деле сеть ответила не тем.
  reply = { body: JSON.stringify({ items: SHELF.products }) };
  await assert.rejects(
    () => adapter.fetchCategoryProducts(cats[0]?.url ?? '', CTX),
    /смена ответа сети/,
    'полка без поля products — дрейф формата, а не пустая витрина',
  );
  reply = { body: JSON.stringify({ products: { 0: SEARCH.products[0] } }) };
  await assert.rejects(
    () => adapter.fetchCategoryProducts(cats[0]?.url ?? '', CTX),
    /не список/,
    'products не массив — дрейф формата',
  );
  // Полка ровно в лимит: пагинации у сети нет, поэтому молчать нельзя.
  reply = {
    body: JSON.stringify({
      products: Array.from({ length: 200 }, (_, i) => ({
        plu: String(900000 + i),
        name: `Товар ${i}`,
        prices: { regular: '10' },
      })),
    }),
  };
  await assert.rejects(
    () => adapter.fetchCategoryProducts(cats[0]?.url ?? '', CTX),
    /пагинации у сети нет/,
    'полка больше лимита сказала вслух, а не потеряла товары молча',
  );
  reply = { body: JSON.stringify(SHELF) };

  await assert.rejects(
    () => adapter.fetchCategoryProducts('https://example.com/catalog/ABC/', CTX),
    /categoryUrl вне каталога/,
    'чужой адрес не опрашивается',
  );

  // Ответ без единой полки: сеть ответила, но каталог наполнить нечем.
  reply = { body: '[]' };
  await assert.rejects(() => adapter.fetchCategories(CTX), /категории пусты/, 'пустой каталог — ошибка');
  reply = { body: JSON.stringify({ categories: 'не массив' }) };
  await assert.rejects(() => adapter.fetchCategories(CTX), /категории пусты/, 'смена формата ответа');
  reply = { body: JSON.stringify([{ id: '', name: '  ' }]) };
  await assert.rejects(() => adapter.fetchCategories(CTX), /категории пусты/, 'мусорные узлы не каталог');
  // Один узел без детей — это полка, а не пустой каталог: разворот обёртки тут ни при чём.
  reply = { body: JSON.stringify([{ id: 'L', name: 'Лист', categories: [] }]) };
  assert.deepEqual(
    (await adapter.fetchCategories(CTX)).map((c) => c.id),
    ['L'],
    'узел без детей остаётся полкой',
  );
  await closeChizhikBrowser();
}

globalThis.fetch = realFetch;
__setPlaywrightForTests(null);
await closeChizhikBrowser();
console.log(
  'chizhik http: ALL GREEN — путь без домена, mode/q в параметрах, кэш сессии, повтор сборки, антибот-страница, отказы 403/422/не-JSON, переименование против молчания сети, полки и чужие адреса',
);