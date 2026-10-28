// Транспорт Чижика: каталог и цены отдаёт только контекст страницы.
//
// Почему браузер: обычный `fetch` к `app.chizhik.club/delivery/api/…` отдаёт
// 403 и без заголовков, и с полным набором X5 (`x-app-version`, `x-platform`,
// `x-tenant-id: tsch`, `x-capabilities`, `x-device-id`, Origin/Referer). Из
// контекста страницы магазина тот же адрес отдаёт 200. Это та же причина, по
// которой Пятёрка едет на браузере, и тот же порт `playwright-port.ts`.
//
// Здесь только транспорт: сессия (Firefox + контекст + страница магазина),
// in-page `fetch` с куками страницы, кэш сессии по магазину и повтор при обрыве.
// Разбор ответов и нормализация — в `chizhik.ts`.
//
// Сессия кэшируется по `sap_id`: прогон 40 товаров не должен 40 раз поднимать
// браузер, а магазины в одном городе разные и каждая сессия своя.

import { readEnvFlag } from '../platform.js';
import { loadPlaywright } from './playwright-port.js';

const WEB = 'https://app.chizhik.club';
const TIMEOUT_MS = 60_000;
/** Сколько ждём, пока SPA дойдёт до состояния, в котором каталог отвечает. */
const WARMUP_MS = 4000;
/**
 * Пауза между запросами: без неё сеть включает 403 уже на третьем (замер 2026-10-08).
 * Очередь и счётчик времени модульные, то есть пауза общая на все точки сразу.
 */
const GAP_MS = 2000;
/** Пауза перед пересборкой сессии после отказа. */
const BACKOFF_MS = 5000;
/**
 * Попыток построить сессию. Первый запуск после старта иногда не прогревается
 * (замер 2026-10-08): сессия падает, вторая попытка проходит. Повтор внутри, а не
 * текстом в ошибке — пользователь не должен ни знать про это, ни нажимать
 * «ещё раз».
 */
const SESSION_ATTEMPTS = 2;

  // Настоящий импорт playwright живёт только в Electron-оболочке: иначе бандлер
  // Android-сборки пытается resolve'ить chromium-bidi. Понятный текст отказа —
  // тоже в порте, вместе с подменой для тестов.
  const importPlaywright = (): Promise<typeof import('playwright')> => loadPlaywright();

/** Признак блокировки по заголовку страницы. */
function assertBlockPage(title: string): void {
  if (/доступ ограничен|доступ запрещён|blocked|forbidden|antibot/i.test(title)) {
    throw new Error(`chizhik: страница закрыта антиботом («${title}») — нужна пауза и обычная сеть, не код`);
  }
}

/** Код магазина кэшируется вместе с сессией: он же ключ её. */
interface ChizhikSession {
  sapId: string;
  /** GET из контекста страницы с разобранным JSON. */
  get<T>(path: string): Promise<T>;
  close(): Promise<void>;
}

/**
 * Сессии по магазинам, а не одна на всё.
 *
 * Опрос идёт по всем товарам без сортировки по городу, то есть города чередуются.
 * При одной сессие на каждый переход к чужому городу браузер закрывался бы и
 * поднимался заново — это минута прогрева на КАЖДЫЙ товар, и сеть не собралась бы
 * опросить ничего. Поэтому держим несколько точек, а лишние закрываем.
 */
/**
 * Сколько точек держим одновременно. 11 городов, и порядок опроса планировщика не
 * гарантирован (`SELECT DISTINCT` без `ORDER BY`), поэтому при честном чередовании
 * лимит меньше числа городов даёт промахи: каждый промах = запуск Firefox, 4 секунды
 * прогрева и лишний удар по антиботу. Пять — с запасом на соседние города, при этом
 * это всё ещё пять Firefox, а не одиннадцать.
 */
