// Перекрёсток на Android через «страницу-читалку» (Фаза 7г).
//
// Десктопный транспорт (`perekrestok-browser.ts`) ходит настоящим Firefox:
// POST в API работает только из контекста страницы, обычный fetch даёт 401.
// На Android браузера нет, но страница, открытая WebView, — настоящий
// браузерный контекст: Java-плагин грузит страницу-донор (каталог), ждёт,
// пока она оседает НАСТОЯЩЕЙ (порог длины режет челлендж-заглушки), и из-под
// её JS делает один подписанный fetch с кредами, которые сама страница
// читает из своих кук/localStorage. Отличие от десктопа в том, что сессия
// НЕ держится между вызовами: каждый вызов = загрузка донора + один POST.
//
// Справедливость классификаций снята зондами 2026-10-24 (см. ROADMAP):
// челлендж-заглушка Перекрёстка — html-страница семейства spjs/spsc/spid
// (X5-набор её не зовёт), провисность отдаёт ПУСТОЕ тело с живым статусом.

import type { ProductFetchContext, ScrapedProduct, StoreAdapter } from '../../shared/types.js';
import { ProductLookupError } from '../adapter-errors.js';
import { loadPageReader, type PageReader } from './page-reader-port.js';
import {
  FEED_PAGE,
  FEED_PATH,
  assertOwnStore,
  assertPerekrestokSapId,
  assertStrictSearch,
  normalizePerekrestokFeed,
  perekrestokNameQueries,
  perekrestokPlu,
} from './perekrestok-parse.js';

const WEB = 'https://www.perekrestok.ru';
const API = `${WEB}/api/customer/1.4.1.0`;
/** Страница-донор: каталог, тот же адрес, что открывают живые пользователи. */
const DONOR = `${WEB}/catalog/`;

/**
 * Повторяемый отказ страницы/антибота: челлендж не прошёл, тело пустое или
 * донор устарел. Немедленного повтора в транспорте нет (каждый вызов = одна
 * загрузка и один POST) — отказ уходит наружу, а догоняет его следующий такт
 * scheduler'а; немедленные повторы WAF читает как долбёжку.
 */
class PageFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageFailure';
  }
}

/**
 * Остаточные обёртки evaluateJavascript — та же ловушка, что у Пятёрки
 * (5ka-page): мост снимает слой сам, но при регрессии моста слой мог бы
 * остаться. Снимаем, пока текст выглядит как строка в кавычках.
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
 * v1 — search + fetchProduct (полки/категории вне v1, как у 5ka-page:
 * в телефоне не рисуются). Тело запроса — ровно десктопное: `page`, `perPage`
 * и `filter.textQuery`; лишний параметр мог бы тихо поменять режим выдачи.
 */
export class PerekrestokPageAdapter implements StoreAdapter {
  readonly storeId = 'perekrestok' as const;

  async search(
    query: string,
    ctx: { city: ProductFetchContext['city']; externalStoreId: string },
  ): Promise<ScrapedProduct[]> {
    const sapId = assertPerekrestokSapId(ctx.externalStoreId);
    const text = query.trim();
    if (text === '') return [];
    const data = await this.feed(text);
    assertStrictSearch(data, 'пользовательский запрос');
    assertOwnStore(data, sapId, 'пользовательский запрос');
    return normalizePerekrestokFeed(data, ctx);
  }

  async fetchProduct(canonicalId: string, ctx: ProductFetchContext): Promise<ScrapedProduct> {
    const sapId = assertPerekrestokSapId(ctx.externalStoreId);
    const plu = perekrestokPlu(canonicalId);
    const name = ctx.name?.trim();
    if (!name) {
      throw new ProductLookupError(
        'у товара нет названия в базе — найди его поиском, чтобы опрос его видел',
        canonicalId,
      );
    }
    // Лестница 40/25 — как на десктопе: каждый шаг = своя загрузка донора и
    // один POST, гэп держит плагин. Прервать лестницу честно: PageFailure
    // вверх, без попыток «дожать» повтором.
    const attempts: string[] = [];
    let sawAnyItems = false;
    for (const query of perekrestokNameQueries(name)) {
      const data = await this.feed(query);
      assertStrictSearch(data, `товар «${query.slice(0, 24)}»`);
      assertOwnStore(data, sapId, `товар «${query.slice(0, 24)}»`);
      const items = normalizePerekrestokFeed(data, ctx);
      if (items.length > 0) sawAnyItems = true;
      attempts.push(`«${query.slice(0, 32)}» товаров=${items.length}`);
      const hit = items.find((p) => p.canonicalId === `perekrestok:${plu}`);
      if (hit !== undefined) return hit;
    }
    if (!sawAnyItems) {
      // Пустая выдача на всех попытках — сеть или дрейф, не переименование:
      // расходиться с десктопом нельзя: ProductLookupError здесь был бы ложью.
      throw new Error(
        `perekrestok: поиск вернул пустую выдачу на все попытки (${attempts.join('; ')}) — сеть или дрейф ответа`,
      );
    }
    throw new ProductLookupError(
      `товар не найден поиском по названию (${attempts.join('; ')}) — возможно, переименован или снят`,
      `perekrestok-${plu}`,
    );
  }

  /**
   * Одна ходка: осевшая страница-донор + один подписанный POST. Статусы
   * классифицируются честно: отказ антибота — PageFailure (доехал позже),
   * дрейф формы сети — обычная ошибка (strike всей сети).
   */
  private async feed(textQuery: string): Promise<unknown> {
    const reader = await loadPageReader();
    if (!reader.post) {
      throw new Error('perekrestok: мост читалки без post() — нужен свежий APK с плагином Фазы 7г');
    }
    // Тело сериализуется РОВНО ОДИН раз: Java вставляет литерал прямо в JS
    // (`body:(<literal>)`), второй stringify дал бы строку-в-строке.
    const bodyJson = JSON.stringify({ page: 1, perPage: FEED_PAGE, filter: { textQuery } });
    const out = await reader.post({ pageUrl: DONOR, apiUrl: `${API}${FEED_PATH}`, bodyJson });
    const body = unwrapJsValue(out.body);
    if (out.status === 0) {
      // fetch не доехал: страница могла перезарядиться или сеть пропала.
      throw new PageFailure(
        `perekrestok: POST на ${FEED_PATH} не доехал (${body.slice(0, 120)}) — страница или сеть пропали`,
      );
    }
    if (out.status === 401 || out.status === 403) {
      throw new PageFailure(
        `perekrestok: ${FEED_PATH} отдал ${out.status} — креды не устоялись, повтор имеет смысл позже`,
      );
    }
    if (out.status !== 200) {
      // Транспортная ошибка С ТЕЛОМ ответа — причина в теле, не «молча пусто».
      throw new Error(`perekrestok: ${FEED_PATH} ответил ${out.status}: ${body.slice(0, 160)}`);
    }
    if (body.trim() === '') {
      // Это провисность антибота, снятая зондом: живой статус, пустое тело.
      throw new PageFailure(`perekrestok: ${FEED_PATH} отдал пустое тело при 200 — провисность антибота`);
    }
    if (body.trimStart().startsWith('<')) {
      // Челлендж встал на сам POST: страница с формой вместо выдачи.
      throw new PageFailure(`perekrestok: ${FEED_PATH} вернул страницу вместо JSON — челлендж антибота`);
    }
    let data: unknown;
    try {
      data = JSON.parse(body) as unknown;
    } catch {
      throw new Error(`perekrestok: пост-ответ ${FEED_PATH} — не JSON (дрейф формы сети?)`);
    }
    return data;
  }
}
