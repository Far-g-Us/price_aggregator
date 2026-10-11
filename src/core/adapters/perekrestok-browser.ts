// Браузерный транспорт Перекрёстка.
//
// Почему браузер, а не fetch (проверено живьём 2026-10-10): тот же адрес из
// контекста страницы отдаёт 200 с товарами, а обычным `fetch` — 401, даже с
// правильным токеном и всеми заголовками. Это тот же класс, что у Пятёрки и
// Чижика, и обходится ровно тем же способом: мы сидим на настоящей странице
// сайта и спрашиваем из неё, ничего не подменяя.
//
// Отличия от `chizhik-browser.ts`, и каждое — по измеренной причине:
//
// 1. **POST с телом.** Каталог отдаёт товары только через
//    `POST /catalog/product/feed` с JSON-телом; `inPageGet` оттуда не годится.
// 2. **Токен — из куки `session`, не из localStorage.** Кука ставится самим
//    сайтом при загрузке, лежит в ней JSON с полем `accessToken`. Заголовки
//    `auth: Bearer` и `x-device-id` нужны на каждом запросе, и без них сеть
//    отвечает 401 даже из своего же контекста.
// 3. **Прогрев — poll по куке, а не сон.** Кука `session` и `_SPUID` ставятся
//    асинхронно; фиксированная пауза угадывала бы и промахивалась бы — тогда
//    каждый запрос уходил бы в 401.
// 4. **Идентичность точки сверяет адаптер, а не транспорт:** в ответе есть
//    `content.sapId`, и это единственное, что можно сверить.

import { readEnvFlag } from '../platform.js';
import { injectedPlaywright } from './playwright-port.js';

const WEB = 'https://www.perekrestok.ru';
const CATALOG = `${WEB}/catalog/`;
const API = `${WEB}/api/customer/1.4.1.0`;
const TIMEOUT_MS = 60_000;
/**
 * Пауза между запросами. Очередь и счётчик времени МОДУЛЬНЫЕ, то есть пауза
 * общая на все точки сразу: при пяти одновременно открытых Firefox у сети это и
 * выглядит как один клиент, а не как пять.
 */
const GAP_MS = 2000;
/** Пауза перед пересборкой сессии после отказа. */
const BACKOFF_MS = 5000;
/** Сколько попыток на сборку сессии: первая может попасть в антибот. */
const SESSION_ATTEMPTS = 2;
/** Сколько секунд ждём токен и `_SPUID`: куки ставятся сайтом уже после загрузки. */
const CREDENTIAL_ATTEMPTS = 30;

async function importPlaywright(): Promise<typeof import('playwright')> {
  const injected = injectedPlaywright();
  if (injected) return injected;
  /* c8 ignore start — в тестах порт подставляет Playwright всегда, а ветка
     битой установки тестом не воспроизводится (как в 5ka-browser и chizhik). */
  try {
    return await import('playwright');
  } catch {
    throw new Error(
      'perekrestok: не удалось загрузить playwright из сборки — приложение установлено повреждённо, переустанови его.',
    );
  }
  /* c8 ignore stop */
}

/** Антибот-заголовок вместо нормальной страницы: каталог сети не откроется. */
function assertBlockPage(title: string): void {
  const t = title.toLowerCase();
  if (t.includes('доступ ограничен') || t.includes('access denied') || t.includes('captcha') || t.includes('robot')) {
    throw new Error(`perekrestok: вместо каталога отдана антибот-страница «${title.slice(0, 60)}»`);
  }
}

export interface PerekrestokSession {
  /** Код точки, к которой относятся цены (из справочника или ответа). */
  sapId: string;
  /** POST с JSON-телом из контекста страницы, с разобранным ответом. */
  post<T>(path: string, body: unknown): Promise<T>;
  close(): Promise<void>;
}

/**
 * Сессии по точкам. Опрос идёт по товарам без сортировки по городу, города
 * чередуются; одна сессия на всё значила бы перезапуск Firefox на КАЖДЫЙ товар.
 */
/** Счётчик занятости точки. Объект, а не число, — счётчиком владеем мы сами. */
interface Hold {
  count: number;
}

const MAX_SESSIONS = 5;
const sessions = new Map<string, PerekrestokSession>();
const busy = new Map<string, Hold>();
const building = new Map<string, Promise<PerekrestokSession>>();

/** Занятость точки: счётчик создаётся при первом обращении. */
function holdOf(sapId: string): Hold {
  const found = busy.get(sapId);
  if (found !== undefined) return found;
  const made: Hold = { count: 0 };
  busy.set(sapId, made);
  return made;
}

/** Точка занята прямо сейчас? Отсутствие записи — это «не занята». */
function isBusy(sapId: string): boolean {
  return (busy.get(sapId)?.count ?? 0) > 0;
}

interface Credentials {
  auth: string;
  deviceId: string;
}

