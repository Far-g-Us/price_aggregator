import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OUR_CATEGORIES,
  classifyOurCategories,
  matchesOurCategory,
  ourCategoryById,
  rootShelves,
  type OurCategoryView,
} from '../src/shared/taxonomy.js';
import { formatPrice } from '../src/shared/format.js';
import { CITIES, CITY_STORES } from '../src/shared/catalog.js';
import { closeDb, openDb, persistDb, savePriceIfChanged, saveProductCategory } from '../src/core/db/db.js';
import { fileStorageAt } from '../electron/node-files.js';
import { SCHEMA } from '../src/core/db/schema.js';

// Копия категории без ключа include целиком (не include: undefined): так
// проверяется именно отсутствие фильтра, а не пустой список.
function dropInclude(c: (typeof OUR_CATEGORIES)[number]): (typeof OUR_CATEGORIES)[number] {
  const copy: { include?: string[] } = { ...c };
  delete copy.include;
  return copy as (typeof OUR_CATEGORIES)[number];
}

assert.ok(OUR_CATEGORIES.length >= 10, 'список полок непустой');
const ids = new Set(OUR_CATEGORIES.map((c) => c.id));
assert.equal(ids.size, OUR_CATEGORIES.length, 'id категорий уникальны');
for (const c of OUR_CATEGORIES) {
  assert.ok(c.queries.length > 0, `у категории есть запросы: ${c.id}`);
  // Без include автораскладка приписывала бы товар половине полок.
  assert.ok(
    (c.include?.length ?? 0) > 0,
    `у категории есть слова include для автораскладки: ${c.id}`,
  );
  const queries = new Set(c.queries);
  assert.equal(queries.size, c.queries.length, `запросы уникальны в ${c.id}`);
}
// Плоский список — осознанное решение (вложенность снята в пользу плиток, как
// у витрины сети). Проверяем данные, а не функции дерева: those уже удалены,
// и проверка через них была бы зелёной по коду, которого в приложении нет.
assert.ok(
  OUR_CATEGORIES.every((c) => c.parentId === null),
  'все полки корневые: список плоский, вложенности нет',
);
assert.equal(ourCategoryById('нет-такой'), undefined);
const toView = (c: (typeof OUR_CATEGORIES)[number]) => ({
  id: c.id,
  name: c.name,
  parentId: c.parentId,
  queryCount: c.queries.length,
  storeCount: 1,
  virtual: false,
});
const all = OUR_CATEGORIES.map(toView);
const roots = rootShelves(all);
assert.ok(roots.length > 0, 'без раскрытия видны корни');
assert.ok(roots.every((c) => c.parentId === null), 'в списке только корневые полки');
assert.equal(
  roots.length,
  all.length,
  'плоский список показывает все полки, а не только корни дерева',
);
const withVirtual: OurCategoryView = {
  id: '__unassigned__',
  name: 'Не разложено',
  parentId: null,
  queryCount: 0,
  storeCount: 1,
  virtual: true,
};
assert.ok(
  rootShelves([...all, withVirtual]).every((c) => c.virtual !== true),
  'виртуальная полка не рисуется в общем списке',
);
// Фильтр rootShelves обязан быть покрыт НЕ-плоским входом: полка с
// проставленным родителем иначе молча исчезла бы из списка — без ошибки и без
// диагностики, то есть полка просто не показывалась бы.
const withNested = { ...withVirtual, id: 'x-nested', name: 'Х', parentId: 'dairy' };
assert.equal(
  rootShelves([...all, withNested]).length,
  all.length,
  'полка с проставленным родителем отфильтровывается, а не показывается',
);

// Дерево в БД совпадает с кодом — иначе раскладка молча разъедется.
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-tax-')), 't.db');
const db = await openDb(fileStorageAt(file));
const rows = db.exec('SELECT id, name, parent_id FROM our_categories ORDER BY position')?.[0]?.values ?? [];
assert.equal(rows.length, OUR_CATEGORIES.length, 'все наши категории засеяны');
const byId = new Map(OUR_CATEGORIES.map((c) => [c.id, c]));
for (const [id, name, parentId] of rows) {
  const c = byId.get(String(id));
  assert.ok(c, `категория из БД есть в коде: ${String(id)}`);
  assert.equal(name, c?.name, `имя совпадает: ${String(id)}`);
  assert.equal(parentId === null ? null : String(parentId), c?.parentId ?? null, `родитель совпадает: ${String(id)}`);
}

