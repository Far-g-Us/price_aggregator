import type { ScrapedProduct, StoreAdapter } from '../../shared/types.js';
import { CITY_TO_SLUG, LENTA_REGIONS } from '../../shared/lenta-regions.js';
import { ProductLookupError } from '../adapter-errors.js';

/** Ответ сети обязан быть про того же товара, о котором просили. */
export function assertLentaAnswered(canonicalId: string, product: ScrapedProduct): void {
  if (product.canonicalId !== canonicalId) {
    throw new Error(`lenta: просили ${canonicalId}, а ответ по ${product.canonicalId}`);
  }
}

export const LENTA_ORIGIN = 'https://lenta.com';
export const LENTA_API = `${LENTA_ORIGIN}/api-gateway/v1`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0';
const CLIENT = 'angular_web_0.0.2';
const APP_VERSION = '0.0.2';
const RELEASE_VERSION = 'web-12.0.823';
// Публичный client id веб-клиента из бандла lenta.com (снят 2026-09-29), не
// секрет пользователя: он лежит в JS сайта и в его HAR.
const MARKETING_PARTNER_KEY = 'mp300-b1de0bac2c257f3257bf5ef2eea4ecbc';
const DELIVERY_MODE = 'pickup';
const TIMEOUT_MS = 25000;
const REQUEST_GAP_MS = 2000;
// Привязка сессии к магазину подтверждается не на весь процесс, а раз в TTL.
const STORE_BIND_TTL_MS = 20 * 60 * 1000;
// Сессия — не бессрочная. Процесс живёт днями (опрос каждые 6 ч), токен сети
// протухает, и без TTL кэш отдавал бы мёртвую сессию до перезапуска.
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// X-Domain — это slug РЕГИОНА, а не id города из CITY_STORES: у Ленты СПб —
// «spb», Краснодар — «ksdr», Ульяновск — «ulyanovsk». Подставить свой id нельзя,
// всё кроме Москвы уехало бы в 401. Справочник регионов с живыми id/slug — в
// src/shared/lenta-regions.ts, его пересобирает scripts/gen-lenta-regions.mjs.
export function lentaDomain(
  city: string,
  regions: readonly { slug: string | null }[] = LENTA_REGIONS,
): string {
  const slug = CITY_TO_SLUG[city];
  if (!slug) throw new Error(`lenta: нет региона для города ${city} (см. lenta-regions.ts)`);
  if (!regions.some((r) => r.slug === slug)) {
    throw new Error(`lenta: регион «${slug}» не найден в справочнике (пересобери: npm run lenta:regions)`);
  }
  return slug;
}

export function assertLentaStoreId(raw: string): string {
  if (!/^\d+$/.test(raw)) throw new Error(`lenta: код магазина не число: ${raw}`);
  return raw;
}

// У Ленты ДВЕ независимые нумерации точки: id (4161) и alias ("3090", у части
// магазинов с ведущим нулём — "0037"). Ни одна не выводится из другой: в
// stores/pickup/search (1018 точек) id === Number(alias) не совпало ни разу.
// Поэтому сверять ответ с нашим магазином можно только тем числом, которое
// сайт сам отдал вместе с магазином, — alias из delivery/mode.
export function sameLentaStore(a: string | number | undefined, b: string | number | undefined): boolean {
  if (a == null || b == null) return false;
  const sa = String(a);
  const sb = String(b);
  if (!/^\d+$/.test(sa) || !/^\d+$/.test(sb)) return false;
  return Number(sa) === Number(sb);
}

export function kopecksToRub(v: number | null | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v / 100;
}

export interface LentaPrices {
  cost?: number;
  costRegular?: number;
  price?: number;
  priceRegular?: number;
  isLoyaltyCardPrice?: boolean;
  isPromoactionPrice?: boolean;
  isQuantPrice?: boolean;
}

