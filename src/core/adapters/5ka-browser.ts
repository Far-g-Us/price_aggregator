import type { ScrapedProduct, StoreCategory } from '../../shared/types.js';
import { readEnvFlag } from '../platform.js';
import { injectedPlaywright } from './playwright-port.js';
import { categoryIdFromUrl, normalize, type SearchItem } from './5ka-parse.js';

const WEB = 'https://5ka.ru/';
const STORE_COOKIE = '5ka_store_id_store';
const TIMEOUT_MS = 60000;

// X5 режет всё, что не браузер: curl, fetch и даже Chromium (даже с
// выключенным VPN). Настоящий Firefox проходит — заголовок и его
// собственные запросы к API отвечают 200. Свой `fetch` внутри страницы
// WAF не принимает (запросы antifrod'а подписаны), поэтому браузер сам
// делает навигацию, а мы читаем перехваченный ответ.
//
// Обхода защиты тут нет: мы не патчим CSP/SRI, не подменяем fingerprint
// и User-Agent, не подставляем заголовки вручную — просто работаем
// внутри настоящего браузера, как обычный посетитель.
const STORE_RE = /^https:\/\/5d\.5ka\.ru\/api\/catalog\/v\d\/stores\/([^/]+)\//;

/**
 * Список категорий магазина — ИМЕННО он, а не любой запрос с `/categories`
 * в пути.
 *
 * Раньше matcher был без правой границы и совпадал ещё и со списком товаров
 * `/categories/<id>/products`: тот запрос сайт делает уже на главной, и он
 * прилетал раньше каталога. Мы перехватывали его и разбирали как дерево
 * категорий — получали ноль детей и честную, но бесполезную ошибку «категории
 * пусты (смена вёрстки?)». Вёрстка тут ни при чём.
 */
export function isCategoriesListUrl(url: string): boolean {
  // Правая граница — только `?` или конец строки. Смотреть шире нельзя: путь
  // товаров — это `/categories/<id>/products`, то есть тоже начинается с
  // `/categories`, и вариант `(?=[?#/]|$)` снова ловил бы список товаров.
  return /^https:\/\/5d\.5ka\.ru\/api\/catalog\/v\d\/stores\/[^/]+\/categories\/?(\?|$)/.test(url);
}

/** Код магазина из URL запроса каталога: сайт называет его сам. */
export function storeCodeFromCatalogUrl(url: string): string | null {
  return STORE_RE.exec(url)?.[1] ?? null;
}

/**
 * Код магазина со страницы карточки.
 *
 * Проверено живьём 2026-10-02: карточка товара НЕ делает ни одного запроса к
 * каталогу (в отличие от главной и витрины), поэтому ждать там ответа API
 * бесполезно — сверять надо саму страницу. Источник — `__NEXT_DATA__`, где
 * `catalogStore` лежит JSON-строкой (`"{\"storeId\":\"35XY\",…}"`), то есть
 * парсить приходится дважды.
 *
 * Путь не зашит (`props.pageProps.props.catalogStore` завтра может
 * переехать): обход ищет любой `storeId`/`sapCode`/`shopId`, включая вложенные
 * JSON-строки, и возвращает ПЕРВЫЙ найденный код. Кодов на живой странице
 * ровно один, так что неоднозначности нет.
 */
