// Разведка транспорта каталога Ленты через настоящий браузер.
//
// Зачем: Qrator режет GET на api-gateway для Node fetch — у Node нет куки
// qrator_jsr, которую ставит браузер после JS-челленджа. Настоящий браузер,
// загрузивший сайт как человек, эти GET делает сам. Мы не обходим защиту и не
// исполняем челлендж в коде: открываем страницу и читаем перехваченные ответы.
//
// Что зонд ищет (важно для инварианта «успешный ответ ≠ наш магазин»):
//   1. КАКОЙ storeId сайт сам зовёт в POST /delivery/mode/set — это то, что
//      реально выбрал сайт, а не то, что мы попросили.
//   2. ЧТО лежит в GET /region/user: там domainRegionId, его можно сверить с
//      регионом нашего города из src/shared/lenta-regions.ts.
//   3. Есть ли маркер точки в ответе catalog/items (в поиске его нет).
//
// Запуск:  npm run lenta:browser            (из корня)
//          LENTA_CITY=omsk npm run lenta:browser
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Браузеры лежат в проекте, а Playwright по умолчанию смотрит в
// %LOCALAPPDATA%\ms-playwright — из-за этого `npm run lenta:browser` падал с
// «Executable doesn't exist», хотя Firefox рядом, в .playwright-browsers.
// Переменную обязано ставить ДО импорта playwright: он замораживает путь при
// первом импорте. Приложение делает то же самое в whenReady, но из Electron,
// а этот скрипт запускается обычным node/tsx.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localBrowsers = join(projectRoot, '.playwright-browsers');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(localBrowsers)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsers;
}

const ORIGIN = 'https://lenta.com';
const OUT = join(tmpdir(), 'lenta-browser-probe');
const CITY = process.env.LENTA_CITY ?? 'moscow';
const CATALOG_PATH = process.env.LENTA_CATALOG_PATH ?? '';
mkdirSync(OUT, { recursive: true });

const playwright = await import('playwright');
const headful = process.env.LENTA_HEADFUL === '1';
const profile = join(OUT, 'profile');
if (!existsSync(profile)) mkdirSync(profile, { recursive: true });
console.log(`каталог браузеров: ${process.env.PLAYWRIGHT_BROWSERS_PATH ?? '(системный по умолчанию)'}`);
const context = await playwright.firefox.launchPersistentContext(profile, {
  headless: !headful,
  locale: 'ru-RU',
});
const page = await context.pages()[0] ?? (await context.newPage());

const requests = [];
const responses = [];
page.on('request', (req) => {
  const url = req.url();
  if (!/api-gateway|jrpc|rest\//.test(url)) return;
  requests.push({
    method: req.method(),
    path: url.replace(ORIGIN, '').replace(/\?.*/, ''),
    body: req.postData()?.slice(0, 300) ?? '',
  });
});
page.on('response', async (res) => {
  const url = res.url();
  if (!/api-gateway|jrpc|rest\//.test(url)) return;
  const mime = (res.headers()['content-type'] ?? '').split(';')[0];
  let text = '';
  try {
    if (mime.includes('json')) text = await res.text();
  } catch {
    text = '';
  }
  responses.push({
    status: res.status(),
    method: res.request().method(),
    path: url.replace(ORIGIN, '').replace(/\?.*/, ''),
    body: text,
  });
});

const go = async (url, label) => {
  console.log(`\n=== ${label}: ${url}`);
  try {
    const r = await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
    console.log(`  статус: ${r?.status() ?? 'нет'}`);
  } catch (e) {
    console.log(`  переход не удался: ${String(e).slice(0, 90)}`);
  }
  await page.waitForTimeout(6000);
  const cookies = await context.cookies();
  const hasQrator = cookies.some((c) => c.name === 'qrator_jsr');
  const info = await page
    .evaluate(() => ({ title: document.title, text: (document.body?.innerText ?? '').slice(0, 100) }))
    .catch(() => ({ title: '?', text: '' }));
  console.log(`  страница: "${info.title.slice(0, 50)}" текст="${info.text.replace(/\s+/g, ' ').slice(0, 60)}"`);
  console.log(`  qrator_jsr: ${hasQrator ? 'есть' : 'НЕТ'}`);
}

await go(`${ORIGIN}/`, 'главная');
await go(`${ORIGIN}/catalog/`, 'каталог');
if (CATALOG_PATH) await go(`${ORIGIN}${CATALOG_PATH}`, 'раздел каталога');

console.log('\n=== что сайт сам просил (важно: это выбор САЙТА) ===');
for (const r of requests) {
  console.log(`  ${r.method.padEnd(4)} ${r.path}${r.body ? `  тело: ${r.body.slice(0, 160)}` : ''}`);
}

console.log('\n=== ответы ===');
for (const r of responses) {
  const kind = r.body ? (r.body.startsWith('{') || r.body.startsWith('[') ? 'json' : 'текст') : '—';
  console.log(`  ${String(r.status).padEnd(4)} ${r.method.padEnd(4)} ${r.path}`);
  if (r.status === 200 && r.body) {
    const name = `${r.method}-${r.path.replace(/[^\w]+/g, '_')}.json`;
    writeFileSync(join(OUT, name), r.body, 'utf8');
    console.log(`        сохранено: ${join(OUT, name)} (${r.body.length} симв.)`);
  }
}

// Сверка региона: если сайт сам назвал наш город — ответ можно доверять.
const regionUser = responses.find((r) => r.path.endsWith('/region/user') && r.status === 200);
if (regionUser) {
  try {
    const j = JSON.parse(regionUser.body);
    console.log(`\nregion/user: ${JSON.stringify(j)}`);
    console.log(`ожидали регион для города ${CITY} — сверь slug 'moscow' с id в справочнике`);
  } catch {
    console.log('\nregion/user: не разобрали');
  }
} else {
  console.log('\nregion/user не пришёл — магазин не подтверждён, каталог доверять нельзя');
}

await context.close();
console.log(`\nснимки: ${OUT}`);
console.log('ВАЖНО: HAR и снимки с живыми куками наружу не отдавать.');