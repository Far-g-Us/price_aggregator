// Диагностика входа в Пятёрочку: с какого IP мы лезем, что о нём думают
// гео-базы и какой магазин отдаёт сайт. Одна команда —
//   npm run 5ka:store
// Перед запуском ВЫКЛЮЧИ Cloudflare WARP: он подменяет домашний адрес
// адресом датацентра, и магазин определяется не по твоему городу.
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '.playwright-browsers';
const { firefox } = await import('playwright');
import { execFileSync } from 'node:child_process';

function warpState() {
  try {
    // sc.exe печатает по-русски и в чужой кодировке, поэтому берём только
    // ASCII-часть: номер состояния и слово RUNNING/STOPPED.
    const out = execFileSync('sc.exe', ['query', 'CloudflareWARP'], { encoding: 'latin1' });
    const m = out.match(/\b(1|4)\s+(RUNNING|STOPPED)\b/);
    if (!m) return 'не определено';
    return m[2] === 'RUNNING' ? 'ВКЛЮЧЁН (твой IP подменён)' : 'выключен';
  } catch {
    return 'служба не найдена';
  }
}

async function geo() {
  try {
    const r = await fetch('http://ip-api.com/json/?fields=query,city,regionName,country,isp,proxy,hosting');
    const j = await r.json();
    return {
      ip: j.query ?? '?',
      place: [j.city, j.regionName, j.country].filter(Boolean).join(', ') || '?',
      isp: j.isp ?? '?',
      viaProxy: j.proxy === true || j.hosting === true,
    };
  } catch (e) {
    return { ip: '?', place: `не определили: ${e.message}`, isp: '?', viaProxy: false };
  }
}

const g = await geo();
console.log('=== Сеть ===');
console.log('Cloudflare WARP:', warpState());
console.log('IP для сайтов:', g.ip);
console.log('Гео по ip-api:', g.place);
console.log('Провайдер:', g.isp);
if (g.viaProxy) console.log('Внимание: адрес помечен как прокси/датацентр, не домашний.');

const browser = await firefox.launch({ headless: true });
let store = null;
let address = '';
try {
  const ctx = await browser.newContext({ locale: 'ru-RU' });
  const page = await ctx.newPage();
  // Код магазина берём из куки ИЛИ из URL запроса каталога: кука ставится не
  // сразу (замер 2026-10-02 — в одном прогоне её не было через 6 с), а магазин
  // при этом уже назван. Cookie-only диагностика врала «капча» там, где её нет.
  const apiWaiter = page
    .waitForResponse((r) => /^https:\/\/5d\.5ka\.ru\/api\/catalog\/v\d\/stores\/([^/]+)\//.test(r.url()), {
      timeout: 40000,
    })
    .then((r) => /^https:\/\/5d\.5ka\.ru\/api\/catalog\/v\d\/stores\/([^/]+)\//.exec(r.url())[1])
    .catch(() => null);
  await page.goto('https://5ka.ru/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const cookies = await ctx.cookies('https://5ka.ru');
    store = cookies.find((c) => c.name === '5ka_store_id_store')?.value ?? null;
    if (store) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!store) store = await Promise.race([apiWaiter, new Promise((r) => setTimeout(() => r(null), 1000))]);
  if (store) {
    address = await page.evaluate(() => {
      try {
        const dp = JSON.parse(localStorage.getItem('DeliveryPanelStore') || '{}');
        return dp?.selectedAddress?.shopAddress || dp?.selectedStore?.shopAddress || '';
      } catch {
        return '';
      }
    });
  }
} finally {
  await browser.close();
}

console.log('\n=== Пятёрочка ===');
console.log('Магазин от сайта:', store ?? 'не определился (ни кука, ни запрос каталога — капча или нет сети)');
if (address) console.log('Адрес магазина:', address);

const same = g.place.toLowerCase().includes('ульянов');
console.log('\n=== Вывод ===');
if (!store) {
  console.log('Сайт не отдал магазин. Повтори запуск — обычно проходит со второй попытки.');
  console.log('Если повторяется: включи обычный браузер и проверь капчу.');
} else if (same && store === '3288') {
  console.log('Гео и магазин совпали с Ульяновском — город можно включать, прокси не нужен.');
} else if (same) {
  console.log('Гео говорит Ульяновск, но магазин московский: 5ka смотрит не только на IP.');
} else {
  console.log('Гео не Ульяновск, поэтому магазин чужой. ВЫКЛЮЧИ WARP и запусти снова.');
}
console.log('Код магазина вписывается в src/shared/catalog.ts для этого города.');
