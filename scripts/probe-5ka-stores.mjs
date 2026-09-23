import { chromium } from 'playwright';
import fs from 'node:fs';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: 'ru-RU' });
const page = await ctx.newPage();

await page.goto('https://5ka.ru/', { waitUntil: 'domcontentloaded', timeout: 60000 });
try {
  await page.locator('label[for="is-robot"]').click({ timeout: 8000 });
  console.log('captcha clicked');
} catch {
  console.log('no captcha');
}
await page.waitForSelector('#app', { timeout: 30000 }).catch(() => console.log('no #app'));

const probed = await page.evaluate(async () => {
  const out = {};
  for (const q of [
    '/api/stores/?type=["store"]&bbox=37.3,55.5,37.9,55.95',
    '/api/stores/?bbox=37.3,55.5,37.9,55.95',
  ]) {
    try {
      const r = await fetch(q, { headers: { Accept: 'application/json' } });
      const t = await r.text();
      out[q] = { status: r.status, len: t.length, head: t.slice(0, 1500) };
    } catch (e) {
      out[q] = { error: String(e) };
    }
  }
  return out;
});

for (const [q, r] of Object.entries(probed)) {
  console.log('===', q);
  console.log(JSON.stringify(r).slice(0, 1800));
}
fs.writeFileSync(new URL('../.tmp-probe.json', import.meta.url), JSON.stringify(probed, null, 2));
await browser.close();
