import type { ScrapedProduct, StoreAdapter } from '../../shared/types.js';

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
  image?: string[];
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
  if (!m || m[1] === undefined) return null;
  const v = Number(m[1].replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

export function validPrice(v: number | null): v is number {
  return v !== null && v > 0;
}

function assertShopCode(shopCode: string): void {
  if (!/^\d+$/.test(shopCode)) throw new Error(`magnit: bad shopCode ${shopCode}`);
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
  ctx: { city: string },
): ScrapedProduct | null {
  const id = raw.url ? idFromUrl(raw.url) : null;
  if (!id || !raw.name) return null;
  const price = raw.price != null ? parseMagnitPrice(String(raw.price)) : null;
  if (!validPrice(price)) return null;
  const product: ScrapedProduct = {
    canonicalId: `magnit-${id}`,
    storeId: 'magnit',
    city: ctx.city,
    name: raw.name,
    price,
    promoPrice: null,
    oldPrice: null,
    inStock: !raw.availability || /InStock/i.test(raw.availability),
    collectedAt: new Date().toISOString(),
  };
  if (raw.url) product.url = raw.url;
  if (raw.image) product.imageUrl = raw.image;
  return product;
}

export function normalizeMagnitProduct(
  raw: MagnitProductLd,
  ctx: { city: string; url: string },
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
    name: raw.name,
    price,
    promoPrice: null,
    oldPrice: null,
    inStock: !offers?.availability || /InStock/i.test(offers.availability),
    url: ctx.url,
    collectedAt: new Date().toISOString(),
  };
  if (brand) product.brand = brand;
  if (raw.description) product.description = raw.description;
  if (raw.image?.[0]) product.imageUrl = raw.image[0];
  if (/^\d+(?:[.,]\d+)?$/.test(weight)) product.unit = `${weight}кг`;
  else if (weight) product.unit = weight;
  return product;
}

function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] === undefined) continue;
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      continue;
    }
  }
  return out;
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

  async search(
    query: string,
    ctx: { city: string; externalStoreId: string },
  ): Promise<ScrapedProduct[]> {
    let playwright: typeof import('playwright');
    try {
      playwright = await import('playwright');
    } catch {
      throw new Error('magnit search: Playwright не установлен/не упакован');
    }
    const browser = await playwright.chromium.launch({ headless: true });
    try {
      assertShopCode(ctx.externalStoreId);
      const context = await browser.newContext({ locale: 'ru-RU' });
      await context.addCookies([
        { name: 'shopCode', value: `"${ctx.externalStoreId}"`, domain: 'magnit.ru', path: '/' },
      ]);
      const page = await context.newPage();
      await page.goto(`https://magnit.ru/search?query=${encodeURIComponent(query)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      try {
        await page.waitForSelector('article.unit-catalog-product-preview', { timeout: 30000 });
      } catch {
        return [];
      }
      const raw = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('article.unit-catalog-product-preview')].slice(0, 12);
        return cards.map((a) => {
          const link = a.querySelector('a[title]');
          const img = a.querySelector('img');
          const texts = [...a.querySelectorAll('*')]
            .filter((e) => e.children.length === 0 && /₽/.test(e.textContent || ''))
            .map((e) => (e.textContent || '').trim());
          return {
            name: link?.getAttribute('title') || '',
            href: link?.getAttribute('href') || '',
            img: img ? img.currentSrc || img.src : '',
            texts,
          };
        });
      });
      const out: ScrapedProduct[] = [];
      for (const r of raw) {
        const id = idFromUrl(r.href);
        const current = r.texts[0] ? parseMagnitPrice(r.texts[0]) : null;
        if (!id || !r.name || !validPrice(current)) continue;
        const money = r.texts.slice(1).filter((t) => !/[·/]/.test(t));
        const old = money.map(parseMagnitPrice).find((v) => v !== null && v !== current) ?? null;
        const unit = r.texts.slice(1).find((t) => /[·/]/.test(t)) ?? null;
        const href = r.href.split('?')[0];
        if (!href) continue;
        const product: ScrapedProduct = {
          canonicalId: `magnit-${id}`,
          storeId: 'magnit',
          city: ctx.city,
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
    } finally {
      await browser.close().catch(() => {});
    }
  }

  async fetchProduct(
    canonicalId: string,
    ctx: { city: string; externalStoreId: string },
  ): Promise<ScrapedProduct> {
    const id = canonicalId.replace(/^magnit-/, '');
    const res = await fetch(`https://magnit.ru/product/${encodeURIComponent(id)}`, {
      headers: this.headers(ctx.externalStoreId),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error(`magnit product HTTP ${res.status}`);
    if (!/\/product\//.test(res.url)) throw new Error('magnit: товар редиректнул с /product/, нет в наличии?');
    const html = await res.text();
    for (const block of extractJsonLd(html)) {
      const blocks =
        typeof block === 'object' && block !== null && '@graph' in block
          ? (block as { '@graph': unknown[] })['@graph']
          : [block];
      for (const b of blocks) {
        const p = b as MagnitProductLd & { '@type'?: string };
        if (p['@type'] !== 'Product' && p.sku == null) continue;
        const norm = normalizeMagnitProduct(p, { city: ctx.city, url: res.url });
        if (norm && norm.canonicalId === canonicalId) return norm;
      }
    }
    throw new Error('magnit: Product JSON-LD не найден (возможно, смена вёрстки)');
  }
}
