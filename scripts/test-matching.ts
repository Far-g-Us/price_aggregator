import assert from 'node:assert';
import { groupByProduct, matchSplitKey, normalizeName, parseSplitKey, sameProduct, splitPairKey } from '../src/shared/matching.js';
import type { ScrapedProduct } from '../src/shared/types.js';

function item(over: Partial<ScrapedProduct> & { name: string }): ScrapedProduct {
  return {
    canonicalId: 't-1',
    storeId: 'magnit',
    city: 'moscow',
    price: 100,
    promoPrice: null,
    oldPrice: null,
    collectedAt: new Date(0).toISOString(),
    ...over,
  };
}

assert.equal(normalizeName('Молоко «Домик в деревне» 3,2% 1л!'), 'молоко домик в деревне 3 2 1л');

const milkA = item({ canonicalId: 'magnit-1', name: 'Молоко Домик в деревне 3.2% 930мл', brand: 'Домик', unit: '930мл' });
const milkB = item({ canonicalId: '5ka-9', storeId: 'pyaterochka', name: 'Молоко Домик в деревне 3,2% 930 мл', brand: 'домик', unit: '930мл' });
assert.equal(sameProduct(milkA, milkB), true);

const other = item({ canonicalId: 'magnit-2', name: 'Кефир Простоквашино 1% 900г', brand: 'Простоквашино' });
assert.equal(sameProduct(milkA, other), false);

const diffBrand = item({ canonicalId: 'magnit-3', name: 'Молоко Домик в деревне 3.2% 930мл', brand: 'Другой' });
assert.equal(sameProduct(milkA, diffBrand), false);

const bcA = item({ canonicalId: 'magnit-4', name: 'А', barcode: '4601234567890' });
const bcB = item({ canonicalId: '5ka-5', storeId: 'pyaterochka', name: 'Совсем другое название', barcode: '4601234567890' });
assert.equal(sameProduct(bcA, bcB), true);

const bcDiff = item({ canonicalId: 'magnit-6', name: 'Молоко Домик в деревне 3.2% 930мл', brand: 'Домик', barcode: '4000000000000' });
const bcDiff2 = item({ canonicalId: '5ka-7', storeId: 'pyaterochka', name: 'Молоко Домик в деревне 3.2% 930мл', brand: 'Домик', barcode: '4000000000001' });
assert.equal(sameProduct(bcDiff, bcDiff2), false);

const fat32 = item({ canonicalId: 'magnit-8', name: 'Молоко Домик в деревне 3.2% 930мл', brand: 'Домик', unit: '930мл' });
const fat25 = item({ canonicalId: 'magnit-9', name: 'Молоко Домик в деревне 2.5% 930мл', brand: 'Домик', unit: '930мл' });
assert.equal(sameProduct(fat32, fat25), false);

const groups = groupByProduct([milkA, milkB, other]);
assert.equal(groups.length, 2);
assert.equal(groups.find((g) => g.name.includes('Молоко'))?.offers.length, 2);

const dupA = item({ canonicalId: 'magnit-10', name: 'Молоко 3.2% 1л', price: 100 });
const dupB = item({ canonicalId: 'magnit-10', name: 'Молоко пастеризованное 3.2% 1л', price: 100 });
const dupGroups = groupByProduct([dupA, dupB, dupA]);
assert.equal(dupGroups.length, 1, 'same canonical merges despite name drift');
assert.equal(dupGroups[0]?.offers.length, 1, 'no offer duplication');
assert.equal(dupGroups[0]?.offers[0]?.product.price, 100);

