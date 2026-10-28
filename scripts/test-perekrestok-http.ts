// Транспорт и адаптер Перекрёстка без сети: браузер подменён, ответы — живые фикстуры.
//
// Здесь проверяется то, чего не видно на живом прогоне: какой адрес и с каким телом
// уходит POST, что происходит с отказами (401/403, не-JSON, антибот-страница),
// кэшируется ли сессия по sapId, пересобирается ли она и — главное — сверяется ли
// точка по `content.sapId` в ответе. Последнее здесь не формальность: цена
// привязана к магазину, и цена чужой точки в нашей истории врёт незаметно.

import assert from 'node:assert';
import fs from 'node:fs';
import { isProductLookupError, isStaleStoreError } from '../src/core/adapter-errors.js';
import { PerekrestokAdapter } from '../src/core/adapters/perekrestok.js';
import { closePerekrestokBrowser, getPerekrestokSession } from '../src/core/adapters/perekrestok-browser.js';
import { __setPlaywrightForTests } from '../src/core/adapters/playwright-port.js';

const read = (name: string): unknown => JSON.parse(fs.readFileSync(`tests/fixtures/perekrestok/${name}`, 'utf8'));
const FEED = read('feed-moloko.json') as Record<string, unknown>;
const PROMO = read('feed-promo.json') as Record<string, unknown>;
const JUNK = read('feed-empty-junk.json') as Record<string, unknown>;
const SWEETS = read('feed-sweets.json') as Record<string, unknown>;

const CTX = { city: 'moscow', externalStoreId: '2053' };

interface Reply {
  status?: number;
  body?: string;
}
let reply: Reply = { body: JSON.stringify(FEED) };
/** Запросы, реально ушедшие в сеть: URL + заголовки + разобранное тело. */
const seen: { url: string; auth: string; deviceId: string; body: unknown }[] = [];
let launches = 0;
let closes = 0;
let titleText = 'Перекрёсток';
let gotoThrows: Error | string | null = null;
/** goto вернул null (about:blank) — статуса нет, и проверять нечего. */
let gotoReturnsNull = false;
let gotoStatus = 200;
/** Куки отдаёт ли Playwright: пустой массив — токен так и не появится. */
let cookies: unknown[] = [{ name: 'session', value: encodeURIComponent(JSON.stringify({ accessToken: 'TOK' })) }];
let localSpuid: string | null = 'SPUID-1';
/** Сессионная кука приходит битой JSON — ждём следующего круга, а не падаем. */
let sessionRaw: string | null = null;
let fetchThrows: string | null = null;
/**
 * Хук, выполняемый ВНУТРИ очередного fetch. Нужен для детерминированной гонки: окно
 * «сессия занята, а лимит превышен» иначе не поймать никакими таймингами.
 */
let onFetch: (() => Promise<void>) | null = null;