// Пересев поверх ПРОТУХШЕГО parent_id. Свежая база проверяет только значения
// сида; у реального пользователя в файле осталась старая иерархия, и чинить её
// обязана повторная инициализация схемы при каждом открытии БД. Приём взят из
// test-db (там так же пересевается stores).
db.run("UPDATE our_categories SET parent_id = 'dairy' WHERE id IN ('dairy-milk', 'bakery-bread')");
db.exec(SCHEMA);
const afterReseed = db.exec('SELECT COUNT(*) FROM our_categories WHERE parent_id IS NOT NULL')?.[0]?.values[0]?.[0];
assert.equal(
  Number(afterReseed ?? 0),
  0,
  'повторная инициализация схемы чинит протухшую иерархию в существующей базе',
);

for (const city of CITIES) {
  for (const s of CITY_STORES[city.id] ?? []) {
    const seeded = db.exec('SELECT external_store_id FROM stores WHERE id = ? AND city = ?', [
      s.storeId,
      city.id,
    ])?.[0]?.values?.[0]?.[0];
    assert.equal(seeded, s.externalStoreId, `stores: ${s.storeId}:${city.id}`);
  }
}

// Раскладка товара по нашим категориям: many-to-many, повтор не плодит строки.
const first = ourCategoryById('dairy');
assert.ok(first);
const price = { canonicalId: 'x-1', storeId: 'magnit', city: 'moscow', name: 'Тест', price: 100 };
assert.equal(savePriceIfChanged(db, price), 'inserted');
const rowsIn = [
  { canonicalId: 'x-1', storeId: 'magnit', city: 'moscow', categoryId: 'dairy' },
  { canonicalId: 'x-1', storeId: 'magnit', city: 'moscow', categoryId: 'dairy' },
  { canonicalId: 'x-1', storeId: 'magnit', city: 'moscow', categoryId: 'dairy-milk' },
  { canonicalId: 'x-1', storeId: 'pyaterochka', city: 'moscow', categoryId: 'dairy' },
];
saveProductCategory(db, rowsIn);
const link = db.exec('SELECT COUNT(*) FROM product_categories')[0]?.values[0]?.[0];
assert.equal(link, 3, 'повторы не плодят строки, разные категории и сети — пишутся');
const mine = db.exec(
  `SELECT category_id FROM product_categories
   WHERE canonical_id = 'x-1' AND store_id = 'magnit' AND city = 'moscow' ORDER BY category_id`,
)[0]?.values.map((r) => String(r[0]));
assert.deepEqual(mine, ['dairy', 'dairy-milk'], 'товар лежит в нескольких наших категориях');

// Город в ключе: тот же товар в другом городе — отдельная запись.
saveProductCategory(db, [
  { canonicalId: 'x-1', storeId: 'magnit', city: 'ulyanovsk', categoryId: 'dairy' },
]);
const perCity = db.exec(
  `SELECT city, COUNT(*) FROM product_categories
   WHERE canonical_id = 'x-1' AND store_id = 'magnit' GROUP BY city ORDER BY city`,
)[0]?.values.map((r) => `${String(r[0])}:${String(r[1])}`);
assert.deepEqual(perCity, ['moscow:2', 'ulyanovsk:1'], 'города не схлопываются');

// Внешние ключи включены: запись на несуществующий товар должна упасть.
const fkOn = db.exec('PRAGMA foreign_keys')[0]?.values[0]?.[0];
assert.equal(fkOn, 1, 'PRAGMA foreign_keys включён');
assert.throws(
  () =>
    saveProductCategory(db, [
      { canonicalId: 'нет-такого', storeId: 'magnit', city: 'moscow', categoryId: 'dairy' },
    ]),
  'FK не даёт ссылаться на несуществующий товар',
);
assert.throws(
  () =>
    saveProductCategory(db, [
      { canonicalId: 'x-1', storeId: 'magnit', city: 'moscow', categoryId: 'нет-такой' },
    ]),
  'FK не даёт ссылаться на несуществующую категорию',
);
const afterRollback = db.exec('SELECT COUNT(*) FROM product_categories')[0]?.values[0]?.[0];
assert.equal(afterRollback, 4, 'откат транзакции не оставил мусорных строк');

