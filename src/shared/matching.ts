import type { ScrapedProduct } from './types.js';

export interface PriceGroup {
  key: string;
  name: string;
  imageUrl?: string;
  brand?: string;
  unit?: string;
  offers: { storeId: string; product: ScrapedProduct }[];
}

/**
 * Ручные разрывы склейки, попавшие в выдачу.
 *
 * Ключи строит та же функция splitKey, что и слой БД, иначе пара, помеченная
 * в интерфейсе, продолжила бы склеиваться после перезапуска.
 */
export function matchSplitKey(a: string, b: string): string {
  return splitPairKey(a, b);
}

/**
 * Раскладка ключа пары обратно в два id.
 *
 * Разделитель — пробел, и это безопасно только потому, что id сетей его не
 * содержат (`5ka-1234`, `magnit-5678`). Один разбор на разрыв дешевле, чем
 * пара структур через весь стек БД → IPC → renderer.
 *
 * Возвращает `null` вместо исключения: единственный вызывающий в рендере
 * обходится по данным из БД, но пустой результат в UI — это пропущенная
 * строка списка, а исключение — падение дерева (error-boundary в renderer
 * нет, окно открылось бы пустым). Случайный непарсинг не должен ронять
 * приложение.
 */
export function parseSplitKey(key: string): [string, string] | null {
  const i = key.indexOf(' ');
  if (i < 0) return null;
  const a = key.slice(0, i);
  const b = key.slice(i + 1);
  // Разделитель — пробел, значит в id пробелов быть не должно. Если вдруг
  // окажется (будущий адаптер со slug-id), пара не наша: вернуть null лучше,
  // чем удалить строку, которой нет.
  if (!a || !b || a.includes(' ') || b.includes(' ')) return null;
  return [a, b];
}

export function splitPairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/(\d+)\s?(мл|г|кг|л|шт)(?![а-яa-z0-9])/g, '$1$2')
    .replace(/[^a-zа-я0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(name: string): Set<string> {
  return new Set(normalizeName(name).split(' ').filter((t) => t.length > 1 || /\d/.test(t)));
}

export function sameProduct(a: ScrapedProduct, b: ScrapedProduct): boolean {
  if (a.barcode && b.barcode && a.barcode !== b.barcode) return false;
  if (a.barcode && b.barcode) return true;
  if (a.brand && b.brand && normalizeName(a.brand) !== normalizeName(b.brand)) return false;
  if (a.unit && b.unit && a.unit !== b.unit) return false;
  const ta = tokens(a.name);
  const tb = tokens(b.name);
  if (ta.size === 0 || tb.size === 0) return false;
  const digits = (ts: Set<string>) => [...ts].filter((t) => /\d/.test(t)).sort().join('|');
  if (digits(ta) !== digits(tb)) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const jaccard = inter / (ta.size + tb.size - inter);
  return jaccard >= 0.6;
}

/**
 * Группирует товары в карточки «один товар в разных сетях».
 *
 * splits — пары, которые пользователь пометил как разные товары (ключи из
 * matchSplitKey). Пара проверяется ДО sameProduct: ручное решение сильнее
 * эвристики, иначе «разделить» ничего бы не меняло, и пользователь счёл бы
 * кнопку сломанной.
 *
 * Инвариант: внутри группы нет разведённой пары. Он держится по индукции —
 * база одна offer, а новый товар не встанет в группу, где уже есть его
 * партнёр по разрыву. Поэтому флага «в группе есть разрыв» не существует и
 * помечать нечего: либо пара разведена, либо её в группе нет.
 */
export function groupByProduct(items: ScrapedProduct[], splits?: ReadonlySet<string>): PriceGroup[] {
  const isSplit = (a: string, b: string) => (splits ? splits.has(matchSplitKey(a, b)) : false);
  const groups: PriceGroup[] = [];
  for (const item of items) {
    const sameId = groups.some((x) =>
      x.offers.some((o) => o.storeId === item.storeId && o.product.canonicalId === item.canonicalId),
    );
    if (sameId) {
      continue;
    }
    // 1) Куда новый товар встанет без нарушения разрыва.
    const linked = groups.find(
      (x) =>
        !x.offers.some((o) => o.storeId === item.storeId) &&
        x.offers.every((o) => !isSplit(o.product.canonicalId, item.canonicalId)) &&
        x.offers.some((o) => sameProduct(o.product, item)),
    );
    if (linked) {
      linked.offers.push({ storeId: item.storeId, product: item });
      continue;
    }
    const group: PriceGroup = {
      key: `${item.storeId}:${item.canonicalId}`,
      name: item.name,
      offers: [{ storeId: item.storeId, product: item }],
    };
    if (item.imageUrl) group.imageUrl = item.imageUrl;
    if (item.brand) group.brand = item.brand;
    if (item.unit) group.unit = item.unit;
    groups.push(group);
  }
  return groups;
}
