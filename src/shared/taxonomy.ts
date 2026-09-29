// Наши собственные категории — единое дерево для всех сетей.
//
// Зачем: сети раскладывают одно и то же по разным полкам (у Магнита
// «Торты, пирожные», у Пятёрочки свои), поэтому единый список нужен и
// для навигации, и для честного сравнения цен. Раскладка товара по
// нашим категориям опирается на поисковые запросы: у каждой категории
// свой список запросов, по которым собираются товары всех готовых сетей,
// а groupByProduct склеивает их в одну карточку с ценами по магазинам.
//
// Запросы подобраны по витринам (названия категорий 5ka) и по типовым
// запросам поиска. Товар может попасть в несколько наших категорий —
// это нормально, у него один источник (canonicalId) и набор категорий.

export interface OurCategory {
  id: string;
  name: string;
  parentId: string | null;
  /** Поисковые запросы, по которым набираются товары. */
  queries: string[];
  /**
   * Слова, которые должны быть в названии товара. Пусто — берём всё,
   * что вернул поиск. Нужно, чтобы в «Молоко» не падало «коктейль молочный».
   */
  include?: string[];
  /** Слова, по которым товар в категорию не попадает. */
  exclude?: string[];
}

// Слова в названии решают раскладку. У КАЖДОЙ категории есть `include`
// (иначе автораскладка приписывала бы товар половине полок), `exclude`
// снимает близких, но разных соседей.
export const OUR_CATEGORIES: OurCategory[] = [
  {
    id: 'dairy', name: 'Молочное и яйца', parentId: null,
    queries: ['молоко', 'кефир', 'йогурт', 'творог', 'сметана', 'сыр', 'сливочное масло', 'яйцо'],
    include: ['молоко', 'кефир', 'йогурт', 'ряженка', 'творог', 'сметан', 'сыр', 'сливочное масло', 'сгущ', 'яйц'],
    exclude: ['коктейль', 'овсяный', 'подсолнечное'],
  },
  { id: 'dairy-milk', name: 'Молоко', parentId: 'dairy', queries: ['молоко'], include: ['молоко'], exclude: ['коктейль', 'сгущ', 'сухое молоко', 'молочная сыворотка', 'овсяный'] },
  { id: 'dairy-fermented', name: 'Кефир и йогурты', parentId: 'dairy', queries: ['кефир', 'йогурт', 'ряженка'], include: ['кефир', 'йогурт', 'ряженка'] },
  { id: 'dairy-cheese', name: 'Сыры', parentId: 'dairy', queries: ['сыр'], include: ['сыр'], exclude: ['сырный крем', 'паста', 'сулугуни лом'] },
  { id: 'dairy-butter', name: 'Масло', parentId: 'dairy', queries: ['сливочное масло'], include: ['масло'], exclude: ['подсолнечное', 'оливковое', 'растительное', 'кокосовое'] },
  {
    id: 'bakery', name: 'Хлеб и выпечка', parentId: null,
    queries: ['хлеб', 'батон', 'булочка', 'выпечка'],
    include: ['хлеб', 'батон', 'булочк', 'сдоб', 'пирог', 'торт', 'печень', 'сухар', 'лаваш', 'слоен', 'кекс', 'рулет'],
    exclude: ['печенье для животных'],
  },
  { id: 'bakery-bread', name: 'Хлеб и батоны', parentId: 'bakery', queries: ['хлеб', 'батон'], include: ['хлеб', 'батон', 'лепешк'], exclude: ['сухари', 'лаваш'] },
  {
    id: 'meat', name: 'Мясо и птица', parentId: null,
    queries: ['курица', 'индейка', 'говядина', 'свинина', 'фарш'],
    include: ['куриц', 'индейк', 'говядин', 'свинин', 'фарш', 'телятин', 'кролик', 'индейк'],
  },
  { id: 'meat-chicken', name: 'Курица и индейка', parentId: 'meat', queries: ['курица', 'индейка', 'филе курицы'], include: ['куриц', 'индейк', 'филе курицы'] },
  { id: 'sausage', name: 'Колбасы', parentId: null, queries: ['колбаса', 'сосиски', 'ветчина'], include: ['колбас', 'сосиск', 'ветчин', 'балык', 'сервелат', 'карбонад', 'брезаль', 'прошут'] },
  {
    id: 'vegetables', name: 'Овощи', parentId: null,
    queries: ['картофель', 'морковь', 'лук', 'капуста', 'огурцы', 'помидоры', 'перец'],
    include: ['картофел', 'морков', 'лук', 'капуст', 'огурц', 'помидор', 'перец', 'свекл', 'кабач', 'баклажан', 'чеснок', 'зелени', 'редис', 'салат'],
  },
  {
    id: 'fruit', name: 'Фрукты и ягоды', parentId: null,
    queries: ['яблоки', 'бананы', 'апельсины', 'груша', 'ягоды'],
    include: ['яблок', 'банан', 'апельсин', 'груш', 'ягод', 'виноград', 'мандарин', 'лимон', 'персик', 'слив', 'вишн', 'черешн', 'арбуз', 'дын', 'малина', 'клубник'],
  },
  {
    id: 'groceries', name: 'Бакалея', parentId: null,
    queries: ['сахар', 'мука', 'крупа', 'макароны', 'масло подсолнечное', 'соль'],
    include: ['сахар', 'мука', 'крупа', 'макарон', 'соль', 'подсолнечное', 'рис', 'греч', 'овсян', 'пшен', 'вермишел', 'паста', 'крахмал', 'какао'],
  },
  { id: 'groceries-flour', name: 'Мука', parentId: 'groceries', queries: ['мука'], include: ['мука'] },
  {
    id: 'drinks', name: 'Напитки', parentId: null,
    queries: ['сок', 'вода', 'лимонад', 'кофе', 'чай'],
    include: ['сок', 'вода', 'лимонад', 'газиров', 'чай', 'кофе', 'квас', 'компот', 'сироп', 'какао-напит'],
    exclude: ['овсяный', 'молочн', 'кофейн'],
  },
  {
    id: 'household', name: 'Быт и химия', parentId: null,
    queries: ['стиральный порошок', 'средство для посуды', 'туалетная бумага', 'салфетки'],
    include: ['стиральн', 'посуд', 'туалетн', 'салфетк', 'бумажн', 'мыл', 'чистящ', 'фольг', 'пакет', 'зубн', 'освежител', 'крем для рук'],
  },
];

