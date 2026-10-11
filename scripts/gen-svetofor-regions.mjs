// Генератор справочника регионов Светофора: src/shared/svetofor-regions.ts
// Источник — живой ответ сети (GET https://svetoforonline.ru/api.php?mode=getShops),
// снято 2026-10-08: 636 магазинов в 40 регионах. У каждого магазина свой домен
// региона, и прайс лежит именно на нём, поэтому справочник — это карта
// «наш id города -> домен», плюс сами домены с числом точек.
//
//   node scripts/gen-svetofor-regions.mjs
//
// Сеть отдаёт магазины без привязки к городам (адрес — «поселок Воротынск,
// ул Железнодорожная»), поэтому город для магазина выбирает человек: см.
// scripts/probe-new-stores.mjs и CITY_TO_SHOP ниже. Если живой запрос не прошёл,
// справочник собирается из снимка scripts/svetofor-regions-snapshot.json, и он
// перезаписывается только при успешном живом ответе.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://svetoforonline.ru';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0';
const OUT = fileURLToPath(new URL('../src/shared/svetofor-regions.ts', import.meta.url));
const SNAPSHOT = fileURLToPath(new URL('./svetofor-regions-snapshot.json', import.meta.url));

// Наш id города -> магазин для этого города (shopid). Домен у магазина свой, и
// он НЕ совпадает с «доменом города»: Москва разложена по доменам
// moskovskaya-oblast, moskva-vostok, moskva-yug, moskva-zapad и другим, и прайс
// лежит именно на домене магазина. Поэтому в справочнике хранится пара
// «shopid -> домен», а город выбирает, какой магазин опрашивать. Соответствие
// проверено по живому getShops: магазин должен быть в самом городе.
const CITY_TO_SHOP = {
  moscow: '820',
  'saint-petersburg': '206',
};

async function fetchShops() {
  const answer = await fetch(`${ORIGIN}/api.php?mode=getShops`, { headers: { 'User-Agent': UA } })
    .then((r) => r.json())
    .catch(() => null);
  const shops = answer?.shops;
  return Array.isArray(shops) && shops.length > 0 ? shops : null;
}

const live = await fetchShops();
const shops = live ?? JSON.parse(readFileSync(SNAPSHOT, 'utf8')).shops;

const byDomain = new Map();
for (const shop of shops) {
  if (!shop?.domain) continue;
  const bucket = byDomain.get(shop.domain) ?? [];
  bucket.push(shop);
  byDomain.set(shop.domain, bucket);
}



const shopToDomain = new Map(shops.map((s) => [String(s.id), s.domain]));
// Домен уходит и в хост URL, и в справочник, который коммитится: плохой ответ
// сети не должен навсегда запечатать чужой хост. Фильтруем по форме поддомена
// svetoforonline.ru — всё, что не проходит, в справочник не попадает.
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const badDomains = [...shopToDomain.entries()].filter(([, d]) => typeof d !== 'string' || !DOMAIN_RE.test(d));
if (badDomains.length > 0) {
  console.error(
    `  ВНИМАНИЕ: отброшено поддоменов с неверной формой: ${badDomains.length} (например ${badDomains[0][1]})`,
  );
}
for (const [id] of badDomains) shopToDomain.delete(id);
const unknown = Object.entries(CITY_TO_SHOP).filter(([, shopId]) => !shopToDomain.has(shopId));
if (unknown.length > 0) {
  console.error(
    `  ВНИМАНИЕ: магазинов нет в ответе сети: ${unknown.map(([c, s]) => `${c} -> ${s}`).join(', ')}`,
  );
}

// Ключ магазина -> домен: по нему адресуется прайс точки.
const STORE_DOMAIN = Object.fromEntries(
  [...shopToDomain.entries()].sort((a, b) => Number(a[0]) - Number(b[0])),
);

const body = `// СПРАВОЧНИК СОБРАН АВТОМАТИЧЕСКИ — правь scripts/gen-svetofor-regions.mjs
// Источник: GET https://svetoforonline.ru/api.php?mode=getShops, снято 2026-10-08.
// Не править руками: файл перезаписывается генератором.



/**
 * shopid магазина -> домен, на котором лежит его прайс. Домен берётся из
 * справочника, а не из города: Москва разложена по доменам moskovskaya-oblast,
 * moskva-vostok и другим, и у соседних регионов метки offersupd свои.
 */
export const STORE_DOMAIN: Record<string, string> = ${JSON.stringify(STORE_DOMAIN, null, 2)};

/**
 * Наш id города -> магазин этого города. Сеть отдаёт точки с адресами и без
 * городов, поэтому соответствие «город -> магазин» проверяется вручную по
 * живому ответу getShops. Новый город — новая строка, магазины при этом
 * не меняются.
 */
export const CITY_TO_SHOP: Record<string, string> = ${JSON.stringify(CITY_TO_SHOP, null, 2)};

/** Домен магазина: на нём лежит его прайс. */
export function svetoforDomain(
  shopId: string,
  domains: Record<string, string> = STORE_DOMAIN,
): string {
  const domain = domains[shopId];
  if (!domain) {
    throw new Error(\`svetofor: магазин \${shopId} не найден в справочнике (пересобери: npm run svetofor:regions)\`);
  }
  return domain;
}
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, body, 'utf8');
// Снимок — страховка на случай, когда живой запрос не прошёл. Перезаписываем
// его ТОЛЬКО при успешном живом ответе: иначе плохой ответ сети (пустой или
// обрезанный) навсегда испортил бы страховку.
if (live !== null) writeFileSync(SNAPSHOT, `${JSON.stringify({ shops }, null, 2)}\n`, 'utf8');
console.log(
  `  svetofor-regions.ts: ${byDomain.size} регионов, ${Object.keys(STORE_DOMAIN).length} магазинов, ${Object.keys(CITY_TO_SHOP).length} городов${live === null ? ' (живой ответ не пришёл, взят снимок)' : ''}`,
);