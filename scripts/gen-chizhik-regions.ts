// Генератор справочника магазинов Чижика: src/shared/chizhik-regions.ts
//
//   npx tsx scripts/gen-chizhik-regions.ts
//
// Источник — живой ответ `GET https://app.chizhik.club/api/v1/shops` (снято
// 2026-10-08: 3799 магазинов, у каждого `sap_id` и `locality`).
//
// ПОЧЕМУ ЧЕРЕЗ БРАУЗЕР, А НЕ fetch: обычный клиент (и Node, и PowerShell)
// получает 307 на тот же URL — редирект-петля. Из контекста страницы
// `app.chizhik.club` тот же адрес отдаёт 200 (проверено 2026-10-08). Это тот же
// антибот, из-за которого каталог и цены едут на браузерном транспорте.
//
// Что делаем: оставляем по ОДНОМУ магазину на каждый наш город, для которого сеть
// реально что-то имеет. Сопоставление строго по названию `locality`: у сети
// почти тысяча городов, и переименовать «Нижний Новгород» в наш
// `nizhny-novgorod` — значит догадаться, а ошибиться здесь нельзя (получим цены
// чужого города). Поэтому алиасы в `CITY_TO_LOCALITY` дописываются руками и
// только после того, как человек увидел близкие варианты в отчёте.
//
// Снимок рядом — узкий: по 3 магазина на каждый наш город (для ручной сверки и
// как фолбэк, когда сеть недоступна). Полный ответ — 1.1 МБ, и в репозиторий ему
// не место.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CITIES } from '../src/shared/catalog.js';
import { openInPageFetch } from './probe-helper.js';

const SHOPS_URL = 'https://app.chizhik.club/api/v1/shops';
const SNAPSHOT = resolve(process.cwd(), 'scripts/chizhik-shops-snapshot.json');
const OUT = resolve(process.cwd(), 'src/shared/chizhik-regions.ts');
/** Сколько магазинов каждого города кладём в снимок — больше не нужно. */
const SNAPSHOT_PER_CITY = 3;

/**
 * Наш id города -> название города у Чижика. Здесь только прямое совпадение
 * написания: любое иное («Санкт-Петербург г.», «СПб») дописывается руками,
 * когда отчёт генератора покажет близкий вариант.
 */
const CITY_TO_LOCALITY: Record<string, string> = {
  moscow: 'Москва',
  'saint-petersburg': 'Санкт-Петербург',
  novosibirsk: 'Новосибирск',
  ekaterinburg: 'Екатеринбург',
  kazan: 'Казань',
  'nizhny-novgorod': 'Нижний Новгород',
  chelyabinsk: 'Челябинск',
  krasnoyarsk: 'Красноярск',
  perm: 'Пермь',
  barnaul: 'Барнаул',
  omsk: 'Омск',
  kemerovo: 'Кемерово',
  ulyanovsk: 'Ульяновск',
  krasnodar: 'Краснодар',
  irkutsk: 'Иркутск',
};

interface Shop {
  sap_id?: unknown;
  name?: unknown;
  locality?: unknown;
}

interface Snapshot {
  takenAt?: string;
  cities?: Record<string, Shop[]>;
}

async function fetchShopsLive(): Promise<Shop[] | null> {
  try {
    const body = await openInPageFetch(SHOPS_URL);
    return Array.isArray(body) && body.length > 0 ? (body as Shop[]) : null;
  } catch (err) {
    console.log(`  живой ответ не пришёл (${(err as Error).message.slice(0, 80)}) — беру снимок`);
    return null;
  }
}

const live = await fetchShopsLive();
let shops: Shop[];
if (live) {
  shops = live;
} else {
  if (!existsSync(SNAPSHOT)) {
    throw new Error(`chizhik: нет ни живого ответа, ни снимка ${SNAPSHOT} — запусти при доступной сети`);
  }
  const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot;
  shops = Object.values(snap.cities ?? {}).flat();
  console.log(`  снимок от ${snap.takenAt ?? 'неизвестной даты'}: ${shops.length} магазинов`);
}