/**
 * Токен и идентификатор устройства из живого состояния страницы.
 *
* `session` — JSON в куке, `accessToken` лежит в нём; `_SPUID` — в
 * localStorage. Пока их нет, запросы уходят в 401, поэтому ждём по-настоящему,
 * а не фиксированное время.
 *
 * Ждём ПОПЫТКАМИ, а не до системной даты: пауза между попытками и так равна
 * секунде, а отсчёт по `Date.now()` превращал проверку отказа в тридцать секунд
 * реального ожидания — медленно и в тестах, и в приложении.
 */
async function readCredentials(context: import('playwright').BrowserContext, page: import('playwright').Page): Promise<Credentials> {
  for (let attempt = 0; attempt < CREDENTIAL_ATTEMPTS; attempt += 1) {
    const session = (await context.cookies()).find((c) => c.name === 'session')?.value ?? '';
    const deviceId = (await page.evaluate(() => globalThis.localStorage?.getItem('_SPUID') ?? null)) ?? '';
    let token = '';
    if (session !== '') {
      try {
        const parsed = JSON.parse(decodeURIComponent(session)) as { accessToken?: unknown };
        if (typeof parsed.accessToken === 'string') token = parsed.accessToken;
      } catch {
        // Кука ещё не дописана: подождём следующий круг.
      }
    }
    if (token !== '' && deviceId !== '') return { auth: `Bearer ${token}`, deviceId };
    await page.waitForTimeout(1000);
  }
  throw new Error(
    `perekrestok: сайт не выдал токен и _SPUID за ${CREDENTIAL_ATTEMPTS} с — каталог недоступен`,
  );
}

/** POST из контекста страницы с потолком времени: без него зависшая сеть — вечный спиннер. */
async function inPagePost(
  page: import('playwright').Page,
  path: string,
  body: unknown,
  creds: Credentials,
): Promise<{ status: number; body: string }> {
  return page.evaluate(
    async (target: { url: string; body: string; auth: string; deviceId: string; timeout: number }) => {
      const res = await fetch(target.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          auth: target.auth,
          'x-device-id': target.deviceId,
        },
        body: target.body,
        credentials: 'include',
        signal: AbortSignal.timeout(target.timeout),
      });
      return { status: res.status, body: await res.text() };
    },
    { url: `${API}${path}`, body: JSON.stringify(body), auth: creds.auth, deviceId: creds.deviceId, timeout: TIMEOUT_MS },
  );
}

/** Один POST из сессии: с очередью и паузой между запросами. */
let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function inSessionPost<T>(
  page: import('playwright').Page,
  creds: Credentials,
  path: string,
  body: unknown,
): Promise<T> {
  const run = queue.then(async () => {
    const since = Date.now() - lastRequestAt;
    if (lastRequestAt > 0 && since < GAP_MS) {
      await new Promise((done) => void setTimeout(done, GAP_MS - since));
    }
    const out = await inPagePost(page, path, body, creds);
    lastRequestAt = Date.now();
    if (out.status !== 200) {
      throw new Error(`perekrestok: ${path.slice(0, 60)} — HTTP ${out.status}: ${out.body.slice(0, 90)}`);
    }
    try {
      return JSON.parse(out.body) as T;
    } catch {
      throw new Error(`perekrestok: ${path.slice(0, 60)} — не JSON (${out.body.slice(0, 60)})`);
    }
  });
  queue = run.catch(() => {});
  return run;
}

async function buildSession(sapId: string): Promise<PerekrestokSession> {
  const pw = await importPlaywright();
  const headless = readEnvFlag('PEREKRESTOK_HEADFUL') !== '1';
  const browser = await pw.firefox.launch({ headless });
  try {
    const context = await browser.newContext({ locale: 'ru-RU' });
    const page = await context.newPage();
    const response = await page.goto(CATALOG, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    const status = response?.status() ?? 0;
    if (status !== 0 && status >= 400) {
      throw new Error(`perekrestok: каталог — HTTP ${status} (антибот или сеть недоступна)`);
    }
    assertBlockPage(await page.title());
    const creds = await readCredentials(context, page);
    return {
      sapId,
      // close() закрывает браузер и ничего не трогает в модуле: вызывающий сам
      // решает, что стало прошлой сессией, иначе закрытие старой стёрло бы новую.
      close: async () => {
        await browser.close().catch(() => {});
      },
      post: <T>(path: string, body: unknown): Promise<T> => inSessionPost<T>(page, creds, path, body),
    };
  } catch (err) {
    // Сессия не опубликована, а браузер уже поднят: без закрытия он висит до
    // конца процесса.
    await browser.close().catch(() => {});
    throw err;
  }
}

async function buildWithRetry(sapId: string): Promise<PerekrestokSession> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SESSION_ATTEMPTS; attempt += 1) {
    try {
      return await buildSession(sapId);
    } catch (err) {
      lastError = err;
      if (attempt < SESSION_ATTEMPTS) await new Promise((done) => void setTimeout(done, BACKOFF_MS));
    }
  }
  // Отказ может прийти и не Error (например, строкой из транспорта). Тогда текст
  // надо сохранить: обезличенное «сессия не построилась» стоило бы нам сообщения
  // о настоящей причине — обычно это конкретная ошибка навигации.
  throw lastError instanceof Error ? lastError : new Error(`perekrestok: сессия ${sapId} не построилась: ${String(lastError)}`);
}