export interface LentaItem {
  id?: number | string | undefined;
  name?: string | undefined;
  slug?: string | undefined;
  storeId?: number | string | undefined;
  count?: number | null | undefined;
  prices?: LentaPrices | undefined;
  // Вес в граммах приходит ДВУМЯ способами (снято 2026-10-01, выдача jrpc):
  // `weight.net` в карточке и `netWeight` верхним уровнем в выдаче. Раньше
  // читался только `weight.net`, и в выдаче он всегда был undefined → весовой
  // товар уходил в историю по обычной цене фасовки вместо цены за килограмм.
  weight?: { package?: string | undefined; net?: number | undefined; gross?: number | undefined } | undefined;
  netWeight?: number | undefined;
  package?: string | undefined;
  isBlockedForSale?: boolean | undefined;
  saleLimit?: { maxSaleQuantity?: number | undefined; minSaleQuantity?: number | undefined } | undefined;
  // `features` в выдаче несёт isBlockedForSale (2026-10-01), в карточке флаг
  // лежит верхним уровнем. Поэтому наличие проверяется по обоим местам.
  features?:
    | {
        isWeight?: boolean | undefined;
        isPromo?: boolean | undefined;
        isBlockedForSale?: boolean | undefined;
      }
    | undefined;
  unitName?: string | undefined;
  images?: { preview?: string | undefined; large?: string | undefined; original?: string | undefined }[] | undefined;
  attributes?: { alias?: string | undefined; name?: string | undefined; value?: string | undefined }[] | undefined;
}

// Выдача поиска (jrpc/searchItems) и карточка (catalog/items/{id}) — это
// РАЗНЫЕ формы одного товара: в выдаче фасовка лежит в `package`, а бренда и
// описания нет вовсе; в карточке наоборот — `weight.package` и `attributes[]`.
export interface LentaSearchResponse {
  result?: {
    items?: LentaItem[];
    total?: number;
    categories?: {
      id?: number | string;
      name?: string;
      level?: number;
      parentId?: number | string;
      parentName?: string;
      hasChildren?: boolean;
      slug?: string;
      imageUrl?: string;
    }[];
  };
  error?: { code?: number | string; message?: string };
}

const SEARCH_LIMIT = 12;

export interface LentaStoreRef {
  id?: number | string;
  alias?: string;
  selected?: boolean;
  marketType?: string;
  regionId?: number;
  title?: string;
}

export interface LentaDeliveryMode {
  storeId?: number | string;
  type?: string;
  userStores?: LentaStoreRef[];
}

export function lentaProductUrl(slug: string | undefined, id: string | number): string {
  if (!slug) return `${LENTA_ORIGIN}/product/${id}/`;
  const tail = `-${id}`;
  const path = slug.endsWith(tail) ? slug : `${slug}${tail}`;
  return `${LENTA_ORIGIN}/product/${encodeURIComponent(path)}/`;
}

export function lentaItemId(canonicalId: string): string {
  const id = canonicalId.replace(/^lenta-/, '');
  if (!/^\d+$/.test(id)) throw new Error(`lenta: нечисловой id товара: ${canonicalId}`);
  return id;
}

// Запросы для поиска товара по названию: сначала полное имя (оно даёт total=1,
// то есть один запрос на товар — столько же, сколько стоила бы карточка), при
// неудаче обрезанное. Обрезаем НЕ по пробелу: у выдачи сеть сортирует по
// релевантности, и обрезка по пробелу оставляет ровно те длинные названия,
// которые мы ищем, но теряет товары с длинным названием без пробелов.
export const PRODUCT_SEARCH_PAGE = 48;

export function lentaNameQueries(name: string): string[] {
  const full = name.trim();
  if (!full) return [];
  const out = [full];
  for (const cut of [40, 25]) {
    if (full.length > cut) out.push(full.slice(0, cut).trim());
  }
  return out;
}

// Тело jrpc-вызова. categoryId здесь НЕ передаём: с categoryId: 0 сеть
// отвечает 200 и total: 0 — то есть тихо отдаёт пустую выдачу вместо ошибки
// (проверено живьём 2026-09-29). Отдельная функция, чтобы это зафиксировать
// тестом, а не только комментарием.
export function lentaSearchBody(query: string, count: number): {
  method: string;
  params: { query: string; count: number; offset: number; filters: unknown[] };
  jsonrpc: string;
} {
  return {
    method: 'searchItems',
    params: { query, count, offset: 0, filters: [] },
    jsonrpc: '2.0',
  };
}

