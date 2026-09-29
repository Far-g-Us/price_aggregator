import type { ScrapedProduct } from './types.js';

export interface PriceGroup {
  key: string;
  name: string;
  imageUrl?: string;
  brand?: string;
  unit?: string;
  offers: { storeId: string; product: ScrapedProduct }[];
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

export function groupByProduct(items: ScrapedProduct[]): PriceGroup[] {
  const groups: PriceGroup[] = [];
  for (const item of items) {
    const sameId = groups.some((x) =>
      x.offers.some((o) => o.storeId === item.storeId && o.product.canonicalId === item.canonicalId),
    );
    if (sameId) {
      continue;
    }
    const linked = groups.find(
      (x) =>
        !x.offers.some((o) => o.storeId === item.storeId) &&
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