const pie1 = item({ canonicalId: 'magnit-100', name: 'Пирожок слоеный вишня Дом выпечки 70г', price: 44.99 });
const pie2 = item({ canonicalId: 'magnit-200', name: 'Пирожок слоеный с вишной Дом выпечки 70г', price: 44.99 });
const pie5ka = item({
  canonicalId: '5ka-300',
  storeId: 'pyaterochka',
  name: 'Пирожок слоеный вишня Дом выпечки 70г',
  price: 39.99,
});
const pieGroups = groupByProduct([pie1, pie2, pie5ka]);
for (const g of pieGroups) {
  const ids = g.offers.map((o) => o.storeId);
  assert.equal(new Set(ids).size, ids.length, `one offer per store in ${g.key}`);
}
assert.equal(pieGroups.length, 2, 'похожие товары одного магазина не сливаются в одну карточку');
assert.equal(
  pieGroups.find((g) => g.offers.length === 2)?.offers.length,
  2,
  'cross-store merge intact',
);
const offerTotal = pieGroups.reduce((n, g) => n + g.offers.length, 0);
assert.equal(offerTotal, 3, 'ни один товар не потерян');
assert.equal(
  pieGroups.filter((g) => g.offers[0]?.product.canonicalId === 'magnit-200').length,
  1,
  'дубль canonicalId не сеет вторую цену',
);

// --- Ручной разрыв склейки ----------------------------------------------
// Сценарий, из-за которого разрыв и нужен: у Пятёрки и Магнита нет общего
// штрих-кода, и Jaccard не отличает «Сыр сливочный 200г» от «Сыр сливочный
// 200г в упаковке» — названия совпадают почти целиком.
// Именно этот случай пользователь и увидит в интерфейсе: два разных сыра в
// одной карточке, где цены сравнивать бессмысленно.
{
  const cheeseA = item({ canonicalId: 'magnit-500', name: 'Сыр сливочный 200г', unit: '200г' });
  const cheeseB = item({ canonicalId: '5ka-501', storeId: 'pyaterochka', name: 'Сыр сливочный 200г в упаковке', unit: '200г' });
  assert.equal(sameProduct(cheeseA, cheeseB), true, 'эвристика считает их одним товаром');

  assert.equal(groupByProduct([cheeseA, cheeseB]).length, 1, 'без разрыва склейка есть');
  const split = new Set([matchSplitKey('magnit-500', '5ka-501')]);
  const after = groupByProduct([cheeseA, cheeseB], split);
  assert.equal(after.length, 2, 'с разрывом это два товара');
  assert.equal(
    after.reduce((n, g) => n + g.offers.length, 0),
    2,
    'оба товара на месте после разрыва',
  );

  // Ключ симметричен: разрыв в любом порядке даёт тот же результат.
  assert.equal(
    matchSplitKey('a', 'b'),
    matchSplitKey('b', 'a'),
    'ключ разрыва не зависит от порядка',
  );
  assert.equal(
    groupByProduct([cheeseA, cheeseB], new Set([matchSplitKey('5ka-501', 'magnit-500')])).length,
    2,
    'разрыв в обратном порядке работает так же',
  );

  // Разрыв чужой пары ничего не меняет.
  assert.equal(
    groupByProduct([cheeseA, cheeseB], new Set([matchSplitKey('x-1', 'y-2')])).length,
    1,
    'чужая пара не влияет на склейку',
  );
  assert.equal(
    groupByProduct([cheeseA, cheeseB], new Set()).length,
    1,
    'пустой набор разрывов = обычное поведение',
  );

// Третий магазин в той же связке: после разрыва между A и B третий остаётся
  // с B, и карточка делится неровно — это нормально, терять нечего.
  const cheeseC = item({ canonicalId: 'lenta-502', storeId: 'lenta', name: 'Сыр сливочный 200г', unit: '200г' });

  // Флага «в группе есть разрыв» не существует: разрыв разводит пару до того,
  // как группа собрана, помечать нечего. Проверяем инвариант напрямую — внутри
  // группы не должно остаться разведённой пары ни при каком порядке офферов.
  const cheeseAAlt = item({ canonicalId: 'magnit-500', name: 'Сыр сливочный 200г', unit: '200г' });
  for (const items of [
    [cheeseAAlt, cheeseB, cheeseC],
    [cheeseB, cheeseAAlt, cheeseC],
  ]) {
    const grouped = groupByProduct(items, split);
    for (const one of grouped) {
      for (let i = 0; i < one.offers.length; i++) {
        for (let j = i + 1; j < one.offers.length; j++) {
          assert.notEqual(
            matchSplitKey(one.offers[i]!.product.canonicalId, one.offers[j]!.product.canonicalId),
            matchSplitKey('magnit-500', '5ka-501'),
            'в группе не осталось разведённой пары',
          );
        }
      }
    }
  }

  const partial = groupByProduct([cheeseA, cheeseB, cheeseC], split);
  assert.equal(partial.length, 2, 'разрыв развёл пару, третий остался с одним из них');
  assert.equal(
    partial.reduce((n, g) => n + g.offers.length, 0),
    3,
    'ни один товар не потерялся при разрыве',
  );
  assert.equal(
    partial.some(
      (g) =>
        g.offers.length === 2 &&
        g.offers.map((o) => o.product.canonicalId).sort().join(',') === 'lenta-502,magnit-500',
    ),
    true,
    'один из разведённых остался склеен с третьим товаром',
  );

  // Три товара в одной группе: все предложения сохраняются в карточке.
  const three = groupByProduct([cheeseA, cheeseB, cheeseC]);
  assert.equal(three.length, 1, 'три одинаковых названия склеились');
  assert.equal(three[0]?.offers.length, 3, 'все три предложения в карточке');
}