export function aliasFromDeliveryMode(mode: LentaDeliveryMode, storeId: string): string {
  const stores = mode.userStores ?? [];
  const selected = stores.find((s) => s.selected === true && sameLentaStore(s.id, storeId));
  const any = selected ?? stores.find((s) => sameLentaStore(s.id, storeId));
  const alias = any?.alias;
  if (alias == null || !/^\d+$/.test(alias)) {
    throw new Error(
      `lenta: магазин ${storeId} не вернулся в delivery/mode (нужен его alias для сверки ответов)`,
    );
  }
  return alias;
}

// Маркер магазина есть НЕ везде: в карточке (catalog/items/{id}) это alias,
// а в выдаче поиска (jrpc/searchItems) маркера нет вообще — ни в теле, ни в
// заголовках ответа (проверено живьём 2026-09-29). Там привязка держится
// только на сессии, поэтому сверять нечего. `required` различает формы:
// карточка маркер обязана нести, выдача поиска — нет.
export function assertLentaItemStore(
  item: LentaItem,
  alias: string | null,
  canonicalId: string,
  required = true,
): void {
  if (item.storeId == null) {
    if (required) throw new Error(`lenta: в ответе нет storeId для ${canonicalId} (смена API?)`);
    return;
  }
  if (alias === null) return;
  if (!sameLentaStore(item.storeId, alias)) {
    throw new Error(
      `lenta: ответ по чужому магазину (storeId=${String(item.storeId)} вместо ${alias}) для ${canonicalId}`,
    );
  }
}

function attributeValue(item: LentaItem, alias: string): string | undefined {
  for (const a of item.attributes ?? []) {
    if (a.alias === alias && typeof a.value === 'string' && a.value.trim()) return a.value.trim();
  }
  return undefined;
}

// Наличие: признак «продажа заблокирована» лежит в ДВУХ местах — верхним
// уровнем в карточке и в `features` в выдаче поиска (снято 2026-10-01: в
// выдаче верхнего уровня нет, в features.isBlockedForSale есть). Поэтому
// смотрим оба. `count` — остаток, НЕ лимит заказа: в живой выдаче 2026-09-29
// он больше saleLimit.maxSaleQuantity (22 против 5), то есть поля независимы.
// При отсутствии count наличия не выдумываем.
export function isLentaInStock(item: LentaItem): boolean {
  if (item.isBlockedForSale === true) return false;
  if (item.features?.isBlockedForSale === true) return false;
  return item.count == null ? true : item.count > 0;
}

// Цена весового товара (снято 2026-10-01, 10 весовых товаров из выдачи 4161,
// совпадение 10 из 10): `prices.price` — цена ЗА ФАСОВКУ (то есть за указанный
// вес), `prices.cost` — цена ЗА КИЛОГРАММ. Проверялось умножением:
// price = cost × netWeight/1000 (531,98 = 279,99 × 1,9; 199,99 = 249,99 × 0,8).
//
// Раньше здесь стояло обратное правило «для весового брать cost», выведенное
// из сервиса цен сайта 2026-09-29 — на весовом товаре оно никогда не
// проверялось (фикстура карточки была печенье) и давало бы 279,99 ₽ вместо
// 531,98 ₽ за тушку. Теперь cost уходит в unitPrice («279,99 ₽/кг»), а price
// остаётся ценой товара.
//
// Зачёркнутая цена берётся из priceRegular, а не из costRegular: priceRegular
// — гарантированно цена за ту же фасовку, а соответствие costRegular и
// priceRegular сетью не гарантировано.
export interface LentaPriceSet {
  price: number | undefined;
  regular: number | undefined;
  perKg?: number | undefined;
  perKgRegular?: number | undefined;
  netGrams?: number | undefined;
}

