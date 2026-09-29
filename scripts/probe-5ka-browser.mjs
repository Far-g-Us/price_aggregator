import { browserCategories, browserSearch, close5kaBrowser } from '../src/main/adapters/5ka-browser.js';

const SAP = process.env.SAP ?? '35XY';
const QUERY = process.env.QUERY ?? 'молоко';
const ctx = { city: 'moscow', externalStoreId: SAP };

try {
  const products = await browserSearch(QUERY, ctx);
  console.log('search:', products.length);
  for (const p of products.slice(0, 6)) {
    console.log(`  ${p.canonicalId} ${p.price}₽ old=${p.oldPrice ?? '-'} unit=${p.unit} ${p.name.slice(0, 40)}`);
  }
  const cats = await browserCategories({ externalStoreId: SAP });
  console.log('categories:', cats.length, cats.slice(0, 5).map((c) => c.name).join(', '));
} catch (e) {
  console.log('ERR', String(e).slice(0, 300));
} finally {
  await close5kaBrowser();
}
