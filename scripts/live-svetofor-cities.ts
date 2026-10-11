// Живой список магазинов Светофора и покрытие по городам каталога.
//
// Источник — официальный выгрузочный API сети: GET /api.php?mode=getShops
// отдаёт 636 магазинов с id, адресом (в адресе есть город) и координатами.
// Правая колонка — свежесть прайса: магазин без свежего прайса в город не берём
// (цены заморожены на годы, а write-on-change молчал бы).
import { resolveSvetoforStamp, loadSvetoforPriceList } from '../src/core/adapters/svetofor.js';

const res = await fetch('https://svetoforonline.ru/api.php?mode=getShops', {
  headers: { 'User-Agent': 'Mozilla/5.0' },
});
const shops = (await res.json()).shops ?? [];
console.log(`  магазинов в getShops: ${shops.length}`);

/** Город из адреса: «г.Боровичи, ул…» → Боровичи; «поселок …» → Петровский. */
function cityOf(name: string): string {
  const raw = String(name ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(?:г\.|г\. ?|город |гор\.|пос[её]лок |село |с\. )?([А-ЯЁ][а-яё-]{2,25})/i.exec(raw);
  return (m?.[1] ?? raw.slice(0, 20)).replace(/^(?:г\.|гор\.|город)/i, '').trim();
}

const byCity = new Map();
for (const shop of shops) {
  const city = cityOf(shop.name);
  if (!byCity.has(city)) byCity.set(city, []);
  byCity.get(city).push(shop);
}
console.log(`  городов в выгрузке: ${byCity.size}`);

// Свежесть прайса считается один раз на домен: метка региональная и кэшируется.
const now = () => Date.now();
const freshById = new Map();
const CITIES_ASK = process.argv.slice(2);
const target = CITIES_ASK.length > 0 ? CITIES_ASK : [...byCity.keys()];

const rows = [];
for (const city of target) {
  const list = byCity.get(city) ?? [];
  let best = null;
  for (const shop of list.slice(0, 8)) {
    if (freshById.has(shop.id)) {
      if (freshById.get(shop.id) === 'live' && !best) best = shop;
      continue;
    }
    try {
      const stamp = await resolveSvetoforStamp(fetch, shop.domain, now);
      const prices = await loadSvetoforPriceList(fetch, shop.domain, String(shop.id), stamp, now);
      const newest = prices.reduce((m, o) => (typeof o.d === 'number' && o.d > m ? o.d : m), 0);
      const age = newest === 0 ? 99999 : Math.round((Date.now() - newest * 1000) / 86_400_000);
      freshById.set(shop.id, age <= 45 ? 'live' : 'stale');
      if (age <= 45 && !best) best = { shop, age, prices: prices.length };
    } catch {
      freshById.set(shop.id, 'stale');
    }
  }
  const text = best ? `магазин ${best.shop.id} (${best.shop.domain}), позиций ${best.prices}, свежайшая ${best.age} дн.` : 'живого магазина нет';
  rows.push(`  ${city.padEnd(22)} ${String(list.length).padStart(2)} магазинов в выгрузке — ${text}`);
  console.log(rows[rows.length - 1]);
}