export function lentaWeightGrams(item: LentaItem): number {
  const fromCard = item.weight?.net;
  if (typeof fromCard === 'number' && fromCard > 0) return fromCard;
  return typeof item.netWeight === 'number' && item.netWeight > 0 ? item.netWeight : 0;
}

export function isLentaWeighed(item: LentaItem): boolean {
  return item.features?.isWeight === true && lentaWeightGrams(item) > 0;
}

export function lentaPricePair(item: LentaItem): LentaPriceSet {
  const p = item.prices ?? {};
  if (isLentaWeighed(item)) {
    return {
      price: p.price,
      regular: p.priceRegular,
      perKg: p.cost,
      perKgRegular: p.costRegular,
      netGrams: lentaWeightGrams(item),
    };
  }
  return { price: p.price, regular: p.priceRegular };
}

/**
 * «1,9 кг» из веса в граммах. Единица всегда кг: функция вызывается только
 * для весового товара, а netWeight приходит в граммах. Раньше тут стоял
 * тернарник `unitName === 'кг' ? 'кг' : unitName`, который при unitName «г» или
 * «шт» давал «0,8 г» вместо «0,8 кг» — и это уезжало в products.unit и в
 * склейку с другими сетями.
 */
export function lentaWeightLabel(item: LentaItem): string | undefined {
  const grams = lentaWeightGrams(item);
  if (!grams) return undefined;
  const kg = grams / 1000;
  const value = Number.isInteger(kg) ? String(kg) : kg.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return `${value.replace('.', ',')} кг`;
}

export function normalizeLentaItem(
  item: LentaItem,
  ctx: { city: string },
  alias: string | null,
  requiredMarker = true,
): ScrapedProduct | null {
  const id = item.id;
  if (id == null || !item.name) return null;
  const canonicalId = `lenta-${id}`;
  assertLentaItemStore(item, alias, canonicalId, requiredMarker);
  const pair = lentaPricePair(item);
  const price = kopecksToRub(pair.price);
  if (price === null) return null;
  const regular = kopecksToRub(pair.regular);
  const product: ScrapedProduct = {
    canonicalId,
    storeId: 'lenta',
    city: ctx.city,
    name: item.name,
    price,
    // promoPrice всегда null: цена по акции У Ленты — это и есть prices.price
    // (сайт показывает ровно его), а зачёркнутая — prices.priceRegular.
    // Писать promoPrice === price бессмысленно, БД всё равно отбрасывает
    // значение, равное цене (savePriceIfChanged ждёт promo < price).
    promoPrice: null,
    oldPrice: regular !== null && regular > price ? regular : null,
    inStock: isLentaInStock(item),
    url: lentaProductUrl(item.slug, id),
    collectedAt: new Date().toISOString(),
  };
  const brand = attributeValue(item, 'brand');
  if (brand) product.brand = brand;
  const description = attributeValue(item, 'description');
  if (description) product.description = description;
  // Фасовка: у весового товара в выдаче `package` пустой, а вес лежит в
  // netWeight + unitName («кг»). Без этого в склейке с Магнитом/Пятёркой у
  // весового товара не будет фасовки вообще.
  const pack = item.weight?.package || item.package || lentaWeightLabel(item);
  if (pack) product.unit = pack;
  // Цена за килограмм у весового товара — полезная ровно тем, что price у него
  // это цена за указанный вес, а не за килограмм. Копейки здесь оставляем: у
  // Магнита unitPrice приходит строкой с копейками («106,45 ₽/л»), и округлять
  // 279,99 до «280 ₽/кг» значило бы врать о цене за кг.
  const perKg = kopecksToRub(pair.perKg);
  if (pair.perKg != null && perKg !== null) {
    product.unitPrice = `${perKg.toFixed(2).replace('.', ',')} ₽/кг`;
  }
  const image = item.images?.[0];
  const imageUrl = image?.large ?? image?.preview ?? image?.original;
  if (imageUrl) product.imageUrl = imageUrl;
  return product;
}