class FakePage {
  async goto(_url: string, _opts?: unknown): Promise<{ status: () => number } | null> {
    if (gotoThrows) throw gotoThrows;
    if (gotoReturnsNull) return null;
    const status = gotoStatus;
    return { status: () => status };
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
  async newContext(_opts?: unknown): Promise<{ newPage: () => Promise<FakePage>; cookies: () => Promise<unknown[]> }> {
    return {
      newPage: async () => new FakePage(),
      cookies: async () => (sessionRaw === null ? cookies : sessionRaw === '' ? [] : [{ name: 'session', value: sessionRaw }]),
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

// --- Подмена браузера: evaluate исполняется в Node, поэтому in-page fetch ---
// --- ходит в глобальный fetch, который мы же и подменили. --------------------
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
const url = typeof input === 'string' ? input : String(input instanceof URL ? input : input.url);
  if (onFetch) {
    const hook = onFetch;
    onFetch = null;
    await hook();
  }
  const headers = (init.headers ?? {}) as Record<string, string>;
  seen.push({
    url,
    auth: headers.auth ?? '',
    deviceId: headers['x-device-id'] ?? '',
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
  });
  if (fetchThrows) throw fetchThrows;
  const status = reply.status ?? 200;
  const body = reply.body ?? '';
  return { ok: status >= 200 && status < 300, status, url, text: async () => body } as unknown as Response;
}) as typeof fetch;

// localStorage внутри evaluate — тоже наш код, поэтому подменяем глобальный объект.
const realLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => (key === '_SPUID' ? localSpuid : null),
};

const adapter = new PerekrestokAdapter();

// --- 1. Поиск: POST, тело, заголовки, нормализация цен из копеек. -------------
{
  seen.length = 0;
  launches = 0;
  reply = { body: JSON.stringify(FEED) };
  const items = await adapter.search('молоко', CTX);
  assert.ok(items.length > 0, 'выдача непустая');
  assert.equal(seen.length, 1, 'один запрос на поиск');
  const call = seen[0];
  assert.ok(call, 'запрос записан');
  assert.equal(call.url, 'https://www.perekrestok.ru/api/customer/1.4.1.0/catalog/product/feed', 'тот самый POST фида');
  assert.equal(call.auth, 'Bearer TOK', 'токен из куки session в заголовке auth');
  assert.equal(call.deviceId, 'SPUID-1', '_SPUID в x-device-id');
  assert.equal((call.body as { page?: unknown }).page, 1, 'page обязателен: без него сеть отдаёт popular');
  assert.equal((call.body as { perPage?: unknown }).perPage, 100, 'perPage = потолок сети: меньше молча обрезало бы выдачу');
  assert.equal((call.body as { filter?: { textQuery?: unknown } }).filter?.textQuery, 'молоко', 'запрос в filter.textQuery');
  // 9799 копеек = 97.99 ₽. Забытый делитель дал бы правдоподобные 9799 ₽,
  // и ни breaker, ни глаз такое не заметили бы.
  assert.equal(items[0]?.price, 97.99, 'цена из копеек');
  assert.ok(items.every((i) => i.storeId === 'perekrestok' && i.city === 'moscow'), 'сеть и город проставлены');
  assert.ok(
    items.every((i) => i.storeCode === '2053'),
    'товар несёт код той точки, о которой просили: две точки сети иначе делят цену',
  );
  assert.ok(items.every((i) => /^perekrestok:\d+$/.test(i.canonicalId)), 'идентичность товара');
  await closePerekrestokBrowser();
}

// --- 2. Акция: price — уже со скидкой, grossPrice — до неё. -----------------
{
  await closePerekrestokBrowser();
  reply = { body: JSON.stringify(PROMO) };
  const promo = await adapter.search('шоколад', CTX);
  const withOld = promo.find((p) => p.oldPrice !== undefined);
  assert.ok(withOld, 'в фикстуре есть товар со скидкой');
  assert.ok((withOld.oldPrice ?? 0) > (withOld.promoPrice ?? 0), 'старая цена выше промо');
  assert.equal(withOld.price, withOld.oldPrice, 'обычная цена — до скидки: иначе история покажет рост на каждой акции');
  await closePerekrestokBrowser();
}

// --- 3. Мусорный запрос: честная пустая выдача, а не popular. ---------------
{
  await closePerekrestokBrowser();
  reply = { body: JSON.stringify(JUNK) };
  assert.deepEqual(await adapter.search('ЁЖ-ИК-ЧЁЖ', CTX), [], 'пустая выдача — не ошибка');
  await closePerekrestokBrowser();
}

// --- 4. Не-strict с товарами: popular-выдаче верить нельзя. -----------------
// Самая опасная ловушка сети: на пустой запрос она отдаёт популярное, и это
// молча ушло бы в каталог и в историю цен.
{
  await closePerekrestokBrowser();
  const popular = JSON.parse(JSON.stringify(FEED)) as { content: { searchType: string } };
  popular.content.searchType = 'popular';
  reply = { body: JSON.stringify(popular) };
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /не строго/,
    'выдача не из нашего поиска отвергнута',
  );
  // В карточке это НЕ переименование: иначе breaker отключился бы.
  const err = await adapter
    .fetchProduct('perekrestok:2059346', { ...CTX, name: 'Молоко АМА МАМА' })
    .then(() => null)
    .catch((e: unknown) => e);
  assert.ok(err && !isProductLookupError(err), 'popular в карточке — не «переименование»');
  // Пустая popular-выдача терпима: искать было нечего, и ругаться не на что.
  const emptyPopular = JSON.parse(JSON.stringify(JUNK)) as { content: { searchType: string } };
  emptyPopular.content.searchType = 'popular';
  reply = { body: JSON.stringify(emptyPopular) };
  assert.deepEqual(await adapter.search('ЁЖ', CTX), [], 'пустая нестрогая выдача допустима');
  await closePerekrestokBrowser();
}

