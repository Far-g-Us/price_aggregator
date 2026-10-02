// Живая проверка: опрос Ленты через поиск по названию (fetchProduct).
// Путь карточки по id закрыт WAF, поэтому проверяем именно рабочий.
import { LentaAdapter } from '../src/core/adapters/lenta.js';

const CITY = 'moscow';
const STORE = '4161';
const ctx = { city: CITY, externalStoreId: STORE };

const adapter = new LentaAdapter();

for (const q of ['молоко', 'картофель']) {
  const s = await adapter.search(q, ctx);
  console.log(`\nпоиск «${q}»: ${s.length} товаров`);
  for (const p of s.filter((x) => x.unitPrice).slice(0, 2)) {
    console.log(
      `  ВЕСОВОЙ ${p.canonicalId} ${p.price} ₽ / ${p.unitPrice} / фасовка ${p.unit} / наличие ${p.inStock} — «${p.name.slice(0, 44)}»`,
    );
  }
  for (const p of s.filter((x) => !x.unitPrice).slice(0, 2)) {
    console.log(
      `  обычный  ${p.canonicalId} ${p.price} ₽${p.oldPrice ? ` (было ${p.oldPrice})` : ''} / фасовка ${p.unit ?? '—'} — «${p.name.slice(0, 44)}»`,
    );
  }
}

const s = await adapter.search('картофель', ctx);
const weighed = s.find((p) => p.unitPrice?.includes('кг'));
if (!weighed) {
  console.log('ВЫВОД: пусто — проверить нечего.');
  process.exit(1);
}

console.log(`\n=== fetchProduct для ${weighed.canonicalId} («${weighed.name.slice(0, 50)}») ===`);
const fetched = await adapter.fetchProduct(weighed.canonicalId, { ...ctx, name: weighed.name });
console.log(`  цена ${fetched.price} ₽${fetched.oldPrice ? ` (было ${fetched.oldPrice})` : ''}`);
console.log(`  фасовка ${fetched.unit ?? '—'}${fetched.unitPrice ? `, за единицу ${fetched.unitPrice}` : ''}`);
console.log(`  наличие ${fetched.inStock}, url ${fetched.url}`);
console.log(
  `  цена совпала с поиском: ${fetched.price === weighed.price ? 'ДА' : `НЕТ (поиск ${weighed.price}, опрос ${fetched.price})`}`,
);

console.log('\n=== переименованный товар: названия в базе нет ===');
try {
  await adapter.fetchProduct(weighed.canonicalId, { ...ctx, name: 'Такого товара нет в выдаче 12345' });
  console.log('  ВЫВОД: не сработало — должен был бросить ProductLookupError');
} catch (e) {
  console.log(`  отказ: ${String(e).slice(0, 150)}`);
  console.log(`  это ProductLookupError (не отказ сети): ${e instanceof Error && e.name === 'ProductLookupError'}`);
}

console.log('\n=== без названия в базе ===');
try {
  await adapter.fetchProduct(weighed.canonicalId, ctx);
  console.log('  ВЫВОД: не сработало');
} catch (e) {
  console.log(`  отказ: ${String(e).slice(0, 120)}`);
}
