import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: 'ru-RU' });
try {
  await ctx.addCookies([
    { name: 'shopCode', value: '"303857"', domain: 'magnit.ru', path: '/' },
  ]);
  const page = await ctx.newPage();
  await page.goto('https://magnit.ru/search?term=moloko', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(12000);
  const cards = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="/product/"]')].slice(0, 3);
    return links.map((a) => ({
      href: a.getAttribute('href'),
      card: (a.closest('[class*="card"], [class*="Card"], li, div') || a).outerHTML.slice(0, 1500),
    }));
  });
  console.log(JSON.stringify(cards, null, 1).slice(0, 4000));
} finally {
  await browser.close();
}