// --- 4a. Дрейф формата: ответ не объект, метки нет. -------------------------
{
  reply = { body: 'null' };
  await assert.rejects(() => adapter.search('молоко', CTX), /не объект/, 'ответ null — дрейф формата');
  reply = { body: '[]' };
  await assert.rejects(() => adapter.search('молоко', CTX), /не объект/, 'ответ-массив — дрейф формата');
  // Непустая выдача без метки strict: молча записать цены ЧУЖИХ популярных
  // товаров хуже, чем отказать.
  reply = { body: JSON.stringify({ content: { items: FEED.content ? JSON.parse(JSON.stringify(FEED)).content.items : [] } }) };
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /не строго/,
    'непустая выдача без searchType — дрейф, а не «метка не нужна»',
  );
  await closePerekrestokBrowser();
}

// --- 5. Главная сверка: sapId из ответа против нашего справочника. ----------
// Если сеть отдаст цены другой точки, они молча уедут в историю нашего города.
{
  await closePerekrestokBrowser();
  const foreign = JSON.parse(JSON.stringify(FEED)) as { content: { sapId: string } };
  foreign.content.sapId = '4099';
  reply = { body: JSON.stringify(foreign) };
  const stale = await adapter
    .search('молоко', CTX)
    .then(() => null)
    .catch((e: unknown) => e);
  assert.ok(stale && isStaleStoreError(stale), 'чужая точка — StaleStoreError, а не отказ сети');
  assert.match(String((stale as Error).message), /4099/, 'сказано, чья тория пришла');
  await closePerekrestokBrowser();

  // Ответ без sapId: сверять нечем, а сеть отдаёт его всегда. Молча пропустить
  // проверку значило бы записать в историю цены неизвестно чьей точки.
  const noSap = JSON.parse(JSON.stringify(FEED)) as { content: { sapId?: unknown } };
  delete noSap.content.sapId;
  reply = { body: JSON.stringify(noSap) };
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /нет sapId/,
    'ответ без sapId — дрейф формата, а не «нечем проверять»',
  );
  await closePerekrestokBrowser();

  // И наоборот: наш код, но чужая точка в справочнике — тот же отказ.
  reply = { body: JSON.stringify(FEED) };
  await assert.rejects(
    () => adapter.search('молоко', { city: 'moscow', externalStoreId: '4099' }),
    isStaleStoreError,
    'код точки из справочника не совпал с ответом сети',
  );
  await closePerekrestokBrowser();
}

// --- 6. Сессия кэшируется по sapId, лишние точки вытесняются. ---------------
{
  launches = 0;
  closes = 0;
  reply = { body: JSON.stringify(FEED) };
  await adapter.search('молоко', CTX);
  await adapter.search('молоко', CTX);
  assert.equal(launches, 1, 'браузер поднят один раз на два запроса');
  await closePerekrestokBrowser();

  launches = 0;
  closes = 0;
  reply = { body: JSON.stringify(FEED) };
  await adapter.search('молоко', CTX);
  // Вторая точка отвечает своим sapId — иначе сверка справедливо ругается.
  const feedOther = JSON.parse(JSON.stringify(FEED)) as { content: { sapId: string } };
  feedOther.content.sapId = '4099';
  reply = { body: JSON.stringify(feedOther) };
  await adapter.search('молоко', { city: 'moscow', externalStoreId: '4099' });
  assert.equal(launches, 2, 'две точки — две сессии');
  assert.equal(closes, 0, 'в пределах лимита никто не закрывается');
  await closePerekrestokBrowser();
}