// Слова-фильтры: без них в «Молоко» падают коктейли и овсяные напитки.
const milk = ourCategoryById('dairy-milk');
assert.ok(milk);
assert.equal(matchesOurCategory(milk, 'Молоко Домик в деревне 2.5% 930мл'), true);
assert.equal(matchesOurCategory(milk, 'Коктейль молочный Чудо клубника 2% 960г'), false);
assert.equal(matchesOurCategory(milk, 'Сгущённое молоко 400г'), false);
assert.equal(matchesOurCategory(milk, 'Йогурт Простоквашино 2.5%'), false);
assert.equal(matchesOurCategory(milk, 'Молочко сгущённое'), false);
const cheese = ourCategoryById('dairy-cheese');
assert.ok(cheese);
assert.equal(matchesOurCategory(cheese, 'Сыр Брест-Литовск 45% 200г'), true);
assert.equal(matchesOurCategory(cheese, 'Сырный крем 200г'), false);
const wide = ourCategoryById('vegetables');
assert.ok(wide);
assert.equal(matchesOurCategory(wide, 'Картофель фасованный'), true, 'с include — по слову');
assert.equal(matchesOurCategory(wide, 'Что угодно'), false, 'с include чужое не проходит');
const noRules = { id: 'x', name: 'Без правил', parentId: null, queries: ['q'] };
assert.equal(matchesOurCategory(noRules, 'что угодно'), true, 'без include берём всё');

// Цены на экране целые, в базе копейки остаются.
assert.equal(formatPrice(219.99), '220 ₽');
assert.equal(formatPrice(229), '229 ₽');
assert.equal(formatPrice(0.4), '0 ₽');
assert.equal(formatPrice(-3), '-3 ₽');

// Автораскладка: товар встаёт на все подходящие полки сразу, мимо всех —
// в «Не разложено».
assert.deepEqual(
  classifyOurCategories('Молоко Домик в деревне пастеризованное 2.5% 930мл').sort(),
  ['dairy', 'dairy-milk'],
  'молоко встаёт и в «Молочное и яйца», и в «Молоко»',
);
assert.deepEqual(
  classifyOurCategories('Сыр Брест-Литовск Финский 45% 200г').sort(),
  ['dairy', 'dairy-cheese'],
  'сыр — в сыры, а не в молоко',
);
assert.deepEqual(classifyOurCategories('Коктейль молочный Чудо 2% 960г'), [], 'коктейль мимо полок');
assert.deepEqual(classifyOurCategories('Бумажные полотенца Магнит 2 слоя 2 рулона'), ['household']);
assert.ok(
  classifyOurCategories('Непонятный товар без слов').length === 0,
  'нераспознанное уходит в «Не разложено»',
);
for (const id of classifyOurCategories('Молоко Простоквашино 2.5% 930мл')) {
  assert.ok(ids.has(id), `автораскладка не выдаёт чужую категорию: ${id}`);
}

// Категория без include не участвует в автораскладке: иначе «без фильтра»
  // означало бы «подходит всё подряд».
assert.deepEqual(
  classifyOurCategories('Молоко Простоквашино 2.5% 930мл', [
    dropInclude(OUR_CATEGORIES[0]!),
    { ...OUR_CATEGORIES[0]!, include: [] },
  ]),
  [],
  'категория без include не раскладывается',
);
assert.ok(
  classifyOurCategories('Молоко Простоквашино 2.5% 930мл', [{ ...OUR_CATEGORIES[0]!, include: ['молоко'] }]).length === 1,
  'а с include — раскладывается',
);

saveProductCategory(db, []);
persistDb(db);
assert.ok(fs.existsSync(file), 'db persisted');
closeDb();
console.log('own categories: ALL GREEN');
