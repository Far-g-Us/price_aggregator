// Сбор точек Магнита по городу.
//   npx tsx scripts/magnit-stores.ts
//   npx tsx scripts/magnit-stores.ts saint-petersburg
//   npx tsx scripts/magnit-stores.ts 277027
//   npx tsx scripts/magnit-stores.ts saint-petersburg --radius 0.04 --check 4 --addresses
//
// Через `npm run magnit:stores -- <город>` тоже работает, но npm отбирает свои
// флаги и не пропускает `--radius` дальше по цепочке: `--radius` он считает
// своим. Поэтому флаги даются прямо в npx-команду.
//
// Что делает. У Магнита нет списка магазинов ни в API, ни в sitemap (проверено
// 2026-11-11: `/webgate/*/stores` → 404, `/webgate/v2/cities` отдаёт 5182 города
// без кодов точек, в sitemap только разделы и товары). Зато при выборе магазина
// на сайте сеть сама зовит
// `POST /webgate/v1/stores-facade/search` с географическим квадратом и получает
// все точки внутри него. Это и есть источник.
//
// Опорная точка берётся из `src/shared/catalog.ts` (по городу или по коду), её
// координаты — из `POST /webgate/v1/stores-facade/store`. Метод сам себя
// проверяет: код из справочника обязан найтись среди отданных точек, иначе
// квадрат построен не вокруг того города и выдача бессмысленна.
//
// Скрипт НИЧЕГО не пишет в catalog.ts: добавление точек решено вручную
// (ROADMAP, Фаза 6). Назначение — показать готовые строки и коды, чтобы вписать
// их руками, и проверить код живым поиском перед этим.
//
// Осторожно с объёмом: в городе 200–300 точек, а проверка живым поиском — это
// запрос к сети на точку. По умолчанию проверяются только найденные в
// справочнике плюс `--check N` первых по расстоянию от опорной.
import { CITY_STORES } from '../src/shared/catalog.js';
import { MagnitAdapter } from '../src/core/adapters/magnit.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0';
const POST_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  'Accept-Language': 'ru-RU,ru;q=0.9',
  'Content-Type': 'application/json',
  Referer: 'https://magnit.ru/',
};
/** Тип точки: MM — Магнит, ME — Магнит Экстра, MA — Аптека. */
const STORE_TYPE = 'MM';

interface FacadeStore {
  externalId?: { storeCode?: string };
  storeTypeV2?: string;
  isActive?: boolean;
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string): boolean => args.includes(name);
const target = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--radius' && args[args.indexOf(a) - 1] !== '--check');