console.log('matching: ALL GREEN');

// parseSplitKey: контракт сменился на nullable, а теста не было. Round-trip и
// отказ на непарсимом ключе обязаны быть зафиксированы, иначе смена сигнатуры
// проходит незамеченной.
const pairs: [string, string][] = [['magnit-123', '5ka-456'], ['5ka-1', 'magnit-2'], ['5ka-9', 'lenta-8']];
for (const [a, b] of pairs) {
  const pair = parseSplitKey(splitPairKey(a, b));
  assert.deepEqual(pair ? [...pair].sort() : null, [a, b].sort(), 'round-trip ' + a + '/' + b);
}
assert.equal(parseSplitKey('nospace'), null, 'ключ без разделителя');
assert.equal(parseSplitKey('one two three'), null, 'лишний разделитель');
assert.equal(parseSplitKey(' leading'), null, 'пустая вторая часть');
assert.equal(parseSplitKey('trailing '), null, 'пустая первая часть');

// Единицы измерения обязаны различать товары: «930мл» и «1л» — это разные
// покупки, даже когда название совпадает до запятой.
const unit930 = item({ canonicalId: 'magnit-u1', name: 'Молоко Домик в деревне 3.2% 930мл', unit: '930мл' });
const unit1l = item({ canonicalId: 'magnit-u2', name: 'Молоко Домик в деревне 3.2% 930мл', unit: '1л' });
assert.equal(sameProduct(unit930, unit1l), false, 'разные единицы — разные товары');
const noUnit = item({ canonicalId: 'magnit-u3', name: 'Молоко Домик в деревне 3.2% 930мл' });
assert.equal(sameProduct(unit930, noUnit), true, 'а если единицы не указана — сравниваем только по названию');

// Имя из одних знаков препинания не должно молча склеивать что-либо с чем-либо.
const onlySigns = item({ canonicalId: 'magnit-p1', name: '!!!' });
const realName = item({ canonicalId: 'magnit-p2', name: 'Молоко Домик в деревне' });
assert.equal(sameProduct(onlySigns, realName), false, 'пустое имя не считается совпадением');

// Группа без картинки остаётся без неё: полка не должна показывать битую
// иконку, выдуманную из пустого url.
const noImg = [item({ canonicalId: 'magnit-n1', name: 'Масло сливочное 82% 200г' })];
assert.equal(groupByProduct(noImg)[0]?.imageUrl, undefined, 'нет картинки — нет и иконки группы');
const withImg = groupByProduct([
  item({ canonicalId: 'magnit-n2', name: 'Масло сливочное 82% 200г', imageUrl: 'https://img/масло.jpg' }),
]);
assert.equal(withImg[0]?.imageUrl, 'https://img/масло.jpg', 'а картинка из ответа попадает в карточку');