export function normalizeLentaSearch(
  raw: LentaSearchResponse,
  ctx: { city: string },
  alias: string | null,
  limit: number,
): ScrapedProduct[] {
  const items = raw.result?.items;
  if (!items) throw new Error('lenta: searchItems без result (смена API?)');
  const out: ScrapedProduct[] = [];
  for (const item of items) {
    if (out.length >= limit) break;
    // Выдача jrpc маркера магазина не несёт (см. assertLentaItemStore).
    const p = normalizeLentaItem(item, ctx, alias, false);
    if (p) out.push(p);
  }
  // Пустой ответ — это «не нашлось», а вот непустой ответ, из которого не
  // нормализовалось ничего, — смена формата. Молча возвращать [] нельзя:
  // это тот же класс ловушки, что `?query=` у Магнита.
  if (items.length > 0 && out.length === 0) {
    throw new Error('lenta: searchItems вернул товары без цен (смена формата ответа?)');
  }
  return out;
}

interface LentaSession {
  sessionToken: string;
  deviceId: string;
  domain: string;
  city: string;
  boundStoreId: string | null;
  boundAt: number;
  at: number;
}

let lastRequestAt = 0;
let requestGapMs = REQUEST_GAP_MS;

/**
 * Ручка для тестов: пауза между запросами к сети. По умолчанию — настоящая
 * `REQUEST_GAP_MS`, и в приложении она никем не меняется. Тесты выставляют 0,
 * иначе набор из полусотни запросов ждал бы две минуты впустую, — а отдельный
 * тест проверяет, что пауза реально выдерживается.
 */
export function __setRequestGapMsForTests(ms: number): void {
  requestGapMs = ms;
}

async function pace(): Promise<void> {
  const wait = requestGapMs - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

function describeStatus(res: Response, url: string): string {
  if (res.status === 401 || res.status === 403) {
    return `lenta: ${url} -> HTTP ${res.status} (Qrator/WAF). С этой сети fetch не проходит, нужна домашняя сеть или браузерный транспорт.`;
  }
  return `lenta: ${url} -> HTTP ${res.status}`;
}

async function jsonOrThrow(res: Response, url: string): Promise<unknown> {
  const raw = await res.text();
  if (raw.trim() === '') throw new Error(`lenta: ${url} вернул пустой ответ (${res.status})`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`lenta: ${url} вернул не JSON (${res.status}, ${raw.slice(0, 80)})`);
  }
}

export class LentaAdapter implements StoreAdapter {
  readonly storeId = 'lenta' as const;

  private sessions = new Map<string, LentaSession>();
  private inflight = new Map<string, Promise<LentaSession>>();
  private aliases = new Map<string, string | null>();
  private warnedAboutWaf = false;
  private wafBlocksApiGateway = false;

