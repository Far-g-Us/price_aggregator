import type { ScrapedProduct, StoreAdapter } from '../../shared/types.js';

// Пятёрочка: неофициальный скрытый API сайта 5ka.ru (по мотивам Open-Inflation/pyaterochka_api, MIT).
// Важно: сайт требует прогрев в браузере (x-app-version, x-device-id, x-platform) и иногда капчу
// "я не робот". Поэтому стратегия: сначала прямой fetch, при 401/403 — fallback на Playwright.
// Цены всегда в разрезе sapCode конкретного магазина (у нас: Москва).
//
// NOTE: ToS — только для личного использования, в README добавим дисклеймер.

const CATALOG = 'https://5d.5ka.ru/api';

function deviceId(): string {
  return `el-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

interface SearchItem {
  plu?: string | number;
  id?: string | number;
  name?: string;
  title?: string;
  price?: number;
  prices?: { price_regular?: number; price_discount?: number | null };
  price_regular?: number;
  price_discount?: number | null;
  promo_price?: number | null;
  old_price?: number | null;
  image?: string;
  image_link?: string;
  image_url?: string;
  description?: string;
  uom?: string;
  unit?: string;
  available?: boolean;
  in_stock?: boolean;
}

function normalize(
  raw: SearchItem,
  ctx: { city: string; externalStoreId: string },
): ScrapedProduct | null {
  const sku = String(raw.plu ?? raw.id ?? '');
  if (!sku || !(raw.name ?? raw.title)) return null;
  const price = Number(raw.price ?? raw.prices?.price_regular ?? raw.price_regular ?? NaN);
  if (!Number.isFinite(price)) return null;
  const promo = raw.prices?.price_discount ?? raw.price_discount ?? raw.promo_price ?? null;
  const img = raw.image_link ?? raw.image_url ?? raw.image;
  const product: ScrapedProduct = {
    canonicalId: `5ka-${sku}`,
    storeId: 'pyaterochka',
    city: ctx.city,
    name: String(raw.name ?? raw.title),
    unit: String(raw.uom ?? raw.unit ?? 'шт'),
    price,
    promoPrice: promo != null ? Number(promo) : null,
    oldPrice: raw.old_price != null ? Number(raw.old_price) : null,
    inStock: (raw.available ?? raw.in_stock ?? true) as boolean,
    url: `https://5ka.ru/product/${sku}/`,
    collectedAt: new Date().toISOString(),
  };
  if (raw.description) product.description = raw.description;
  if (img) product.imageUrl = String(img);
  return product;
}

export class PyaterochkaAdapter implements StoreAdapter {
  readonly storeId = 'pyaterochka' as const;

  private headers(): Record<string, string> {
    return {
      Accept: 'application/json, text/plain, */*',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Referer: 'https://5ka.ru/',
      'x-platform': 'web',
      'x-device-id': deviceId(),
    };
  }

  async search(
    query: string,
    ctx: { city: string; externalStoreId: string },
  ): Promise<ScrapedProduct[]> {
    const url =
      `${CATALOG}/catalog/v3/stores/${encodeURIComponent(ctx.externalStoreId)}` +
      `/search?mode=store&include_restrict=true&q=${encodeURIComponent(query)}&limit=12`;
    const res = await fetch(url, { headers: this.headers() });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `5ka требует прогрев браузера (HTTP ${res.status}). Нужен Playwright-warmup для x-app-version.`,
      );
    }
    if (!res.ok) throw new Error(`5ka search HTTP ${res.status}`);
    const data = (await res.json()) as {
      products?: SearchItem[];
      results?: SearchItem[];
      items?: SearchItem[];
    };
    const list = data.products ?? data.results ?? data.items ?? [];
    return list
      .map((r) => normalize(r, ctx))
      .filter((x): x is ScrapedProduct => x !== null);
  }

  async fetchProduct(
    canonicalId: string,
    ctx: { city: string; externalStoreId: string },
  ): Promise<ScrapedProduct> {
    const plu = canonicalId.replace(/^5ka-/, '');
    const url =
      `${CATALOG}/catalog/v2/stores/${encodeURIComponent(ctx.externalStoreId)}` +
      `/products/${encodeURIComponent(plu)}?mode=store&include_restrict=true`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`5ka product HTTP ${res.status}`);
    const raw = (await res.json()) as SearchItem & { plu?: string | number };
    const norm = normalize({ ...raw, plu: raw.plu ?? plu }, ctx);
    if (!norm) throw new Error('5ka: пустой ответ по товару');
    return norm;
  }
}