/**
 * Сессия точки: из карты, иначе строим. Параллельные вызовы дедуплицируются —
 * без этого два одинаковых запроса подняли бы два Firefox.
 */
export async function getPerekrestokSession(sapId: string): Promise<PerekrestokSession> {
  const cached = sessions.get(sapId);
  if (cached !== undefined) {
    // Попадание в кэш продвигает точку в конец карты: порядок вытеснения
    // становится LRU, и неиспользуемая точка уходит первой.
    sessions.delete(sapId);
    sessions.set(sapId, cached);
    return cached;
  }
  const pending = building.get(sapId);
  if (pending !== undefined) return pending;

  const promise = buildWithRetry(sapId);
  building.set(sapId, promise);
  try {
    const session = await promise;
    if (building.get(sapId) === promise) building.delete(sapId);
    sessions.set(sapId, session);
// Лишние точки закрываем: занятые пропускаем — закрытие страницы роняет чужой
    // запрос в «Target closed», то есть платим отказом вместо экономии памяти.
    //
    // Обход по всем подряд, а не «вытеснить одну и выйти»: если первая по счёту
    // занята, при остановке на первой лишние старые точки уедут из карты
    // незакрытыми, и их Firefox будет висеть до конца процесса.
    //
    // Отдельной проверки «не выгоняем сами себя» тут нет намеренно: текущая
    // точка только что переставлена в КОНЕЦ карты, а цикл успевает выйти по
    // лимиту раньше, чем дойдёт до неё. Такая проверка была бы мёртвым кодом.
    for (const [key, old] of [...sessions]) {
      if (sessions.size <= MAX_SESSIONS) break;
      if (isBusy(key)) continue;
      sessions.delete(key);
      await old.close();
    }
    return session;
  } catch (err) {
    if (building.get(sapId) === promise) building.delete(sapId);
    throw err;
  }
}

/**
 * POST с пересборкой сессии на отказе.
 *
 * 401/403 — это не «формат сломался», а протухшее антифрод-состояние: страница,
 * на которой мы сидим, сеть больше не пускает. Оставить её в кэше нельзя —
 * приложение живёт сутками, и без пересборки мёртвая сессия держала бы сеть
 * выключенной до перезапуска.
 */
export async function postWithRebuild<T>(sapId: string, path: string, body: unknown): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
const current = await getPerekrestokSession(sapId);
    // Занимаем занятость ДО запроса, а не после `getPerekrestokSession`: сессия
    // строится внутри, и если её в этот момент вытеснят, запрос уйдёт в
    // «Target closed» — восстановимый отказ ценой в полную пересборку.
    holdOf(sapId).count += 1;
    // Уменьшаем ТЕКУЩЕЕ значение, а не вычитаем из запомненного. Запросы к одной
    // точке стоят в общей очереди транспорта, но счётчик `busy` они делят: первый
    // взял 1, второй — 2, и кто освободит первым, тот уже не помнит своего
    // числа. При записи по своему счётчику он залипал на 1 навсегда, точка вечно
    // считалась занятой, её нельзя было вытеснить, а её Firefox висел до конца
    // процесса.
    const release = (): void => {
      holdOf(sapId).count = Math.max(0, holdOf(sapId).count - 1);
    };
try {
      const out = await current.post<T>(path, body);
      release();
      return out;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const recoverable =
        /HTTP (401|403)/.test(message) ||
        /NetworkError|TimeoutError|ERR_|Target closed|browser has been closed/.test(message);
      // 400 и «не JSON» сессию НЕ рвут: это наш неверный параметр или дрейф
      // ответа, а не протухшее антифрод-состояние.
      if (!recoverable) {
        release();
        throw err;
      }
      if (attempt === 1) {
        release();
        if (sessions.get(sapId) === current) sessions.delete(sapId);
        await current.close();
        throw err;
      }
      release();
      if (sessions.get(sapId) === current) sessions.delete(sapId);
      await current.close();
      await new Promise((done) => void setTimeout(done, BACKOFF_MS));
    }
  }
}

/** Закрыть все браузеры: вызывается при выходе из приложения. */
export async function closePerekrestokBrowser(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  building.clear();
  for (const s of all) await s.close().catch(() => {});
}