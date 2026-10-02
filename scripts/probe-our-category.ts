// Проверяем живьём: слова-фильтры в наших категориях, офлайн-кэш и
// «Не разложено». Сеть трогаем по-настоящему.
import { MagnitAdapter } from '../src/core/adapters/magnit.js';
import { PyaterochkaAdapter } from '../src/core/adapters/pyaterochka.js';
import { close5kaBrowser } from '../src/core/adapters/5ka-browser.js';
import { ourCategoryById, matchesOurCategory } from '../src/shared/taxonomy.js';
import { formatPrice } from '../src/shared/format.js';

const milk = ourCategoryById('dairy-milk');
if (!milk) throw new Error('нет категории');
console.log('фильтр «Молоко»:');
for (const name of [
  'Молоко Домик в деревне пастеризованное 2.5% 930мл',
  'Коктейль молочный Чудо клубника 2% 960г',
  'Сгущённое молоко 400г',
  'Йогурт Простоквашино 2.5%',
  'Сыр Брест-Литовск 200г',
]) {
  console.log(`  ${matchesOurCategory(milk, name) ? 'да ' : 'нет'}  ${name}`);
}
console.log('\nформат цены:', formatPrice(219.99), formatPrice(229), formatPrice(43.5));

const adapters = { magnit: new MagnitAdapter(), pyaterochka: new PyaterochkaAdapter() };
const ctx = { city: 'moscow', externalStoreId: '35XY' };
const mctx = { city: 'moscow', externalStoreId: '303857' };
try {
  const a = await adapters.magnit.search('молоко', mctx);
  const b = await adapters.pyaterochka.search('молоко', ctx);
  const all = [...a, ...b];
  console.log(`\nживая выдача: Магнит ${a.length}, Пятёрочка ${b.length}`);
  const inMilk = all.filter((p) => matchesOurCategory(milk, p.name));
  const outMilk = all.filter((p) => !matchesOurCategory(milk, p.name));
  console.log(`в «Молоко» попало ${inMilk.length}, отсеяно ${outMilk.length}`);
  for (const p of outMilk.slice(0, 5)) console.log(`  отсеян: ${p.name.slice(0, 60)}`);
} finally {
  await close5kaBrowser();
}
