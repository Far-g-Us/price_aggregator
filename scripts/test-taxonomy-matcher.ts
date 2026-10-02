// Матчер наших полок: ложные срабатывания уходят, верные остаются.
// Имена — из живых данных (Магнит) и типовых позиций сети.
//
// Кейс = { name, required: [...], forbidden: [...] }; это id полок из
// src/shared/taxonomy.ts, их и отдаёт classifyOurCategories. Пустой результат
// допустим, только если нет required.
import assert from 'node:assert/strict';
import { OUR_CATEGORIES, classifyOurCategories, matchesOurCategory, ourCategoryById } from '../src/shared/taxonomy.js';

type Case = { name: string; required: string[]; forbidden: string[]; why?: string };

const cases: Case[] = [
  // Ложные срабатывания, которые матчер обязан убрать.
  { name: 'Игрушка для кошки с хвостом', required: [], forbidden: ['fruit'], why: '«груш» внутри «и-груш-ки»' },
  { name: 'Молоко высокобелковое Bombbar 1л', required: ['dairy-milk'], forbidden: ['drinks'], why: '«сок» внутри «вы-сок-обелковое»' },
  { name: 'Сливки 20% 200мл', required: [], forbidden: ['fruit'], why: '«слив» из «сливки»' },
  { name: 'Пачка масла сливочного 82,5%', required: ['dairy-butter'], forbidden: ['fruit'], why: '«слив» внутри «сли-во-чного»' },
  { name: 'Чай чёрный в пакетиках 100 шт', required: ['drinks'], forbidden: ['household'], why: '«пакет» из «в паке-ти-ках»' },
  { name: 'Пакет молока 3,2% 930мл', required: ['dairy-milk'], forbidden: ['household'], why: '«пакет» — упаковка, а не быт' },
  { name: 'Молоко Домик пастеризованное 2.5% 930мл', required: ['dairy-milk'], forbidden: ['groceries'], why: '«паста» из «па-паст-еризованное»' },
  { name: 'Лимон 1 шт', required: ['fruit'], forbidden: ['drinks'], why: '«лимон» — строгий префикс основы «лимонад»' },
  { name: 'Лимоны 400г', required: ['fruit'], forbidden: ['drinks'] },
  { name: 'Лимонная мята 30г', required: [], forbidden: ['drinks'] },
  { name: 'Сок яблочный 1л', required: ['drinks'], forbidden: ['fruit'], why: '`яблок` ловит «яблочный»' },
  { name: 'Пюре яблочное 90г', required: [], forbidden: ['fruit'] },
  { name: 'Картофельные крупинки 60г', required: ['vegetables'], forbidden: ['groceries'], why: '`крупа` не ловит «крупинки» — сравнение с основы' },
  { name: 'Пакет стирального порошка 3кг', required: ['household'], forbidden: [] },
  { name: 'Стирального порошка 3кг', required: ['household'], forbidden: [] },
  { name: 'Куриное филе 1кг', required: ['meat'], forbidden: [] },
  { name: 'Яйцо куриное С1 10шт', required: ['dairy'], forbidden: ['meat'], why: '`курин` не должен ловить «Яйцо куриное»' },
  { name: 'Яйца куриные С1 10шт', required: ['dairy'], forbidden: ['meat'], why: 'родительный тоже' },
  { name: 'Нектар персиковый 0,95л', required: ['drinks'], forbidden: ['fruit'] },
  { name: 'Молочник 500мл со сливом', required: [], forbidden: ['dairy'] },
  { name: 'Гриб молочница 200г', required: [], forbidden: ['dairy'] },
  { name: 'Сгущенное с сахаром 397г', required: ['dairy'], forbidden: [] },
  { name: 'Сок яблоковый 0,95л', required: ['drinks'], forbidden: ['fruit'] },
  { name: 'Сливовый нектар 0,9л', required: ['drinks'], forbidden: ['fruit'] },
  { name: 'Пакет перца 200г', required: ['vegetables'], forbidden: [] },
  { name: 'Говяжья тушёная 800г', required: ['meat'], forbidden: [] },
  { name: 'Гречневая крупа 800г', required: ['groceries'], forbidden: [] },
  { name: 'Бумажные чайные салфетки 100 шт', required: ['household'], forbidden: ['drinks'] },
  { name: 'Зеленый чай 100 шт', required: ['drinks'], forbidden: ['vegetables'], why: '`зелени` ловит «зеленый»' },
  { name: 'Зеленый лук 100г', required: ['vegetables'], forbidden: ['drinks'], why: 'многословное исключение не забирает лук' },
  { name: 'Чистая вода 5л', required: ['drinks'], forbidden: ['household'], why: '`чистящ` ловит «чистая»' },
  { name: 'Чистый берёзовый сок 1л', required: ['drinks'], forbidden: ['household'] },
  { name: 'Чистящий крем для ванны 500мл', required: ['household'], forbidden: [], why: 'настоящее средство остаётся в быте' },
  { name: 'Молочная сметана 400г', required: ['dairy'], forbidden: ['dairy-milk'], why: '`молоко` больше не ловит «молочная»' },

  // Верные срабатывания, которые матчер обязан сохранить.
  { name: 'Сырники творожные 200г', required: ['dairy-cheese'], forbidden: [] },
  { name: 'Сок апельсиновый нектар 1л', required: ['drinks'], forbidden: [] },
  { name: 'Масло сливочное 82,5% 180г', required: ['dairy-butter'], forbidden: [] },
  { name: 'Сливочное масло 82,5% 180г', required: ['dairy-butter'], forbidden: ['fruit'] },
  { name: 'Груша Конференц 1кг', required: ['fruit'], forbidden: [] },
  { name: 'Молоко сгущённое 8%, 397г', required: ['dairy'], forbidden: [] },
  { name: 'Молочные продукты 1л', required: ['dairy'], forbidden: ['dairy-milk'] },
  { name: 'Сахар-песок 1кг', required: ['groceries'], forbidden: [] },
  { name: 'Какао-порошок 100г', required: ['groceries'], forbidden: [] },
  { name: 'Печенье «Сырный крем» 200г', required: ['bakery'], forbidden: [] },
  { name: 'Пакет стирального порошка 3кг', required: ['household'], forbidden: [] },
  { name: 'Стиральный порошок 3кг', required: ['household'], forbidden: [] },
];

for (const c of cases) {
  const hits = classifyOurCategories(c.name);
  const miss = c.required.filter((r) => !hits.includes(r));
  const extra = c.forbidden.filter((f) => hits.includes(f));
  assert.deepEqual(
    [miss, extra],
    [[], []],
    `«${c.name}» -> [${hits.join(', ')}]${c.why ? ` (${c.why})` : ''}`,
  );
}

// Граница слова: основа ловится в начале токена и внутри него не ловится.
const fruit = ourCategoryById('fruit');
assert.ok(fruit);
assert.equal(matchesOurCategory(fruit, 'Игрушка для кошки'), false, '«груш» не должен ловиться в «игрушке»');
assert.equal(matchesOurCategory(fruit, 'Груша Конференц'), true);
assert.equal(matchesOurCategory(fruit, 'Ягоды мытые'), true);

console.log('taxonomy matcher: ALL GREEN');
console.log(`  кейсов ${cases.length}, полок с include ${OUR_CATEGORIES.filter((c) => c.include && c.include.length).length}`);
