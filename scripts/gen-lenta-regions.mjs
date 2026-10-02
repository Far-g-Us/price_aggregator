// Генератор справочника регионов Ленты: src/shared/lenta-regions.ts
// Источник — живые ответы сети (POST /api-gateway/v1/stores/pickup/search и
// GET /api-gateway/v1/region/list), снято 2026-09-30. Ленты не нужно выбирать
// магазин в браузере: pickup/search отдаёт все точки со всеми регионами.
//
//   node scripts/gen-lenta-regions.mjs
// region/list — GET, с дата-центровой сети его режет Qrator (401). Поэтому
// имена регионов берём из живого ответа, а если он недоступен — из
// снимка scripts/lenta-regions-snapshot.json (публичный справочник, без
// персональных данных). Пересобрать снимок из домашней сети:
// LENTA_REFRESH_SNAPSHOT=1 node scripts/gen-lenta-regions.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://lenta.com';
const API = `${ORIGIN}/api-gateway/v1`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0';
const CLIENT = 'angular_web_0.0.2';
const MPK = 'mp300-b1de0bac2c257f3257bf5ef2eea4ecbc';
const OUT = fileURLToPath(new URL('../src/shared/lenta-regions.ts', import.meta.url));
const SNAPSHOT = fileURLToPath(new URL('./lenta-regions-snapshot.json', import.meta.url));

const deviceId = crypto.randomUUID();
const s = await fetch(`${ORIGIN}/api/rest/sessionGet`, {
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
        Domain: 'moscow',
      },
      Body: {},
    }),
  )}`,
});
const token = (await s.json()).Body?.SessionToken;
if (!token) throw new Error('sessionGet не выдал SessionToken');

const base = {
  Accept: 'application/json',
  'User-Agent': UA,
  Referer: `${ORIGIN}/`,
  Origin: ORIGIN,
  SessionToken: token,
  DeviceID: deviceId,
  'X-Device-Id': deviceId,
  'X-Retail-Brand': 'lo',
  'X-Platform': 'omniweb',
  'X-Device-OS': 'Web',
  'X-Delivery-Mode': 'pickup',
  'X-Query-Host': 'lenta.com',
  'App-Version': '0.0.2',
  'X-Domain': 'moscow',
  Client: CLIENT,
  MarketingPartnerKey: MPK,
  'Content-Type': 'application/json',
};

// region/list — GET, с дата-центровой сети его режет Qrator. Поэтому имена
// регионов берём из pickup/search, а если сеть их не отдаёт — slug оставляем.
const listRes = await fetch(`${API}/stores/pickup/search`, { method: 'POST', headers: base, body: '{}' });
if (!listRes.ok) throw new Error(`stores/pickup/search -> HTTP ${listRes.status}`);
const stores = (await listRes.json()).items ?? [];

const byRegion = new Map();
for (const s2 of stores) {
  const rid = s2.regionId;
  const cur = byRegion.get(rid) ?? { stores: 0, pickup: 0, sample: null, marketTypes: new Set() };
  cur.stores += 1;
  if (s2.features?.includes('PICKUP')) {
    cur.pickup += 1;
    if (!cur.sample) cur.sample = s2.id;
  }
  if (s2.marketType) cur.marketTypes.add(s2.marketType);
  byRegion.set(rid, cur);
}

// Имена регионов: живой region/list, иначе снимок.
let names = new Map();
const { 'Content-Type': _jsonOnly, ...baseGet } = base;
const regionRes = await fetch(`${API}/region/list`, { method: 'GET', headers: baseGet });
if (regionRes.ok) {
  const body = await regionRes.json();
  for (const g of body.regions ?? []) names.set(g.id, { name: g.name, slug: g.slug });
  if (process.env.LENTA_REFRESH_SNAPSHOT) {
    writeFileSync(
      SNAPSHOT,
      JSON.stringify(
        {
          _source: 'GET https://lenta.com/api-gateway/v1/region/list',
          _note: 'Публичный справочник регионов магазина (id/slug/name), без персональных данных. Нужен, потому что region/list — GET, и с дата-центровой сети его режет Qrator. Обновляется: LENTA_REFRESH_SNAPSHOT=1 node scripts/gen-lenta-regions.mjs из домашней сети.',
          regions: (body.regions ?? []).map((g) => ({ id: g.id, slug: g.slug, name: g.name })),
        },
        null,
        1,
      ) + '\n',
      'utf8',
    );
    console.log('снимок регионов обновлён');
  }
} else {
  console.log(`region/list недоступен (HTTP ${regionRes.status}) — берём снимок`);
  const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf-8'));
  for (const g of snap.regions ?? []) names.set(g.id, { name: g.name, slug: g.slug });
}

const rows = [...byRegion.entries()]
  .map(([id, v]) => {
    const meta = names.get(id);
    return {
      id,
      slug: meta?.slug ?? null,
      name: meta?.name ?? null,
      stores: v.stores,
      pickup: v.pickup,
      sampleStoreId: v.sample,
      marketTypes: [...v.marketTypes].sort().join(','),
    };
  })
  .sort((a, b) => b.stores - a.stores || a.id - b.id);

// Сеть отдаёт неполный список с чужой географии (с IP ЦОД приходит 1018/1020
// точек, из других мест — меньше). Не даём испортить хороший справочник.
const existing = readFileSync(OUT, 'utf-8').match(/"stores": (\d+)/g) ?? [];
const prevTotal = existing.reduce((sum, s) => sum + Number(s.replace(/\D/g, '')), 0);
const total = rows.reduce((a, r) => a + r.stores, 0);
if (existing.length > 0 && total < prevTotal * 0.9) {
  console.error(
    `ОТКАЗ: с этой сети пришло ${total} точек против ${prevTotal} в текущем справочнике. ` +
      'Похоже, список неполный (география/IP). Перегенерируй из домашней сети или оставь как есть.',
  );
  process.exit(1);
}
if (rows.some((r) => r.slug === null)) {
  console.error(
    'ОТКАЗ: region/list недоступен И снимка нет — в справочнике останутся регионы без slug, ' +
      'а по slug строится X-Domain. Запусти из домашней сети.',
  );
  process.exit(1);
}

const body = `// СГЕНЕРИРОВАНО scripts/gen-lenta-regions.mjs из живых ответов lenta.com, ${new Date()
  .toISOString()
  .slice(0, 10)}. Не править руками.
