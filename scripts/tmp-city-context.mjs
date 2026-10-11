import { writeFileSync } from 'node:fs';

const res = await fetch('https://svetoforonline.ru/shops', { headers: { 'User-Agent': 'Mozilla/5.0' } });
const html = new TextDecoder('windows-1251').decode(new Uint8Array(await res.arrayBuffer()));

const out = [];
for (const city of ['Ульянов', 'Перм', 'Иркутск', 'Омск', 'Нижний Новгород']) {
  let from = 0;
  let found = 0;
  while (found < 3) {
    const at = html.indexOf(city, from);
    if (at < 0) break;
    const chunk = html.slice(Math.max(0, at - 700), at + 200);
    // Ближайший домен в этом куске
    const domains = [...chunk.matchAll(/([a-z0-9-]+\.svetoforonline\.ru)/gi)].map((m) => m[1].toLowerCase());
    out.push(`=== ${city} (вхождение ${found + 1}) ===`);
    out.push(`домены рядом: ${[...new Set(domains)].join(', ') || '—'}`);
    out.push(chunk.replace(/\s+/g, ' ').slice(0, 500));
    out.push('');
    from = at + city.length;
    found += 1;
  }
}
writeFileSync('scripts/tmp-city-context.txt', out.join('\n'), 'utf8');
console.log('готово');