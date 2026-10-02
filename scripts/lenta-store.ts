// Коды магазинов Ленты по городам. Ленте не нужен выбор магазина в браузере:
// POST /api-gateway/v1/stores/pickup/search с пустым телом отдаёт ВСЕ точки
// сети (1020 шт., проверено 2026-09-30) с полем regionId, а координаты в теле
// игнорируются. Справочник регионов (regionId -> slug, имя, сколько точек)
// лежит в src/shared/lenta-regions.ts, его пересобирает
// scripts/gen-lenta-regions.mjs.
//
//   npm run lenta:store                       # сводка по нашим городам
//   npm run lenta:store -- spb                # все точки Петербурга
//   npm run lenta:store -- spb --pickup       # только с самовывозом
//   npm run lenta:store -- moscow --near 55.7,37.6
//
// Печатает id точки — его и вписываем в CITY_STORES (src/shared/catalog.ts)
// и в сид stores (src/core/db/schema.sql).
import assert from 'node:assert';
import { LENTA_REGIONS, CITY_TO_SLUG } from '../src/shared/lenta-regions.js';

const ORIGIN = 'https://lenta.com';
const API = `${ORIGIN}/api-gateway/v1`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0';
const CLIENT = 'angular_web_0.0.2';
const MPK = 'mp300-b1de0bac2c257f3257bf5ef2eea4ecbc';

const arg = process.argv[2] ?? '';
const flags = process.argv.slice(3);
const wantSlug = CITY_TO_SLUG[arg] ?? arg;
const onlyPickup = flags.includes('--pickup');
const nearIdx = flags.indexOf('--near');
const near = nearIdx >= 0 ? flags[nearIdx + 1]?.split(',').map(Number) : null;
const limit = Number(flags[flags.indexOf('--limit') + 1]) || 20;

const slugToRegion = new Map(LENTA_REGIONS.map((r) => [r.slug, r.id]));

const deviceId = crypto.randomUUID();
const sessionRes = await fetch(`${ORIGIN}/api/rest/sessionGet`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
  body: `request=${encodeURIComponent(
    JSON.stringify({
      Head: {
        MarketingPartnerKey: MPK,
        Version: 'web-12.0.823',
        Client: CLIENT,
        Method: 'sessionGet',
        DeviceId: deviceId,
        Domain: wantSlug,
      },
      Body: {},
    }),
  )}`,
});
interface LentaStore {
  id: number;
  alias: string;
  marketType: string;
  features: string[];
  title: string;
  addressShort: string;
  regionId: number;
  coordinates: { latitude: number; longitude: number };
}

interface SessionResponse {
  Body?: { SessionToken?: string };
}

const cityNames: Record<string, string> = {
  moscow: 'Москва',
  'saint-petersburg': 'Санкт-Петербург',
  ulyanovsk: 'Ульяновск',
  krasnodar: 'Краснодар',
  irkutsk: 'Иркутск',
};

const sessionJson = (await sessionRes.json()) as SessionResponse;
assert.ok(sessionJson?.Body?.SessionToken, `sessionGet не выдал токен: ${sessionRes.status}`);

const listRes = await fetch(`${API}/stores/pickup/search`, {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    'User-Agent': UA,
    Referer: `${ORIGIN}/`,
    Origin: ORIGIN,
    SessionToken: sessionJson.Body.SessionToken,
    DeviceID: deviceId,
    'X-Device-Id': deviceId,
    'X-Retail-Brand': 'lo',
    'X-Platform': 'omniweb',
    'X-Device-OS': 'Web',
    'X-Delivery-Mode': 'pickup',
    'X-Query-Host': 'lenta.com',
    'App-Version': '0.0.2',
    'X-Domain': wantSlug,
    Client: CLIENT,
    MarketingPartnerKey: MPK,
    'Content-Type': 'application/json',
  },
  body: '{}',
});
assert.ok(listRes.ok, `stores/pickup/search -> HTTP ${listRes.status}`);
const stores = ((await listRes.json()) as { items?: LentaStore[] }).items ?? [];
assert.ok(stores.length > 0, 'сеть вернула пустой список точек');

console.log(`точек в сети: ${stores.length}, регионов: ${new Set(stores.map((s) => s.regionId)).size}`);

if (!arg) {
  console.log('\nнаши города (id точки для CITY_STORES):');
  for (const [city, slug] of Object.entries(CITY_TO_SLUG) as [string, string][]) {
    const label = cityNames[city] ?? city;
    const rid = slugToRegion.get(slug);
    const inCity = stores.filter((s) => s.regionId === rid);
    const sample = inCity.slice(0, 3).map((s) => `${s.id} (${s.marketType}, самовывоз: ${s.features.includes('PICKUP') ? 'да' : 'нет'})`);
    console.log(
      `  ${label.padEnd(18)} slug=${slug.padEnd(10)} regionId=${String(rid).padEnd(4)} точек=${String(inCity.length).padStart(3)}  ${sample.join('  ')}`,
    );
  }
  console.log('\nподробности: npm run lenta:store -- <город>');
} else {
  const rid = slugToRegion.get(wantSlug);
  assert.ok(rid, `не знаю регион по slug «${wantSlug}» (см. src/shared/lenta-regions.ts)`);
  let found = stores.filter((s) => s.regionId === rid);
  if (onlyPickup) found = found.filter((s) => s.features.includes('PICKUP'));
  if (near && near.length === 2) {
    const [lat, lon] = near as [number, number];
    const dist = (s: LentaStore) => {
      const dx = (s.coordinates.longitude - lon) * Math.cos((lat * Math.PI) / 180);
      const dy = s.coordinates.latitude - lat;
      return Math.hypot(dx, dy);
    };
    found = found.slice().sort((a, b) => dist(a) - dist(b));
  }
  console.log(`\n${cityNames[arg] ?? arg} (${wantSlug}, regionId=${rid}): найдено ${found.length}`);
  for (const s of found.slice(0, limit)) {
    console.log(
      `  id=${String(s.id).padEnd(6)} alias=${s.alias.padEnd(5)} ${s.marketType.padEnd(3)} ` +
        `самовывоз=${s.features.includes('PICKUP') ? 'да' : 'НЕТ'} ` +
        `${String(s.title).padEnd(9)} ${s.addressShort}`,
    );
  }
  if (found.length === 0) console.log('  (пусто: в этом городе нет подходящих точек)');
  console.log(`\nвписать в catalog.ts: { storeId: 'lenta', name: 'Лента', externalStoreId: '${found[0]?.id ?? ''}', ready: false }`);
}