// --- 7. Параллельные запросы не поднимают второй браузер. -------------------
{
  launches = 0;
  closes = 0;
  reply = { body: JSON.stringify(FEED) };
  const both = await Promise.all([adapter.search('молоко', CTX), adapter.search('молоко', CTX)]);
  assert.ok(both[0]?.length && both[1]?.length, 'оба параллельных запроса получили товары');
  assert.equal(launches, 1, 'на два одновременных запроса — одна сессия');
  assert.equal(closes, 0, 'сессию на оба запроса не закрывали');
  await closePerekrestokBrowser();
}

// --- 7a. Параллельные запросы к ОДНОЙ точке: счётчик занятости схлопывается. -
// Регрессия: `release` писал в счётчик запомненное число вместо текущего. При
// параллельных запросах к одной точке первый освободивший уже не «помнит» своё
// значение, и счётчик залипал на 1 навсегда — точка становилась невытесняемой, и
// её Firefox висел до конца процесса.
//
// Утверждение здесь обратное привычному. Залипший счётчик держит точку в карте
// как раз слишком хорошо: проверка «осталась ли она в кэше» выполнялась бы тем
// успешнее, чем глубже баг (так и вышло в первой версии этого теста, где он
// зелёный был и на сломанном коде). Проверяем поэтому вытесняемость: когда
// лимит превышен, а занятость схлопнулась в ноль, точку обязаны вытеснить и её
// браузер закрыть. При залипшем счётчике она не вытесняется никогда.
{
  await closePerekrestokBrowser();
  launches = 0;
  closes = 0;
  const feedFor = (sap: string): string => {
    const clone = JSON.parse(JSON.stringify(FEED)) as { content: { sapId: string } };
    clone.content.sapId = sap;
    return JSON.stringify(clone);
  };
  const BUSY_SAP = '2053';
  const WARM = ['9201', '9202', '9203', '9204'];
  onFetch = async () => {
    for (const sap of WARM) await getPerekrestokSession(sap);
  };
  reply = { body: feedFor(BUSY_SAP) };
  await Promise.all([adapter.search('молоко', CTX), adapter.search('молоко', CTX)]);
  onFetch = null;
  // В карте было 5 сессий (гонка + четыре тёплые). Добираем ещё пять — лимит
  // превышен трижды, и очередь на вытеснение доходит до точки из гонки: она
  // первая по возрасту, а её счётчик после фикса равен нулю.
  for (const sap of ['9205', '9206', '9207', '9208', '9209']) {
    reply = { body: feedFor(sap) };
    await adapter.search('молоко', { city: 'moscow', externalStoreId: sap });
  }
  // Косвенный, но однозначный признак вытеснения: браузер гонки закрыт, поэтому
  // повторный запрос к этой точке поднимает Firefox заново.
  const before = launches;
  reply = { body: feedFor(BUSY_SAP) };
  await adapter.search('молоко', CTX);
  assert.equal(
    launches,
    before + 1,
    'точка из гонки вытеснена и её браузер закрыт — при залипшем счётчике занятости она осталась бы в карте навсегда',
  );
await closePerekrestokBrowser();
}