//
// Что это: справочник регионов Ленты. У Ленты нет «кода города» — цена
// всегда за конкретную точку, а регион определяет, к какому городу точка
// относится (это slug, а не наш id города: СПб — \`spb\`, Краснодар — \`ksdr\`).
// Это НЕ id из CITY_STORES: там id точки (напр. 4161 = ТК3090, Москва).
//
// \`stores\` — сколько точек в регионе, \`pickup\` — сколько с самовывозом
// (только такие годится: цены берутся по mode:pickup), \`sampleStoreId\` —
// первая точка с самовывозом, её можно сразу вписать в src/shared/catalog.ts.

export interface LentaRegion {
  /** regionId из pickup/search и region/list. */
  id: number;
  /** slug региона: он уходит в заголовок X-Domain. */
  slug: string | null;
  /** Название региона как в магазине, null если region/list был недоступен. */
  name: string | null;
  /** Всего точек в регионе. */
  stores: number;
  /** Из них с самовывозом. */
  pickup: number;
  /** Первая точка с самовывозом — кандидат на externalStoreId. */
  sampleStoreId: number | null;
  /** Типы точек: SM супермаркет, HM гипермаркет, ZO зоомагазин. */
  marketTypes: string;
}

export const LENTA_REGIONS: LentaRegion[] = ${JSON.stringify(rows, null, 2)};

/** Регион по slug (именно slug идёт в X-Domain). */
export function lentaRegionBySlug(slug: string): LentaRegion | undefined {
  return LENTA_REGIONS.find((r) => r.slug === slug);
}

/** Регион по нашему id города из CITY_STORES. */
export function lentaRegionByCity(city: string): LentaRegion | undefined {
  return LENTA_REGIONS.find((r) => r.slug === CITY_TO_SLUG[city]);
}

/**
 * Наш id города -> slug региона Ленты. Разные системы нумерации: у нас
 * \`saint-petersburg\`, у Ленты \`spb\`; у нас \`krasnodar\`, у Ленты \`ksdr\`.
 * Подставить свой id в X-Domain нельзя — всё кроме Москвы уедет в 401.
 */
export const CITY_TO_SLUG: Record<string, string> = {
  moscow: 'moscow',
  'saint-petersburg': 'spb',
  ulyanovsk: 'ulyanovsk',
  krasnodar: 'ksdr',
  irkutsk: 'irkutsk',
};
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, body, 'utf-8');
console.log(`регионов: ${rows.length}, точек: ${stores.length}`);
console.log('топ-10 по числу точек:');
for (const r of rows.slice(0, 10)) console.log(`  ${String(r.id).padStart(4)} ${r.slug ?? '?'.padEnd(12)} ${String(r.stores).padStart(4)}  ${r.name ?? '(без имени)'}`);
console.log(`\nзаписано: ${OUT}`);
