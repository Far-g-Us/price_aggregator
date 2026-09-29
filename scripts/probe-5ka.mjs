import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ locale: 'ru-RU' });
  const page = await ctx.newPage();
  const console_ = [];
  const failed = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/CORS|integrity|servicepipe|cross-origin/i.test(t)) console_.push(t.slice(0, 200));
  });
  page.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 100)}`));
  page.on('response', (r) => {
    if (r.url().includes('servicepipe.tech') || /5d\.5ka\.ru/.test(r.url())) {
      console_.push(`RESP ${r.status()} ${r.url().slice(0, 110)}`);
    }
  });
  const resp = await page.goto('https://5ka.ru/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('5ka.ru status:', resp?.status());
  await page.waitForTimeout(15000);
  console.log('console (CORS/integrity/5d):');
  for (const l of console_.slice(0, 15)) console.log('  ' + l);
  console.log('failed requests:');
  for (const l of [...new Set(failed)].slice(0, 10)) console.log('  ' + l);
  const ls = await page.evaluate(() => Object.keys(localStorage).filter((k) => /5ka|store|sap|delivery/i.test(k)));
  console.log('5ka localStorage keys:', JSON.stringify(ls));
  const inpage = await page.evaluate(async () => {
    const out = [];
    for (const u of [
      'https://5d.5ka.ru/api/catalog/v3/stores/X383/search?mode=store&q=%D0%BC%D0%BE%D0%BB%D0%BE%D0%BA%D0%BE&limit=3&utm_referrer=https%3a%2f%2f5ka.ru%2f',
    ]) {
      try {
        const r = await fetch(u, { headers: { accept: 'application/json, text/plain, */*' } });
        out.push(`HTTP ${r.status} len=${(await r.text()).length}`);
      } catch (e) {
        out.push('ERR ' + String(e).slice(0, 100));
      }
    }
    return out;
  });
  console.log('in-page catalog fetch:', inpage.join(' | '));
} finally {
  await browser.close();
}