// --- 7b. Вытеснение при занятых и «холодных» сессиях. ----------------------
// Занятую точку вытеснять нельзя: закрытие страницы роняет чужой запрос в
// «Target closed» — восстановимый отказ ценой в полную пересборку. И сессию,
// построенную напрямую (без запроса), вытеснять можно: она ничего не ждёт.
{
  await closePerekrestokBrowser();
  launches = 0;
  closes = 0;
  const BUSY_SAP = '2053';
  // Висим на запросе: он держит точку занятой, пока мы гоняем лимит. Так гонку
  // не надо ловить таймингами — занятость держится ровно до `release()`.
  let releaseFetch: (() => void) | null = null;
  onFetch = async () =>
    await new Promise<void>((done) => {
      releaseFetch = done;
    });
  reply = { body: JSON.stringify(FEED) };
  const hanging = adapter.search('молоко', CTX);
  // Цикл ждёт, пока хук внутри fetch отдаст «отписку». Тип сужаем явно: без
  // проверки TypeScript не знает, что переменная уже не null (присваивание
  // происходит в колбэке, и он для анализатора — чужой код).
  let release: () => void = () => {};
  while (releaseFetch === null) {
    await new Promise((done) => void setTimeout(done, 1));
    release = releaseFetch ?? release;
  }
  // Четыре точки строим напрямую: запросов они не делают, поэтому в карте лежат
  // БЕЗ отметки занятости — ровно тот случай, когда вытеснение обязано их
  // закрыть. Коды берём неиспользованные выше: счётчик занятости живёт в модуле
  // между блоками, и «холодная» точка с уже заведённой записью была бы не той
  // проверкой, которую мы здесь делаем.
  const COLD = ['9101', '9102', '9103', '9104'];
  for (const sap of COLD) await getPerekrestokSession(sap);
  const closesBefore = closes;
  await getPerekrestokSession('9105');
  assert.equal(closes, closesBefore + 1, 'вытеснилась незанятая сессия, а не та, что под запросом');
  release();
  releaseFetch = null;
  onFetch = null;
  const items = await hanging;
  assert.ok(items.length > 0, 'зависший запрос дошёл до ответа после всех вытеснений');
  await closePerekrestokBrowser();
}

// --- 8. Отказы: 401/403 лечатся пересборкой, 400 и не-JSON — нет. -----------
{
  await closePerekrestokBrowser();
  launches = 0;
  reply = { status: 401, body: '{"error":"unauthorized"}' };
  await assert.rejects(() => adapter.search('молоко', CTX), /HTTP 401/, '401 виден в ошибке');
  assert.ok(launches >= 2, `401: сессия пересобрана (браузеров ${launches})`);
  await closePerekrestokBrowser();

  await closePerekrestokBrowser();
  launches = 0;
  reply = { status: 403, body: '<html>403</html>' };
  await assert.rejects(() => adapter.search('молоко', CTX), /HTTP 403/, '403 виден в ошибке');
  assert.ok(launches >= 2, `403: сессия пересобрана (браузеров ${launches})`);
  await closePerekrestokBrowser();

  // 400 — наш неверный параметр (например, perPage больше 100), а не протухшая
  // сессия: рвать браузер на каждом таком отказе дорого.
  await closePerekrestokBrowser();
  launches = 0;
  reply = { status: 400, body: '{"detail":"perPage too large"}' };
  await assert.rejects(() => adapter.search('молоко', CTX), /HTTP 400/, '400 виден в ошибке');
  assert.equal(launches, 1, '400 — это наш неверный параметр, а не протухшая сессия');
  await closePerekrestokBrowser();

  await closePerekrestokBrowser();
  launches = 0;
  reply = { status: 200, body: '<html>не JSON</html>' };
  await assert.rejects(() => adapter.search('молоко', CTX), /не JSON/, 'HTML вместо JSON — дрейф ответа');
  assert.equal(launches, 1, 'не-JSON сессию не трогает: ответ пришёл, просто не того вида');
  await closePerekrestokBrowser();

  // Отказ не-Error (строка) не теряется на `err.message` и сессию не пересобирает.
  await closePerekrestokBrowser();
  fetchThrows = 'строка-от-транспорта';
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /строка-от-транспорта/,
    'не-Error не проглатывается молча',
  );
  fetchThrows = null;
  await closePerekrestokBrowser();

  // Обрыв соединения лечится пересборкой: первый запрос рвёт сессию, второй
  // поднимает новый браузер, и если сеть ожила — ответ приходит.
  await closePerekrestokBrowser();
  launches = 0;
  reply = { body: JSON.stringify(FEED) };
  await adapter.search('молоко', CTX);
  assert.equal(launches, 1, 'первый запрос построил сессию');
  fetchThrows = 'NetworkError when attempting to fetch resource.';
  await assert.rejects(() => adapter.search('молоко', CTX), /NetworkError/, 'обрыв дойдёт до вызывающего');
  assert.equal(launches, 2, 'после обрыва сессия пересобрана ровно один раз');
  fetchThrows = null;
  const afterDrop = await adapter.search('молоко', CTX);
  assert.ok(afterDrop.length > 0, 'сеть ожила после обрыва');
  assert.equal(launches, 3, 'битая сессия в кэше не остаётся');
  await closePerekrestokBrowser();
}