export function storeCodesFromNextData(nextData: string): string[] {
  let root: unknown;
  try {
    root = JSON.parse(nextData);
  } catch {
    return [];
  }
  const keys = ['storeId', 'store_id', 'sapCode', 'shopId'];
  // Сюда попадает уже проверенный объект: тип отсекается на обходе стека.
  const readCode = (rec: object): string | null => {
    const values = rec as Record<string, unknown>;
    for (const key of keys) {
      const val = values[key];
      if (typeof val === 'string' && /^[0-9A-Za-z]{3,8}$/.test(val)) return val;
    }
    return null;
  };
  const found = new Set<string>();
  const stack: { n: unknown; d: number }[] = [{ n: root, d: 0 }];
  while (stack.length > 0) {
    // Стек пуст ровно тогда, когда цикл не идёт: элемент есть всегда.
    const cur = stack.pop()!;
    if (!cur.n || typeof cur.n !== 'object' || cur.d > 14) continue;
    if (Array.isArray(cur.n)) {
      for (const v of cur.n) stack.push({ n: v, d: cur.d + 1 });
      continue;
    }
    const direct = readCode(cur.n);
    if (direct) found.add(direct);
    for (const val of Object.values(cur.n as Record<string, unknown>)) {
      if (typeof val === 'string' && val.trimStart().startsWith('{')) {
        try {
          stack.push({ n: JSON.parse(val) as unknown, d: cur.d + 1 });
        } catch {
          // не JSON — идём дальше
        }
      } else if (val && typeof val === 'object') {
        stack.push({ n: val, d: cur.d + 1 });
      }
    }
  }
  return [...found];
}

/**
 * Код магазина, только если назван РОВНО один. Несколько разных кодов — это
 * неоднозначность, и выдумывать из неё «правильный» нельзя: вызывающий должен
 * решать это громко, а не молча взять «первый попавшийся».
 */
export function storeCodeFromNextData(nextData: string): string | null {
  const codes = storeCodesFromNextData(nextData);
  // При длине 1 элемент существует по построению, а не «по счастливой case».
  return codes.length === 1 ? codes[0]! : null;
}

interface Session {
  ctx: import('playwright').BrowserContext;
  page: import('playwright').Page;
  browser: import('playwright').Browser;
  sapCode: string;
  close: () => Promise<void>;
}

let session: Session | null = null;
let sessionKey = '';
let inFlight: Promise<Session> | null = null;

async function importPlaywright(): Promise<typeof import('playwright')> {
  const injected = injectedPlaywright();
  if (injected) return injected;
  /* c8 ignore start — см. magnit.ts: в тестах порт подставляет Playwright
     всегда, а ветка битой установки тестом не воспроизводится. */
  try {
    return await import('playwright');
  } catch {
    // Отдельно от отсутствия браузера: сам пакет playwright обязан ехать в
    // сборку (он в dependencies). Если модуль не грузится — битая установка,
    // лечится переустановкой. Отсутствие Firefox выглядит иначе: до launch
    // дело не доходит, падает firefox.launch() со своим «Executable doesn't exist».
throw new Error(
      '5ka: не удалось загрузить playwright из сборки — приложение установлено повреждённо, переустанови его.',
    );
  }
  /* c8 ignore stop */
}

// Признаки блокировки смотрим по заголовку и по факту наличия товаров:
// сам 5ka.ru везде в разметке упоминает recaptcha, так что grep по HTML
// даёт ложные срабатывания. Реальный сигнал капчи — сайт не назвал магазин
// ни кукой, ни запросом каталога (см. detectStore) и каталог пуст.
function assertBlockPage(title: string): void {
  if (/доступ запрещён|выключите vpn|проверьте настройки интернета|blocked|forbidden/i.test(title)) {
    throw new Error('5ka: сайт отдаёт блокировку по IP — пауза и обычная сеть, не код');
  }
}

// headful нужен ровно для ручного разбора капчи; по умолчанию headless.
function launchOptions(pw: typeof import('playwright')) {
  return readEnvFlag('PA5KA_HEADFUL') === '1' ? { headless: false } : { headless: true };
}

