import type { ScrapedProduct } from '../../shared/types.js';

// Разбор ответов 5ka вынесен отдельно от адаптера: браузерный транспорт
// переиспользует ровно этот код, а общий модуль позволяет импортировать его
// статически. Раньше браузерный код брался динамическим import() — только ради
// того, чтобы не заводить цикл модулей (5ka-browser импортировал normalize отсюда).
// Побочный эффект был измерен: V8 считает веткой сам `await import()`, и
// непокрытой остаётся ветка ОТКАЗА — «модуль не загрузился». Её не закрывает
// никакой тест: успешный импорт есть, а падение воспроизводится только битой
// установкой. Статический импорт убирает и цикл, и эту ветку, поэтому
// `c8 ignore` здесь не понадобился — в отличие от `import('playwright')`,
// где ветка отказа остаётся (см. playwright-port).
export const categoryIdFromUrl = (url: string): string | null => {
  const m = url.match(/^https:\/\/5ka\.ru\/catalog\/(?:[^/]+--)?([0-9A-Za-z]+)\/?$/);
  return m?.[1] ?? null;
};

export function assertSapCode(sap: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sap)) throw new Error(`5ka: bad sapCode ${sap}`);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function validOldPrice(old: number | null, price: number): old is number {
  return old !== null && old > price && old / price < 5;
}

// Реальные ответы 5ka (фикстуры 5ka-search.json и 5ka-product.json,
// сняты 2026-09 в браузере юзера, Москва X383). Формат цены РАЗНЫЙ:
// в выдаче поиска `prices` — объект {regular, discount, markdown},
// в карточке товара — МАССИВ [{value, placement_type}]. Баркода нет
// ни там, ни там — склейка по названию/бренду/фасовке (см. matching).
export interface SearchItem {
  plu?: string | number;
  name?: string;
  prices?:
    | {
        regular?: string | number | null;
        discount?: string | number | null;
        cpd_promo_price?: string | number | null;
        cpd_promo_price_from_sum_cart?: string | number | null;
        markdown?: string | number | null;
      }
    | { value?: string | number | null; placement_type?: string }[]
    | null;
  promo?: { rebate?: { units_to_activate?: number } } | null;
  uom?: string;
  property_clarification?: string;
  package_quantity?: string;
  is_available?: boolean;
  // small подтверждён живым ответом (зонд 2026-09-30): в выдаче категории
  // normal иногда нет, и без фолбэка карточки молча теряли бы картинки.
  image_links?: { normal?: string[]; small?: string[] };
  // В листинге категории верхний image_links иногда не приходит, а картинка
  // лежит в media — без фолбэка она молча пропадала бы.
  media?: { image_links?: { normal?: string[]; small?: string[] } };
  description?: string;
  attributes?: { name?: string; value?: string; uom?: string | null }[];
}

/**
 * Лучшая доступная картинка: normal, иначе small. Малый адрес поднимаем до
 * 800x800: БД отдаёт приоритет новому значению (COALESCE), и без подъёма
 * клик по полке тихо ухудшил бы уже сохранённую нормальную картинку.
 */
function bestImage(links?: { normal?: string[]; small?: string[] }): string | null {
  const normal = links?.normal?.[0];
  if (normal) return normal;
  const small = links?.small?.[0];
  if (!small) return null;
  return small.replace(/\/320x320\.jpeg$/, '/800x800.jpeg');
}

interface PriceParts {
  regular: number | null;
  promo: number | null;
  old: number | null;
}