// --- 9. Антибот-страница: падаем сразу, а не после таймаута запроса. ---------
{
  await closePerekrestokBrowser();
  launches = 0;
  closes = 0;
  titleText = 'Доступ ограничен';
  reply = { body: JSON.stringify(FEED) };
  await assert.rejects(() => adapter.search('молоко', CTX), /антибот-страница|антибот/, 'антибот опознан по заголовку');
  assert.equal(launches, 2, 'первая попытка и повтор внутри транспорта');
  assert.ok(closes >= 1, 'браузер закрыт, а не оставлен висеть');
  titleText = 'Перекрёсток';
  await closePerekrestokBrowser();
}

// --- 10. Сессия без токена: ждём и сдаёмся внятно, а не молча едем в 401. ----
{
  await closePerekrestokBrowser();
  // Куки есть, но нужной среди них нет: сайт ещё не дописал `session`.
  // Такой прогон — норма, а не поломка, поэтому ждём и падаем внятно.
  cookies = [{ name: 'spjs', value: 'x' }];
  localSpuid = null;
  gotoThrows = null;
  reply = { body: JSON.stringify(FEED) };
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /не выдал токен/,
    'куки без session — внятная ошибка, а не запрос без заголовков',
  );

  cookies = [{ name: 'session', value: encodeURIComponent(JSON.stringify({ accessToken: 'TOK' })) }];
  localSpuid = 'SPUID-1';
  gotoThrows = 'ERR_NAVIGATION';
  await assert.rejects(
    () => getPerekrestokSession('2053'),
    /ERR_NAVIGATION/,
    'ошибка навигации не проглочена даже при готовых куках',
  );
  gotoThrows = null;
  await closePerekrestokBrowser();
}

// --- 11. Куки и _SPUID появляются не сразу: ждём и сдаёмся внятно. ----------
// Кука `session` и `_SPUID` ставятся сайтом асинхронно после загрузки, поэтому
// первый круг читает пустоту. Если бы мы падали на первой пустой проверке, живой
// прогон ловил бы отказ там, где сеть просто не успела.
{
  await closePerekrestokBrowser();
  sessionRaw = 'не-json';
  localSpuid = null;
  reply = { body: JSON.stringify(FEED) };
  // Каждый круг читает битую куку и пустой _SPUID и ждёт: без таймаута это 30 секунд
  // ожидания — ровно то поведение, которое мы и проверяем (ошибка про токен, а не
  // исключение парсинга).
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /не выдал токен/,
    'битая кука и пустой _SPUID — внятная ошибка, а не исключение парсинга',
  );
  // Теперь кука целая, а _SPUID ещё не появился: ждать умеем и на этом тоже.
  sessionRaw = null;
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /не выдал токен/,
    'валидная кука без _SPUID — тоже ждём, а не едем в запрос без заголовка',
  );
  localSpuid = 'SPUID-1';
  const recovered = await adapter.search('молоко', CTX);
  assert.ok(recovered.length > 0, 'после появления обоих значений сессия работает');
  await closePerekrestokBrowser();
}

// --- 12. goto без ответа (null) и HTTP-ошибка на самой странице. -----------
{
  await closePerekrestokBrowser();
  gotoReturnsNull = true;
  reply = { body: JSON.stringify(FEED) };
  const items = await adapter.search('молоко', CTX);
  assert.ok(items.length > 0, 'без статуса goto сессия всё равно работает');
  gotoReturnsNull = false;

  // Сессию закрываем: иначе поиск возьмёт её из кэша и до goto не дойдёт.
  await closePerekrestokBrowser();
  gotoStatus = 503;
  await assert.rejects(
    () => adapter.search('молоко', CTX),
    /HTTP 503/,
    '503 на самой странице каталога — сеть недоступна, а не пустая витрина',
  );
  gotoStatus = 200;
  await closePerekrestokBrowser();
}

