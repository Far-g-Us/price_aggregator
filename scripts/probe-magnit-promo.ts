// Снимает живую выдачу Магнита по РЕАЛЬНОМУ поиску (?term=) и кладёт
// компактную фикстуру. Годится и для проверки скидок.
import fs from 'node:fs';
import { parseMagnitSearchGoods, goodsToProducts } from '../src/main/adapters/magnit.js';

const QUERY = process.env.QUERY ?? 'молоко';
const SHOP = process.env.SHOP ?? '303857';
const OUT = process.env.OUT ?? 'tests/fixtures/magnit-search-promo.html';
const ua =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const res = await fetch('https://magnit.ru/search?term=' + encodeURIComponent(QUERY), {
  headers: {
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'User-Agent': ua,
    Referer: 'https://magnit.ru/',
    Cookie: 'shopCode=' + encodeURIComponent(`"${SHOP}"`),
  },
  signal: AbortSignal.timeout(30000),
});
const html = await res.text();
const goods = parseMagnitSearchGoods(html, SHOP);
const products = goodsToProducts(goods, { city: 'moscow' });
const discounted = products.filter((p) => p.oldPrice != null);
console.log(`запрос «${QUERY}»: товаров ${products.length}, со скидкой ${discounted.length}`);
for (const p of discounted.slice(0, 6)) {
  console.log(`  ${p?.canonicalId ?? '?'} ${p?.price ?? '?'} ← ${p?.oldPrice ?? '?'} ${(p?.name ?? '').slice(0, 40)}`);
}

const script = html.match(/<script[^>]*__NUXT_DATA__[^>]*>(.*?)<\/script>/s)?.[1] ?? '';
const re = /"(\d{7,})","((?:[^"\\]|\\.){3,120}?)"\s*,\s*"((?:\\u002Fproduct\\u002F[^"\\]+))/g;
const marks = [...script.matchAll(re)];
const first = marks[0];
const last = marks[marks.length - 1];
if (first && last) {
  const start = Math.max(0, first.index - 30);
  const end = Math.min(script.length, last.index + 1500);
  const slice = script.slice(start, end);
  const out =
    '<html><body><script id="__NUXT_DATA__" type="application/json">["x",' +
    slice +
    `,{"shop":"shopCode=${SHOP}"}]</script></body></html>`;
  fs.writeFileSync(new URL('../' + OUT, import.meta.url), out);
  console.log('сохранено', OUT, out.length, 'байт');
}