async function buildSession(sapCode: string): Promise<Session> {
  const pw = await importPlaywright();
  const browser = await pw.firefox.launch(launchOptions(pw));
  const built = (async (): Promise<Session> => {
    const ctx = await browser.newContext({ locale: 'ru-RU' });
    const page = await ctx.newPage();
    const s: Session = {
      ctx,
      page,
      browser,
      sapCode,
      close: async () => {
        session = null;
        sessionKey = '';
        inFlight = null;
        await browser.close().catch(() => {});
      },
    };
    // Слушаем ответы каталоза ДО навигации: первый запрос с главной уже
    // называет магазин, и после goto его не достать.
    const apiWaiter = page
      .waitForResponse((r) => STORE_RE.test(r.url()), { timeout: TIMEOUT_MS })
      .then((r) => storeCodeFromCatalogUrl(r.url()))
      .catch(() => null);
    await page.goto(WEB, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    assertBlockPage(await page.title());
    // СПА готова принимать ввод не сразу: даём ей дойти до ума.
    await page.waitForTimeout(6000);
    const detected = await detectStore(ctx, sapCode, apiWaiter);
    if (detected === null) {
      throw new Error(
        `5ka: сайт не определил магазин — ни кука, ни запрос каталога за ${Math.round(STORE_DETECT_MS / 1000)} с. ` +
          'Повторите — обычно проходит со второй попытки (замер 2026-10-02: примерно 1 отказ из 4 прогонов ' +
          'без всякой капчи). Если повторяется — вероятна капча или блокировка, тогда нужен ручной разбор ' +
          'в видимом окне (PA5KA_HEADFUL=1).',
      );
    }
    if (detected !== sapCode) {
      throw new Error(
        `5ka: браузер работает с магазином ${detected}, а настроен ${sapCode}. ` +
          'X5 выбирает магазин по геолокации и не даёт подставить произвольный — ' +
          'поставь в настройках тот код, который отдаёт сайт.',
      );
    }
    return s;
  })();
  try {
    return await built;
  } catch (err) {
    // Сессия не публикуется до успешной проверки, но браузер уже запущен.
    session = null;
    sessionKey = '';
    await browser.close().catch(() => {});
    throw err;
  }
}

// Опрос без капчи и без блокировки примерно 1 из 4 прогонов не называет магазин:
// пустая сессия, и всё, что зовёт `getSession`, падает до ручного повтора.
// Смысл повтора внутри, а не в тексте ошибки: пользователь не должен ни знать
// про это, ни нажимать «ещё раз» — тем более что в UI повтор был недоступен,
// и разделы просто не появлялись.
const STORE_DETECT_ATTEMPTS = 2;

async function getSession(sapCode: string): Promise<Session> {
  if (session && sessionKey === sapCode) return session;
  if (inFlight) {
    const s = await inFlight;
    if (s.sapCode === sapCode) return s;
    await s.close();
  }
  const pending = (async () => {
    let last: Error = new Error(`5ka: сессия для ${sapCode} не построена`);
    for (let attempt = 1; attempt <= STORE_DETECT_ATTEMPTS; attempt += 1) {
      try {
        return await buildSession(sapCode);
      } catch (err) {
        // buildSession бросает только Error, поэтому приведение тут не проверка,
        // а договорённость: строкой Throwable отсюда не пойдёт.
        last = err as Error;
        if (!isStoreDetectFailure(last)) throw last;
        if (attempt === STORE_DETECT_ATTEMPTS) break;
        await sleep(1500);
      }
    }
    throw last;
  })();
  inFlight = pending;
  try {
    const built = await pending;
    session = built;
    sessionKey = sapCode;
    return built;
  } finally {
    // Раньше `inFlight` сбрасывался только на успехе. Одна капча или любой
    // сбой навсегда оставляли отвергнутый промис в `inFlight`, и каждый
    // следующий `getSession` мгновенно повторял ту же ошибку, не доходя до
    // `buildSession`: сеть была мертва до перезапуска приложения. Симптом
    // был ровно тот, с которого началась разборка — «нажал, получил то же
    // самое».
    // Проверка идентичности обязательна: при другом городе второй вызов мог
    // успеть поставить свой `inFlight`, и безусловный сброс затер бы его.
    if (inFlight === pending) inFlight = null;
  }
}

/** Сколько ждём, пока сайт назовёт свой магазин. */
export const STORE_DETECT_MS = 30000;

// Повтор делаем только на «сайт не назвал магазин»: капча, блокировка и чужой
// магазин после повтора не пройдут, а тратить ещё 30 с на них бессмысленно.
function isStoreDetectFailure(err: unknown): boolean {
  return err instanceof Error && err.message.includes('сайт не определил магазин');
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Код магазина: кука ИЛИ ответ каталога.
 *
 * Раньше единственным признаком была кука `5ka_store_id_store`, и это давало
 * ложную диагностику «капча/антифрод». Проверено живьём 2026-10-02: сайт
 * ставит куку не сразу — в одном прогоне её не было через 6 секунд, в другом
 * была, — но магазин при этом уже определён, потому что X5 называет его прямо
 * в URL запроса каталога (`/api/catalog/v4/stores/35XY/categories`). То есть
 * магазин известен, а мы сообщали пользователю про капчу, которой нет.
 *
 * `apiWaiter` регистрируется ДО навигации: иначе мы пропустим тот самый
 * первый запрос с главной, который и называет магазин.
 *
 * Из API выходим досрочно только если код СОВПАЛ с настроенным. Иначе первый
 * же промо-запрос чужой точки зафиксировал бы не тот магазин, и мы упали бы
 * с «работает с магазином X» вместо того, чтобы дождаться куки. Код из API —
 * финальный фолбэк, кука — приоритет.
 */
export async function detectStore(
  ctx: { cookies(url: string): Promise<{ name: string; value: string }[]> },
  sapCode: string,
  apiWaiter: Promise<string | null>,
  timeoutMs: number = STORE_DETECT_MS,
): Promise<string | null> {
  let fromApi: string | null = null;
  // Обработчик отказа обязателен: сигнатура экспортирована, и промис без
  // catch в этой цепочке дал бы unhandled rejection — в main-процессе Electron
  // это крашит приложение целиком.
  void apiWaiter.then(
    (v) => {
      fromApi = v;
    },
    () => {
      fromApi = null;
    },
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = (await ctx.cookies('https://5ka.ru')).find((c) => c.name === STORE_COOKIE)?.value;
    if (value) return value;
    if (fromApi === sapCode) return fromApi;
    await new Promise((r) => setTimeout(r, 500));
  }
  // Кука не появилась — берём то, что успел увидеть каталог. Ждать самого
  // `apiWaiter` здесь нельзя: у него собственный таймаут в минуту, и тогда
  // «капча» сообщалась бы через минуту вместо честных 30 с.
  return fromApi;
}

export async function close5kaBrowser(): Promise<void> {
  await session?.close();
  session = null;
  sessionKey = '';
  inFlight = null;
}

// Ответы по одному URL идут парами: сначала 307 с utm_referrer, потом 200.
// Ждём строго успешный И с тем же sapCode — иначе в историю попали бы
// цены чужого магазина (та же ловушка, что assertOwnStore у Магнита).
function waitForOwn(
  s: Session,
  matcher: (url: string) => boolean,
): Promise<import('playwright').Response> {
  return s.page.waitForResponse(
    (r) => {
      const m = STORE_RE.exec(r.url());
      return m?.[1] === s.sapCode && r.status() === 200 && matcher(r.url());
    },
    { timeout: TIMEOUT_MS },
  );
}

async function grab<T>(
  s: Session,
  matcher: (url: string) => boolean,
  navigate: () => Promise<unknown>,
): Promise<T> {
  const waiter = waitForOwn(s, matcher);
  // Слушатель отказа нужен сразу: если навигация не уложится в таймаут
  // ожидания, промис отклонится без слушателя, а unhandled rejection в
  // main-процессе Electron роняет приложение целиком. Оригинальный промис
  // при этом продолжает отклоняться для await ниже.
  void waiter.catch(() => {});
  // SPA рвёт `domcontentloaded` при переходах между своими страницами
  // (NS_BINDING_ABORTED) — нам важен только ответ API.
  await navigate().catch(() => {});
  const response = await waiter;
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`5ka: ответ на ${response.url().slice(0, 80)} не JSON (смена вёрстки?)`);
  }
}