// --- 13. Карточка по названию: нашли, переименовали, сеть молчит. -----------
{
  await closePerekrestokBrowser();
  seen.length = 0;
  reply = { body: JSON.stringify(FEED) };
  const found = (await adapter.search('молоко', CTX))[0];
  assert.ok(found, 'товар для карточки есть');

  seen.length = 0;
  const card = await adapter.fetchProduct(found.canonicalId, { ...CTX, name: 'Молоко АМА МАМА' });
  assert.equal(card.canonicalId, found.canonicalId, 'карточка того же товара');
  assert.equal(card.price, found.price, 'цена карточки совпала с поиском');
  assert.equal(seen.length, 1, 'короткое имя — один запрос');

  // Выдача есть, нашего plu нет → переименование (ProductLookupError).
  reply = { body: JSON.stringify(SWEETS) };
  const renamed = await adapter
    .fetchProduct(found.canonicalId, { ...CTX, name: 'Молоко АМА МАМА' })
    .then(() => null)
    .catch((e: unknown) => e);
  assert.ok(renamed && isProductLookupError(renamed), 'выдача была, товара нет — переименование');

  // Пустая выдача на всех попытках → обычная ошибка, breaker должен сработать.
  reply = { body: JSON.stringify(JUNK) };
  const silent = await adapter
    .fetchProduct(found.canonicalId, { ...CTX, name: 'Молоко АМА МАМА' })
    .then(() => null)
    .catch((e: unknown) => e);
  assert.ok(silent && !isProductLookupError(silent), 'пустая выдача — не переименование');
  assert.match(String((silent as Error).message), /пустую выдачу/, 'сказано, что сеть молчит');

  // Без имени в базе карточку не ищем вовсе.
  const noName = await adapter
    .fetchProduct(found.canonicalId, CTX)
    .then(() => null)
    .catch((e: unknown) => e);
  assert.ok(noName && isProductLookupError(noName), 'без названия — ProductLookupError с советом найти поиском');

// Мусор в canonical id — до запроса.
  await assert.rejects(
    () => adapter.fetchProduct('perekrestok-abc', { ...CTX, name: 'X' }),
    /не наш ключ товара/,
    'ключ должен быть наш',
  );
  // Ключ наш, а кода в нём нет: искать нечего, и молча искать по имени «» значило
  // бы разослать пустые запросы в сеть.
  await assert.rejects(
    () => adapter.fetchProduct('perekrestok:', { ...CTX, name: 'X' }),
    /нет кода/,
    'пустой код товара отвергнут',
  );
  await closePerekrestokBrowser();
}

// --- 14. Лестница длин имени: длинное имя проверяется тремя запросами. ------
{
  await closePerekrestokBrowser();
  reply = { body: JSON.stringify(FEED) };
  const found = (await adapter.search('молоко', CTX))[0];
  const longName = `${found?.name ?? 'Молоко'} ${'до'.repeat(30)}`;
  assert.ok(longName.length > 40, 'имя для лестницы длин действительно длинное');
  seen.length = 0;
  reply = { body: JSON.stringify(SWEETS) };
  const notFound = await adapter
    .fetchProduct('perekrestok:2059346', { ...CTX, name: longName })
    .then(() => null)
    .catch((e: unknown) => e);
  assert.ok(notFound && isProductLookupError(notFound), 'длинное имя без нашего plu — переименование');
  assert.equal(seen.length, 3, 'лестница длин: полное, 40 и 25 символов');
  await closePerekrestokBrowser();
}

// --- 15. Код точки: формат. -------------------------------------------------
{
  await closePerekrestokBrowser();
  reply = { body: JSON.stringify(FEED) };
  await assert.rejects(
    () => adapter.search('молоко', { ...CTX, externalStoreId: '../evil' }),
    /не похож на sapId/,
    'код точки — цифры, в адрес он не подставляется',
  );
  await assert.rejects(
    () => adapter.search('молоко', { ...CTX, externalStoreId: '' }),
    /не похож на sapId/,
    'пустой код',
  );
  // Пустой запрос не ходит в сеть вовсе.
  seen.length = 0;
  assert.deepEqual(await adapter.search('   ', CTX), [], 'пустой запрос — пустота без запроса');
  assert.equal(seen.length, 0, 'пустой запрос в сеть не уходит');
  await closePerekrestokBrowser();
}

