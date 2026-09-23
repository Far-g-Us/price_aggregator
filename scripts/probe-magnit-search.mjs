import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: 'ru-RU' });
try {
  await ctx.addCookies([
    { name: 'shopCode', value: '"473996"', domain: 'magnit.ru', path: '/' },
  ]);
  const page = await ctx.newPage();
  const hits = new Set();
  page.on('request', (r) => {
    const u = r.url();
    if (/goods|search|api/i.test(u) && !/yandex|metric|analytic|pixel|mc\.yandex/i.test(u))
      hits.add(`${r.method()} ${u.slice(0, 220)}`);
  });
  await page.goto('https://magnit.ru/search?query=moloko', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(12000);
  console.log('api-ish requests:');
  for (const h of [...hits].slice(0, 25)) console.log(' ', h);
} finally {
  await browser.close();
}