// В объекте имена полей несут смысл, в массиве placement_type акционной
// цены не наблюдался — там определяем по величине относительно
// regular_primary. Обычная скидка приходит в `discount` — это видно на
// живой фикстуре tests/fixtures/5ka-search-promo.json (999.0 → 739.0, метка
// «-26%»). Мультибай — отдельные поля: цена в `cpd_promo_price` (а для «от N
// шт в корзине» — `cpd_promo_price_from_sum_cart`), а `promo.rebate` с
// `units_to_activate` помечает, что это акция на количество: при нём в
// promoPrice цена не пишется, единичная остаётся regular. Если rebate нет, а
// cpd_promo_price есть — сеть отдала это как обычную акцию, и она уходит в
// promoPrice (зафиксировано в scripts/test-5ka.ts).
function priceParts(prices: SearchItem['prices']): PriceParts {
  if (prices === null || prices === undefined) return { regular: null, promo: null, old: null };
  if (Array.isArray(prices)) {
    const values = prices
      .map((p) => num(p?.value))
      .filter((v): v is number => v !== null);
    const tagged = prices.find((p) => p?.placement_type === 'regular_primary');
    const regular = num(tagged?.value) ?? values[0] ?? null;
    // Без обычной цены акции и старой цены тоже нет: сравнивать не с чем, и в
    // остатке всё равно ничего не окажется.
    if (regular === null) return { regular: null, promo: null, old: null };
    const rest = values.filter((v) => v !== regular);
    return {
      regular,
      promo: rest.find((v) => v < regular) ?? null,
      old: rest.find((v) => v > regular) ?? null,
    };
  }
  return {
    regular: num(prices.regular),
    // cpd_promo_price_from_sum_cart НЕ берём: это цена от N-го товара в
    // корзине, та же мультибай-механика, что rebate, и в живых данных
    // всегда null.
    promo: num(prices.cpd_promo_price ?? prices.discount),
    old: num(prices.markdown),
  };
}

function attribute(item: SearchItem, name: string): string | undefined {
  const hit = item.attributes?.find((a) => a?.name === name);
  const value = String(hit?.value ?? '').trim();
  return value || undefined;
}

export function normalize(raw: SearchItem, ctx: { city: string }): ScrapedProduct | null {
  const plu = String(raw.plu ?? '');
  const name = String(raw.name ?? '').trim();
  if (!/^\d+$/.test(plu) || !name) return null;
  const { regular: price, promo: promoRaw, old: oldRaw } = priceParts(raw.prices);
  if (price === null) return null;
  // Мультибай («% ко 2-й», promo.rebate.units_to_activate): цена действует
  // только от N-го товара в корзине, единичная остаётся regular. Такую
  // скидку НЕ пишем в promoPrice, иначе в карточке и в истории цена
  // одного товара соврёт.
  const isMultibuy = raw.promo?.rebate?.units_to_activate != null;
  const product: ScrapedProduct = {
    canonicalId: `5ka-${plu}`,
    storeId: 'pyaterochka',
    city: ctx.city,
    name,
    unit:
      String(raw.property_clarification ?? '').trim() ||
      String(raw.package_quantity ?? '').trim() ||
      String(raw.uom ?? '').trim() ||
      'шт',
    price,
    promoPrice: !isMultibuy && promoRaw !== null && promoRaw < price ? promoRaw : null,
    oldPrice: validOldPrice(oldRaw, price) ? oldRaw : null,
    inStock: raw.is_available === true,
    // Короткая ссылка редиректит на slug-вариант (проверено юзером на
    // 5ka.ru/product/3255206/ -> .../moloko-domik-...-9--3255206/).
    url: `https://5ka.ru/product/${encodeURIComponent(plu)}/`,
    collectedAt: new Date().toISOString(),
  };
  // normal есть не везде: в выдаче категории встречается только small. Малый
  // адрес поднимаем до 800x800: БД отдаёт приоритет новому значению (COALESCE),
  // и без подъёма клик по полке тихо ухудшил бы уже сохранённую картинку.
  const img = bestImage(raw.image_links) ?? bestImage(raw.media?.image_links);
  if (img) product.imageUrl = img;
  const brand = attribute(raw, 'Бренд');
  if (brand) product.brand = brand;
  if (raw.description) product.description = raw.description;
  return product;
}
