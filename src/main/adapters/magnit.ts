import type { ScrapedProduct, StoreAdapter, StoreCategory } from '../../shared/types.js';

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

export function hasShopCode(html: string, shopCode: string): boolean {
  assertShopCode(shopCode);
  return new RegExp(`shopCode=(%22|")?${shopCode}(%22|"|&|$)`).test(html);
}

function assertOwnStore(html: string, shopCode: string): void {
  if (!hasShopCode(html, shopCode)) {
    throw new Error(`magnit: ответ от чужого магазина (нет shopCode=${shopCode})`);
  }
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
    if (m[1] === undefined) continue;
    try {
      out.push(JSON.parse(m[1]));
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

export function cardsToProducts(raw: RawCard[], ctx: { city: string }, limit: number): ScrapedProduct[] {
  const out: ScrapedProduct[] = [];
  for (const r of raw.slice(0, limit)) {
    const id = idFromUrl(r.href);
    const current = r.texts[0] ? parseMagnitPrice(r.texts[0]) : null;
    if (!id || !r.name || !validPrice(current)) continue;
    const money = r.texts.slice(1).filter((t) => !/[·/]/.test(t));
    const old = money.map(parseMagnitPrice).find((v) => validOldPrice(v, current)) ?? null;
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
}

async function importPlaywright(): Promise<typeof import('playwright')> {
  try {
    return await import('playwright');
  } catch {
    throw new Error('magnit: Playwright не установлен/не упакован (нужен для клиентского рендера)');
  }
}

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
    const id = m[1];
    const title = m[2];
    const link = (m[3] ?? '').replace(/\\u002F/g, '/');
    const image = (m[4] ?? '').replace(/\\u002F/g, '/');
    const price = m[5] ?? '';
    if (!id || !title || !price) continue;
    const priceNum = parseMagnitPrice(price);
    const tail = script.slice(m.index + m[0].length, m.index + m[0].length + 160);
    const oldPrice = priceNum !== null ? oldPriceFromTail(tail, priceNum) : '';
    out.push({ id, title, link, image, price, oldPrice });
    if (out.length >= limit) break;
  }
  return out;
}

export function parseMagnitSearchGoods(html: string, shopCode: string): MagnitGoodsItem[] {
  assertNoBlock(html, '');
  assertOwnStore(html, shopCode);
  const script = nuxtScript(html);
  const out = goodsFromScript(script, 32);
  if (out.length === 0 && /\/product\//.test(script)) {
    throw new Error('magnit: search-парсер пуст при живых /product/ (смена вёрстки?)');
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
    throw new Error(`magnit: страница без следов shopCode=${shopCode} (чужой магазин?)`);
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
          .filter((e) => e.children.length === 0 && /₽/.test(e.textContent || ''))
          .map((e) => (e.textContent || '').trim());
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

export function parseMagnitCategories(html: string, shopCode: string): MagnitCategory[] {
  const script = html.match(/<script[^>]*__NUXT_DATA__[^>]*>(.*?)<\/script>/s)?.[1] ?? '';
  assertOwnStore(script, shopCode);
  const re = /"g(\d+)","\d+","((?:[^"\\]|\\.)*)","(testmm[a-z0-9_]+)","((?:[^"\\]|\\.)*)","((?:[^"\\]|\\.)*)"/g;
  const seen = new Map<string, MagnitCategory>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const id = m[1];
    const name = m[2];
    const rawUrl = (m[5] ?? '').replace(/\\u002F/g, '/');
    if (!id || !name || seen.has(id)) continue;
    const pathOnly = rawUrl.split('?')[0];
    if (!pathOnly || !/\/catalog\/\d+-/.test(pathOnly)) continue;
    seen.set(id, { id, name, url: `https://magnit.ru${pathOnly}` });
    if (seen.size >= 40) break;
  }
  if (seen.size === 0) throw new Error('magnit: категории не найдены (смена вёрстки?)');
  return [...seen.values()];
}