const byLocality = new Map<string, Shop[]>();
for (const shop of shops) {
  if (typeof shop.locality !== 'string') continue;
  const bucket = byLocality.get(shop.locality) ?? [];
  if (bucket.length < SNAPSHOT_PER_CITY) bucket.push(shop);
  byLocality.set(shop.locality, bucket);
}

const picked: Record<string, { sapId: string; name: string }> = {};
const missing: string[] = [];
for (const [city, locality] of Object.entries(CITY_TO_LOCALITY)) {
  const first = byLocality.get(locality)?.[0];
  if (!first || typeof first.sap_id !== 'string') {
    missing.push(`${city} («${locality}»)`);
    continue;
  }
  picked[city] = { sapId: first.sap_id, name: String(first.name ?? '') };
}

const ours = new Set(CITIES.map((c) => c.id));
for (const city of Object.keys(picked)) {
  if (!ours.has(city)) console.error(`  ВНИМАНИЕ: ${city} есть в справочнике, но нет в каталоге городов`);
}

if (live) {
  const narrow: Record<string, Shop[]> = {};
  for (const [city, locality] of Object.entries(CITY_TO_LOCALITY)) {
    const bucket = byLocality.get(locality);
    if (bucket && bucket.length > 0) narrow[locality] = bucket;
  }
  writeFileSync(
    SNAPSHOT,
    `${JSON.stringify(
      {
        takenAt: new Date().toISOString().slice(0, 10),
        url: SHOPS_URL,
        note: 'узкий снимок: по 3 магазина на каждый наш город, полный ответ не храним',
        cities: narrow,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

if (missing.length > 0) {
  console.log(`  без магазина: ${missing.length} городов`);
  for (const item of missing) {
    const locality = item.slice(item.indexOf('«') + 1, item.lastIndexOf('»'));
    const stem = locality.slice(0, 5).toLowerCase();
    const near = [...byLocality.keys()]
      .filter((k) => k.toLowerCase().startsWith(stem) || stem.startsWith(k.slice(0, 5).toLowerCase()))
      .slice(0, 8);
    console.log(`    ${item}`);
    if (near.length > 0) console.log(`      близко у сети: ${near.join(', ')}`);
    else console.log(`      близко у сети: ничего похожего`);
  }
}

const body = `// СПРАВОЧНИК СОБРАН АВТОМАТИЧЕСКИ — правь scripts/gen-chizhik-regions.ts
// Источник: GET https://app.chizhik.club/api/v1/shops из контекста страницы
// app.chizhik.club, снято ${new Date().toISOString().slice(0, 10)}. Не править руками:
// файл перезаписывается генератором.

/** Один магазин Чижика на наш город. */
export interface ChizhikStore {
  /** Буквенный код точки (4 знака). Именно он подставляется в адрес каталога. */
  sapId: string;
  /** Название точки из ответа сети — только для показа пользователю. */
  name: string;
}

/**
 * Города каталога, для которых у Чижика есть магазин. Соответствие строго по
 * названию города: у сети почти тысяча городов, и «Нижний Новгород» нужно
 * сопоставить с проверкой живого ответа — иначе цены придут из соседнего города.
 *
 * Покрыты 11 городов из 15. НЕ покрыты Санкт-Петербург, Красноярск, Омск и
 * Иркутск: в localities сети для них нет (для Питера есть только
 * «Ленинградская ст-ца» — станица в Краснодарском крае, а не Санкт-Петербург).
 */
export const CITY_TO_STORE: Record<string, ChizhikStore> = ${JSON.stringify(picked, null, 2)};

/** Код магазина нашего города. */
export function chizhikSapId(city: string): string {
  const store = CITY_TO_STORE[city];
  if (!store) throw new Error(\`chizhik: нет магазина для города \${city} (см. chizhik-regions.ts)\`);
  return store.sapId;
}
`;

writeFileSync(OUT, body, 'utf8');
console.log(`  chizhik-regions.ts: ${Object.keys(picked).length} городов из ${Object.keys(CITY_TO_LOCALITY).length} наших`);
for (const [city, store] of Object.entries(picked)) console.log(`    ${city.padEnd(17)} ${store.sapId}  ${store.name.slice(0, 42)}`);