/** Радиус квадрата в градусах: 0.1° по широте — примерно 11 км. */
const RADIUS = Number(flag('--radius') ?? '0.12');
const CHECK = Number(flag('--check') ?? '3');
const WITH_ADDRESSES = has('--addresses');

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`https://magnit.ru/webgate/v1/${path}`, {
    method: 'POST',
    headers: POST_HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Координаты точки по её коду: магазин сам знает, где он. */
async function storeByCode(code: string): Promise<{ address?: string; coordinates?: { latitude: number; longitude: number } }> {
  return postJson('stores-facade/store', {
    externalId: { owner: 'OWNER_MAGNIT', storeCode: code },
  });
}

/** Все точки Магнита внутри географического квадрата. */
async function storesInBox(
  leftTop: { latitude: number; longitude: number },
  rightBottom: { latitude: number; longitude: number },
): Promise<FacadeStore[]> {
  const res = await postJson<{ items?: { items?: FacadeStore[] } }>('stores-facade/search', {
    filters: {
      geo: { typeName: 'box', leftTopPoint: leftTop, rightBottomPoint: rightBottom },
      deliveryTypeList: ['DELIVERY_TYPE_PICKUP'],
      storeTypeListV2: [STORE_TYPE],
    },
  });
  return res.items?.items ?? [];
}

/** Расстояние по прямой между точками — чтобы ближайшие к опорной шли первыми. */
function km(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * 111.32;
  const dLon = (lon2 - lon1) * 111.32 * Math.cos((Math.PI / 180) * ((lat1 + lat2) / 2));
  return Math.round(Math.sqrt(dLat * dLat + dLon * dLon) * 10) / 10;
}

// ─── Опорная точка ──────────────────────────────────────────────────────────
let referenceCode: string | null = null;
let citySlug: string | null = null;
if (target && /^\d{4,6}$/.test(target)) {
  referenceCode = target;
} else {
  citySlug = target ?? 'moscow';
  const entries = CITY_STORES[citySlug] ?? [];
  const magnit = entries.find((s) => s.storeId === 'magnit' && s.ready);
  referenceCode = magnit?.externalStoreId ?? null;
  if (!referenceCode) {
    console.error(`В каталоге нет точки Магнита для города «${citySlug}».`);
    console.error('Города Магнита:', Object.entries(CITY_STORES).filter(([, l]) => l.some((s) => s.storeId === 'magnit')).map(([c]) => c).join(', '));
    process.exitCode = 1;
    throw new Error('выход');
  }
  console.log(`Город: ${citySlug}, опорная точка из справочника: ${referenceCode}`);
}
if (!referenceCode) throw new Error('выход');

const ref = await storeByCode(referenceCode);
const lat = ref.coordinates?.latitude;
const lon = ref.coordinates?.longitude;
console.log(`Опорная точка: ${ref.address ?? '—'}${lat === undefined || lon === undefined ? ' (без координат!)' : ` [${lat}, ${lon}]`}`);
if (lat === undefined || lon === undefined) throw new Error('выход: у точки нет координат, квадрат построить нечем');

// ─── Сбор ───────────────────────────────────────────────────────────────────
const found = await storesInBox(
  { latitude: lat + RADIUS, longitude: lon - RADIUS },
  { latitude: lat - RADIUS, longitude: lon + RADIUS },
);
interface Row {
  code: string;
  distanceKm: number | null;
}
const rows: Row[] = [];
const seen = new Set<string>();
for (const s of found) {
  const code = s.externalId?.storeCode;
  if (!code || seen.has(code) || s.isActive === false) continue;
  seen.add(code);
  const c = (s as { coordinates?: { latitude: number; longitude: number } }).coordinates;
  rows.push({ code, distanceKm: c ? km(lat, lon, c.latitude, c.longitude) : null });
}
rows.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));

console.log(`Точек типа ${STORE_TYPE} в квадрате ±${RADIUS}° (≈${Math.round(RADIUS * 111.32)} км): ${rows.length}`);

const known = CITY_STORES[citySlug ?? '']?.find((s) => s.storeId === 'magnit')?.externalStoreId;
if (known !== undefined) {
  console.log(
    rows.some((r) => r.code === known)
      ? `  сверка сработала: точка ${known} из справочника найдена среди ${rows.length}`
      : `  ВНИМАНИЕ: точка ${known} из справочника НЕ найдена — квадрат построен не вокруг этого города.`,
  );
}

const adapter = new MagnitAdapter();
const candidates = [
  ...(known !== undefined ? rows.filter((r) => r.code === known) : []),
  ...rows.filter((r) => r.code !== known).slice(0, CHECK),
];
console.log(`Живая проверка ${candidates.length} точек (поиск «молоко»):`);
for (const row of candidates) {
  const t = Date.now();
  try {
    const items = await adapter.search('молоко', {
      city: citySlug ?? 'moscow',
      externalStoreId: row.code,
    } as never);
    const addr = WITH_ADDRESSES ? ((await storeByCode(row.code)).address ?? '—') : '';
    const first = items[0];
    console.log(
      `  ${row.code}  ${row.distanceKm === null ? '   ? км' : String(row.distanceKm).padStart(5) + ' км'}  ` +
        `товаров ${String(items.length).padStart(3)}  ${String(Date.now() - t).padStart(5)}мс  ` +
        `${first ? `от ${first.price} ₽` : 'без цен'}  ${addr.slice(0, 54)}`,
    );
  } catch (err) {
    console.log(`  ${row.code}  ОТКАЗ: ${String(err).slice(0, 90)}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
}

console.log(`\nВсе коды квадрата (${rows.length}), ближайшие первыми:`);
console.log(rows.slice(0, 40).map((r) => r.code).join(' '));
console.log('\nСтрока для src/shared/catalog.ts дописывается руками; код проверяется');
console.log('живым поиском: npx tsx scripts/magnit-store.ts <код>');