interface ProductListResponse {
  products?: SearchItem[];
}

// Поиск срабатывает только через поле на главной: прямой переход на
// /search/?text=… запрос не делает, а /search/?query=… отдаёт пустую
// категорию. Поэтому вводим в поле и жмём Enter — как человек.
export async function browserSearch(
  query: string,
  ctx: { city: string; externalStoreId: string },
): Promise<ScrapedProduct[]> {
  const s = await getSession(ctx.externalStoreId);
  const waiter = waitForOwn(s, (u) => /\/api\/catalog\/v\d\/stores\/[^/]+\/search/.test(u));
  // Слушатель отказа нужен сразу. Часы `waitForResponse` стартуют на строку
  // раньше, чем у `goto`, поэтому при таймауте навигации промис отклонится
  // раньше, чем мы дойдём до `await waiter`, — а без обработчика это
  // unhandled rejection, который в main-процессе Electron роняет приложение
  // целиком. В остальных трёх местах файла заглушка стоит, здесь она
  // отсутствовала — и это был единственный непокрытый путь.
  void waiter.catch(() => {});
  await s.page.goto(WEB, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS }).catch(() => null);
  assertBlockPage(await s.page.title());
  await s.page.waitForTimeout(2000);
  const input = await s.page.waitForSelector('input[placeholder="Поиск"]', { timeout: TIMEOUT_MS });
  await input.fill(query);
  await input.press('Enter');
  const response = await waiter;
  let data: ProductListResponse;
  try {
    data = (await response.json()) as ProductListResponse;
  } catch {
    throw new Error(`5ka: ответ на ${response.url().slice(0, 80)} не JSON (смена вёрстки?)`);
  }
  return (data.products ?? [])
    .map((p) => normalize(p, ctx))
    .filter((x): x is ScrapedProduct => x !== null);
}

