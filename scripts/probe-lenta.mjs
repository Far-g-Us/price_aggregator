import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
try {
const ctx = await browser.newContext({ locale: 'ru-RU' });
const page = await ctx.newPage();
const hits = [];
page.on('request', (r) => {
  const u = r.url();
  if (/store[_-]?id/i.test(u)) hits.push(u);
});
await page.goto('https://lenta.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);
const cookies = await ctx.cookies();
const interesting = cookies.filter((c) => /store|city|geo|shop/i.test(c.name));
console.log('cookie names:', cookies.map((c) => c.name).join(', '));
console.log('interesting:', JSON.stringify(interesting, null, 1).slice(0, 1500));
console.log('localStorage keys:', await page.evaluate(() => Object.keys(localStorage)));
console.log('storeId requests:', JSON.stringify([...new Set(hits)].slice(0, 20), null, 1));
} finally {
  await browser.close();
}
