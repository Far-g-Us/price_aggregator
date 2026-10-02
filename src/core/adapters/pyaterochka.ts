import type { ScrapedProduct, StoreAdapter , StoreCategory } from '../../shared/types.js';
import { readEnvFlag } from '../platform.js';

export const categoryIdFromUrl = (url: string): string | null => {
  const m = url.match(/^https:\/\/5ka\.ru\/catalog\/(?:[^/]+--)?([0-9A-Za-z]+)\/?$/);
  return m?.[1] ?? null;
};

const CATALOG = 'https://5d.5ka.ru/api';

function assertSapCode(sap: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sap)) throw new Error(`5ka: bad sapCode ${sap}`);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function deviceId(): string {
  return `el-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

// Один device-id на запуск приложения: у Магнита аналогично не нужно, но
// антифрод 5ka (ServicePipe) видит смену устройства на каждом запросе.
const DEVICE_ID = deviceId();

export function validOldPrice(old: number | null, price: number): old is number {
  return old !== null && old > price && old / price < 5;
}

// Реальные ответы 5ka (фикстуры 5ka-search.json и 5ka-product.json,
// сняты 2026-09 в браузере юзера, Москва X383). Формат цены РАЗНЫЙ:
// в выдаче поиска `prices` — объект {regular, discount, markdown},
// в карточке товара — МАССИВ [{value, placement_type}]. Баркода нет
// ни там, ни там — склейка по названию/бренду/фасовке (см. matching).
export interface SearchItem {
  plu?: string | number;
  name?: string;
  prices?:
    | {
        regular?: string | number | null;
        discount?: string | number | null;
        cpd_promo_price?: string | number | null;
        cpd_promo_price_from_sum_cart?: string | number | null;
        markdown?: string | number | null;
      }
    | { value?: string | number | null; placement_type?: string }[]
    | null;
  promo?: { rebate?: { units_to_activate?: number } } | null;
  uom?: string;
  property_clarification?: string;
  package_quantity?: string;
  is_available?: boolean;
  // small подтверждён живым ответом (зонд 2026-09-30): в выдаче категории
  // normal иногда нет, и без фолбэка карточки молча теряли бы картинки.
  image_links?: { normal?: string[]; small?: string[] };
  // В листинге категории верхний image_links иногда не приходит, а картинка
  // лежит в media — без фолбэка она молча пропадала бы.
  media?: { image_links?: { normal?: string[]; small?: string[] } };
  description?: string;
  attributes?: { name?: string; value?: string; uom?: string | null }[];
}

/**
 * Лучшая доступная картинка: normal, иначе small. Малый адрес поднимаем до
 * 800x800: БД отдаёт приоритет новому значению (COALESCE), и без подъёма
 * клик по полке тихо ухудшил бы уже сохранённую нормальную картинку.
 */
function bestImage(links?: { normal?: string[]; small?: string[] }): string | null {
  const normal = links?.normal?.[0];
  if (normal) return normal;
  const small = links?.small?.[0];
  if (!small) return null;
  return small.replace(/\/320x320\.jpeg$/, '/800x800.jpeg');
}

interface PriceParts {
  regular: number | null;
  promo: number | null;
  old: number | null;
}

// В объекте имена полей несут смысл, в массиве placement_type акционной
// цены не наблюдался — там определяем по величине относительно
// regular_primary. Реальная акция приходит в `cpd_promo_price`
// (обычная скидка) или `cpd_promo_price_from_sum_cart` (цена от N-го
// товара в корзине), а `discount` в живых ответах всегда null.
function priceParts(prices: SearchItem['prices']): PriceParts {
  if (prices === null || prices === undefined) return { regular: null, promo: null, old: null };
  if (Array.isArray(prices)) {
    const values = prices
      .map((p) => num(p?.value))
      .filter((v): v is number => v !== null);
    const tagged = prices.find((p) => p?.placement_type === 'regular_primary');
    const regular = num(tagged?.value) ?? values[0] ?? null;
    const rest = values.filter((v) => v !== regular);
    return {
      regular,
      promo: rest.find((v) => v < (regular ?? v)) ?? null,
      old: rest.find((v) => v > (regular ?? v)) ?? null,
    };
  }
  return {
    regular: num(prices.regular),
    // cpd_promo_price_from_sum_cart НЕ берём: это цена от N-го товара в
    // корзине, та же мультибай-механика, что rebate, и в живых данных
    // всегда null.
    promo: num(prices.cpd_promo_price ?? prices.discount),
    old: num(prices.markdown),
  };
}

function attribute(item: SearchItem, name: string): string | undefined {
  const hit = item.attributes?.find((a) => a?.name === name);
  const value = String(hit?.value ?? '').trim();
  return value || undefined;
}

export function normalize(raw: SearchItem, ctx: { city: string }): ScrapedProduct | null {
  const plu = String(raw.plu ?? '');
  const name = String(raw.name ?? '').trim();
  if (!/^\d+$/.test(plu) || !name) return null;
  const { regular: price, promo: promoRaw, old: oldRaw } = priceParts(raw.prices);
  if (price === null) return null;
  // Мультибай («% ко 2-й», promo.rebate.units_to_activate): цена действует
  // только от N-го товара в корзине, единичная остаётся regular. Такую
  // скидку НЕ пишем в promoPrice, иначе в карточке и в истории цена
  // одного товара соврёт.
  const isMultibuy = raw.promo?.rebate?.units_to_activate != null;
  const product: ScrapedProduct = {
    canonicalId: `5ka-${plu}`,
    storeId: 'pyaterochka',
    city: ctx.city,
    name,
    unit:
      String(raw.property_clarification ?? '').trim() ||
      String(raw.package_quantity ?? '').trim() ||
      String(raw.uom ?? '').trim() ||
      'шт',
    price,
    promoPrice: !isMultibuy && promoRaw !== null && promoRaw < price ? promoRaw : null,
    oldPrice: validOldPrice(oldRaw, price) ? oldRaw : null,
    inStock: raw.is_available === true,
    // Короткая ссылка редиректит на slug-вариант (проверено юзером на
    // 5ka.ru/product/3255206/ -> .../moloko-domik-...-9--3255206/).
    url: `https://5ka.ru/product/${encodeURIComponent(plu)}/`,
    collectedAt: new Date().toISOString(),
  };
  // normal есть не везде: в выдаче категории встречается только small. Малый
  // адрес поднимаем до 800x800: БД отдаёт приоритет новому значению (COALESCE),
  // и без подъёма клик по полке тихо ухудшил бы уже сохранённую картинку.
  const img = bestImage(raw.image_links) ?? bestImage(raw.media?.image_links);
  if (img) product.imageUrl = img;
  const brand = attribute(raw, 'Бренд');
  if (brand) product.brand = brand;
  if (raw.description) product.description = raw.description;
  return product;
}