interface CategoryNode {
  id?: string | number;
  name?: string;
  image_link?: string;
  categories?: CategoryNode[];
}

// Версия держится рядом с URL (скилл): categories — v4, products — v2.
//
// Зонд 2026-09-30 (scripts/probe-5ka-caturl.mjs) снял с живого ответа:
//  • id категорий — ШЕСТНАДЦАТЕРИЧНЫЙ (251C17045), а не цифровой;
//  • рабочие адреса: /catalog/<slug>--<id>/ и /catalog/<id>/ (редирект на
//    слаг). Формы /catalog/id/<id>/ сайт НЕ маршрутизирует — products-запрос
//    не приходит вовсе, поэтому её не используем;
//  • верхние узлы (18 штук) имеют type="category_list", advert=null,
//    products=[] и БЕЗ image_link. Признака, отличающего промо-узел
//    («Пятёрочка выручает!») от товарной категории, в ответе нет вообще,
//    поэтому ничего не фильтруем: витрина повторяет сайт. Картинки лежат
//    только у ДЕТЕЙ, поэтому собираем именно их.
// Разбор ссылки на категорию живёт в pyaterochka.ts рядом с остальным кодом
// сети: этот модуль уже импортирует его оттуда, обратного импорта нет.

export async function browserCategories(ctx: { externalStoreId: string }): Promise<StoreCategory[]> {
  const s = await getSession(ctx.externalStoreId);
  const data = await grab<CategoryNode[]>(
    s,
    (u) => isCategoriesListUrl(u),
    () => s.page.goto(`${WEB}catalog/`, { waitUntil: 'commit', timeout: TIMEOUT_MS }),
  );
  // Без этой проверки при капче мы висим до таймаута и падаем «категории
  // пусты», что врёт: пусто не потому, что вёрстка изменилась.
  assertBlockPage(await s.page.title());
  const roots = Array.isArray(data) ? data : [];
  const out: StoreCategory[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    // Только дети: у верхних узлов image_link нет (зонд), значит плитки вышли
    // бы без картинок, а товары лежат именно в детях.
    for (const node of Array.isArray(root?.categories) ? root.categories : []) {
      const id = node?.id != null ? String(node.id) : '';
      const name = String(node?.name ?? '').trim();
      if (!id || !name || seen.has(id) || out.length >= 40) continue;
      seen.add(id);
      const image = String(node?.image_link ?? '').trim();
      // Адрес строим коротким: /catalog/<id>/ сайт принимает и редиректит на
      // слаг (зонд), а слаг уезжает при переименовании категории.
      out.push({
        id,
        name,
        url: `${WEB}catalog/${encodeURIComponent(id)}/`,
        ...(isUsableImage(image) ? { imageUrl: image } : {}),
      });
    }
  }
  if (out.length === 0) throw new Error('5ka: категории пусты (смена вёрстки или режим магазина?)');
  return out;
}

