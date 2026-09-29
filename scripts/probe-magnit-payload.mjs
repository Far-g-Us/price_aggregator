import { chromium } from 'playwright';
import fs from 'node:fs';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: 'ru-RU' });
try {
  await ctx.addCookies([
    { name: 'shopCode', value: '"303857"', domain: 'magnit.ru', path: '/' },
  ]);
  const page = await ctx.newPage();
  await page.goto('https://magnit.ru/catalog/4998-ryba_moreprodukty', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(12000);
  const info = await page.evaluate(() => {
    const keys = Object.keys(window).filter((k) => /nuxt|payload|__[A-Z]/i.test(k));
    const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map(
      (s) => s.textContent,
    );
    let offer = null;
    try {
      const cat = JSON.parse(ld[0] || '{}');
      offer = (cat.itemListElement || [])[0] || null;
    } catch {
      offer = null;
    }
    const nuxtData = document.getElementById('__NUXT_DATA__');
    return {
      windowKeys: keys.slice(0, 20),
      jsonLdCount: ld.length,
      firstOffer: offer,
      nuxtDataLen: nuxtData ? nuxtData.textContent.length : 0,
      nuxtDataHead: nuxtData ? nuxtData.textContent.slice(0, 500) : null,
    };
  });
  console.log(JSON.stringify(info, null, 1).slice(0, 3000));
  fs.writeFileSync(new URL('../.tmp-nuxt.json', import.meta.url), JSON.stringify(info));
} finally {
  await browser.close();
}
