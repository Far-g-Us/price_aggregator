import { firefox } from 'playwright';

const ADDR = process.env.ADDR ?? 'Ульяновск, улица Мира, 10';
const browser = await firefox.launch({ headless: true });
try {
  const ctx = await browser.newContext({ locale: 'ru-RU' });
  const page = await ctx.newPage();
  const hits = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('5d.5ka.ru/api')) hits.push(r.method() + ' ' + u.slice(23, 140));
  });
  await page.goto('https://5ka.ru/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(10000);
  console.log('магазин до:', (await ctx.cookies('https://5ka.ru')).find((c) => c.name === '5ka_store_id_store')?.value);

  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((e) =>
      /Уточните адрес/i.test(e.textContent || ''),
    );
    b?.click();
  });
  await page.waitForTimeout(4000);
  const inp = await page.waitForSelector('input[placeholder="Введите ваш адрес"]', { timeout: 20000 });
  await inp.fill(ADDR);
  await page.waitForTimeout(6000);

  const sugg = await page.evaluate(() =>
    [...document.querySelectorAll('[role="option"],li,[class*="suggest"],[class*="Suggest"],[class*="autocomplete" i]')]
      .map((n) => (n.textContent || '').trim().slice(0, 70))
      .filter((t) => t.length > 3)
      .slice(0, 6),
  );
  console.log('подсказки:', JSON.stringify(sugg));

  const clicked = await page.evaluate(() => {
    const n = [...document.querySelectorAll('[role="option"],li,[class*="suggest"],[class*="Suggest"]')].find(
      (e) => (e.textContent || '').trim().length > 3,
    );
    if (n) {
      n.click();
      return (n.textContent || '').trim().slice(0, 50);
    }
    return null;
  });
  console.log('выбрали подсказку:', clicked);
  await page.waitForTimeout(18000);
  console.log('магазин после:', (await ctx.cookies('https://5ka.ru')).find((c) => c.name === '5ka_store_id_store')?.value);
  console.log('api:', [...new Set(hits)].slice(-6).join('\n  '));
} finally {
  await browser.close();
}
