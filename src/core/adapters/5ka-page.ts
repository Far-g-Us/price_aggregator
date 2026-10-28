import type { ProductFetchContext, ScrapedProduct, StoreAdapter } from '../../shared/types.js';
import { assertSapCode, normalize, type SearchItem } from './5ka-parse.js';
import { loadPageReader, type PageReader } from './page-reader-port.js';

const WEB = 'https://5ka.ru/';
const CATALOG = 'https://5d.5ka.ru/api';

interface SearchResponse {
  products?: SearchItem[] | null;
}

interface NextDataEnvelope {
  ok?: boolean;
  reason?: string;
  codes?: string[];
  product?: string;
}

/**
 * Отказ, который имеет смысл повторить один раз: WAF-заглушка, пустое тело
 * или не дошедшие до конца данные — куки и челлендж могли ещё не устояться.
 * Априорные ошибки (не-JSON, чужой магазин, плохой plu) наружу сразу: повтор их не чинит, а
 * лишние запросы — расход и rate-limit, который лимит не восстанавливает.
 * На адрес — максимум 2 попытки (ToS-рамки Фазы 7в).
 */
class PageFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageFailure';
  }
}

const isRetryable = (err: unknown): boolean => err instanceof PageFailure;

/** Страница WAF вместо JSON: у Пятёрки это html с внятным текстом, а не код
 * ответа, поэтому по статусу её не отличить — тот же маркер, что у прямого
 * адаптера (`pyaterochka.ts`). */
function wafPage(body: string): boolean {
  return /Проблемы со связью|проверьте настройки интернета и VPN|request id/i.test(body);
}

/**
 * evaluateJavascript отдаёт значение JSON-литералом (строка — с кавычками),
 * и обёртку снимает мост (JSONTokener). Остаточные слои могли бы остаться
 * при регрессии моста или обновлении Capacitor: снимаем, пока текст выглядит
 * как JSON-строка, максимум два слоя — двух лишних обёрток мост не создаёт.
 */
function unwrapJsValue(text: string): string {
  let current = text.trim();
  for (let layer = 0; layer < 2; layer += 1) {
    if (!current.startsWith('"') || !current.endsWith('"')) break;
    try {
      const parsed: unknown = JSON.parse(current);
      if (typeof parsed !== 'string') break;
      current = parsed.trim();
    } catch {
      break;
    }
  }
  return current;
}

/**
 * Пятёрочка на Android через «страницу-читалку».
 *
 * Десктопная Пятёрка (`pyaterochka.ts`) ходит настоящим Firefox (Playwright):
 * WAF X5 режет всё, что не браузер. На Android браузера нет, но страница,
 * открытая WebView, выполняется в настоящем браузерном контексте: WebView сам
 * делает навигацию со своими куками и подписями антифрода, без подмены UA и
 * отпечатка, а мы читаем ответ из DOM.
 *
 * v1 — search + fetchProduct: search открывает адрес API как страницу
 * (sapCode вшивается в URL нами самими — маркера магазина в теле выдачи нет,
 * как у Ленты), карточка открывает страницу товара и ждёт непустого
 * `__NEXT_DATA__`: сайт НЕ грузит карточку отдельным запросом, товар лежит
 * вшитым в снимок. Категории и товары категории — вне v1: листинги категории
 * через страницу не сняты, полки честно не рисуются (как у Ленты).
 */
export class PyaterochkaPageAdapter implements StoreAdapter {
  readonly storeId = 'pyaterochka' as const;

  /** Прогрев ленивый: страница 5ka.ru ставит антибот-куки десятки секунд
   * (Измерение 5), и на старте приложения он висел бы всегда, даже когда
   * Пятёрку не зовут. Состояние антибота живёт в КОНТЕКСТЕ ОТКРЫТЫХ СТРАНИЦ
   * WebView и переживает вызовы (замер Фазы 7в: CookieManager и после
   * успешного челленджа показывает none) — видимые куки не признак его
   * жизни, диагностика по ним водит за нос. Повторный прогрев — только по
   * WAF-отказу. */
  private warmed = false;

  private async withReader<T>(read: (reader: PageReader) => Promise<T>): Promise<T> {
    const reader = await loadPageReader();
    if (!this.warmed) {
      await reader.warmup({ url: WEB });
      this.warmed = true;
    }
    try {
      return await read(reader);
    } catch (err) {
      // ≤2 попытки на адрес. В повторе смысл есть только на PageFailure:
      // кука могла ещё не устояться после первого прогрева.
      if (!isRetryable(err)) throw err;
      await reader.warmup({ url: WEB });
      return await read(reader);
    }
  }