const MAX_SESSIONS = 5;
const sessions = new Map<string, ChizhikSession>();
/** Сколько запросов сейчас идёт по каждой точке: занятую не вытесняем. */
/** Счётчик занятости точки. Объект, а не число, — счётчиком владеем мы сами. */
interface Hold {
  count: number;
}

const busy = new Map<string, Hold>();

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
const building = new Map<string, Promise<ChizhikSession>>();



/**
 * Запрос с пересборкой сессии на отказе. 401/403 — это не «формат сломался», а
 * протухшее антифрод-состояние: страница, на которой мы сидим, сеть больше не
 * пускает. Оставить её в кэше нельзя — приложение живёт сутками, опрос идёт
 * каждые 6 часов, и без пересборки мёртвая сессия держала бы сеть выключенной до
 * перезапуска приложения (ровно тот отказ, который у Ленты лечится сбросом на
 * 401/403, а у 5ka — рвётся в catch).
 */
async function getWithRebuild<T>(sapId: string, path: string): Promise<T> {
  // Цикл без условия выхода: каждая итерация либо возвращает ответ, либо бросает.
  // Счётчик отказывает второй попытке — после неё сессия уже пересобрана, а третья
  // попытка просто повторила бы тот же отказ (и съела ещё минуту таймаута).
  for (let attempt = 0; ; attempt += 1) {
    const current = await getChizhikSession(sapId);
    holdOf(sapId).count += 1;
    // Занятость снимается перед каждым выходом из итерации: на «занятой» точке
    // вытеснение невозможно, а забытая занятость держала бы браузер в карте до конца
    // процесса.
    //
    // Уменьшаем ТЕКУЩЕЕ значение карты, а не вычитаем из своего `hold`. Запросы к
    // одной точке стоят в общей очереди транспорта, но счётчик `busy` они делят:
    // первый взял 1, второй — 2. Запись по своему `hold` залипала на 1 навсегда,
    // если первым отпускал не первый взявший: точка вечно считалась занятой, её
    // нельзя было вытеснить, и её браузер висел до конца процесса.
    const release = (): void => {
      holdOf(sapId).count = Math.max(0, holdOf(sapId).count - 1);
    };
    try {
      const out = await current.get<T>(path);
      release();
      return out;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const recoverable =
        /HTTP (401|403)/.test(message) ||
        /NetworkError|TimeoutError|ERR_|Target closed|browser has been closed/.test(message);
      // 422, 500 и «не JSON» сессию НЕ рвут: это наш неверный параметр или дрейф
      // ответа, а не протухшее антифрод-состояние. Рвать её значило бы платить полную
      // пересборку браузера на каждый запрос умирающей сети.
      if (!recoverable) {
        release();
        throw err;
      }
      // Последняя попытка всё равно бросает: ждать перед ней бессмысленно — мы
      // отложили бы отказ на 5 секунд и ничего не купили.
      if (attempt === 1) {
        release();
        if (sessions.get(sapId) === current) sessions.delete(sapId);
        await current.close();
        throw err;
      }
      // Пауза перед пересборкой: мгновенный повтор после 403 добавляет к отказу ещё и
      // прогрев страницы, то есть давление удваивается. Сеть успевает отпустить.
      await new Promise((done2) => void setTimeout(done2, BACKOFF_MS));
      // Рвём именно ту сессию, которая ответила отказом (`current`), а не «текущую»:
      // за это время другой город мог занять карту своей сессией, и мы закрыли бы
      // рабочий браузер соседнего города вместо своего.
      release();
      if (sessions.get(sapId) === current) sessions.delete(sapId);
      await current.close();
    }
  }
}

/**
 * Запрос из страницы. Код передаётся ФУНКЦИЕЙ с аргументом, а не строкой:
 * `page.evaluate` со строкой не умеет принимать аргументы (проверено — вернёт
 * `undefined`), а любая вложенная именованная стрелка внутри функции ломает
 * сборку esbuild (`__name is not defined`). Поэтому внутри — прямой код без
 * вложенных `const`-стрелок.
 */
