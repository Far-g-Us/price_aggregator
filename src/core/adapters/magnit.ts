import {
  UNKNOWN_STORE_CODE,
  type ScrapedProduct,
  type StoreAdapter,
  type StoreCategory,
} from '../../shared/types.js';
import { loadPlaywright } from './playwright-port.js';
import { httpFetch } from '../http.js';
import { isNativeShell } from '../platform.js';
import { isProductLookupError, ProductLookupError } from '../adapter-errors.js';
import {
  buildSearchBody,
  EmptySearchError,
  parseWebgateCategories,
  parseWebgateSearch,
  safeJsonParse,
  WebgateDriftError,
  NOT_JSON,
} from './magnit-webgate.js';

interface MagnitOffer {
  name?: string;
  price?: string | number;
  image?: string;
  url?: string;
  availability?: string;
}

interface MagnitProductLd {
  name?: string;
  brand?: string | { name?: string };
  description?: string;
  image?: string[] | string;
  sku?: string | number;
  weight?: string | number | { value?: string | number; unitText?: string };
  offers?: { price?: string | number; availability?: string } | { price?: string | number }[];
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export function parseMagnitPrice(raw: string): number | null {
  const clean = raw.replace(/[\s\u00a0\u2009]/g, '');
  const withRub = clean.match(/(-?\d+(?:[.,]\d+)?)\s*₽/);
  const m = withRub ?? clean.match(/(-?\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  // Группа (-?\d+(?:[.,]\d+)?) участвует в любом совпадении, поэтому m[1] —
  // строка, а не «может отсутствовать».
  const v = Number(m[1]!.replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

export function validPrice(v: number | null): v is number {
  return v !== null && v > 0;
}

function assertShopCode(shopCode: string): void {
  if (!/^\d+$/.test(shopCode)) throw new Error(`magnit: bad shopCode ${shopCode}`);
}

/**
 * Коды магазинов из ссылок на товары.
 *
 * Ссылки лежат в ДВУХ формах: буквальной (`/product/…`) в отрендеренном HTML
 * и экранированной (`\u002Fproduct\u002F…`) в пейлоаде Nuxt. Ловить только
 * первую было бы тихо: на странице поиска её в ответе нет вовсе.
 *
 * ВНИМАНИЕ к группам: все части ДО `(\d+)` сделаны незахватывающими. Иначе
 * код магазина съезжает с `m[1]` на `m[2]`, и сверка тихо ломается — такое
 * уже было в этой функции и в зонде.
 *
 * Экспортируется для зонда `scripts/magnit-store.ts`, чтобы правило сверки
 * жило в одном месте, а не копировалось в скрипт без тестов.
 */
export function shopCodesInProductLinks(html: string): string[] {
  return [
    ...new Set(
      [
        ...html.matchAll(
          /(?:\/product\/|u002Fproduct\\u002F)[^"']*?shopCode=\\?(?:u0022|%22|\\?"|")?(\d+)(?!\d)/g,
        ),
      // Группы регулярки всегда участвуют в совпадении, поэтому m[1] здесь
      // строка, а не «может отсутствовать».
      ].map((m) => m[1]!),
    ),
  ];
}

/**
 * Ответ принадлежит именно этому магазину.
 *
 * Одного «есть строка `shopCode=<код>` в HTML» НЕДОСТАТОЧНО: пейлоад повторяет
 * там куку — то есть наш собственный код — даже если такого магазина нет.
 * Проверено живьём 2026-10-01 на коде 111111: строка на месте, а ссылки на
 * товары ведут в 992301 (магазин по умолчанию). Прежняя проверка принимала любой
 * код, и цены чужой точки уехали бы в историю.
 *
 * Настоящий признак — shopCode в ссылках на товары (shopCodesInProductLinks
 * выше): они ведут в тот магазин, цены которого показаны. Если в ссылках чужой
 * код, а нашего нет, ответ отбрасывается: иначе в историю уедут цены чужой точки
 * (инвариант домена).
 */
export function hasShopCode(html: string, shopCode: string): boolean {
  assertShopCode(shopCode);
  const inLinks = shopCodesInProductLinks(html);
  // Ссылки есть, но нашего кода среди них нет — ответ чужого магазина.
  if (inLinks.length > 0) return inLinks.includes(shopCode);
  // Ссылок нет (страница без товаров): проверить нечем, и мы не выдумываем вины.
  return new RegExp(`shopCode=(%22|")?${shopCode}(%22|"|&|$)`).test(html);
}

/**
 * Проверка принадлежности ответа магазину ВОЗВРАЩАЕТ код, который сеть
 * подтвердила.
 *
 * Отдельная функция, потому что код из ответа теперь едет в товаре: ядро сверяет
 * его с запрошенной точкой и отказывается писать цену, если это другая точка
 * (инвариант домена на коде). Пока сеть код в ссылках не показала (страница без
 * товаров), возвращаем sentinel — ядро тогда доверяет запрошенной точке.
 */
function assertOwnStore(html: string, shopCode: string): string {
  if (!hasShopCode(html, shopCode)) {
    throw new Error(`magnit: ответ от чужого магазина (нет shopCode=${shopCode})`);
  }
  const inLinks = shopCodesInProductLinks(html);
  return inLinks.includes(shopCode) ? shopCode : UNKNOWN_STORE_CODE;
}

/**
 * Мягкий вариант сверки: различает «показана чужая точка» и «страница вообще
 * без товаров».
 *
 * Различие обязательно с 2026-10-18: сайт Магнита ушёл на клиентский рендер,
 * и `/search?term=` отдаёт ПУСТУЮ оболочку Nuxt — ни ссылок на товары, ни
 * `shopCode=`. Жёсткая сверка объявляла такую страницу «чужим магазином»,
 * и поиск на этом обрывался ДО браузера, где товары ещё видны. Теперь пустая
 * оболочка — это «идём в браузер», а чужая точка — по-прежнему громкий отказ.
 */
function inspectOwnStore(
  html: string,
  shopCode: string,
): { observed: string; foreign: boolean } {
  if (!hasShopCode(html, shopCode)) {
    // Ссылок на товары нет вовсе → пустая оболочка, а не чужая точка. Если
    // ссылки есть, но наш код в них не встречается — это уже чужая точка.
    const foreign = shopCodesInProductLinks(html).length > 0;
    return { observed: UNKNOWN_STORE_CODE, foreign };
  }
  const inLinks = shopCodesInProductLinks(html);
  return {
    observed: inLinks.includes(shopCode) ? shopCode : UNKNOWN_STORE_CODE,
    foreign: false,
  };
}

function cookieHeader(shopCode: string): string {
  assertShopCode(shopCode);
  return `shopCode=${encodeURIComponent(`"${shopCode}"`)}`;
}

function idFromUrl(url: string): string | null {
  const m = url.match(/\/product\/(\d+)/);
  return m?.[1] ?? null;
}

export function normalizeMagnitOffer(
  raw: MagnitOffer,
  ctx: { city: string; externalStoreId: string },
  oldPrice: number | null = null,
): ScrapedProduct | null {
  const id = raw.url ? idFromUrl(raw.url) : null;
  if (!id || !raw.name) return null;
  const price = raw.price != null ? parseMagnitPrice(String(raw.price)) : null;
  if (!validPrice(price)) return null;
  const product: ScrapedProduct = {
    canonicalId: `magnit-${id}`,
    storeId: 'magnit',
    city: ctx.city,
    storeCode: ctx.externalStoreId,
    name: raw.name,
    price,
    promoPrice: null,
    oldPrice: validOldPrice(oldPrice, price) ? oldPrice : null,
    inStock: !raw.availability || /InStock/i.test(raw.availability),
    collectedAt: new Date().toISOString(),
  };
  if (raw.url) product.url = raw.url;
  if (raw.image) product.imageUrl = raw.image;
  return product;
}

/**
 * Предупреждение о неподтверждённой точке.
 *
 * Не один раз за процесс (процесс живёт неделями, и дрейф маркера на второй
 * день не дал бы ни строки), а раз в сутки на точку: сигнал остаётся, но лог не
 * засоряется тысячей одинаковых строк на каждый товар опроса.
 */
const warnedNoStoreMarker = new Map<string, number>();
const NO_STORE_MARKER_WARN_EVERY_MS = 24 * 60 * 60 * 1000;
function warnNoStoreMarker(shopCode: string): void {
  const last = warnedNoStoreMarker.get(shopCode) ?? 0;
  if (Date.now() - last < NO_STORE_MARKER_WARN_EVERY_MS) return;
  warnedNoStoreMarker.set(shopCode, Date.now());
  console.warn(
    `magnit: код магазина в ссылках не показан, точка ${shopCode} не подтверждена — цена записана по запрошенной точке`,
  );
}

export function normalizeMagnitProduct(
  raw: MagnitProductLd,
  ctx: { city: string; url: string; externalStoreId: string; storeCode?: string },
): ScrapedProduct | null {
  const id = raw.sku != null ? String(raw.sku) : idFromUrl(ctx.url);
  if (!id || !raw.name) return null;
  const offers: { price?: string | number; availability?: string } | undefined = Array.isArray(
    raw.offers,
  )
    ? raw.offers[0]
    : raw.offers;
  const price = offers?.price != null ? parseMagnitPrice(String(offers.price)) : null;
  if (!validPrice(price)) return null;
  const brand = typeof raw.brand === 'string' ? raw.brand : raw.brand?.name;
  const weight =
    typeof raw.weight === 'object'
      ? `${raw.weight.value ?? ''}${raw.weight.unitText ?? ''}`.trim()
      : String(raw.weight ?? '').trim();
  const product: ScrapedProduct = {
    canonicalId: `magnit-${id}`,
    storeId: 'magnit',
    city: ctx.city,
    // Код, который сеть подтвердила ссылками; без подтверждения — sentinel, и
    // тогда код запрошенной точки подставит ядро.
    storeCode: ctx.storeCode ?? ctx.externalStoreId,
    name: raw.name,
    price,
    // promoPrice/oldPrice НЕ заполняем: в JSON-LD карточки только
    // offers.price, зачёркнутой цены там нет. undefined = «путь не знает»,
    // БД возьмёт прежнее значение (см. savePriceIfChanged).
    inStock: !offers?.availability || /InStock/i.test(offers.availability),
    url: ctx.url,
    collectedAt: new Date().toISOString(),
  };
  if (brand) product.brand = brand;
  if (raw.description) product.description = raw.description;
  const firstImage = Array.isArray(raw.image) ? raw.image[0] : raw.image;
  if (typeof firstImage === 'string' && firstImage) product.imageUrl = firstImage;
  if (/^\d+(?:[.,]\d+)?$/.test(weight)) product.unit = `${weight}кг`;
  else if (weight) product.unit = weight;
  return product;
}

export type MagnitCategory = StoreCategory;

function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      // Группа (.*?) участвует в любом совпадении, даже пустая: пустая строка
      // честно уходит в catch ниже.
      out.push(JSON.parse(m[1]!));
    } catch {
      continue;
    }
  }
  return out;
}

export interface RawCard {
  name: string;
  href: string;
  img: string;
  texts: string[];
}

export function cardsToProducts(
  raw: RawCard[],
  ctx: { city: string; externalStoreId: string },
  limit: number,
  // По умолчанию — запрошенный код: обе функции зовутся только после того, как
  // ответ уже сверили (assertOwnStore / assertPageUsable), то есть код подтверждён.
  // Явный observedCode нужен там, где сеть показала код в ссылках.
  observedCode: string = ctx.externalStoreId,
): ScrapedProduct[] {
  const out: ScrapedProduct[] = [];
  for (const r of raw.slice(0, limit)) {
    const id = idFromUrl(r.href);
    const current = r.texts[0] ? parseMagnitPrice(r.texts[0]) : null;
    if (!id || !r.name || !validPrice(current)) continue;
    const money = r.texts.slice(1).filter((t) => !/[·/]/.test(t));
    const old = money.map(parseMagnitPrice).find((v) => validOldPrice(v, current)) ?? null;
    const unit = r.texts.slice(1).find((t) => /[·/]/.test(t)) ?? null;
    // Путь без query: id уже извлечён из этой же ссылки регуляркой
    // /product/(\d+)/, поэтому он непустой и проверять href здесь не нужно.
    const href = r.href.split('?')[0];
    const product: ScrapedProduct = {
      canonicalId: `magnit-${id}`,
      storeId: 'magnit',
      city: ctx.city,
      storeCode: observedCode,
      name: r.name,
      price: current,
      promoPrice: null,
      oldPrice: old,
      inStock: true,
      url: `https://magnit.ru${href}`,
      collectedAt: new Date().toISOString(),
    };
    if (r.img && !r.img.startsWith('data:')) product.imageUrl = r.img;
    if (unit) product.unitPrice = unit;
    out.push(product);
  }
  return out;
}

  // Настоящий импорт playwright живёт только в Electron-оболочке: иначе бандлер
  // Android-сборки пытается resolve'ить chromium-bidi. Понятный текст отказа —
  // тоже в порте, вместе с подменой для тестов.
  const importPlaywright = (): Promise<typeof import('playwright')> => loadPlaywright();

function assertNoBlock(html: string, title: string): void {
  if (/app-empty-vpn|выключите vpn|проблемы со связью|доступ запрещён/i.test(`${title} ${html.slice(0, 4000)}`)) {
    throw new Error('magnit: блок по IP («Выключите VPN») — пауза и домашняя сеть, не код');
  }
}

export interface MagnitGoodsItem {
  id: string;
  title: string;
  link: string;
  image: string;
  price: string;
  oldPrice: string;
}

function nuxtScript(html: string): string {
  return html.match(/<script[^>]*__NUXT_DATA__[^>]*>(.*?)<\/script>/s)?.[1] ?? '';
}

// В payload встречаются и не-ценовые строки (цвета бейджей `#FF5858`,
// подписи `Только у нас`), из которых parseMagnitPrice вытащил бы мусор.
function isPlainPriceToken(s: string): boolean {
  return /^\d+(?:[.,]\d+)?$/.test(s.trim());
}

export function validOldPrice(old: number | null, price: number): old is number {
  return old !== null && old > price && old / price < 5;
}

// Плоский goods-список в __NUXT_DATA__ (одинаков для поиска и категории):
// id, title, /product/..., cashback, image, price, [oldPrice, -salePercent], ...
// Акционная запись всегда несёт пару "<oldPrice>","-<N>%" сразу после цены
// (у неакционной вместо oldPrice пустой слот), поэтому ищем именно пару,
// а не «любое число побольше» — иначе в хвост попадают рейтинги и бейджи.
// oldPrice — ровно первый строковый слот после цены (у акционных записей он
// идёт за пустым слотом и/или рядом с `"-<N>%"`, у остальных слот пустой).
// Смотрим только первый слот, поэтому рейтинги, цвета бейджей и подписи
// в кандидаты не попадают.
const FIRST_SLOT_RE = /^\s*,(?:"")?\s*,?\s*"([^"\\]*)"/;
function oldPriceFromTail(tail: string, price: number): string {
  const candidate = FIRST_SLOT_RE.exec(tail)?.[1]?.trim() ?? '';
  if (!isPlainPriceToken(candidate)) return '';
  return validOldPrice(parseMagnitPrice(candidate), price) ? candidate : '';
}

function goodsFromScript(script: string, limit: number): MagnitGoodsItem[] {
  const re = /"(\d{7,})","((?:[^"\\]|\\.){3,120}?)"\s*,\s*"((?:\\u002Fproduct\\u002F[^"\\]+))"\s*(?:,\s*\d+)?\s*,\s*"((?:[^"\\]|\\.)+)"\s*,\s*"((?:[^"\\]|\\.)*)"/g;
  const out: MagnitGoodsItem[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const id = m[1]!;
    const title = m[2]!;
    const link = m[3]!.replace(/\\u002F/g, '/');
    const image = m[4]!.replace(/\\u002F/g, '/');
    const price = m[5]!;
    if (!id || !title || !price) continue;
    const priceNum = parseMagnitPrice(price);
    const tail = script.slice(m.index + m[0].length, m.index + m[0].length + 160);
    const oldPrice = priceNum !== null ? oldPriceFromTail(tail, priceNum) : '';
    out.push({ id, title, link, image, price, oldPrice });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Разбор выдачи поиска из HTML.
 *
 * `allowBlank` — режим пустой оболочки: страница без `shopCode=` и без ссылок
 * на товары (сайт на клиентском рендере, 2026-10-18) не объявляется «чужим
 * магазином» — из неё идём в браузер, где товары ещё видны. Ссылка на товары
 * ЧУЖОЙ точки по-прежнему даёт громкий отказ.
 */
export function parseMagnitSearchGoods(
  html: string,
  shopCode: string,
  allowBlank = false,
): MagnitGoodsItem[] {
  assertNoBlock(html, '');
  if (allowBlank) {
    const { foreign } = inspectOwnStore(html, shopCode);
    if (foreign) {
      throw new Error(`magnit: ответ от чужого магазина (нет shopCode=${shopCode})`);
    }
  } else {
    assertOwnStore(html, shopCode);
  }
  const script = nuxtScript(html);
  const out = goodsFromScript(script, 32);
  // Ссылки в пейлоаде лежат экранированными (`\u002Fproduct\u002F`), поэтому
  // проверка только буквального `/product/` на странице поиска всегда ложна и
  // «смена вёрстки» этим guard'ом не ловилась —LOUD-ошибка не доходила.
  if (out.length === 0 && /(?:\/product\/|u002Fproduct\\u002F)/.test(script)) {
    throw new Error('magnit: search-парсер пуст при живых ссылках на товары (смена вёрстки?)');
  }
  return out;
}

export function parseMagnitCategoryPromos(html: string, shopCode: string): Map<string, number> {
  assertNoBlock(html, '');
  assertOwnStore(html, shopCode);
  const promos = new Map<string, number>();
  for (const g of goodsFromScript(nuxtScript(html), Number.POSITIVE_INFINITY)) {
    const old = g.oldPrice ? parseMagnitPrice(g.oldPrice) : null;
    if (old !== null && validPrice(old)) promos.set(g.id, old);
  }
  return promos;
}

/**
 * Бюджет прямой фазы поиска на ОБЕ попытки вместе.
 *
 * Без него запрос растягивался до 25 + 1.5 + 25 секунд, а в полке это
 * удваивалось на два страйка подряд. Вторая попытка получает остаток, поэтому
 * при быстром обрыве (доли секунды) она почти ничего не теряет, а при полной
 * недоступности потолок держится.
 */
const DIRECT_PHASE_BUDGET_MS = 30000;
/** Пауза между прямым запросом и браузерным фолбэком по тому же домену. */
const BROWSER_FALLBACK_PAUSE_MS = 1200;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Сколько миллисекунд ещё можно тратить на прямой запрос.
 *
 * `null` означает «бюджет исчерпан, дальше только браузер». Вынесено отдельной
 * функцией не для красоты: иначе ветку «время кончилось» пришлось бы проверять
 * настоящими 30 секундами ожидания, и она осталась бы непокрытой навсегда.
 */
let directPhaseBudgetMs = DIRECT_PHASE_BUDGET_MS;

export function directPhaseLeftMs(elapsedMs: number): number | null {
  const left = directPhaseBudgetMs - elapsedMs;
  return left < 2000 ? null : left;
}

// Тестовый крючок: потолок приходится уменьшать в тестах, а ждать настоящие
// 30 секунд ради одной ветки нельзя. `null` возвращает боевой бюджет.
export function __setDirectPhaseBudgetForTests(ms: number | null): void {
  directPhaseBudgetMs = ms ?? DIRECT_PHASE_BUDGET_MS;
}

async function assertPageUsable(
  page: {
    content(): Promise<string>;
    title(): Promise<string>;
  },
  shopCode: string,
): Promise<void> {
  const [html, title] = await Promise.all([page.content(), page.title()]);
  assertNoBlock(html, title);
  if (/капча|капчи|captcha|robot/i.test(`${title} ${html.slice(0, 2000)}`)) {
    throw new Error('magnit: капча/блок — нужен ручной разбор');
  }
  if (!html.includes(`"${shopCode}"`)) {
    // Без следа кода магазина виноваты две разные вещи, и раньше обе назывались
    // «чужой магазин?», хотя витрина уводила в эту ошибку и при недогруженной
    // странице (2026-11-11, полка: `fetch failed` → фолбэк → это сообщение).
    // Разные выводы и разное лечение (следующий запрос против сверки кода в
    // справочнике), поэтому и сообщения разные.
    //
    // Меряем ТОЛЬКО видимый текст тела: magnit.ru всегда шлёт инлайновые стили,
    // и на живой фикстуре `magnit-home.html` «текста» получалось 52 354
    // символа, из которых 49 752 — CSS внутри `<style>`. Считать теги по
    // `<[^>]*>` мало: содержимое script/style остаётся. Поэтому вырезаем их
    // вместе с комментариями и берём тело.
    const visible = visibleText(html);
    if (visible.length < BLANK_PAGE_TEXT_LIMIT) {
      throw new Error(`magnit: страница почти пустая (${visible.length} символов) — не догрузилась`);
    }
    throw new Error(`magnit: страница без следов shopCode=${shopCode} (чужой магазин?)`);
  }
}

/**
 * Видимый текст страницы без служебного содержимого.
 *
 * `<script>`, `<style>`, `<noscript>` и комментарии вырезаются ДО снятия тегов:
 * иначе метрика «сколько на странице текста» измеряет минифицированный CSS и
 * принимает заглушку за полноценную витрину.
 */
export function visibleText(html: string): string {
  // Тело берётся, когда оно есть; HTML без `<body>` (обрывок ответа,
  // фрагмент из кеша) разбираем целиком — иначе такой ответ объявился бы
  // пустым и ушёл в браузерный фолбэк зря.
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  return body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ниже этого числа видимого текста страницу считаем недогруженной. */
export const BLANK_PAGE_TEXT_LIMIT = 200;

/**
 * Строгая сверка магазина по ссылкам карточек.
 *
 * Для путей Playwright проверки по эху куки в DOM было мало: эхо доказывает,
 * что кука дошла, а не что магазин тот. Раньше это был единственный путь, где
 * цены чужой точки могли уехать в историю молча (fetch-пути давно сверяются по
 * `hasShopCode`).
 *
 * Ссылки на карточках у нас есть всегда — `readCards` отдаёт `href` вида
 * `/product/111-a?shopCode=1`, поэтому сверка бесплатна.
 *
 * Правило ровно как у `hasShopCode`: коды есть и нашего среди них нет —
 * чужой магазин; кодов нет вовсе (проверять нечем) — не выдумываем вины;
 * наш код есть среди чужих — принимаем: смешанная страница с промо-блоком
 * реальна, и ложный отказ ударил бы по всей полке города сильнее, чем риск
 * подмены на одной карточке.
 */
export function assertCardsOwnStore(cards: RawCard[], shopCode: string): void {
  // Считаем только непустые ссылки: карточка без href — это «сверять нечем»,
  // а не «сеть сменила формат». Разные вещи, и путать их нельзя.
  const hrefs = cards.map((c) => c.href.trim()).filter((h) => h.length > 0);
  if (hrefs.length === 0) return;
  const codes = shopCodesInProductLinks(hrefs.join(' '));
  if (codes.length === 0) {
    // Тихий возврат здесь опасен: если сеть уберёт shopCode из ссылок, проверка
    // превратится в пустышку и Playwright-путь молча вернётся к сверке по эху
    // куки — той самой, что уже доказала негодность (код `111111`: эхо на
    // месте, ссылки в чужой магазин). Ссылки есть, а сверить нечем — это повод
    // сказать вслух, а не сделать вид, что всё проверили.
    throw new Error(
      'magnit: в ссылках карточек нет shopCode — свервать магазин нечем (смена формата ссылок?)',
    );
  }
  if (!codes.includes(shopCode)) {
    throw new Error(
      `magnit: ответ от чужого магазина (ссылки ведут в ${codes.join(', ')}, а настроен ${shopCode})`,
    );
  }
}

async function readCards(
  page: {
    evaluate(fn: (n: number) => RawCard[], arg: number): Promise<RawCard[]>;
  },
  limit: number,
): Promise<RawCard[]> {
  return page.evaluate(
    (n: number) => {
      const list = [...document.querySelectorAll('article.unit-catalog-product-preview')].slice(0, n);
      return list.map((a) => {
        const link = a.querySelector('a[title]');
        const img = a.querySelector('img');
        const texts = [...a.querySelectorAll('*')]
          .filter((e) => e.children.length === 0 && typeof e.textContent === 'string' && e.textContent.includes('₽'))
          // Фильтр выше оставил только строки: текст здесь точно есть, и trim()
          // не может получить null из-за узла без содержимого.
          .map((e) => (e.textContent as string).trim());
        return {
          name: link?.getAttribute('title') || '',
          href: link?.getAttribute('href') || '',
          img: img ? img.currentSrc || img.src : '',
          texts,
        };
      });
    },
    limit,
  );
}

/**
 * Витрина категорий с главной страницы.
 *
 * Формат сменился (проверено на живом ответе 2026-10-08): в `__NUXT_DATA__`
 * больше нет ни меток `"g123"`, ни ссылок `/catalog/…` — вместо них лежит
 * плоский Nuxt-массив (devalue) со ссылками на индексы, где у записи категории
 * есть `id`/`name`/`code`/`image`/`children`, но нет URL. Зато сами плитки
 * витрины пришли обычными `<a>` в HTML главной:
 *
 *   <a class="catalog-categories-tiles__item pl-hover-base"
 *      href="https://magnit.ru/catalog/63303" data-test-id="v-app-link">
 *     <img src="https://…png" alt="Скидки"> <span …>Скидки</span></a>
 *
 * Отсюда и берём: числовой id из `href`, название из `alt` (у плиток без
 * картинки alt пустой, там берём текст `span`), картинку — только https и не
 * `data:` (в `data:` утекает вес страницы, а в `<img>` такая не покажется).
 * Сверка магазина остаётся прежней: `shopCode` должен встречаться в ответе,
 * иначе мы смотрим не тот магазин.
 */
export function parseMagnitCategories(html: string, shopCode: string): MagnitCategory[] {
  assertOwnStore(html, shopCode);
  // Плитку ищем по открывающему `<a>`, а класс и адрес разбираем внутри тега
  // отдельными регулярками: их порядок в атрибутах менялся (сейчас `class`
  // первым, в других ответах — `href`), а общий шаблон вида
  // `<a ... class=... href=...>` молча перестал бы находить витрину целиком.
  // Адрес бывает и абсолютным, и относительным — поэтому ищем `/catalog/<id>`.
  const openTag = /<a\b[^>]*>/g;
  const classRe = /\bclass="[^"]*\bcatalog-categories-tiles__item\b[^"]*"/;
  const hrefRe = /\bhref="[^"]*\/catalog\/(\d+)[^"]*"/;
  // SSR-разметка Nuxt оборачивает текст служебными комментариями
  // (`<!--[-->Бакалея<!--]-->`), и без их снятия разбор подписи упирается в
  // `<!--[-->` и даёт пустую строку: плитка без `alt` молча выпала бы.
  const stripSsr = (raw: string): string => raw.replace(/<!--[\s\S]*?-->/g, '');
  const seen = new Map<string, MagnitCategory>();
  let m: RegExpExecArray | null;
  while ((m = openTag.exec(html)) !== null) {
    const tag = m[0];
    if (!classRe.test(tag)) continue;
    const id = hrefRe.exec(tag)?.[1];
    if (id === undefined) continue;
    const openEnd = m.index + tag.length;
    // Тело плитки — до следующего открывающего `<a`, а не до `</a>`: при
    // незакрытой плитке `[\s\S]*?</a>` съедал бы следующую целиком, и витрина
    // молча теряла бы половину. Закрывающий тег в хвосте просто отрезается.
    const nextOpen = html.indexOf('<a', openEnd);
    const stop = nextOpen === -1 ? html.length : nextOpen;
    const body = stripSsr(html.slice(openEnd, stop));
    const alt = body.match(/<img[^>]*\salt="([^"]*)"/)?.[1] ?? '';
    const label = body.match(/catalog-categories-tiles__text[^>]*>([^<]*)</)?.[1] ?? '';
    // alt из одних пробелов — это не имя: иначе плитка без подписи потеряла бы
    // своё настоящее название.
    const name = (alt.trim() !== '' ? alt : label).replace(/\s+/g, ' ').trim();
    if (name === '' || seen.has(id)) continue;
    const category: MagnitCategory = { id, name, url: `https://magnit.ru/catalog/${id}` };
    const rawImage = body.match(/<img[^>]*\ssrc="([^"]*)"/)?.[1] ?? '';
    if (/^https:\/\/\S+$/.test(rawImage) && !rawImage.startsWith('data:')) category.imageUrl = rawImage;
    seen.set(id, category);
    openTag.lastIndex = Math.max(openEnd, nextOpen);
    // Витрина на главной — это верхний уровень (8–9 плиток), потолок оставлен
    // на случай, если сеть вернёт развёрнутый список с вложенными.
    if (seen.size >= 40) break;
  }
  if (seen.size === 0) throw new Error('magnit: категории не найдены (смена вёрстки?)');
  return [...seen.values()];
}

//
// observedCode — код, который сеть показала в ответе (см. assertOwnStore).
// Он едет в товар, чтобы ядро сверило его с запрошенной точкой: цены чужой
// точки не должны попасть в нашу историю молча.
export function goodsToProducts(
  goods: MagnitGoodsItem[],
  ctx: { city: string; externalStoreId: string },
  // По умолчанию — запрошенный код: обе функции зовутся только после того, как
  // ответ уже сверили (assertOwnStore / assertPageUsable), то есть код подтверждён.
  // Явный observedCode нужен там, где сеть показала код в ссылках.
  observedCode: string = ctx.externalStoreId,
): ScrapedProduct[] {
  const out: ScrapedProduct[] = [];
  for (const g of goods) {
    const price = parseMagnitPrice(g.price);
    if (!g.id || !g.title || !validPrice(price)) continue;
    const old = g.oldPrice ? parseMagnitPrice(g.oldPrice) : null;
    const product: ScrapedProduct = {
      canonicalId: `magnit-${g.id}`,
      storeId: 'magnit',
      city: ctx.city,
      storeCode: observedCode,
      name: g.title,
      price,
      promoPrice: null,
      oldPrice: validOldPrice(old, price) ? old : null,
      inStock: true,
      collectedAt: new Date().toISOString(),
    };
    const pathOnly = g.link.split('?')[0];
    if (pathOnly) product.url = `https://magnit.ru${pathOnly}`;
    if (g.image && !g.image.startsWith('data:') && /^https:\/\//.test(g.image)) product.imageUrl = g.image;
    out.push(product);
  }
  return out;
}

// Именно `term`. С `query` (как было раньше) сайт параметр игнорирует и
// отдаёт популярные товары вместо выдачи — молоко превращалось в бананы и
// лук, и это молча уходило в историю. Отдельная функция, чтобы зафиксировать
// URL тестом: откат на `query=` тестами не ловится.
export function magnitSearchUrl(query: string): string {
  return `https://magnit.ru/search?term=${encodeURIComponent(query)}`;
}

export class MagnitAdapter implements StoreAdapter {
  readonly storeId = 'magnit' as const;

  private headers(shopCode: string): Record<string, string> {
    return {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru-RU,ru;q=0.9',
      'User-Agent': UA,
      Referer: 'https://magnit.ru/',
      Cookie: cookieHeader(shopCode),
    };
  }

  /** Заголовки JSON-API: тот же UA и та же кука, плюс `Accept: application/json`. */
  private jsonHeaders(shopCode: string): Record<string, string> {
    return {
      ...this.headers(shopCode),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: 'https://magnit.ru',
    };
  }

  /**
   * Поиск через скрытое JSON-API сайта (`magnit-webgate`). Это ПЕРВЫЙ путь,
   * а не замена: сайт перешёл на клиентский рендер (2026-10-18), страница
   * `/search?term=` отдаёт оболочку без товаров, поэтому HTML-разбор ниже
   * живёт фолбэком на случай, если API временно отдаёт 5xx.
   *
   * Сверка точки здесь точная: код приходит полем `storeCode` у каждого
   * товара, тогда как HTML-путь вынужден угадывать по ссылкам.
   */
  private async searchViaWebgate(
    query: string,
    ctx: { city: string; externalStoreId: string },
    startMs: number,
  ): Promise<{ products: ScrapedProduct[]; degradedTotal: number | null }> {
    const shopCode = ctx.externalStoreId;
    // Пустой терм — ровно та ловушка, что была с `?query=`: сеть молча
    // отдаёт ПОПУЛЯРНЫЕ товары вместо выдачи по запросу, и они тихо уехали бы
    // в историю под именем чужого товара. Лучше пусто, чем чужие цены.
    if (!query.trim()) return { products: [], degradedTotal: null };
    // Таймаут webgate тоже укладывается в общий бюджет дёшевой фазы.
    // На телефоне потолок ниже: там при отказе сети ждать 20 с на КАЖДЫЙ товар
    // нельзя, а мобильная сеть отвечает медленнее — 10 с вполне хватает
    // нормальному ответу, а зависший запрос обрывается заметно раньше.
    const webgateTimeoutMs = isNativeShell() ? 10000 : 20000;
    const res = await httpFetch('https://magnit.ru/webgate/v2/goods/search', {
      method: 'POST',
      headers: this.jsonHeaders(shopCode),
      body: buildSearchBody(query, shopCode),
      timeoutMs: Math.min(webgateTimeoutMs, Math.max(3000, directPhaseBudgetMs - (Date.now() - startMs))),
    });
    // 5xx у Магнита — это их собственный сбой (сайт в такие минуты тоже
    // показывает пустоту). Не считаем это дрейфом формата: отдаём управление
    // HTML-фолбэку, а не шумим громким отказом.
    if (!res.ok) {
      throw new Error(`magnit webgate search HTTP ${res.status}`);
    }
    const raw = safeJsonParse(await res.text());
    if (raw === NOT_JSON) throw new Error('magnit webgate ответил не JSON (WAF-страница?)');
    const products = parseWebgateSearch(raw, shopCode);
    // Пустая выдача в поиске — НЕ всегда «ничего не нашлось». Если сеть
    // утверждает, что совпадения есть (`totalCount > 0`), но не отдала ни
    // одного товара, то это её деградация, и молчать об этом нельзя: в
    // интерфейсе пользователь увидит «ничего не нашлось» и решит, что товара
    // нет. `totalCount: 0` — честная пустота, её показываем.
    if (products.length === 0) {
      const total = (raw as { pagination?: { totalCount?: unknown } }).pagination?.totalCount;
      if (typeof total === 'number' && total > 0) {
        // Деградация: сеть говорит, что совпадения есть, но не отдала их.
        // Возвращаем ПОМЕТКУ, а не бросок: дальше должен идти HTML-фолбэк и
        // браузер — клиентский рендер живого сайта товары ещё видит. Если и
        // они ничего не нашли, сообщение будет точным (см. `search`).
        return { products: [], degradedTotal: total };
      }
      if (typeof total !== 'number') {
        // Поля `pagination` в живом ответе есть (проверено 2026-10-19), и его
        // отсутствие — дрейф формы, а не «ничего не нашлось». Молчать здесь
        // нельзя: пользователь увидел бы «нет товаров» вместо «сеть сменила
        // ответ». Тот же класс, что и в `fetchProduct`.
        throw new WebgateDriftError(
          'magnit: в ответе webgate/v2/goods/search нет pagination.totalCount (смена формы ответа), выдача пуста',
        );
      }
    }
    const collectedAt = new Date().toISOString();
    // `promoPrice` НЕ пишем — у Магнита акция живёт в паре price/oldPrice
    // (так же, как в HTML-пути), а «цена по акции» без старой тут была бы
    // выдумкой. `storeCode` — не запрошенный, а тот, что ОТДАЛА сеть: сверка
    // уже прошла в parseWebgateSearch, и подменять его обратно незачем.
    return {
      products: products.map((p) => ({
        // ПРЕФИКС `magnit-` обязателен: без него товар из поиска не доживёт до
        // `fetchProduct`, который сверяет `norm.canonicalId === canonicalId` и
        // строит адрес из `canonicalId.replace(/^magnit-/, '')`. Голый id дал бы
        // вечный «JSON-LD не найден» на КАЖДЫЙ такой товар плюс дубль строк в
        // `prices_history` против товара, найденного полкой. Все прочие пути
        // адаптера строят id ровно так же.
        canonicalId: `magnit-${p.id}`,
        name: p.title,
        price: p.price,
        oldPrice: p.oldPrice,
        ...(p.inStock !== undefined ? { inStock: p.inStock } : {}),
        url: p.url,
        storeId: 'magnit',
        city: ctx.city,
        storeCode: p.observedShopCode,
        collectedAt,
        ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
      })),
      // null — деградации нет; число — сеть молчит, но обещает совпадения.
      degradedTotal: null,
    };
  }

  async search(
    query: string,
    ctx: { city: string; externalStoreId: string },
  ): Promise<ScrapedProduct[]> {
    assertShopCode(ctx.externalStoreId);

    // Отсчёт бюджета дёшевой фазы стартует ДО webgate, а не после него.
    // Иначе худший случай растягивается до 20 с (webgate) + 1,5 с (пауза) +
    // 30 с (бюджет HTML) = 51,5 с плюс Chromium — ровно то число, ради
    // устранения которого бюджет и вводился.
    const startedAt = Date.now();

    // Сначала API: он дешевле браузера и точнее по сверке точки.
    //
    // В HTML-фолбэк уходят ТОЛЬКО отрывы (5xx, обрыв, таймаут). Дрейф формата
    // и «ответ от чужого магазина» повтором не лечатся — это прямо написано
    // ниже в HTML-фазе, и правило должно действовать и для webgate: гнать их
    // дальше значит сделать ещё два запроса к сети и запустить Chromium ради
    // результата, которого не будет, а пользователю показать ошибку
    // соседнего пути вместо точной причины.
    //
    // ИСКЛЮЧЕНИЕ — деградация сети (webgate ответил 200, но товаров не
    // отдал, а сам сообщает, что совпадения есть). Это единственный случай,
    // когда стоит ДОЙТИ до браузера: клиентский рендер живого сайта видит
    // товары там, где API молчит. Если и браузер ничего не нашёл, сообщение
    // остаётся точным (см. конец функции), а не «ничего не нашлось».
    let degradedTotal: number | null = null;
    let webgateErr: unknown = null;
    try {
      const res = await this.searchViaWebgate(query, ctx, startedAt);
      if (res.degradedTotal === null) return res.products;
      degradedTotal = res.degradedTotal;
      console.error(
        `magnit webgate degraded (totalCount=${degradedTotal}), идём в HTML и браузер`,
      );
    } catch (err) {
      if (
        err instanceof WebgateDriftError ||
        /чужого магазина/.test(String(err))
      ) {
        throw err;
      }
      webgateErr = err;
      console.error('magnit webgate search failed, HTML fallback:', String(err).slice(0, 140));
    }

    // В WebView (Android) HTML-поиска нет по сути: сайт Магнита на клиентском
    // рендере, в HTML-оболочке товаров нет, и браузера в WebView тоже нет. Там
    // фолбэк тратит 12–20 с на ТОТ ЖЕ запрос и всё равно падает — на замере в
    // эмуляторе один товар занимал 33 с. Поэтому в нативной оболочке после
    // отказа webgate падаем сразу и честно: «нужен браузерный путь, а его
    // тут нет».
    //
    // Тексты разные, потому что разные причины: «не ответил» — сеть молчит,
    // «деградация» — сеть ответила, но выдала пустую витрину. Смешанный текст
    // вводил бы в заблуждение и breaker-лог, и пользователя.
    //
    // Проверка стоит ДО паузы между фазами: «честный отказ» должен быть и
    // быстрым, а 1,5 с ожидания на каждый упавший товар — это в проходе десятки
    // секунд чистого сна.
    if (isNativeShell()) {
      const cause = webgateErr === null ? '' : `, причина: ${String(webgateErr).slice(0, 140)}`;
      throw new Error(
        degradedTotal === null
          ? `magnit: webgate не ответил, а браузерного пути на этой платформе нет (Android WebView${cause})`
          : `magnit: сеть отдала пустую выдачу (totalCount=${degradedTotal}), а браузерного пути на этой платформе нет (Android WebView${cause})`,
      );
    }

    // Пауза между фазами: без неё в magnit.ru уходят три запроса подряд, а сеть
    // режет уже на третьем. От бюджета не отнимаем — пауза защитная, а не
    // часть попыток.
    await sleep(1500);

    // Именно `term`: с `query` сайт отдаёт популярные товары вместо выдачи.
    //
    // Прямой запрос повторяется ОДИН раз после паузы, и только потом идёт
    // браузер. Повтор — не паранойя, а следствие живой проверки 2026-11-11:
    // восемь запросов подряд прошли за 0.6–2.2 с каждый, а в полке та же сеть
    // дважды отвалилась на первом же запросе с «fetch failed» после 25-секундного
    // таймаута — то есть это был разовый сетевой сбой под нагрузкой (полка
    // бьёт шесть сетей параллельно). Браузерный фолбэк стоит дороже: это запуск
    // Chromium и отдельная навигация. Порядок «дешёвый повтор → дорогой фолбэк»
    // и означает, что случайный обрыв не стоит целого браузера.
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      // Бюджет ДЕШЁВОЙ фазы общий на обе попытки, а не на каждую: без него
      // систематический отказ растягивал запрос до 25 + 1.5 + 25 секунд, и в
      // полке это удваивалось на два страйка. Теперь вторая попытка получает
      // остаток бюджета, и при быстром обрыве (0.2–2 с) она почти не теряет
      // ничего, а при полной недоступности потолок держится.
      const left = directPhaseLeftMs(Date.now() - startedAt);
      if (left === null) break;
      try {
        const res = await httpFetch(magnitSearchUrl(query), {
          headers: this.headers(ctx.externalStoreId),
          timeoutMs: Math.min(25000, left),
        });
        if (!res.ok) throw new Error(`magnit search HTTP ${res.status}`);
        const html = await res.text();
        // Код, который сеть подтвердила ссылками на товары, едет в товар.
        // Сверка мягкая: пустая оболочка (сайт на клиентском рендере) — это
        // «идём в браузер», а чужая точка — громкий отказ (его выдаёт разбор
        // ниже, чтобы правило «чужой магазин» жило в одном месте).
        const { observed } = inspectOwnStore(html, ctx.externalStoreId);
        const goods = parseMagnitSearchGoods(html, ctx.externalStoreId, true);
        if (goods.length > 0) {
          // Товары есть, а код магазина ссылками не подтверждён. Отдавать такое
          // ядру нельзя: sentinel в товаре означал бы «доверяй запрошенной
          // точке», то есть цены неподтверждённого магазина уехали бы в историю
          // нашей точки. Молчаливый skip здесь хуже громкого отказа.
          if (observed === UNKNOWN_STORE_CODE) {
            throw new Error(
              'magnit: цены в ответе есть, а код магазина ссылками не показан — сверять точку нечем',
            );
          }
          if (attempt === 2) {
            console.log(`magnit: повтор помог, попытка 2, магазин ${ctx.externalStoreId}, ${Date.now() - startedAt}мс`);
          }
          return goodsToProducts(goods, ctx, observed);
        }
        // Пустой разбор. С 2026-10-18 это НЕ дрейф вёрстки, а обычное дело:
        // сайт на клиентском рендере, и в HTML выдачи нет — она рисуется
        // браузером. Поэтому страница без товаров уводит нас в браузер, а не
        // объявляется поломкой. Диагностика «смена вёрстки» остаётся на
        // случай, когда и браузер ничего не нашёл.
        throw new Error('magnit: search-парсер пуст, уходим в браузер');
      } catch (err) {
        // Блок по VPN, чужая точка и «сверять точку нечем» повтором не
        // лечатся: второй заход вернёт то же самое и только сожжёт бюджет, а
        // «сверять нечем» и вовсе ушёл бы в браузерный фолбэк — то есть
        // неподтверждённая выдача вернулась бы ценами нашей точки.
        if (/блок по IP|чужого магазина|сверять точку нечем/.test(String(err))) throw err;
        // Пустая оболочка (сайт на клиентском рендере) — не поломка, а
        // «идём в браузер»: там клиентский скрипт дорисует товары. Бросать
        // «смена вёрстки» здесь означало бы, что поиск Магнита не работает
        // вовсе — а он работает через webgate и через браузер.
        lastError = err;
        if (attempt === 1) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    console.error('magnit search fetch failed, playwright fallback:', String(lastError).slice(0, 120));
    const playwright = await importPlaywright();
    const browser = await playwright.chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ locale: 'ru-RU' });
      await context.addCookies([
        { name: 'shopCode', value: `"${ctx.externalStoreId}"`, domain: 'magnit.ru', path: '/' },
      ]);
      const page = await context.newPage();
      await page.goto(magnitSearchUrl(query), {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      try {
        await page.waitForSelector('article.unit-catalog-product-preview', { timeout: 30000 });
      } catch {
        // Деградация проверяется ДО разбора страницы: пустой рендер — типичный
        // вид деградации, и сообщение «страница почти пустая» скрыло бы настоящую
        // причину («сеть обещала совпадения, но не отдала»).
        if (degradedTotal !== null) {
          throw new EmptySearchError(
            `magnit: сеть отдала пустую выдачу (сообщает о ${degradedTotal} совпадениях) и браузер товар не нашёл — это сбой сети, а не «ничего не нашлось»`,
          );
        }
        await assertPageUsable(page, ctx.externalStoreId);
        // Браузер открыл страницу, а товаров на ней нет — это честная пустота
        // («по запросу ничего не нашлось»), а не поломка.
        return [];
      }
      await assertPageUsable(page, ctx.externalStoreId);
      const raw = await readCards(page, 12);
      assertCardsOwnStore(raw, ctx.externalStoreId);
      return cardsToProducts(raw, ctx, 12, ctx.externalStoreId);
    } finally {
      await browser.close().catch(() => {});
    }
  }

  /**
   * Карточка товара по webgate — тем же приёмом, что у Ленты: отдельного
   * эндпоинта карточки у Магнита нет (проверено 2026-10-18: `webgate/v2/goods/
   * <id>`, `v1/goods/<id>`, `v2/goods/product`, `v2/goods/info` → все 404),
   * поэтому товар ищется тем же `goods/search` по названию из нашей БД и
   * отбирается ПО `productId`.
   *
   * Почему не HTML-карточка как основной путь: она ЖИВА (живая проверка
   * 2026-10-19: страница `/product/<id>` отдаёт 200 и блок
   * `application/ld+json` с Product — sku, имя, `offers.price`), но для
   * `fetchProduct` она не годится: цена в JSON-LD приходит в РУБЛЯХ, тогда
   * как в webgate — в КОПЕЙКАХ, и путать их нельзя; и главное — карточка
   * отвечает на ВОПРОС «этот товар», а не «наш товар с этим названием», то
   * есть переименование она бы пропустила. Поэтому карточка ищется тем же
   * `goods/search` по названию из нашей БД и отбирается ПО `productId`.
   *
   * HTML-карточка остаётся ФОЛБЭКОМ, и он рабочий: если webgate отказал,
   * цена всё равно соберётся — из JSON-LD, в рублях.
   *
   * Различение причин обязательно: товар есть в выдаче, но не наш, либо
   * выдача пуста при `totalCount: 0` → `ProductLookupError` (товар
   * переименован/снят, паузу сети не ставим); пусто при ненулевом
   * `totalCount` или без поля — обычная ошибка, чтобы breaker поставил сети
   * паузу.
   */
  private async fetchProductViaWebgate(
    canonicalId: string,
    ctx: { city: string; externalStoreId: string; name?: string },
  ): Promise<ScrapedProduct> {
    const id = canonicalId.replace(/^magnit-/, '');
    const shopCode = ctx.externalStoreId;
    // Названия нет — искать нечем (сеть ищет по тексту, гадать по id бессмысленно).
    // Это дыра в НАШИХ данных, а не отказ сети, поэтому `ProductLookupError`:
    // планировщик не растит strike за неё и не выключает Магнит из-за пробела
    // в базе (тот же прецедент, что у Ленты).
    if (!ctx.name || !ctx.name.trim()) {
      throw new ProductLookupError(
        `magnit: у товара ${id} нет названия — искать по webgate нечем`,
        canonicalId,
      );
    }
    const res = await httpFetch('https://magnit.ru/webgate/v2/goods/search', {
      method: 'POST',
      headers: this.jsonHeaders(shopCode),
      body: buildSearchBody(ctx.name, shopCode),
      // Потолок такой же, как в поиске: на телефоне 20 с на товар — это минуты
      // молчания в проходе, а мобильная сеть отвечает медленнее.
      timeoutMs: isNativeShell() ? 10000 : 20000,
    });
    if (!res.ok) throw new Error(`magnit webgate product HTTP ${res.status}`);
    const raw = safeJsonParse(await res.text());
    if (raw === NOT_JSON) throw new Error('magnit webgate ответил не JSON (WAF-страница?)');
    const products = parseWebgateSearch(raw, shopCode);
    // Пустая выдача сама по себе НЕ доказывает переименование: сеть может
    // просто деградировать (200 + пусто — тот же класс, что у Ленты). Решаем
    // по `pagination.totalCount`: 0 — совпадений по названию нет вовсе
    // (переименование/снятие, паузу сети не ставим); неноль — сбой сети;
    // отсутствие поля — дрейф формы (документированная форма ответа его несёт).
    // Все три ответа УЖЕ получены, поэтому уходить с них в HTML-фолбэк нельзя:
    // повторный запрос лишь замедляет опрос и маскирует причину.
    if (products.length === 0) {
      const total = (raw as { pagination?: { totalCount?: unknown } }).pagination?.totalCount;
      if (typeof total === 'number' && total === 0) {
        throw new ProductLookupError(
          `magnit: товар ${id} не нашёлся в выдаче по названию «${ctx.name}» (totalCount=0)`,
          canonicalId,
        );
      }
      if (typeof total !== 'number') {
        throw new WebgateDriftError(
          'magnit: в ответе webgate/v2/goods/search нет pagination.totalCount (смена формы ответа), выдача пуста',
        );
      }
      throw new EmptySearchError(
        `magnit: webgate вернул пустую выдачу при totalCount=${total} — сбой сети, а не переименование товара`,
      );
    }
    const found = products.find((p) => p.id === id);
    if (!found) {
      throw new ProductLookupError(
        `magnit: товар ${id} не нашёлся в выдаче по названию «${ctx.name}»`,
        canonicalId,
      );
    }
    const collectedAt = new Date().toISOString();
    return {
      canonicalId: `magnit-${found.id}`,
      name: found.title,
      price: found.price,
      oldPrice: found.oldPrice,
      ...(found.inStock !== undefined ? { inStock: found.inStock } : {}),
      url: found.url,
      storeId: 'magnit',
      city: ctx.city,
      storeCode: found.observedShopCode,
      collectedAt,
      ...(found.imageUrl ? { imageUrl: found.imageUrl } : {}),
    };
  }

  async fetchProduct(
    canonicalId: string,
    ctx: { city: string; externalStoreId: string; name?: string },
  ): Promise<ScrapedProduct> {
    const id = canonicalId.replace(/^magnit-/, '');
    // Сначала API. Переименование, дрейф и подмена точки пробрасываются
    // наружу сразу: второй поиск того же товара ничего не изменит, а пауза
    // 1.5 с на каждую такую ошибку лишь замедляет опрос и МАСКИРУЕТ причину.
    let webgateErr: unknown = null;
    try {
      return await this.fetchProductViaWebgate(canonicalId, ctx);
    } catch (err) {
      if (
        isProductLookupError(err) ||
        err instanceof WebgateDriftError ||
        err instanceof EmptySearchError ||
        /чужого магазина/.test(String(err))
      ) {
        throw err;
      }
      webgateErr = err;
      console.error('magnit webgate product failed, HTML fallback:', String(err).slice(0, 140));
      await sleep(1500);
    }
    // Фолбэк, и он РАБОТАЕТ (живая проверка 2026-10-19: страница
    // `/product/<id>` отдаёт 200 и блок `application/ld+json` с Product —
    // sku, имя, `offers.price` в РУБЛЯХ; `normalizeMagnitProduct` на нём
    // даёт canonicalId `magnit-<id>` и цену). Он нужен на случай, когда
    // webgate отказал: цена всё равно соберётся. Потолок запроса урезан
    // (12 с вместо 25), потому что при зависшем magnit.ru лишние 25 с на
    // КАЖДЫЙ товар съедали бы весь проход опроса. Причина ухода с API едет в
    // тексте ошибки — иначе breaker-логи писали бы «сменилась вёрстка» при
    // живом обрыве или WAF.
    //
    // Отказываться от этого пути на Android НЕЛЬЗЯ: карточка отдаётся обычным
    // HTTP-клиентом (без браузера и без CORS — нативный слой), то есть
    // WebView-оболочка тут не мешает. Ранний отказ «фолбэк бесполезен» срезал
    // бы рабочий путь сбора цены именно на телефоне.
    const cause = String(webgateErr).slice(0, 160);
    let html = '';
    let htmlUrl = '';
    try {
      const res = await httpFetch(`https://magnit.ru/product/${encodeURIComponent(id)}`, {
        headers: this.headers(ctx.externalStoreId),
        // Потолок одинаковый на всех платформах: страница карточки — около
        // 600 КБ, и на медленной мобильной сети короткий потолок обрывал бы её
        // на середине. Экономим не здесь, а на HTML-фолбэке ПОИСКА, которого на
        // Android нет вовсе (см. выше).
        timeoutMs: 12000,
      });
      if (!res.ok) throw new Error(`magnit product HTTP ${res.status}`);
      if (!/\/product\//.test(res.url)) {
        throw new Error(`magnit: ушёл с /product/ на ${res.url.slice(0, 80)}`);
      }
      html = await res.text();
      htmlUrl = res.url;
    } catch (htmlErr) {
      throw new Error(`${String(htmlErr).slice(0, 200)} (вектор: ${cause})`);
    }
    const observed = assertOwnStore(html, ctx.externalStoreId);
    // Карточка товара — единственный путь, где код магазина подтвердить нечем
    // в принципе: страница одного товара не несёт ссылок на витрину, и в живой
    // выдаче `/product/` маркера нет (проверено на фикстуре API-карточки,
    // links: 0). Отказывать здесь нельзя — тогда бы опрос не работал ни для
    // одного товара Магнита. Поэтому подтверждённый код едет в товар, а
    // неподтверждённый остаётся sentinel и попадает в лог: видно, что точка не
    // верифицирована.
    if (observed === UNKNOWN_STORE_CODE) {
      warnNoStoreMarker(ctx.externalStoreId);
    }
    for (const block of extractJsonLd(html)) {
      const blocks =
        typeof block === 'object' && block !== null && '@graph' in block
          ? (block as { '@graph': unknown[] })['@graph']
          : [block];
      for (const b of blocks) {
        if (typeof b !== 'object' || b === null) continue;
        const p = b as MagnitProductLd & { '@type'?: string };
        if (p['@type'] !== 'Product' && p.sku == null) continue;
        const norm = normalizeMagnitProduct(p, {
          city: ctx.city,
          url: htmlUrl,
          externalStoreId: ctx.externalStoreId,
          storeCode: observed,
        });
        if (norm && norm.canonicalId === canonicalId) return norm;
      }
    }
    // Причина ухода с API сохраняется в тексте: без неё breaker-логи писали бы,
    // что вёрстка сменилась, когда настоящая причина — обрыв, 5xx или WAF в
    // API. Причина здесь всегда есть: до этой строки доходит только ветка, где
    // webgate уже ответил и упал (успех вернулся выше).
    throw new Error(
      `magnit: Product JSON-LD не найден (возможно, смена вёрстки). Причина ухода с API: ${cause}`,
    );
  }

  async fetchCategories(ctx: { city: string; externalStoreId: string }): Promise<MagnitCategory[]> {
    assertShopCode(ctx.externalStoreId);
    // Сначала HTML-главная: ТОЛЬКО в ней витрина идёт с картинками, и id
    // плиток живые. Замер с телефона (2026-10-21): главная отдаёт 200 и 1,2 МБ
    // с восемью плитками верхнего уровня («Скидки», «Готовая еда», «Бакалея»,
    // «Молочное», «Овощи», «Птица, мясо», «Сладкое», «Сыры»), у каждой своя
    // картинка, id живые (`/catalog/64121` и `/catalog/63991` отдают 200), а
    // сверка точки проходит: в теле есть код нашего магазина.
    //
    // Раньше первым шёл API-дерево, и это было ошибкой: у его ЛИСТЬЕВ («Бакалея»,
    // «Заморозка», «Кофе»…) картинок в ответе нет вовсе, поэтому витрина
    // получалась пустой, а кэш витрины из-за этого не писался — и на телефоне
    // картинок не было видно.
    try {
      const res = await httpFetch('https://magnit.ru/', {
        headers: this.headers(ctx.externalStoreId),
        timeoutMs: 20000,
      });
      if (!res.ok) throw new Error(`magnit categories HTTP ${res.status}`);
      const html = await res.text();
      const cats = parseMagnitCategories(html, ctx.externalStoreId);
      if (cats.length > 0) return cats;
    } catch (err) {
      console.error('magnit html categories failed, webgate fallback:', String(err).slice(0, 140));
    }
    // Запасной путь — API-дерево: листья конкретных категорий, но без картинок.
    const res = await httpFetch(
      `https://magnit.ru/webgate/v3/categories/store/${encodeURIComponent(ctx.externalStoreId)}` +
        '?storetype=express&catalogtype=3',
      { headers: this.jsonHeaders(ctx.externalStoreId), timeoutMs: 20000 },
    );
    if (!res.ok) throw new Error(`magnit webgate categories HTTP ${res.status}`);
    const catsRaw = safeJsonParse(await res.text());
    if (catsRaw === NOT_JSON) throw new Error('magnit webgate каталог ответил не JSON (WAF-страница?)');
    return parseWebgateCategories(catsRaw).map((c) => ({
      id: c.id,
      name: c.name,
      url: `https://magnit.ru/catalog/${encodeURIComponent(c.id)}`,
      ...(c.imageUrl ? { imageUrl: c.imageUrl } : {}),
    }));
  }

  canHandleCategoryUrl(categoryUrl: string): boolean {
    return /^https:\/\/magnit\.ru\/(promo-)?catalog\//.test(categoryUrl);
  }

  async fetchCategoryProducts(
    categoryUrl: string,
    ctx: { city: string; externalStoreId: string },
  ): Promise<ScrapedProduct[]> {
    if (!this.canHandleCategoryUrl(categoryUrl)) {
      throw new Error('magnit: categoryUrl вне каталога');
    }
    assertShopCode(ctx.externalStoreId);
    const res = await httpFetch(categoryUrl, {
      headers: this.headers(ctx.externalStoreId),
      timeoutMs: 25000,
    });
    if (!res.ok) throw new Error(`magnit category HTTP ${res.status}`);
    if (!res.url.startsWith('https://magnit.ru/')) {
      throw new Error(`magnit: ушёл с magnit.ru на ${res.url.slice(0, 80)}`);
    }
    const html = await res.text();
    const unconfirmed = { count: 0 };
    const fromLd = extractCategoryOffers(
      html,
      { city: ctx.city, shopCode: ctx.externalStoreId },
      unconfirmed,
    );
    if (fromLd.length > 0) return fromLd;
    // Пауза перед браузерным фолбэком: только что был запрос в magnit.ru, и
    // навигация браузера по тому же домену через миллисекунды — это ровно тот
    // рисунок, за который сеть банит.
    await sleep(BROWSER_FALLBACK_PAUSE_MS);
    const playwright = await importPlaywright();
    const browser = await playwright.chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ locale: 'ru-RU' });
      await context.addCookies([
        { name: 'shopCode', value: `"${ctx.externalStoreId}"`, domain: 'magnit.ru', path: '/' },
      ]);
      const page = await context.newPage();
      await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      try {
        await page.waitForSelector('article.unit-catalog-product-preview', { timeout: 30000 });
      } catch {
        await assertPageUsable(page, ctx.externalStoreId);
        if (unconfirmed.count > 0) throw unconfirmedShelf(unconfirmed.count, ctx.externalStoreId);
        return [];
      }
      await assertPageUsable(page, ctx.externalStoreId);
      const raw = await readCards(page, 32);
      assertCardsOwnStore(raw, ctx.externalStoreId);
      return cardsToProducts(raw, ctx, 32, ctx.externalStoreId);
    } finally {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * «Витрина пуста» и «точку не подтвердили» — разные вещи, и путать их нельзя:
 * прямой ответ содержал N ценённых товаров, мы их выбросили по инварианту, и
 * браузерный фолбэк тоже ничего не нашёл. Молча вернуть пустой массив значило
 * показать пользователю «товаров нет» вместо правды.
 */
function unconfirmedShelf(count: number, shopCode: string): Error {
  return new Error(
    `magnit: витрина отдала ${count} товаров, но код магазина ссылками не подтверждён (точка ${shopCode}) — цены не показаны`,
  );
}

export function extractCategoryOffers(
  html: string,
  ctx: { city: string; shopCode: string },
  /** Сколько товаров слинковано, но код магазина не подтверждён (см. ниже). */
  unconfirmed?: { count: number },
): ScrapedProduct[] {
  const observed = assertOwnStore(html, ctx.shopCode);
  const promos = parseMagnitCategoryPromos(html, ctx.shopCode);
  const out: ScrapedProduct[] = [];
  for (const block of extractJsonLd(html)) {
    const b = block as { '@type'?: string; itemListElement?: MagnitOffer[] };
    if (b['@type'] !== 'OfferCatalog' || !Array.isArray(b.itemListElement)) continue;
    for (const raw of b.itemListElement.slice(0, 32)) {
      const id = raw.url ? idFromUrl(raw.url) : null;
      const norm = normalizeMagnitOffer(
        raw,
        { city: ctx.city, externalStoreId: ctx.shopCode },
        id ? (promos.get(id) ?? null) : null,
      );
      if (norm) out.push(norm);
    }
  }
  // Товары витрины есть, а код магазина ссылками не подтверждён. Отдавать их
  // нельзя: sentinel в товаре означал бы «доверяй запрошенной точке», то есть
  // цены неподтверждённого магазина уехали бы в историю нашей точки.
  //
  // Но бросать здесь тоже нельзя: JSON-LD витрины и пейлоад __NUXT_DATA__ —
  // два независимых носителя, дрейф именно пейлоада (для Магнита он уже был)
  // уронил бы полку целиком, минуя браузерный фолбэк, где своя сверка по
  // quoted-коду. Поэтому возвращаем пусто: фолбэк отработает и либо найдёт
  // товары со сверкой, либо честно скажет, что витрины нет.
  if (out.length > 0 && observed === UNKNOWN_STORE_CODE) {
    warnNoStoreMarker(ctx.shopCode);
    if (unconfirmed) unconfirmed.count = out.length;
    return [];
  }
  return out;
}
