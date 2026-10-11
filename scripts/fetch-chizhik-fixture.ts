// Съём живых фикстур Чижика — КАК ЕСТЬ, без преобразований.
//
//   npx tsx scripts/fetch-chizhik-fixture.ts            # магазин по умолчанию
//   npx tsx scripts/fetch-chizhik-fixture.ts HDJ7 novosibirsk
//
// Что кладём в tests/fixtures/chizhik/:
//   categories.json        — дерево категорий целиком;
//   category-products.json — товары одной листовой категории;
//   search.json            — ответ поиска;
//   discount.json          — товар с непустой скидкой (если сеть её отдала).
//
// Преобразовывать ответы нельзя: именно эти структуры читает scripts/test-chizhik.ts.
//
// Одна браузерная сессия на весь съём: 24 запроса в 24 браузерах подряд включают у
// сети 403 уже на третьем (проверено 2026-10-08), а внутри сессии пауза между
// запросами есть (probe-helper.ts).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chizhikSapId } from '../src/shared/chizhik-regions.js';
import { openInPageSession } from './probe-helper.js';

const city = process.argv[3] ?? 'moscow';
const sapId = process.argv[2] ?? chizhikSapId(city);
const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/chizhik');
const pageUrl = `https://app.chizhik.club/shop/${sapId}`;
const API = `https://app.chizhik.club/delivery/api/catalog/v3/stores/${sapId}`;

function save(name: string, body: unknown): void {
  mkdirSync(outDir, { recursive: true });
  const text = `${JSON.stringify(body, null, 2)}\n`;
  writeFileSync(resolve(outDir, name), text, 'utf8');
  console.log(`  ${name}: ${text.length} байт`);
}

interface RawNode {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  image_link?: unknown;
  categories?: RawNode[];
}

console.log(`  магазин ${sapId} (${city}), страница ${pageUrl}`);
const session = await openInPageSession(pageUrl);

const categories = (await session.get(
  `${API}/categories?mode=delivery&include_subcategories=1&include_restrict=true`,
)) as RawNode[];
if (!Array.isArray(categories) || categories.length === 0) {
  throw new Error('chizhik: ответ категорий не массив — формат сменился, разбор надо переписать');
}
save('categories.json', categories);

/** Лист дерева: узел без вложенных категорий — именно он и есть полка. */
function firstLeaf(nodes: RawNode[]): RawNode {
  for (const node of nodes) {
    const kids = node.categories ?? [];
    if (kids.length === 0) return node;
    const deeper = firstLeaf(kids);
    if (deeper) return deeper;
  }
  return nodes[0] as RawNode;
}

const leaf = firstLeaf(categories);
console.log(`  лист: ${String(leaf.id)} «${String(leaf.name)}»`);
const goods = (await session.get(
  `${API}/categories/${String(leaf.id)}/products?mode=delivery&include_restrict=true&limit=200`,
)) as { products?: Record<string, unknown>[] };
save('category-products.json', goods);

const search = (await session.get(
  `${API}/search?mode=delivery&include_restrict=true&limit=48&q=${encodeURIComponent('молоко')}`,
)) as { products?: Record<string, unknown>[] };
save('search.json', search);

// Скидки: обходим страницы категорий, пока не найдём товар с непустой акционной ценой.
// `discount` у Чижика в выборках 2026-10-08 был пуст везде, поэтому это вопрос
// удачи, а не формат; мультибай-поля (cpd_*) в акцию не пишутся (см. chizhik-parse).
const SALE_FIELDS = ['discount', 'cpd_promo_price', 'cpd_promo_price_from_sum_cart', 'markdown'] as const;
function hasSale(item: Record<string, unknown>): boolean {
  const prices = item.prices as Record<string, unknown> | undefined;
  return SALE_FIELDS.some((f) => prices?.[f] !== null && prices?.[f] !== undefined);
}

let discount: Record<string, unknown> | null =
  search.products?.find((p) => hasSale(p)) ?? goods.products?.find((p) => hasSale(p)) ?? null;
if (!discount) {
  const ids: string[] = [];
  const collect = (nodes: RawNode[]): void => {
    for (const node of nodes) {
      const kids = node.categories ?? [];
      if (kids.length === 0 && typeof node.id === 'string') ids.push(node.id);
      else collect(kids);
    }
  };
  collect(categories);
  console.log(`  листовых категорий: ${ids.length}, ищу со скидкой`);
  for (const id of ids) {
    const page = (await session.get(
      `${API}/categories/${id}/products?mode=delivery&include_restrict=true&limit=200`,
    )) as { products?: Record<string, unknown>[] };
    const hit = page.products?.find((p) => hasSale(p));
    if (hit) {
      console.log(`  нашлась скидка в категории ${id}`);
      discount = hit;
      save('discount.json', { category_id: id, product: hit });
      break;
    }
  }
} else {
  console.log(`  нашлась скидка в уже снятой выборке: ${JSON.stringify(discount.prices)}`);
  save('discount.json', { product: discount });
}
if (!discount) console.log('  (!) товара со скидкой в выборке нет — фикстура discount.json не записана');

const sample = (search.products ?? [])[0] ?? (goods.products ?? [])[0];
if (sample) {
  console.log('  поля товара: ' + Object.keys(sample).join(','));
  console.log('  цены: ' + JSON.stringify(sample.prices));
  console.log('  наличие: ' + JSON.stringify(sample.is_available) + ', промо: ' + JSON.stringify(sample.promo));
  console.log('  price_piece_unit: ' + JSON.stringify(sample.price_piece_unit) + ', uom: ' + JSON.stringify(sample.uom));
}
await session.close();