function wafPage(body: string): boolean {
  return /Проблемы со связью|проверьте настройки интернета и VPN|request id/i.test(body);
}

export class PyaterochkaAdapter implements StoreAdapter {
  readonly storeId = 'pyaterochka' as const;

  // Основной транспорт — браузерный (X5 режет всё, что не браузер).
  // Прямой fetch оставлен как запасной путь для отладки/экспериментов
  // (PA5KA_TRANSPORT=fetch): он громко падает на WAF-странице.
  private browser = readEnvFlag('PA5KA_TRANSPORT') !== 'fetch';

  private headers(): Record<string, string> {
    return {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      Referer: 'https://5ka.ru/',
      'x-platform': 'web',
      'x-device-id': DEVICE_ID,
    };
  }

  private async getJson<T>(url: string, what: string): Promise<T> {
    const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(25000) });
    const body = await res.text();
    if (res.status === 403 && wafPage(body)) {
      throw new Error(
        `5ka: WAF режет запрос вне браузера (${what}, HTTP 403). Коды каталога подтверждены, но нужен браузерный контекст — см. скилл.`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `5ka: ${what} HTTP ${res.status} — WAF не пускает запросы вне браузера. ` +
          'Обычный транспорт — браузерный (PA5KA_TRANSPORT=fetch только для отладки).',
      );
    }
    if (!res.ok) throw new Error(`5ka ${what} HTTP ${res.status}`);
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`5ka ${what}: ответ не JSON (смена вёрстки/отдача WAF?)`);
    }
  }

  async search(
    query: string,
    ctx: { city: string; externalStoreId: string },
  ): Promise<ScrapedProduct[]> {
    assertSapCode(ctx.externalStoreId);
    if (this.browser) {
      const { browserSearch } = await import('./5ka-browser.js');
      return browserSearch(query, ctx);
    }
    const url =
      `${CATALOG}/catalog/v3/stores/${encodeURIComponent(ctx.externalStoreId)}` +
      `/search?mode=store&include_restrict=true&q=${encodeURIComponent(query)}&limit=12`;
    const data = await this.getJson<{ products?: SearchItem[] }>(url, 'search');
    const list = data.products ?? [];
    return list
      .map((r) => normalize(r, ctx))
      .filter((x): x is ScrapedProduct => x !== null);
  }

  async fetchProduct(
    canonicalId: string,
    ctx: { city: string; externalStoreId: string },
  ): Promise<ScrapedProduct> {
    const plu = canonicalId.replace(/^5ka-/, '');
    if (!/^\d+$/.test(plu)) throw new Error(`5ka: bad canonicalId ${canonicalId}`);
    assertSapCode(ctx.externalStoreId);
    if (this.browser) {
      const { browserFetchProduct } = await import('./5ka-browser.js');
      return browserFetchProduct(plu, ctx);
    }
    const url =
      `${CATALOG}/catalog/v2/stores/${encodeURIComponent(ctx.externalStoreId)}` +
      `/products/${encodeURIComponent(plu)}?mode=store&include_restrict=true`;
    const raw = await this.getJson<SearchItem>(url, 'product');
    const norm = normalize({ ...raw, plu: raw.plu ?? plu }, ctx);
    if (!norm) throw new Error('5ka: пустой ответ по товару (нет цены/имени)');
    if (norm.canonicalId !== canonicalId) {
      throw new Error(`5ka: ответ по другому товару (${norm.canonicalId} вместо ${canonicalId})`);
    }
      return norm;
    }

    // Категории и товары по ним работают только через браузер: fetch-путь
    // упирается в WAF, и копировать его параметры (mode, include_restrict)
    // в код незачем — мы всё равно перехватываем САЙТСКИЙ запрос.
    canHandleCategoryUrl(categoryUrl: string): boolean {
      return categoryIdFromUrl(categoryUrl) !== null;
    }

    async fetchCategories(ctx: { city: string; externalStoreId: string }): Promise<StoreCategory[]> {
      assertSapCode(ctx.externalStoreId);
      if (!this.browser) {
        throw new Error('5ka: категории доступны только в браузерном транспорте (PA5KA_TRANSPORT=fetch)');
      }
      const { browserCategories } = await import('./5ka-browser.js');
      return browserCategories({ externalStoreId: ctx.externalStoreId });
    }

    async fetchCategoryProducts(
      categoryUrl: string,
      ctx: { city: string; externalStoreId: string },
    ): Promise<ScrapedProduct[]> {
      assertSapCode(ctx.externalStoreId);
      if (!this.canHandleCategoryUrl(categoryUrl)) {
        throw new Error('5ka: categoryUrl вне каталога');
      }
      if (!this.browser) {
        throw new Error('5ka: товары категории доступны только в браузерном транспорте (PA5KA_TRANSPORT=fetch)');
      }
      const { browserCategoryProducts } = await import('./5ka-browser.js');
      return browserCategoryProducts(categoryUrl, ctx);
    }
  }