  private headers(session: LentaSession, json: boolean): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/json',
      'Accept-Language': 'ru-RU,ru;q=0.9',
      'User-Agent': UA,
      Referer: `${LENTA_ORIGIN}/`,
      Origin: LENTA_ORIGIN,
      SessionToken: session.sessionToken,
      DeviceID: session.deviceId,
      'X-Device-Id': session.deviceId,
      'X-Retail-Brand': 'lo',
      'X-Platform': 'omniweb',
      'X-Device-OS': 'Web',
      'X-Delivery-Mode': DELIVERY_MODE,
      'X-Query-Host': 'lenta.com',
      'App-Version': APP_VERSION,
      'X-Domain': session.domain,
      Client: CLIENT,
      MarketingPartnerKey: MARKETING_PARTNER_KEY,
      'X-Device-Web-Platform': 'desktop_web',
    };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private async request<T>(
    url: string,
    init: { method: 'GET' | 'POST'; body?: unknown; session: LentaSession; form?: string },
    retryOnAuth = true,
  ): Promise<T> {
    await pace();
    const headers = this.headers(init.session, init.body !== undefined);
    if (init.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const init2: RequestInit = {
      method: init.method,
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    };
    const payload = init.form ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
    if (payload !== undefined) init2.body = payload;
    const res = await fetch(url, init2);
    if (!res.ok) {
      if (res.status === 409) {
        const why = await res.text();
        throw new Error(`lenta: магазин не принят сетью (${url}): ${why.slice(0, 120)}`);
      }
      // Сессия протухает, а процесс живёт днями (опрос каждые 6 ч). Без
      // пересоздания Лента умирала бы навсегда до перезапуска приложения:
      // токен не обновляем, кэш сессий не инвалидируем. Поэтому на 401/403
      // роняем сессию и повторяем запрос один раз. Исключение — `delivery/mode`:
      // этот GET Qrator режет всегда, повторять его бессмысленно (флажок
      // wafBlocksApiGateway выставляется в alias()).
      if (retryOnAuth && (res.status === 401 || res.status === 403) && !url.endsWith('/delivery/mode')) {
        if (this.sessions.get(init.session.city) === init.session) {
          this.sessions.delete(init.session.city);
          const fresh = await this.session(init.session.city);
          if (fresh !== init.session) return this.request<T>(url, { ...init, session: fresh }, false);
        }
      }
      throw new Error(describeStatus(res, url));
    }
    return (await jsonOrThrow(res, url)) as T;
  }

  // Сессия — это POST /api/rest/sessionGet (его же зовёт сайт при первом
  // входе; в ответе приходит Set-Cookie Utk_SssTkn с тем же токеном).
  // Юзеровые JWT (PassportAccessToken/RefreshToken) сети не нужны и в
  // приложении не хранятся. DeviceId в Head ОБЯЗАТЕЛЕН: без него сеть
  // отвечает 200, но Status: failure и Utkapi_Exception_EmptyDeviceId —
  // то есть тихо, без ошибки на нашей стороне.
  private async session(city: string): Promise<LentaSession> {
    const cached = this.sessions.get(city);
    // TTL обязателен: процесс живёт днями, а токен у сети не бессрочный. Без
    // этой проверки кэш отдавал бы протухшую сессию вечно.
    if (cached && Date.now() - cached.at < SESSION_TTL_MS) return cached;
    // Дедупликация параллельных входов: юзер ищет, пока идёт опрос. Без неё оба
    // потока строили бы свою сессию, второй перетирал бы первый в кэше, и
    // ретрай по 401 у первого не сработал бы (guard сверяет объект из кэша).
    const running = this.inflight.get(city);
    if (running) return running;
    const promise = this.createSession(city);
    this.inflight.set(city, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(city);
    }
  }

  private async createSession(city: string): Promise<LentaSession> {
    const bootstrap: LentaSession = {
      sessionToken: '',
      // Web Crypto есть и в Node, и в WebView — в отличие от node:crypto.
      deviceId: globalThis.crypto.randomUUID(),
      domain: lentaDomain(city),
      city,
      boundStoreId: null,
      boundAt: 0,
      at: Date.now(),
    };
    const head = {
      Head: {
        MarketingPartnerKey: MARKETING_PARTNER_KEY,
        Version: RELEASE_VERSION,
        Client: CLIENT,
        Method: 'sessionGet',
        DeviceId: bootstrap.deviceId,
        Domain: bootstrap.domain,
      },
      Body: {},
    };
    const out = await this.request<{
      Head?: { Status?: string };
      Body?: { SessionToken?: string; ErrorList?: { Description?: string; Class?: string }[] };
    }>(`${LENTA_ORIGIN}/api/rest/sessionGet`, {
      method: 'POST',
      session: bootstrap,
      form: `request=${encodeURIComponent(JSON.stringify(head))}`,
    });
    if (out.Head?.Status && out.Head.Status !== 'success') {
      const why = out.Body?.ErrorList?.map((e) => e.Description || e.Class).join('; ') || out.Head.Status;
      throw new Error(`lenta: sessionGet отклонил сессию: ${why}`);
    }
    const token = out.Body?.SessionToken;
    if (!token) throw new Error('lenta: sessionGet не вернул SessionToken (смена API?)');
    bootstrap.sessionToken = token;
    this.sessions.set(city, bootstrap);
    return bootstrap;
  }

  // Выбор магазина: серверная привязка сессии к точке, не куки (крафтить
  // App_Cache_MissionAddress нельзя — это хрупко и не наш формат).
  // Ответ mode/set — настоящее подтверждение, а не эхо: на несуществующий
  // storeId сеть отвечает 409 «Pickup store with id N not found» (2026-09-29).
  //
  // Привязка подтверждается РАЗ в TTL, а не на весь процесс: процесс живёт
  // между опросами (6 ч), и молча сменить точку на сервере мы бы не заметили —
  // сверять выдачу поиска не по чему, маркера магазина в ней нет вовсе.
  private async alias(ctx: { city: string; externalStoreId: string }): Promise<string | null> {
    const storeId = assertLentaStoreId(ctx.externalStoreId);
    const cacheKey = `${ctx.city}:${storeId}`;
    const session = await this.session(ctx.city);
    const boundFresh = Date.now() - session.boundAt < STORE_BIND_TTL_MS;
    if (this.aliases.has(cacheKey) && session.boundStoreId === storeId && boundFresh) {
      return this.aliases.get(cacheKey) ?? null;
    }
    const set = await this.request<{ storeId?: number | string; type?: string; message?: string }>(
      `${LENTA_API}/delivery/mode/set`,
      { method: 'POST', session, body: { type: DELIVERY_MODE, storeId: Number(storeId) } },
    );
    if (!sameLentaStore(set.storeId, storeId)) {
      throw new Error(`lenta: сервер выбрал магазин ${String(set.storeId)} вместо ${storeId}`);
    }
    session.boundStoreId = storeId;
    session.boundAt = Date.now();
    let alias: string | null = null;
    // GET api-gateway Qrator режет с части сетей ВСЕГДА (401). Один раз узнав
    // об этом, больше не тратим на него запрос: сверять по alias нечем, а
    // привязка уже подтверждена ответом mode/set.
    if (!this.wafBlocksApiGateway) {
      try {
        const mode = await this.request<LentaDeliveryMode>(`${LENTA_API}/delivery/mode`, {
          method: 'GET',
          session,
        });
        if (!sameLentaStore(mode.storeId, storeId)) {
          throw new Error(`lenta: режим доставки на магазине ${String(mode.storeId)}, а нужен ${storeId}`);
        }
        alias = aliasFromDeliveryMode(mode, storeId);
      } catch (err) {
        if (!/HTTP (401|403)/.test(String(err))) throw err;
        this.wafBlocksApiGateway = true;
        if (!this.warnedAboutWaf) {
          this.warnedAboutWaf = true;
          console.error('lenta: GET api-gateway режет WAF, сверка ответов по alias отключена');
        }
      }
    }
    this.aliases.set(cacheKey, alias);
    return alias;
  }

  // Карточка товара. Канонический GET `catalog/items/{id}` на api-gateway с
  // этой сети режет Qrator (401, проверено 2026-09-30 и 2026-10-01), поэтому
  // единственный рабочий путь — искать товар тем же jrpc-поиском и брать его по
  // id из выдачи. Проверено живьём 2026-10-01: полное название даёт total=1,
  // обрезанное тоже находит нужный id.
  //
  // Обрезанное имя нужно потому, что магазин переименовывает товар: полное
  // имя может перестать находиться, и тогда «не нашли» — это правда, а не сбой.
  // Проверка только по id: сверять названия нельзя, сверка сама сломала бы
  // случай переименования.
  //
  // ИНВАРИАНТ СВЕРКИ МАГАЗИНА: в выдаче jrpc маркера точки нет вообще (ни в
  // теле, ни в заголовках), поэтому `requiredMarker` здесь false by design, и
  // «ужесточать» его нельзя — это сломает единственный рабочий путь. Держит
  // привязку сессии: `mode/set` раз в STORE_BIND_TTL_MS, а на несуществующий
  // storeId сеть отвечает 409. Цены у Ленты не per-store, наличие — per-store,
  // так что сверка ответа наличия бы не дала.
  private async findByName(
    id: string,
    name: string,
    ctx: { city: string; externalStoreId: string },
  ): Promise<LentaItem> {
    const attempts: string[] = [];
    // Различаем «выдача была, нашего товара в ней нет» и «выдачи не было вовсе».
    // Второе — это дрейф формы или сеть/WAF: та же ловушка, что `categoryId: 0`
    // отдаёт 200 с total: 0. Если такое выдать за «переименование», то breaker
    // никогда не сработает, и история цены молча замрёт.
    let sawAnyItems = false;
    // Запросы от lentaNameQueries попарно различны (полное имя и его укороченные
    // префиксы), повторять один и тот же запрос смысла нет.
    for (const query of lentaNameQueries(name)) {
      const res = await this.request<LentaSearchResponse>(`${LENTA_ORIGIN}/jrpc/searchItems`, {
        method: 'POST',
        session: await this.session(ctx.city),
        body: lentaSearchBody(query, PRODUCT_SEARCH_PAGE),
      });
      if (res.error) {
        throw new Error(`lenta: jrpc searchItems -> ${String(res.error.message ?? res.error.code)}`);
      }
      const items = res.result?.items;
      if (!items) throw new Error('lenta: searchItems без result (смена API?)');
      if (items.length > 0) sawAnyItems = true;
      attempts.push(`«${query.slice(0, 32)}…» total=${String(res.result?.total ?? '?')}`);
      const hit = items.find((it) => String(it.id) === id);
      if (hit) return hit;
    }
    if (!sawAnyItems) {
      // Сетевой класс: пустая выдача на ВСЕ попытки. Сеть жива, но не отдаёт
      // товары — это не «переименование», и паузу сети ставить надо.
      throw new Error(
        `lenta: поиск вернул пустую выдачу на все попытки (${attempts.join('; ')}) — сеть, WAF или дрейф ответа`,
      );
    }
    throw new ProductLookupError(
      `товар не найден поиском по названию (${attempts.join('; ')}) — возможно, переименован или снят`,
      `lenta-${id}`,
    );
  }

  async fetchProduct(
    canonicalId: string,
    ctx: { city: string; externalStoreId: string; name?: string },
  ): Promise<ScrapedProduct> {
    const id = lentaItemId(canonicalId);
    const name = ctx.name?.trim();
    if (!name) {
      throw new ProductLookupError(
        'у товара нет названия в базе — найди его поиском, чтобы опрос его видел',
        canonicalId,
      );
    }
    const alias = await this.alias(ctx);
    const item = await this.findByName(id, name, ctx);
    // Маркера магазина в выдаче нет (см. assertLentaItemStore), привязка держится
    // на сессии, подтверждённой mode/set.
    const product = normalizeLentaItem(item, { city: ctx.city }, alias, false);
    if (!product) {
      // id мы уже нашли в выдаче, значит normalize вернул null из-за отсутствия
      // name или price — это дрейф формата, а не «товар снят». Сетевой класс:
      // иначе breaker не сработает и история молча замрёт.
      throw new Error('lenta: найденный товар без цены или названия (смена формата ответа?)');
    }
    assertLentaAnswered(canonicalId, product);
    return product;
  }

  // Поиск: JSON-RPC на Origin сайта, не api-gateway. Тело — ровно то, что
  // собирает клиент сайта (бандл chunk-KNWP5BWU): categoryId НЕ передаём —
  // с categoryId: 0 сеть отвечает 200 с total: 0, то есть тихо отдаёт
  // пустую выдачу вместо ошибки.
  async search(
    query: string,
    ctx: { city: string; externalStoreId: string },
  ): Promise<ScrapedProduct[]> {
    const alias = await this.alias(ctx);
    const res = await this.request<LentaSearchResponse>(`${LENTA_ORIGIN}/jrpc/searchItems`, {
      method: 'POST',
      session: await this.session(ctx.city),
      body: lentaSearchBody(query, SEARCH_LIMIT),
    });
    if (res.error) throw new Error(`lenta: jrpc searchItems -> ${String(res.error.message ?? res.error.code)}`);
    return normalizeLentaSearch(res, ctx, alias, SEARCH_LIMIT);
  }
}