export function goodsToProducts(goods: MagnitGoodsItem[], ctx: { city: string }): ScrapedProduct[] {
  const out: ScrapedProduct[] = [];
  for (const g of goods) {
    const price = parseMagnitPrice(g.price);
    if (!g.id || !g.title || !validPrice(price)) continue;
    const old = g.oldPrice ? parseMagnitPrice(g.oldPrice) : null;
    const product: ScrapedProduct = {
      canonicalId: `magnit-${g.id}`,
      storeId: 'magnit',
      city: ctx.city,
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

  async search(
    query: string,
    ctx: { city: string; externalStoreId: string },
  ): Promise<ScrapedProduct[]> {
    assertShopCode(ctx.externalStoreId);
    // Именно `term`: с `query` сайт отдаёт популярные товары вместо выдачи.
    try {
      const res = await fetch(magnitSearchUrl(query), {
        headers: this.headers(ctx.externalStoreId),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error(`magnit search HTTP ${res.status}`);
      const goods = parseMagnitSearchGoods(await res.text(), ctx.externalStoreId);
      if (goods.length > 0) {
        return goodsToProducts(goods, ctx);
      }
      throw new Error('magnit: search-парсер пуст при живом shopCode (смена вёрстки?)');
    } catch (err) {
      if (/блок по IP|чужого магазина|смена вёрстки/.test(String(err))) throw err;
      console.error('magnit search fetch failed, playwright fallback:', String(err).slice(0, 120));
    }
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
        await assertPageUsable(page, ctx.externalStoreId);
        return [];
      }
      await assertPageUsable(page, ctx.externalStoreId);
      const raw = await readCards(page, 12);
      return cardsToProducts(raw, ctx, 12);
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
    if (!/\/product\//.test(res.url)) {
      throw new Error(`magnit: ушёл с /product/ на ${res.url.slice(0, 80)}`);
    }
    const html = await res.text();
    assertOwnStore(html, ctx.externalStoreId);
    for (const block of extractJsonLd(html)) {
      const blocks =
        typeof block === 'object' && block !== null && '@graph' in block
          ? (block as { '@graph': unknown[] })['@graph']
          : [block];
      for (const b of blocks) {
        if (typeof b !== 'object' || b === null) continue;
        const p = b as MagnitProductLd & { '@type'?: string };
        if (p['@type'] !== 'Product' && p.sku == null) continue;
        const norm = normalizeMagnitProduct(p, { city: ctx.city, url: res.url });
        if (norm && norm.canonicalId === canonicalId) return norm;
      }
    }
    throw new Error('magnit: Product JSON-LD не найден (возможно, смена вёрстки)');
  }

  async fetchCategories(ctx: { city: string; externalStoreId: string }): Promise<MagnitCategory[]> {
    assertShopCode(ctx.externalStoreId);
    const res = await fetch('https://magnit.ru/', {
      headers: this.headers(ctx.externalStoreId),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error(`magnit home HTTP ${res.status}`);
    return parseMagnitCategories(await res.text(), ctx.externalStoreId);
  }

  async fetchCategoryProducts(
    categoryUrl: string,
    ctx: { city: string; externalStoreId: string },
  ): Promise<ScrapedProduct[]> {
    if (!/^https:\/\/magnit\.ru\/(promo-)?catalog\//.test(categoryUrl)) {
      throw new Error('magnit: categoryUrl вне каталога');
    }
    assertShopCode(ctx.externalStoreId);
    const res = await fetch(categoryUrl, {
      headers: this.headers(ctx.externalStoreId),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error(`magnit category HTTP ${res.status}`);
    if (!res.url.startsWith('https://magnit.ru/')) {
      throw new Error(`magnit: ушёл с magnit.ru на ${res.url.slice(0, 80)}`);
    }
    const html = await res.text();
    const fromLd = extractCategoryOffers(html, {
      city: ctx.city,
      shopCode: ctx.externalStoreId,
    });
    if (fromLd.length > 0) return fromLd;
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
        return [];
      }
      await assertPageUsable(page, ctx.externalStoreId);
      return cardsToProducts(await readCards(page, 32), ctx, 32);
    } finally {
      await browser.close().catch(() => {});
    }
  }
}

export function extractCategoryOffers(
  html: string,
  ctx: { city: string; shopCode: string },
): ScrapedProduct[] {
  const promos = parseMagnitCategoryPromos(html, ctx.shopCode);
  const out: ScrapedProduct[] = [];
  for (const block of extractJsonLd(html)) {
    const b = block as { '@type'?: string; itemListElement?: MagnitOffer[] };
    if (b['@type'] !== 'OfferCatalog' || !Array.isArray(b.itemListElement)) continue;
    for (const raw of b.itemListElement.slice(0, 32)) {
      const id = raw.url ? idFromUrl(raw.url) : null;
      const norm = normalizeMagnitOffer(raw, { city: ctx.city }, id ? (promos.get(id) ?? null) : null);
      if (norm) out.push(norm);
    }
  }
  return out;
}

