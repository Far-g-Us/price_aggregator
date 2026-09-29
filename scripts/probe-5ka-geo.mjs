import { firefox } from 'playwright';

// Сайт висит на geo-location-loader. Пробуем выдать браузерную
// геолокацию (координаты города) и открыть пикер адреса.
const CITIES = [
  { name: 'ulyanovsk', lat: 54.314192, lng: 48.403132 },
  { name: 'saint-petersburg', lat: 59.9386, lng: 30.3141 },
];
for (const city of CITIES) {
  const browser = await firefox.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      locale: 'ru-RU',
      geolocation: { latitude: city.lat, longitude: city.lng },
      permissions: ['geolocation'],
    });
    const page = await ctx.newPage();
    const hits = [];
    page.on('request', (r) => {
      const u = r.url();
      if (/5d\.5ka\.ru\/api/.test(u) || /geocod|address|geo/i.test(u)) hits.push(u.slice(0, 110));
    });
    await page.goto('https://5ka.ru/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(13000);
    const store = (await ctx.cookies('https://5ka.ru')).find((c) => c.name === '5ka_store_id_store')?.value;
    console.log(`${city.name}: магазин=${store} запросы=${[...new Set(hits)].length}`);
    console.log('  ' + [...new Set(hits)].slice(0, 6).join('\n  '));
  } finally {
    await browser.close();
  }
}
