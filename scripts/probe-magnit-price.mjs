import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: 'ru-RU' });
try {
  await ctx.addCookies([
    { name: 'shopCode', value: '"473996"', domain: 'magnit.ru', path: '/' },
  ]);
  const page = await ctx.newPage();
  await page.goto('https://magnit.ru/search?query=moloko', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForSelector('article.unit-catalog-product-preview', { timeout: 30000 });
  const r = await page.evaluate(() => {
    const a = document.querySelector('article.unit-catalog-product-preview');
    const texts = [...a.querySelectorAll('*')]
      .filter((e) => e.children.length === 0 && /₽/.test(e.textContent || ''))
      .map((e) => ({ text: (e.textContent || '').trim(), cls: e.className }));
    const img = a.querySelector('img');
    return {
      priceTexts: texts.slice(0, 5),
      img: img
        ? { src: (img.currentSrc || img.src || '').slice(0, 100), dataSrc: img.getAttribute('data-src') }
        : null,
    };
  });
  console.log(JSON.stringify(r, null, 1).slice(0, 2000));
} finally {
  await browser.close();
}
