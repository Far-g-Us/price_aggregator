import type { ScrapedProduct, StoreCategory } from '../../shared/types.js';
import { normalize, type SearchItem } from './pyaterochka.js';

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
  try {
    return await import('playwright');
  } catch {
    throw new Error('5ka: Playwright не установлен/не упакован (нужен для браузерного транспорта)');
  }
}

// Признаки блокировки смотрим по заголовку и по факту наличия товаров:
// сам 5ka.ru везде в разметке упоминает recaptcha, так что grep по HTML
// даёт ложные срабатывания. Реальный сигнал капчи — не нашлась кука
// магазина (см. waitForStoreCookie) и пустой каталог.
function assertBlockPage(title: string): void {
  if (/доступ запрещён|выключите vpn|проверьте настройки интернета|blocked|forbidden/i.test(title)) {
    throw new Error('5ka: сайт отдаёт блокировку по IP — пауза и обычная сеть, не код');
  }
}

// headful нужен ровно для ручного разбора капчи; по умолчанию headless.
function launchOptions(pw: typeof import('playwright')) {
  return process.env.PA5KA_HEADFUL === '1' ? { headless: false } : { headless: true };
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
    await page.goto(WEB, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    assertBlockPage(await page.title());
    // СПА готова принимать ввод не сразу: даём ей дойти до ума.
    await page.waitForTimeout(6000);
    const detected = await waitForStoreCookie(ctx);
    if (detected === null) {
      throw new Error(
        '5ka: сайт не определил магазин — скорее всего капча/антифрод. ' +
          'Нужен ручной разбор в видимом окне (PA5KA_HEADFUL=1).',
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

async function getSession(sapCode: string): Promise<Session> {
  if (session && sessionKey === sapCode) return session;
  if (inFlight) {
    const s = await inFlight;
    if (s.sapCode === sapCode) return s;
    await s.close();
  }
  const pending = buildSession(sapCode);
  inFlight = pending;
  const built = await pending;
  session = built;
  sessionKey = sapCode;
  inFlight = null;
  return built;
}

async function waitForStoreCookie(ctx: Session['ctx']): Promise<string | null> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const cookies = await ctx.cookies('https://5ka.ru');
    const value = cookies.find((c) => c.name === STORE_COOKIE)?.value;
    if (value) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
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
  await s.page.goto(WEB, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  assertBlockPage(await s.page.title());
  await s.page.waitForTimeout(2000);
  const input = await s.page.waitForSelector('input[placeholder="Поиск"]', { timeout: TIMEOUT_MS });
  await input.fill(query);
  await input.press('Enter');
  const response = await waiter;
  const data = (await response.json()) as ProductListResponse;
  return (data.products ?? [])
    .map((p) => normalize(p, ctx))
    .filter((x): x is ScrapedProduct => x !== null);
}

interface CategoryNode {
  id?: string | number;
  name?: string;
  categories?: CategoryNode[];
}

// Версия держится рядом с URL (скилл): categories — v4, products — v2.
export async function browserCategories(ctx: { externalStoreId: string }): Promise<StoreCategory[]> {
  const s = await getSession(ctx.externalStoreId);
  const data = await grab<CategoryNode[]>(
    s,
    (u) => /\/api\/catalog\/v4\/stores\/[^/]+\/categories/.test(u),
    () => s.page.goto(`${WEB}catalog/`, { waitUntil: 'commit', timeout: TIMEOUT_MS }),
  );
  const out: StoreCategory[] = [];
  const walk = (nodes: CategoryNode[]): void => {
    for (const n of nodes) {
      const id = n?.id != null ? String(n.id) : '';
      const name = String(n?.name ?? '').trim();
      if (id && name && out.length < 40) {
        out.push({ id, name, url: `${WEB}catalog/${encodeURIComponent(name.toLowerCase())}/` });
      }
      if (Array.isArray(n?.categories)) walk(n.categories);
    }
  };
  walk(Array.isArray(data) ? data : []);
  if (out.length === 0) throw new Error('5ka: категории пусты (смена вёрстки?)');
  return out;
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
  const s = await getSession(ctx.externalStoreId);
  await s.page
    .goto(`${WEB}product/${encodeURIComponent(plu)}/`, { waitUntil: 'commit', timeout: TIMEOUT_MS })
    .catch(() => {});
  // __NEXT_DATA__ — скрытый <script>, нужен attached, а не visible.
  await s.page.waitForSelector('#__NEXT_DATA__', { state: 'attached', timeout: TIMEOUT_MS });
  assertBlockPage(await s.page.title());
  const cookies = await s.ctx.cookies('https://5ka.ru');
  const actual = cookies.find((c) => c.name === STORE_COOKIE)?.value;
  if (actual !== s.sapCode) {
    throw new Error(`5ka: магазин сменился на ${actual ?? 'неизвестный'}`);
  }
  const raw = await s.page.evaluate((id) => {
    const next = document.getElementById('__NEXT_DATA__');
    if (!next?.textContent) return null;
    const root = JSON.parse(next.textContent) as Record<string, unknown>;
    const stack: { node: unknown; path: string; depth: number }[] = [
      { node: root, path: '', depth: 0 },
    ];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur) break;
      const { node, path, depth } = cur;
      if (depth > 8 || !node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        node.forEach((v, i) => stack.push({ node: v, path: `${path}[${i}]`, depth: depth + 1 }));
        continue;
      }
      const rec = node as Record<string, unknown>;
      if (rec.plu != null && String(rec.plu) === id) return rec;
      for (const [k, v] of Object.entries(rec)) {
        if (typeof v === 'string' && v.length > 200 && v.includes('"plu"')) {
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
  if (!raw) throw new Error(`5ka: товар ${plu} не найден в данных страницы (смена вёрстки?)`);
  const data = raw as SearchItem;
  const product = normalize({ ...data, plu: data.plu ?? plu }, ctx);
  if (!product) throw new Error(`5ka: ответ по товару ${plu} без цены (пустой prices?)`);
  return product;
}