  async search(query: string, ctx: { city: ProductFetchContext['city']; externalStoreId: string }): Promise<ScrapedProduct[]> {
    assertSapCode(ctx.externalStoreId);
    const url =
      `${CATALOG}/catalog/v3/stores/${encodeURIComponent(ctx.externalStoreId)}` +
      `/search?mode=store&include_restrict=true&q=${encodeURIComponent(query)}&limit=12`;
    const products = await this.withReader(async (reader) => {
      const text = unwrapJsValue(await reader.readPage({ url }));
      if (wafPage(text)) {
        throw new PageFailure(`5ka: WAF отдал заглушку вместо ответа на поиск — повторите позже`);
      }
      if (text.trim() === '') {
        throw new PageFailure(`5ka: тело ответа на поиск пустое — страница не отдала данных`);
      }
      let data: SearchResponse;
      try {
        data = JSON.parse(text) as SearchResponse;
      } catch {
        // Начало с '<' — это HTML, а не дрейф той же формы: настоящий
        // челлендж WAF может не иметь ни одного текстового маркера заглушки,
        // и для него повтор имеет смысл (куки могли ещё не устояться).
        if (text.trimStart().startsWith('<')) {
          throw new PageFailure(`5ka: поиск отдал HTML вместо JSON (WAF-челлендж?)`);
        }
        throw new Error(`5ka: поиск: ответ не JSON (смена вёрстки?)`);
      }
      if (!Array.isArray(data.products)) {
        throw new Error(`5ka: поиск: в ответе нет списка товаров (смена вёрстки?)`);
      }
      if (data.products.length === 0) {
        // Пустая выдача при живой сети — не честное «ничего не нашлось», а
        // симптом подмены: WAF мог вернуть форму ответа без товаров. Молча
        // вернуть «пусто» нельзя — опрос снял бы это как «цена не изменилась»
        // (write-on-change), и сеть тихо перестала бы обновляться.
        throw new PageFailure(
          `5ka: поиск отдал 0 товаров при живой сети — либо совпадений нет, либо ответ подменён`,
        );
      }
      return data.products;
    });
    // Фильтр без throw после нормализации — как у десктопного поиска: позиции
    // без цены или названия сайт отдаёт и в норме (вне наличия).
    return products
      .map((p) => normalize(p, ctx))
      .filter((x): x is ScrapedProduct => x !== null);
  }

  async fetchProduct(canonicalId: string, ctx: ProductFetchContext): Promise<ScrapedProduct> {
    const plu = canonicalId.replace(/^5ka-/, '');
    if (!/^\d+$/.test(plu)) throw new Error(`5ka: bad canonicalId ${canonicalId}`);
    assertSapCode(ctx.externalStoreId);
    const raw = await this.withReader(async (reader) => {
      const envelope = unwrapJsValue(
        await reader.readNextData({ url: `${WEB}product/${encodeURIComponent(plu)}/`, plu }),
      );
      let parsed: NextDataEnvelope;
      try {
        parsed = JSON.parse(envelope) as NextDataEnvelope;
      } catch {
        throw new Error(`5ka: карточка ${plu}: сводка чтения не JSON — мост отдал мусор`);
      }
      if (!parsed.ok) {
        const why =
          parsed.reason === 'next-missing'
            ? 'страницы товара с данными нет (WAF-заглушка или ошибка сети)'
            : parsed.reason === 'next-broken'
              ? 'снимок __NEXT_DATA__ не разобрался — страница не отдала данные целиком'
              : 'товар не появился в данных страницы';
        throw new PageFailure(`5ka: карточка ${plu}: ${why}`);
      }
      // Коды страницы обязаны назвать наш магазин. На карточке URL без
      // магазина, поэтому доказательство — снимок: коды собираются ВСЕ
      // и сверяются с настроенным (скилл: требование единогласия мягче не
      // становилось, но десктопный эталон допускает «наш назван среди прочих»
      // с warn — держим ровно это же правило).
      const codes = Array.isArray(parsed.codes) ? parsed.codes : [];
      if (codes.length > 0 && !codes.includes(ctx.externalStoreId)) {
        throw new Error(
          `5ka: страница карточки назвала магазины ${codes.join(' / ')}, а настроен ${ctx.externalStoreId}`,
        );
      }
      if (codes.length !== 1) {
        console.warn(
          `5ka: карточка ${plu} — кодов на странице ${codes.length === 0 ? 'нет' : codes.join(' / ')}, берём ${ctx.externalStoreId} из настроек`,
        );
      }
      if (typeof parsed.product !== 'string') {
        throw new Error(`5ka: карточка ${plu}: в сводке нет товара`);
      }
      try {
        return JSON.parse(parsed.product) as SearchItem;
      } catch {
        throw new Error(`5ka: карточка ${plu}: запись товара не JSON (смена вёрстки?)`);
      }
    });
    const product = normalize(raw, ctx);
    if (!product) throw new Error(`5ka: карточка ${plu} без цены (пустой prices?)`);
    if (product.canonicalId !== canonicalId) {
      throw new Error(`5ka: карточка отдала другую запись: ${product.canonicalId} вместо ${canonicalId}`);
    }
    return product;
  }
}
