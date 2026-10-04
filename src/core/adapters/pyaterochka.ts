import type { ScrapedProduct, StoreAdapter, StoreCategory } from '../../shared/types.js';
import { readEnvFlag } from '../platform.js';
import { browserCategories, browserCategoryProducts, browserFetchProduct, browserSearch } from './5ka-browser.js';
import { assertSapCode, categoryIdFromUrl, normalize } from './5ka-parse.js';
import type { SearchItem } from './5ka-parse.js';

// Публичные имена разбора живут в 5ka-parse, но исторически импортируются
// отсюда: переименование ломало бы тесты и чтение истории коммитов.
export { categoryIdFromUrl, normalize, validOldPrice } from './5ka-parse.js';
export type { SearchItem } from './5ka-parse.js';

const CATALOG = 'https://5d.5ka.ru/api';

function deviceId(): string {
  return `el-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

// Один device-id на запуск приложения: у Магнита аналогично не нужно, но
// антифрод 5ka (ServicePipe) видит смену устройства на каждом запросе.
const DEVICE_ID = deviceId();

// Страница WAF вместо JSON: у Пятёрки это html с внятным текстом, а не код
// ответа, поэтому по status её не отличить — приходится смотреть тело.
function wafPage(body: string): boolean {
  return /Проблемы со связью|проверьте настройки интернета и VPN|request id/i.test(body);
}
export class PyaterochkaAdapter implements StoreAdapter {
  readonly storeId = 'pyaterochka' as const;

  // Основной транспорт — браузерный (X5 режет всё, что не браузер).
  // Прямой fetch оставлен как запасной путь для отладки/экспериментов
  // (PA5KA_TRANSPORT=fetch): он громко падает на WAF-странице.
  private browser = readEnvFlag('PA5KA_TRANSPORT') !== 'fetch';

  private headers(): Record<string, string> {
    return {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      Referer: 'https://5ka.ru/',
      'x-platform': 'web',
      'x-device-id': DEVICE_ID,
    };
  }

  private async getJson<T>(url: string, what: string): Promise<T> {
    const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(25000) });
    const body = await res.text();
    if (res.status === 403 && wafPage(body)) {
      throw new Error(
        `5ka: WAF режет запрос вне браузера (${what}, HTTP 403). Коды каталога подтверждены, но нужен браузерный контекст — см. скилл.`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `5ka: ${what} HTTP ${res.status} — WAF не пускает запросы вне браузера. ` +
          'Обычный транспорт — браузерный (PA5KA_TRANSPORT=fetch только для отладки).',
      );
    }
    if (!res.ok) throw new Error(`5ka ${what} HTTP ${res.status}`);
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`5ka ${what}: ответ не JSON (смена вёрстки/отдача WAF?)`);
    }
  }

  async search(
    query: string,
    ctx: { city: string; externalStoreId: string },
  ): Promise<ScrapedProduct[]> {
    assertSapCode(ctx.externalStoreId);
    if (this.browser) {
      return browserSearch(query, ctx);
    }
    const url =
      `${CATALOG}/catalog/v3/stores/${encodeURIComponent(ctx.externalStoreId)}` +
      `/search?mode=store&include_restrict=true&q=${encodeURIComponent(query)}&limit=12`;
    const data = await this.getJson<{ products?: SearchItem[] }>(url, 'search');
    const list = data.products ?? [];
    return list
      .map((r) => normalize(r, ctx))
      .filter((x): x is ScrapedProduct => x !== null);
  }

  async fetchProduct(
    canonicalId: string,
    ctx: { city: string; externalStoreId: string },
  ): Promise<ScrapedProduct> {
    const plu = canonicalId.replace(/^5ka-/, '');
    if (!/^\d+$/.test(plu)) throw new Error(`5ka: bad canonicalId ${canonicalId}`);
    assertSapCode(ctx.externalStoreId);
    if (this.browser) {
      return browserFetchProduct(plu, ctx);
    }
    const url =
      `${CATALOG}/catalog/v2/stores/${encodeURIComponent(ctx.externalStoreId)}` +
      `/products/${encodeURIComponent(plu)}?mode=store&include_restrict=true`;
    const raw = await this.getJson<SearchItem>(url, 'product');
    const norm = normalize({ ...raw, plu: raw.plu ?? plu }, ctx);
    if (!norm) throw new Error('5ka: пустой ответ по товару (нет цены/имени)');
    if (norm.canonicalId !== canonicalId) {
      throw new Error(`5ka: ответ по другому товару (${norm.canonicalId} вместо ${canonicalId})`);
    }
    return norm;
  }

  // Категории и товары по ним работают только через браузер: fetch-путь упирается
  // в WAF, и копировать его параметры (mode, include_restrict) в код незачем —
  // мы всё равно перехватываем САЙТСКИЙ запрос.
  canHandleCategoryUrl(categoryUrl: string): boolean {
    return categoryIdFromUrl(categoryUrl) !== null;
  }

  async fetchCategories(ctx: { city: string; externalStoreId: string }): Promise<StoreCategory[]> {
    assertSapCode(ctx.externalStoreId);
    if (!this.browser) {
      throw new Error('5ka: категории доступны только в браузерном транспорте (PA5KA_TRANSPORT=fetch)');
    }
    return browserCategories({ externalStoreId: ctx.externalStoreId });
  }

  async fetchCategoryProducts(
    categoryUrl: string,
    ctx: { city: string; externalStoreId: string },
  ): Promise<ScrapedProduct[]> {
    assertSapCode(ctx.externalStoreId);
    if (!this.canHandleCategoryUrl(categoryUrl)) {
      throw new Error('5ka: categoryUrl вне каталога');
    }
    if (!this.browser) {
      throw new Error('5ka: товары категории доступны только в браузерном транспорте (PA5KA_TRANSPORT=fetch)');
    }
    return browserCategoryProducts(categoryUrl, ctx);
  }
}