/** Проходит ли товар в нашу категорию по словам в названии. */
export function matchesOurCategory(category: OurCategory, name: string): boolean {
  const lower = name.toLowerCase().replace(/ё/g, 'е');
  if (category.exclude?.some((w) => lower.includes(w.toLowerCase().replace(/ё/g, 'е')))) return false;
  if (!category.include || category.include.length === 0) return true;
  return category.include.some((w) => lower.includes(w.toLowerCase().replace(/ё/g, 'е')));
}

// Автораскладка: в какие наши категории попадает товар по названию.
// Применяется ко ВСЕМУ, что мы получили из сетей (поиск, категория,
// наши категории), чтобы товар сразу оказывался на полках, а не только
// внутри своей категории. Пустой массив = «не разложено».
// Категории без `include` в автораскладке не участвуют: иначе «без
// фильтра» означало бы «подходит всё подряд».
export function classifyOurCategories(
  name: string,
  all: OurCategory[] = OUR_CATEGORIES,
): string[] {
  return all
    .filter((c) => (c.include?.length ?? 0) > 0 && matchesOurCategory(c, name))
    .map((c) => c.id);
}

export function ourCategoryById(id: string): OurCategory | undefined {
  return OUR_CATEGORIES.find((c) => c.id === id);
}

export function ourChildCategories(parentId: string | null): OurCategory[] {
  return OUR_CATEGORIES.filter((c) => c.parentId === parentId);
}

export function hasOurChildren(id: string): boolean {
  return OUR_CATEGORIES.some((c) => c.parentId === id);
}

// Какие категории видны при текущем раскрытии: корни всегда, дети — только
// у раскрытого родителя. Вынесено отдельно, чтобы тестировать ту же
// логику, что рисует UI (иначе опечатка в фильтре осталась бы незамеченной).
// `info` — то, что приходит по IPC: id/имя/родитель плюс счётчики.
export interface OurCategoryView {
  id: string;
  name: string;
  parentId: string | null;
  queryCount: number;
  storeCount: number;
  virtual?: boolean;
}

export function visibleOurCategories(
  open: Record<string, boolean>,
  all: OurCategoryView[],
): OurCategoryView[] {
  return all.filter((c) => c.parentId === null || open[c.parentId] === true);
}