/**
 * Запрос из страницы с потолком времени: без него зависшая сеть — вечный спиннер.
 */
async function inPageGet(
  page: import('playwright').Page,
  url: string,
): Promise<{ status: number; body: string }> {
  return page.evaluate(
    async (target: { url: string; timeout: number }) => {
      const res = await fetch(target.url, {
        headers: { accept: 'application/json' },
        credentials: 'include',
        signal: AbortSignal.timeout(target.timeout),
      });
      return { status: res.status, body: await res.text() };
    },
    { url, timeout: TIMEOUT_MS },
  );
}

/**
 * Один GET из сессии, с паузой и очередью.
 *
 * Пауза не из вежливости: тот же обход браузером на 24 категориях подряд включил
 * у сети 403 уже на третьем запросе (проверено 2026-10-08 в
 * `scripts/probe-helper.ts`). Очередь — чтобы два параллельных запроса не пошли
 * в сеть одновременно, что для антибота выглядит как долбёжка.
 */
let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function inSessionGet<T>(page: import('playwright').Page, path: string): Promise<T> {
  const run = queue.then(async () => {
    const since = Date.now() - lastRequestAt;
    if (lastRequestAt > 0 && since < GAP_MS) {
      await new Promise((done) => void setTimeout(done, GAP_MS - since));
    }
    const { status, body } = await inPageGet(page, `${WEB}${path}`);
    lastRequestAt = Date.now();
    if (status !== 200) {
      throw new Error(`chizhik: ${path.slice(0, 70)} — HTTP ${status}: ${body.slice(0, 90)}`);
    }
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`chizhik: ${path.slice(0, 70)} — не JSON (${body.slice(0, 60)})`);
    }
  });
  queue = run.catch(() => {});
  return run;
}

async function buildSession(sapId: string): Promise<ChizhikSession> {
  const pw = await importPlaywright();
  const headless = readEnvFlag('CHIZHIK_HEADFUL') !== '1';
  const browser = await pw.firefox.launch({ headless });
  try {
    const context = await browser.newContext({ locale: 'ru-RU' });
    const page = await context.newPage();
    const response = await page.goto(`${WEB}/shop/${sapId}`, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT_MS,
    });
    // Ответ на саму страницу магазина тоже смотрим: редирект на антибот отдаёт 403
    // с пустым заголовком, и такой случай ловится только здесь.
    const status = response?.status() ?? 0;
    if (status !== 0 && status >= 400) {
      throw new Error(`chizhik: страница магазина ${sapId} — HTTP ${status} (антибот или сеть недоступна)`);
    }
    assertBlockPage(await page.title());
    await page.waitForTimeout(WARMUP_MS);
    // Кто ответил: у X5 неизвестный код молча подменяется дефолтным (так же ведёт
    // себя Пятёрка). Цены у Чижика общие по городам, но наличие — нет, поэтому
    // подмена магазина тихо записала бы чужое наличие в историю нашего города.
    //
    // Проверка по адресу страницы, а не по телу ответа: сверять нечем — проверено
    // живьём 2026-10-08, что ни куки (только spjs/spsc/spid), ни localStorage
    // (_SPUID), ни `sap_code` в теле каталога кода точки НЕ содержат. Поэтому
    // это всё, что можно проверить; подмена магазина при том же адресе мы бы не
    // заметили, и это известное ограничение (записано в ROADMAP).
    //
    // Сравнение по path, а не `includes` по строке: подстрочный матч прошёл бы
    // и `/shop/HD87X`, и `/shop/HD87?store=HDJ7` — то есть проверка, которая
    // ничего не проверяет.
    const expectedPath = `/shop/${sapId}`;
    const actual = new URL(page.url());
    if (actual.origin !== WEB || actual.pathname.replace(/\/$/, '') !== expectedPath) {
      throw new Error(
        `chizhik: браузер на ${actual.origin}${actual.pathname} вместо магазина ${sapId} — ` +
          'сеть подменила точку, цены и наличие придут из чужого магазина',
      );
    }
    return {
      sapId,
      // close() закрывает браузер и НИЧЕГО не трогает в модуле: вызывающий сам
      // решает, что стало прошлой сессией. Иначе закрытие старой сессии стирало бы
      // из `session` новую (присваивание идёт до закрытия) — и следующий запрос
      // поднимал бы третий браузер, а второй остался бы висеть на весь процесс.
      close: async () => {
        await browser.close().catch(() => {});
      },
      get: <T>(path: string): Promise<T> => inSessionGet<T>(page, path),
    };
  } catch (err) {
    // Сессия не опубликована, а браузер уже поднят: без закрытия он останется
    // висеть на весь процесс.
    await browser.close().catch(() => {});
    throw err;
  }
}

