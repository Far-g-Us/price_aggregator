// Снимает живую HTML-карточку товара Магнита и кладёт УРЕЗАННУЮ фикстуру:
// только head с блоками ld+json и тело со ссылкой на витрину. Полная
// страница — 600 КБ, в репозиторий ей не место, а разбирать надо именно
// JSON-LD карточки (в webgate цена в копейках, здесь — в рублях).
//
//   npm run magnit:card
// Режим `--check`: фикстуру НЕ переписывать, только проверить, что JSON-LD с
// ценой на месте. Так прогон не затирает закоммиченную фикстуру (юнит-тесты
// assert'ят живые значения оттуда).
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ID = '1000427075';
const SHOP = '473996';
const CHECK_ONLY = process.argv.includes('--check');

const res = await fetch(`https://magnit.ru/product/${ID}`, {
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: 'https://magnit.ru/',
    Cookie: `shopCode="${SHOP}"`,
  },
  redirect: 'follow',
  signal: AbortSignal.timeout(25000),
}).catch((e) => {
  // Сеть не ответила — это НЕ «форма уехала». Код 2 («не проверено») с предупреждением:
  // ночная проверка не должна краснеть из-за мигания сети (у Магнита бывают
  // свои 503/504 — это зафиксированное состояние, а не поломка проекта).
  console.warn(`card: сеть не ответила (${String(e).slice(0, 80)}) — проверка неубедительна`);
      process.exit(2);
});
const html = await res.text();
console.log('HTTP', res.status, res.url, html.length, 'байт');

if (!res.ok) {
  console.warn(`card: сеть ответила HTTP ${res.status} — проверка неубедительна`);
      process.exit(2);
}

const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map(
  (m) => m[1] ?? '',
);
if (blocks.length === 0) {
  console.error('card: на странице нет ld+json — HTML-фолбэк карточки перестал работать');
  process.exit(4);
}
// Блока мало: нужен именно Product с ценой — на нём держится фолбэк.
const product = blocks
  .map((b) => {
    try {
      return JSON.parse(b) as Record<string, unknown>;
    } catch {
      return null;
    }
  })
  .find((o) => o && o['@type'] === 'Product' && o.offers);
if (!product) {
  console.error('card: в ld+json нет Product с ценой (offers) — фолбэк карточки не соберёт цену');
  process.exit(4);
}
const offers = product.offers as { price?: unknown };
console.log('Product:', String(product.name ?? '').slice(0, 50), 'цена:', String(offers.price ?? '—'));

// Маркер магазина в теле страницы. Без него фолбэк не проходит сверку точки
// (`assertOwnStore` требует `shopCode=<код>` в ответе), и цена чужого
// магазина могла бы уехать в историю нашей точки. Проверка обязана быть в
// живом ответе: фикстура собирается из блоков ld+json плюс реальный кусок
// тела, а не из придуманной ссылки.
//
// Замер с телефона (эмулятор, 2026-10-21): GET /product/1000417384 → 200,
// 562 506 байт, `application/ld+json` на позиции 75 338, `shopCode=` — на
// 429 511. То есть маркер в живой странице есть.
const markerAt = html.indexOf(`shopCode=${SHOP}`);
if (markerAt < 0) {
  console.error(
    `card: в живой странице нет маркера shopCode=${SHOP} — фолбэк не пройдёт сверку точки (сверка по коду магазина обязательна)`,
  );
  process.exit(4);
}
console.log('маркер магазина в теле: позиция', markerAt);
const bodyChunk = html.slice(Math.max(0, markerAt - 300), markerAt + 300);
const head = blocks
  .map((b) => `<script type="application/ld+json">${b}</script>`)
  .join('\n    ');
const fixture = `<!doctype html>
<!-- Живая карточка товара Магнита, магазин ${SHOP}, снята 2026-10-19: блоки
     ld+json и РЕАЛЬНЫЙ кусок тела страницы вокруг маркера магазина. Полная
     страница — около 560 КБ, в репозиторий ей не место.
     ВНИМАНИЕ: цена в JSON-LD карточки — в РУБЛЯХ (139.99), в webgate — в
     КОПЕЙКАХ (13999). Это разные парсеры, и путать их нельзя. -->
<html>
  <head>
    ${head}
  </head>
  <body>${bodyChunk}</body>
</html>
`;
const target = resolve(import.meta.dirname, '..', 'tests', 'fixtures', 'magnit-card-live.html');
if (CHECK_ONLY) {
  console.log('card: JSON-LD с ценой и маркер магазина на месте, фикстуру не трогаю');
  process.exit(0);
}
writeFileSync(target, fixture, 'utf8');
console.log('записано:', target, `(${fixture.length} байт, блоков ld+json: ${blocks.length})`);
