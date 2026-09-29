// Зонд Ленты. Firefox, а не Chromium: у 5ka WAF режет Chromium и пропускает
// Firefox, логично ждать того же от Qrator на lenta.com.
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '.playwright-browsers';
const { firefox } = await import('playwright');

const CITY_ID = process.env.LENTA_CITY_ID ?? '107';
const CITY_SLUG = process.env.LENTA_CITY ?? 'ulyanovsk';
const CITY_JSON = JSON.stringify({
  centerLat: '54.314192',
  centerLng: '48.403132',
  id: Number(CITY_ID),
  isDefault: false,
  mainDomain: false,
  name: 'Ульяновск',
  slug: CITY_SLUG,
});
const browser = await firefox.launch({ headless: true });
try {
  const ctx = await browser.newContext({ locale: 'ru-RU' });
  await ctx.addCookies([
    { name: 'App_Cache_City', value: CITY_JSON, domain: 'lenta.com', path: '/' },
    { name: 'App_Cache_CitySlug', value: CITY_SLUG, domain: 'lenta.com', path: '/' },
  ]);
  const page = await ctx.newPage();
  const api = new Set();
  const store = new Set();
  page.on('request', (r) => {
    if (/\/api\//i.test(r.url())) api.add(r.url());
    if (/store|shop|hypermarket/i.test(r.url())) store.add(r.url());
  });
  const resp = await page.goto('https://lenta.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`city id=${CITY_ID} slug=${CITY_SLUG} | status: ${resp?.status()} | title: ${await page.title()}`);
  await page.waitForTimeout(10000);
  console.log('cookies:', (await ctx.cookies()).map((c) => `${c.name}=${c.value.slice(0, 50)}`).join(' | ').slice(0, 600));
  console.log('api:', [...api].slice(0, 15).join('\n  ') || '(нет)');
  console.log('store-ish:', [...store].slice(0, 10).join('\n  ') || '(нет)');
  const html = await page.content();
  for (const re of [/store_?id["'\s:=]+[\d]{1,9}/gi, /citySlug["'\s:=]+[A-Za-z_]+/gi]) {
    console.log(`html ${re}:`, [...new Set(html.match(re) ?? [])].slice(0, 6).join(', ') || '(нет)');
  }
  console.log('html mentions slug:', html.includes(CITY_SLUG), '| mentions city id:', html.includes(`"${CITY_ID}"`));
} finally {
  await browser.close();
}