function isUsableImage(url: string): boolean {
  return /^https:\/\/\S+$/.test(url) && !url.startsWith('data:');
}

/**
 * Товары категории. Отдельного запроса не строим: сайт сам уходит в
 * /api/catalog/v2/stores/<sap>/categories/<id>/products, мы перехватываем
 * ответ. Одна навигация на клик пользователя — rate-limit не трогаем.
 */
export async function browserCategoryProducts(
  url: string,
  ctx: { city: string; externalStoreId: string },
): Promise<ScrapedProduct[]> {
  const categoryId = categoryIdFromUrl(url);
  if (!categoryId) throw new Error('5ka: categoryUrl вне каталога');
  const s = await getSession(ctx.externalStoreId);
  try {
    const data = await grab<{ products?: SearchItem[] } | SearchItem[]>(
      s,
      (u) =>
        new RegExp(`/api/catalog/v\\d/stores/[^/]+/categories/${categoryId}/products(\\?|$)`).test(u),
      () => s.page.goto(url, { waitUntil: 'commit', timeout: TIMEOUT_MS }),
    );
    const products = Array.isArray(data) ? data : (data?.products ?? []);
    if (!Array.isArray(products) || products.length === 0) {
      throw new Error('5ka: сайт не отдал товары категории (устаревшая ссылка?)');
    }
    const items = products
      .map((p) => normalize(p, ctx))
      .filter((x): x is ScrapedProduct => x !== null)
      // Страница сайта — 12 товаров. Больше без второго запроса не взять.
      .slice(0, 32);
    // Проверяем ПОСЛЕ нормализации: сайт мог отдать 12 позиций, у которых нет
    // цены или имени (например, все вне наличия), и normalize их отбросил. Тогда
    // пустой ответ — это не «товаров нет», а смена ответа, и сказать об этом
    // нужно громко.
    if (items.length === 0) {
      throw new Error(
        `5ka: сайт отдал ${products.length} позиций, ни одна не пригодна (нет цены или имени) — смена ответа?`,
      );
    }
    return items;
  } catch (err) {
    // Сессия после неудачной навигации остаётся залипшей — следующий запрос
    // снова ждал бы полный таймаут. Рвём её, как в browserFetchProduct.
    await s.close().catch(() => {});
    throw err;
  }
}

// Карточку товара сайт НЕ грузит отдельным запросом — объект лежит
// вшитым в `__NEXT_DATA__` (`props.pageProps.props.productStore` — JSON
// строка, внутри `product` с тем же форматом, что у catalog API). Поэтому
// читаем страницу, а не перехватываем ответ.
export async function browserFetchProduct(
  plu: string,
  ctx: { city: string; externalStoreId: string },
): Promise<ScrapedProduct> {
  if (!/^\d+$/.test(plu)) throw new Error(`5ka: bad plu ${plu}`);
  const startedAt = Date.now();
  const s = await getSession(ctx.externalStoreId);
  try {
    return await fetchProductOnPage(s, plu, ctx);
  } catch (err) {
    // Сессия после неудачной навигации обычно остаётся «залипшей»: следующий
    // товар снова ждёт полный TIMEOUT_MS, и опрос на 76 позиций превращается в
    // очередь по минуте на позицию. Рвём сессию — следующий товар начнётся с
    // чистого браузера (его подъём стоит секунд шесть, зато не минуту).
    await s.close().catch(() => {});
    throw err;
  } finally {
    console.log(`5ka товар ${plu}: ${Date.now() - startedAt}мс`);
  }
}

