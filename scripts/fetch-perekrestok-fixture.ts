// Снятие живых фикстур Перекрёстка для тестов парсера и транспорта.
//
// Формат ответа уже известен из ROADMAP, но парсер писать вслепую нельзя:
// цена в копейках, `balanceState` строкой, категории в `catalogPrimaryCategory`.
// Фикстуры берутся из браузера (обычный fetch отдаёт 401), поэтому скрипт
// поднимает сессию один раз и снимает всё в ней — с паузами, как это делает
// сам сайт.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCAL_BROWSERS = resolve(process.cwd(), '.playwright-browsers');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(LOCAL_BROWSERS)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = LOCAL_BROWSERS;
}
const API = 'https://www.perekrestok.ru/api/customer/1.4.1.0';
const OUT = resolve(process.cwd(), 'tests/fixtures/perekrestok');
mkdirSync(OUT, { recursive: true });

const { firefox } = await import('playwright');
const browser = await firefox.launch({ headless: true });
try {
  const context = await browser.newContext({ locale: 'ru-RU' });
  const page = await context.newPage();
  await page.goto('https://www.perekrestok.ru/catalog/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  let sessionCookie = '';
  for (let i = 0; i < 30; i += 1) {
    sessionCookie = (await context.cookies()).find((c) => c.name === 'session')?.value ?? '';
    if (sessionCookie !== '') break;
    await page.waitForTimeout(1000);
  }
  const spuid = (await page.evaluate(() => window.localStorage.getItem('_SPUID'))) ?? '';
  const accessToken = (JSON.parse(decodeURIComponent(sessionCookie)) as { accessToken?: string }).accessToken ?? '';
  const headers: Record<string, string> = { auth: `Bearer ${accessToken}` };
  if (spuid !== '') headers['x-device-id'] = spuid;
  // Токен в фикстуры не пишем: он живёт одну сессию, а в тестах нужен только
  // вид ответа.
  void headers;

  const post = async (path: string, body: unknown) => {
    await page.waitForTimeout(2000);
    const out = await page.evaluate(
      async (arg: { url: string; body: string; headers: Record<string, string> }) => {
        const res = await fetch(arg.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...arg.headers },
          body: arg.body,
          credentials: 'include',
        });
        return { status: res.status, body: await res.text() };
      },
      { url: `${API}${path}`, body: JSON.stringify(body), headers },
    );
    if (out.status !== 200) throw new Error(`${path} → ${out.status}: ${out.body.slice(0, 120)}`);
    return JSON.parse(out.body) as unknown;
  };

  const save = (name: string, value: unknown): void => {
    writeFileSync(resolve(OUT, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    console.log(`  сохранено ${name}`);
  };

  save('feed-moloko.json', await post('/catalog/product/feed', { page: 1, perPage: 10, filter: { textQuery: 'молоко' } }));
  save('feed-promo.json', await post('/catalog/product/feed', { page: 1, perPage: 10, filter: { promoListing: 26 } }));
  save('feed-empty-junk.json', await post('/catalog/product/feed', { page: 1, perPage: 10, filter: { textQuery: 'zzzqqqкхх' } }));
  save('feed-page2.json', await post('/catalog/product/feed', { page: 2, perPage: 10, filter: { textQuery: 'молоко' } }));
  save('feed-sweets.json', await post('/catalog/product/feed', { page: 1, perPage: 10, filter: { textQuery: 'шоколад' } }));
} finally {
  await browser.close().catch(() => {});
}
console.log('готово');