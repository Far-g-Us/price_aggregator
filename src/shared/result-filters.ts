/**
 * Фильтры выдачи: цена «от/до» и «есть в N и более сетях».
 *
 * Модуль лежит в `src/shared`, а не в `src/renderer` намеренно: гейт покрытия
 * исключает renderer (`package.json`, `test:coverage`), и файла в renderer
 * тест не спасает — гейт его просто не потребует. Чистая функция без React
 * покрывается обычным юнит-тестом и попадает в 100 % автоматически.
 */

import type { PriceGroup } from './matching.js';

export interface ResultFilters {
  /** Нижняя граница включительно; `null` — граница не задана. */
  priceFrom: number | null;
  /** Верхняя граница включительно; `null` — граница не задана. */
  priceTo: number | null;
  /** Сколько разных сетей должно быть в карточке. `1` — не фильтруем. */
  minStores: number;
}

/**
 * Цена карточки — минимальная действующая по всем предложениям.
 *
 * Определение одно на всю выдачу: тем же считается `minOf` при сортировке и
 * тем же напечатана цена в строке предложения (`promoPrice ?? price`). Второго
 * определения заводить нельзя: «дешевле 100» и сортировка «сначала дешевле»
 * обязаны значить одно и то же.
 */
export function groupPrice(group: PriceGroup): number {
  return Math.min(...group.offers.map((o) => o.product.promoPrice ?? o.product.price));
}

/**
 * Сколько разных СЕТЕЙ в карточке.
 *
 * Считается по `storeId`, а не по числу предложений: после склейки в группе
 * может лежать два товара одной сети (200 мл и 900 мл молока), и это всё равно
 * одна сеть. И наоборот: две точки одной сети — это одна сеть для этого
 * счётчика и ДВЕ точки для агрегата цен (groupPriceRange).
 */
export function groupStoreCount(group: PriceGroup): number {
  return new Set(group.offers.map((o) => o.storeId)).size;
}

/**
 * Диапазон цен карточки и число ТОЧЕК в ней.
 *
 * Две точки одной сети — это два разных магазина с разными ценами, и одна
 * цифра в шапке («119 ₽») была бы враньём: непонятно, чья это цена и сколько
 * магазинов в карточке. Поэтому шапка печатает «от … до …» и число точек.
 *
 * Цена точки — та же, что и в строке предложения: `promoPrice ?? price`.
 * `points` считается по паре «сеть + код», потому что предложения внутри
 * группы уже разные точки (см. `groupByProduct`).
 */
export function groupPriceRange(group: PriceGroup): { min: number; max: number; points: number } {
  const prices = group.offers.map((o) => o.product.promoPrice ?? o.product.price);
  return {
    min: Math.min(...prices),
    max: Math.max(...prices),
    points: group.offers.length,
  };
}

/**
 * Разбор того, что вписал человек в поле цены.
 *
 * `null` означает «границы нет»: пустая строка, мусор и нечисловой ввод
 * (`1e5`, `-`, `abc`) дают одно и то же, иначе `NaN` дошёл бы до сравнения и
 * молча пропускал товары мимо фильтра. Запятая разрешена: русская раскладка
 * ставит её как десятичный разделитель.
 */
export function parsePriceFilter(raw: string): number | null {
  const text = raw.trim().replace(',', '.');
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Границы перепутаны местами.
 *
 * Возвращается отдельно от результата фильтра, потому что это не «пусто»:
 * пользователь должен увидеть ошибку у полей, а не пустое состояние в другом
 * конце экрана. Сами границы при этом НЕ переставляются молча — иначе человек
 * получит выдачу, которой не просил.
 */
export function priceRangeInverted(f: ResultFilters): boolean {
  return f.priceFrom !== null && f.priceTo !== null && f.priceFrom > f.priceTo;
}

/**
 * Отбор по цене и по числу сетей.
 *
 * Неизвестная цена (нечисловая или NaN в данных) фильтр НЕ прячет: молча
 * выкинуть товар из выдачи хуже, чем показать его рядом с остальными. Границы
 * при `от > до` несовместимы, поэтому результат пустеет — это осознанно.
 */
export function filterPriceGroups(groups: PriceGroup[], f: ResultFilters): PriceGroup[] {
  const byPrice = (g: PriceGroup): boolean => {
    const price = groupPrice(g);
    if (!Number.isFinite(price)) return true;
    if (f.priceFrom !== null && price < f.priceFrom) return false;
    if (f.priceTo !== null && price > f.priceTo) return false;
    return true;
  };
  return groups.filter((g) => byPrice(g) && groupStoreCount(g) >= f.minStores);
}