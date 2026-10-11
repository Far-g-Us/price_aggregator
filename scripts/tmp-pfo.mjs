import { writeFileSync } from 'node:fs';

const res = await fetch('https://svetoforonline.ru/shops', { headers: { 'User-Agent': 'Mozilla/5.0' } });
const html = new TextDecoder('windows-1251').decode(new Uint8Array(await res.arrayBuffer()));

// Каждая точка: "Магазин СВЕТОФОР <город/посёлок>, <адрес>" с доменом рядом
const rows = [...html.matchAll(/<a href=\/\/([a-z0-9.-]+\.svetoforpf?o\.ru)[^>]*>([^<]{5,120})<\/a>/gi)].map((m) => ({
  domain: m[1].toLowerCase(),
  label: m[2].replace(/\s+/g, ' ').trim(),
}));

const out = [];
out.push(`всего точек в списке: ${rows.length}`);
const byDomain = new Set(rows.map((r) => r.domain));
out.push(`уникальных доменов: ${byDomain.size}`);

// Наши города ищутся по названию в подписи: «город Пермь», «город Ульяновск»
// и варианты без слова «город» (посёлки пригородов — их берём отдельно).
/** @type {Record<string, string[]>} */
const CITIES = {
  moscow: ['Москва', 'Москвы', 'Подольск', 'Мытищи', 'Химки', 'Балашиха', 'Люберцы', 'Одинцово'],
  saint_petersburg: ['Санкт-Петербург', 'Петербург', 'Петроград'],
  perm: ['Пермь'],
  ulyanovsk: ['Ульяновск', 'Ульяновска', 'Димитровград', 'Новоульяновск'],
  kazan: ['Казань'],
  nizhniy_novgorod: ['Нижний Новгород', 'Нижнего Новгорода'],
  chelyabinsk: ['Челябинск', 'Челябинска'],
  ekaterinburg: ['Екатеринбург', 'Екатеринбурга'],
  novosibirsk: ['Новосибирск', 'Новосибирска'],
  omsk: ['Омск', 'Омска'],
  krasnoyarsk: ['Красноярск', 'Красноярска'],
  irkutsk: ['Иркутск', 'Иркутска'],
  barnaul: ['Барнаул', 'Барнаула'],
  kemerovo: ['Кемерово', 'Кемеровская'],
  krasnodar: ['Краснодар', 'Краснодарский'],
};

out.push('\n--- совпадения по нашим городам ---');
for (const [city, names] of Object.entries(CITIES)) {
  const hits = rows.filter((r) => names.some((n) => r.label.includes(n)));
  if (hits.length === 0) {
    out.push(`${city}: НЕТ`);
    continue;
  }
  out.push(`${city}: ${hits.length}`);
  for (const h of hits.slice(0, 12)) out.push(`   ${h.domain}  |  ${h.label}`);
}

out.push('\n--- сколько всего точек у доменов pfo ---');
out.push(String(rows.length));

writeFileSync('scripts/tmp-pfo-report.txt', out.join('\n'), 'utf8');
console.log('готово');