/**
 * Сессия магазина: из карты, иначе строим (с повтором). Параллельные вызовы одного
 * магазина дедуплицируются: без этого два одинаковых запроса подняли бы два Firefox.
 */
export async function getChizhikSession(sapId: string): Promise<ChizhikSession> {
  const cached = sessions.get(sapId);
  if (cached) {
    // Попадание в кэш продвигает точку в конец карты: порядок вытеснения становится
    // «по последнему использованию» (LRU), а не «по сборке». Иначе давно не
    // использованная точка вытеснялась бы первой — ровно та, к которой опрос
    // возвращается.
    sessions.delete(sapId);
    sessions.set(sapId, cached);
    return cached;
  }
  const pending = building.get(sapId) ?? buildWithRetry(sapId);
  building.set(sapId, pending);
  let built: ChizhikSession;
  try {
    built = await pending;
  } finally {
    // Сброс с проверкой идентичности: безусловный затёр бы чужой промис, если к
    // этому моменту кто-то успел начать сборку другой точки.
    if (building.get(sapId) === pending) building.delete(sapId);
  }
  sessions.delete(sapId);
  sessions.set(sapId, built);
  // Лишние точки закрываем: Firefox'ы дорогие, а городов у сети одиннадцать.
  // Обход по всем подряд, а не «первый лишний»: на лимитной проверке остановиться
  // нельзя, а на вытеснении — можно, и тогда остальные старые точки уедут из карты
  // незакрытыми.
  //
  // Занятые (по ним идёт запрос) не трогаем: закрытие страницы роняет чужой
  // запрос в «Target closed», а это восстановимый отказ — 5 секунд backoff, новая
  // сборка и возможное вытеснение третьего города. Один каскад вместо точной
  // экономии памяти.
  //
  // Проверки «не выгоняем сами себя» здесь нет намеренно: текущая точка только что
  // переставлена в КОНЕЦ карты, поэтому цикл успевает выйти по лимиту раньше, чем
  // дойдёт до неё. Такая проверка была бы мёртвым кодом.
  for (const [oldSap, oldSession] of [...sessions]) {
    if (sessions.size <= MAX_SESSIONS) continue;
    if (isBusy(oldSap)) continue;
    sessions.delete(oldSap);
    await oldSession.close();
  }
  return built;
}

async function buildWithRetry(sapId: string): Promise<ChizhikSession> {
  let last = new Error(`chizhik: сессия для ${sapId} не построена`);
  for (let attempt = 1; attempt <= SESSION_ATTEMPTS; attempt += 1) {
    try {
      return await buildSession(sapId);
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err));
      if (attempt < SESSION_ATTEMPTS) await new Promise((done) => void setTimeout(done, 2000));
    }
  }
  throw last;
}

/** Закрыть все браузеры: приложение зовёт это при выходе. */
export async function closeChizhikBrowser(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  // Чистим и незаконченные сборки: дописавшись в карту после выхода, они оставили бы
  // Firefox висеть до конца процесса.
  building.clear();
  await Promise.all(all.map((s) => s.close().catch(() => {})));
}

export { getWithRebuild };
