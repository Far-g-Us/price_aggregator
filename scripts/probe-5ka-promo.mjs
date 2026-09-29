import { firefox } from 'playwright';
import fs from 'node:fs';

const CATEGORY = process.env.CAT ?? 'skidki-nedeli--251C17046';
const browser = await firefox.launch({ headless: true });
try {
  const ctx = await browser.newContext({ locale: 'ru-RU' });
  const page = await ctx.newPage();
  const hits = [];
  page.on('response', async (r) => {
    const u = r.url();
    if (!/5d\.5ka\.ru\/api\/catalog\/v2\/stores\/[^/]+\/categories\/.+\/products/.test(u)) return;
    if (r.status() !== 200) return;
    try {
      const j = await r.json();
      hits.push({ u, n: j?.products?.length ?? -1, products: j?.products ?? [] });
    } catch {
      /* ignore */
    }
  });
  await page.goto('https://5ka.ru/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(9000);
  await page.goto('https://5ka.ru/catalog/' + CATEGORY + '/', { waitUntil: 'commit', timeout: 60000 });
  await page.waitForTimeout(14000);
  console.log('calls:', hits.map((h) => h.n).join(', '));
  const all = hits.flatMap((h) => h.products);
  const withPromo = all.filter((p) => p?.prices?.cpd_promo_price != null);
  const multibuy = withPromo.filter((p) => p?.promo?.rebate != null);
  console.log('products:', all.length, '| cpd_promo_price:', withPromo.length, '| из них мультибай:', multibuy.length);
  for (const p of withPromo.slice(0, 8)) {
    console.log(
      `  plu=${p.plu} regular=${p.prices.regular} promo=${p.prices.cpd_promo_price} rebate=${JSON.stringify(p.promo?.rebate ?? null)} avail=${p.is_available} ${String(p.name).slice(0, 38)}`,
    );
  }
  if (all.length > 0) {
    const out = {
      source: '5ka.ru category ' + CATEGORY + ' via Playwright Firefox',
      store: '35XY',
      capturedAt: new Date().toISOString(),
      products: all.slice(0, 12),
    };
    fs.writeFileSync(
      new URL('../tests/fixtures/5ka-search-promo.json', import.meta.url),
      JSON.stringify(out, null, 1),
    );
    console.log('saved tests/fixtures/5ka-search-promo.json');
  }
} finally {
  await browser.close();
}