// --- 6a. Лимит сессий: Firefox не копятся, лишние закрываются. ------------
// Прогон идёт по товарам без сортировки по городу, то есть точки чередуются.
// При одной сессии на всё каждый переход к чужой точке поднимал бы Firefox
// заново. Держим пять, остальные вытесняем.
{
  await closePerekrestokBrowser();
  launches = 0;
  closes = 0;
  // Ответ должен совпадать с точкой, иначе сверка справедливо ругается: сеть
  // ответила sapId той точки, которую и спросили.
  const feedFor = (sap: string): string => {
    const clone = JSON.parse(JSON.stringify(FEED)) as { content: { sapId: string } };
    clone.content.sapId = sap;
    return JSON.stringify(clone);
  };
  const CITIES = ['2053', '4099', '4100', '4101', '4102', '4103', '4104'];
  for (const sap of CITIES) {
    reply = { body: feedFor(sap) };
    await adapter.search('молоко', { city: 'moscow', externalStoreId: sap });
  }
  assert.equal(launches, CITIES.length, 'каждая точка — свой браузер');
  assert.equal(closes, CITIES.length - 5, 'лишние сессии закрыты, а не забыты');
  // Возврат к первой точке поднимает браузер заново: её вытеснили, и это честно —
  // держать семь Firefox ради одной точки дороже, чем лишний прогрев.
  reply = { body: feedFor('2053') };
  await adapter.search('молоко', CTX);
  assert.equal(launches, CITIES.length + 1, 'вытесненная точка строится заново');
  // LRU: недавно использованная точка остаётся в кэше.
  const beforeWarm = launches;
  reply = { body: feedFor('4104') };
  await adapter.search('молоко', { city: 'moscow', externalStoreId: '4104' });
  assert.equal(launches, beforeWarm, 'недавно использованная точка в кэше');
  await closePerekrestokBrowser();
}

// --- 6b. Занятую сессию не вытесняем. ---------------------------------------
// Вытеснение закрывает страницу, а параллельный запрос по ней падает в
// «Target closed» — восстановимый отказ с полной пересборкой браузера. То есть
// вместо одной лишней сессии получаем каскад. Занятую точку оставляем.
{
  await closePerekrestokBrowser();
  launches = 0;
  closes = 0;
  const feedFor = (sap: string): string => {
    const clone = JSON.parse(JSON.stringify(FEED)) as { content: { sapId: string } };
    clone.content.sapId = sap;
    return JSON.stringify(clone);
  };
  const COLD = '2053';
  const WARM = ['4099', '4100', '4101', '4102'];
  // Пока идёт запрос по «холодной» точке, хук занимает карту ещё четырьмя
  // сессиями — теперь COLD занята в момент, когда придёт шестая точка и упрётся
  // в лимит. Через `search` тут звать нельзя: он встал бы в ту же очередь и ждал
  // бы сам себя, поэтому сессии строим напрямую (запросов они не делают).
  onFetch = async () => {
    for (const sap of WARM) await getPerekrestokSession(sap);
  };
  reply = { body: feedFor(COLD) };
  await adapter.search('молоко', CTX);
  onFetch = null;
  const closesWhileBusy = closes;
  reply = { body: feedFor('4103') };
  await adapter.search('молоко', { city: 'moscow', externalStoreId: '4103' });
  assert.equal(closes, closesWhileBusy + 1, 'вытеснилась свободная сессия, а не занятая');
  await closePerekrestokBrowser();
}

globalThis.fetch = realFetch;
__setPlaywrightForTests(null);
await closePerekrestokBrowser();
console.log(
  'perekrestok http: ALL GREEN — POST-фид, токен из session и _SPUID, цена из копеек, промо как price/grossPrice, сверка sapId, popular-ловушка, кэш сессии по точке, пересборка на 401/403 и обрыве, 400 и не-JSON сессию не рвут, карточка и лестница длин',
);