async function fetchProductOnPage(
  s: Session,
  plu: string,
  ctx: { city: string; externalStoreId: string },
): Promise<ScrapedProduct> {
  // Страница карточки не делает запросов к каталогу (проверено живьём), так
  // что свидетельство о магазине берём из двух мест: кука и сама страница.
  // Раньше требовалась только кука, а сессия теперь может быть и без неё —
  // тогда каждый товар падал с «магазин сменился на неизвестный», а обёртка
  // рвала браузер: на опросе в 76 позиций Firefox пересоздавался десятки раз.
  const apiWaiter = s.page
    .waitForResponse((r) => STORE_RE.test(r.url()), { timeout: TIMEOUT_MS })
    .then((r) => storeCodeFromCatalogUrl(r.url()))
    .catch(() => null);
  const resp = await s.page
    .goto(`${WEB}product/${encodeURIComponent(plu)}/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS })
    .catch(() => null);
  if (resp && resp.status() >= 400) {
    throw new Error(`5ka: страница товара ${plu} отдала HTTP ${resp.status()}`);
  }
  // __NEXT_DATA__ — скрытый <script>, нужен attached, а не visible.
  await s.page.waitForSelector('#__NEXT_DATA__', { state: 'attached', timeout: TIMEOUT_MS });
  assertBlockPage(await s.page.title());

  const nextData = await s.page.evaluate(() => document.getElementById('__NEXT_DATA__')?.textContent ?? '');
  const fromPageEarly = storeCodeFromNextData(nextData);
  const cookie = (await s.ctx.cookies('https://5ka.ru')).find((c) => c.name === STORE_COOKIE)?.value ?? null;
  const fromApi = await Promise.race([apiWaiter, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);

  // Если источники РАЗОШЛИСЬ — не выбираем «более удобный», а падаем: кука
  // меняется с запозданием за первым запросом нового магазина, и цена уже
  // отрендеренного сервером товара была бы чужой. Ожидаемый код в сообщении
  // обязателен: пользователь должен видеть, что вписывать в конфиг.
  const known = [cookie, fromPageEarly, fromApi].filter((c): c is string => c !== null && c !== undefined);
  const distinct = [...new Set(known)];
  if (distinct.length > 1) {
    throw new Error(
      `5ka: источники называют разные магазины (${known.join(' / ')}), а настроен ${s.sapCode}`,
    );
  }
  const early = distinct[0] ?? null;
  if (early !== null && early !== s.sapCode) {
    throw new Error(`5ka: магазин сменился на ${early} (настроен ${s.sapCode})`);
  }

  const product = await readProductFromNextData(s, plu, ctx);

  // Сверка по ФИНАЛЬНОМУ снимку. Ранний берётся сразу после `commit`, когда
  // `__NEXT_DATA__` ещё пустая оболочка, а товар мы читаем из позднего — иначе
  // принадлежность цены доказывалась бы снимком, который к этому моменту уже
  // не тот. Если финальный снимок всё ещё молчит, доверяем магазину сессии.
  const finalNextData = await s.page.evaluate(() => document.getElementById('__NEXT_DATA__')?.textContent ?? '');
  const finalCodes = storeCodesFromNextData(finalNextData);
  if (finalCodes.length > 0 && !finalCodes.includes(s.sapCode)) {
    throw new Error(
      `5ka: страница назвала магазины ${finalCodes.join(' / ')}, а настроен ${s.sapCode}`,
    );
  }
  if (finalCodes.length !== 1) {
    console.warn(
      `5ka: карточка ${plu} — кодов на странице ${finalCodes.length || 0}` +
        ` (раньше: ${early ?? 'ни одного'}), берём ${s.sapCode} из сессии`,
    );
  }
  return product;
}

/** Сколько ждём, пока SPA допишет товар в __NEXT_DATA__. */
const PRODUCT_WAIT_MS = 20000;

/**
 * Разбор товара из `__NEXT_DATA__` — отдельно от проверки магазина.
 *
 * Читать данные приходится с ожиданием: `#__NEXT_DATA__` прикрепляется
 * немедленно, а `productStore` наполняется позже. Без ожидания опрос терял
 * товары без всякой причины — замер 2026-10-02: из трёх товаров подряд на одной
 * сессии два прошли, третий «не найден в данных страницы», хотя через пару
 * секунд он там был. Живой title в этот момент был `Loading
 * …/api/authV2/callback/keycloak/…` — страница ещё переходила.
 *
 * Данные перечитываются на каждой итерации: Next.js переписывает
 * `__NEXT_DATA__` на клиенте, поэтому один раз прочитанный снимок может
 * оказаться пустой оболочкой.
 */
async function readProductFromNextData(
  s: Session,
  plu: string,
  ctx: { city: string; externalStoreId: string },
): Promise<ScrapedProduct> {
  const readOnce = (): Promise<Record<string, unknown> | null> =>
    s.page.evaluate((id) => {
      const next = document.getElementById('__NEXT_DATA__');
      if (!next?.textContent) return null;
      let root: unknown;
      try {
        // Next.js переписывает снимок на клиенте, поэтому он может оказаться
        // недописанным. Без try сырой SyntaxError вылетел бы наружу и уронил
        // сессию вместо того, чтобы просто ждать следующую итерацию.
        root = JSON.parse(next.textContent);
      } catch {
        return null;
      }
      const stack: { node: unknown; path: string; depth: number }[] = [
        { node: root, path: '', depth: 0 },
      ];
      while (stack.length > 0) {
        // Стек пуст ровно тогда, когда цикл не идёт: элемент есть всегда.
        const { node, path, depth } = stack.pop()!;
        if (depth > 12 || !node || typeof node !== 'object') continue;
        if (Array.isArray(node)) {
          node.forEach((v, i) => stack.push({ node: v, path: `${path}[${i}]`, depth: depth + 1 }));
          continue;
        }
        const rec = node as Record<string, unknown>;
        if (rec.plu != null && String(rec.plu) === id) return rec;
        for (const [k, v] of Object.entries(rec)) {
          // Любая строка, которая разбирается как JSON-объект, может оказаться
          // вложенным стором. Раньше порог длины был 200 символов, и короткий
          // productStore не разбирался вообще — товар «терялся» без причины.
          if (typeof v === 'string' && v.trimStart().startsWith('{')) {
            try {
              stack.push({ node: JSON.parse(v) as unknown, path: `${path}.${k}`, depth: depth + 1 });
              continue;
            } catch {
              /* не JSON — идём по обычному пути */
            }
          }
          stack.push({ node: v, path: `${path}.${k}`, depth: depth + 1 });
        }
      }
      return null;
    }, plu);

  const poll = async (ms: number): Promise<Record<string, unknown> | null> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const found = await readOnce();
      if (found) return found;
      await new Promise((r) => setTimeout(r, 700));
    }
    return null;
  };

  let raw = await poll(PRODUCT_WAIT_MS / 2);
  if (!raw) {
    // Первое ожидание исчерпано — перезагружаем документ и пробуем ещё раз.
    // Замер 2026-10-02: на последовательной выдаче из 12 товаров СПА один раз
    // не дописывала productStore за 20 с (обход в том же виде находил его
    // при прямом открытии страницы). Одна перезагрузка дешевле, чем рвать
    // сессию и поднимать заново Firefox.
    await s.page.reload({ waitUntil: 'commit', timeout: TIMEOUT_MS }).catch(() => {});
    // После перезагрузки страница могла приземлиться на капчу или на
    // «товар не найден» — молча ждать тогда 20 с и сказать «товар не
    // появился» значило бы выдать 404 за проблему с данными.
    assertBlockPage(await s.page.title());
    raw = await poll(PRODUCT_WAIT_MS / 2);
  }
  if (!raw) {
    throw new Error(`5ka: товар ${plu} не появился в данных страницы за ${Math.round(PRODUCT_WAIT_MS / 1000)} с`);
  }
  const data = raw as unknown as SearchItem;
  // Снимок отдаёт запись только когда plu в ней совпал с запрошенным, значит
  // plu там есть по построению: подставлять запрошенный id руками не нужно.
  const product = normalize(data, ctx);
  if (!product) throw new Error(`5ka: ответ по товару ${plu} без цены (пустой prices?)`);
  return product;
}
