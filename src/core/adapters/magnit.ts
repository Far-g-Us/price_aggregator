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

/**
 * Ответ принадлежит именно этому магазину.
 *
 * Одного «есть строка `shopCode=<код>` в HTML» НЕДОСТАТОЧНО: пейлоад повторяет
 * там куку — то есть наш собственный код — даже если такого магазина нет.
 * Проверено живьём 2026-10-01 на коде 111111: строка на месте, а ссылки на
 * товары ведут в 992301 (магазин по умолчанию). Прежняя проверка принимала любой
 * код, и цены чужой точки уехали бы в историю.
 *
 * Настоящий признак — shopCode в ссылках на товары: они ведут в тот магазин,
 * цены которого показаны. Если в ссылках чужой код, а нашего нет, ответ
 * отбрасывается: иначе в историю уедут цены чужой точки (инвариант домена).
 */
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
      ].map((m) => m[1] ?? ''),
    ),
  ];
}

export function hasShopCode(html: string, shopCode: string): boolean {
  assertShopCode(shopCode);
  const inLinks = shopCodesInProductLinks(html);
  // Ссылки есть, но нашего кода среди них нет — ответ чужого магазина.
  if (inLinks.length > 0) return inLinks.includes(shopCode);
  // Ссылок нет (страница без товаров): проверить нечем, и мы не выдумываем вины.
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
  // Порядок полей записи категории в __NUXT_DATA__ (проверен на живом ответе):
  //   id, числовой id, название, код, КАРТИНКА, ссылка на категорию.
  // Картинка — пятое поле, ссылка — шестое. Раньше пятое отбрасывалось, и
  // плитки категорий оставались без картинок, хотя сеть её отдаёт.
  const re = /"g(\d+)","\d+","((?:[^"\\]|\\.)*)","(testmm[a-z0-9_]+)","((?:[^"\\]|\\.)*)","((?:[^"\\]|\\.)*)"/g;
  const seen = new Map<string, MagnitCategory>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const id = m[1];
    const name = m[2];
    const unescape = (s: string | undefined): string => (s ?? '').replace(/\\u002F/g, '/');
    const rawImage = unescape(m[4]);
    const rawUrl = unescape(m[5]);
    if (!id || !name || seen.has(id)) continue;
    const pathOnly = rawUrl.split('?')[0];
    if (!pathOnly || !/\/catalog\/\d+-/.test(pathOnly)) continue;
    const category: MagnitCategory = { id, name, url: `https://magnit.ru${pathOnly}` };
    // Только https и без data:-картинка с не-HTTP схемой в <img> не покажется,
    // а в data: утекает вес страницы.
    if (/^https:\/\/\S+$/.test(rawImage) && !rawImage.startsWith('data:')) category.imageUrl = rawImage;
    seen.set(id, category);
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
      assertCardsOwnStore(raw, ctx.externalStoreId);
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
      const raw = await readCards(page, 32);
      assertCardsOwnStore(raw, ctx.externalStoreId);
      return cardsToProducts(raw, ctx, 32);
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

