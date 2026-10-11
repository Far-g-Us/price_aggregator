// Адаптер Перекрёстка (`perekrestok.ru`).
//
// Что подтверждено живой разведкой 2026-10-10 (см. ROADMAP и фикстуры
// `tests/fixtures/perekrestok/`), а не выдумано:
//
// - **Только браузер.** Из контекста страницы `POST /catalog/product/feed` → 200,
//   обычным `fetch` → 401 даже с токеном и заголовками. Обход антибота не
//   используется: мы просто сизим на каталоге, как это делает сам сайт.
// - **Карточек по plu нет** (`/catalog/product/<plu>` → 404), поэтому
//   `fetchProduct` ищет товар тем же поиском по названию, что Лента и Чижик.
// - **Цена в копейках**, при акции `price` — уже со скидкой, а `grossPrice` —
//   до неё (см. `perekrestok-parse.ts`).
// - **Точка опознаётся по `content.sapId`** прямо в ответе: в Москве «2053».
//   Это единственная сверка, которая у нас есть, и она обязательна — цена
//   привязана к магазину.
// - **Поиск строгий, и сеть сообщает об этом сама** (`content.searchType`).
//   Мусорный запрос даёт пустую выдачу — проверено живьём.

import type { ScrapedProduct, StoreAdapter } from '../../shared/types.js';
import { ProductLookupError, StaleStoreError } from '../adapter-errors.js';
import { closePerekrestokBrowser, postWithRebuild } from './perekrestok-browser.js';
import {
  isStrictPerekrestokSearch,
  normalizePerekrestokFeed,
  perekrestokSapId,
} from './perekrestok-parse.js';

/**
 * Сколько товаров берём за один запрос.
 *
 * 100 — потолок сети: при `perPage: 500` она отвечает 400 (проверено живьём
 * 2026-10-10). Дерева категорий у Перекрёстка нет, поиск `/catalog/product/feed`
 * — единственный вход в товары, поэтому «первые 10» означало бы молчаливо
 * показывать четверть того, что нашлось, без единого слова об обрезке.
 */
const PAGE = 100;
/** Лестница длин названия: сеть режет запрос, полное название может не найтись. */
const NAME_CUTS = [40, 25];

const FEED_PATH = '/catalog/product/feed';

const PREFIX = 'perekrestok:';

/** plu из нашего ключа товара: `perekrestok:2059346` → `2059346`. */
function perekrestokPlu(canonicalId: string): string {
  if (!canonicalId.startsWith(PREFIX)) {
    throw new Error(`perekrestok: не наш ключ товара ${canonicalId.slice(0, 40)}`);
  }
  const plu = canonicalId.slice(PREFIX.length);
  if (plu === '') throw new Error('perekrestok: в ключе товара нет кода');
  return plu;
}

/** Код точки: цифры и ничего кроме них, код в адрес не подставляется. */
export function assertPerekrestokSapId(value: string): string {
  if (!/^\d{1,12}$/.test(value)) {
    throw new Error(`perekrestok: код магазина «${value.slice(0, 20)}» не похож на sapId (цифры)`);
  }
  return value;
}

/** Названия для поиска: целиком и укороченные, как у Чижика. */
function perekrestokNameQueries(name: string): string[] {
  // Имя уже обрезано вызывающим (`ctx.name?.trim()` и проверка на пустоту), поэтому
  // своей проверки тут нет: она была бы недостижимой и читалась бы как
  // «пустое имя — особый случай», хотя вызывающий его уже отсекает.
  const out = [name];
  for (const cut of NAME_CUTS) {
    const short = name.slice(0, cut).trim();
    if (short !== '' && !out.includes(short)) out.push(short);
  }
  return out;
}

/**
 * Строгий ли поиск. Сеть сама пишет `searchType`: если она искала не строго,
 * выдача размыта и в неё попали чужие популярные товары, а write-on-change их
 * потом не отыграет. Это обычная ошибка ( breaker должен остановить сеть), а не
 * `ProductLookupError`.
 */
function assertStrictSearch(data: unknown, where: string): void {
  // Массив — тоже `typeof 'object'`, поэтому проверяем явно: без этого
  // `[]`-ответ прошёл бы дальше как «пустая выдача», а это дрейф формата.
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`perekrestok: ответ ${where} — не объект (смена ответа сети?)`);
  }
  const feed = data as { content?: { items?: unknown[] } };
  const nonEmpty = Array.isArray(feed.content?.items) && feed.content.items.length > 0;
  if (isStrictPerekrestokSearch(data)) return;
  if (nonEmpty) {
    throw new Error(
      `perekrestok: сеть искала ${where} не строго (searchType=${JSON.stringify((data as { content?: { searchType?: unknown } }).content?.searchType)}), ` +
        'а товары вернула — доверять такой выдаче цену нельзя',
    );
  }
}

/**
 * Ответ относится к нашей точке. `sapId` в ответе — единственное, что можно
 * сверить: код из нашего справочника подставляется в заголовок/тело запроса, но
 * если сеть отдаст другую точку, её цены уедут в нашу историю молча.
 *
 * Отсутствие `sapId` — тоже отказ, а не «нечем проверять, ну и ладно»: сеть
 * отдаёт его в каждом ответе (снимали живьём 2026-10-10), а молча пропустить
 * проверку значило бы записать в историю цены неизвестно чьей точки.
 */
function assertOwnStore(data: unknown, sapId: string, where: string): void {
  const answer = perekrestokSapId(data);
  if (answer === null) {
    throw new Error(`perekrestok: в ответе ${where} нет sapId — сеть сменила ответ, цены неизвестно чьи`);
  }
  if (answer === sapId) return;
  // Расхождение кода точки — наша неверная настройка, а не отказ сети: обычная
  // ошибка дала бы strike и паузу ВСЕЙ сети, а сеть-то жива.
  throw new StaleStoreError(
    `perekrestok: ${where} вернул цены точки ${answer}, а опрашивается ${sapId} — это чужой магазин`,
    `perekrestok:${sapId}`,
  );
}

export class PerekrestokAdapter implements StoreAdapter {
  readonly storeId = 'perekrestok';

  async search(query: string, ctx: { city: string; externalStoreId: string }): Promise<ScrapedProduct[]> {
    const sapId = assertPerekrestokSapId(ctx.externalStoreId);
    const text = query.trim();
    if (text === '') return [];
    // Тело запроса — ровно то, которым снимались живые фикстуры
    // (`scripts/fetch-perekrestok-fixture.ts`, 2026-10-10): `page`, `perPage` и
    // `filter.textQuery`. Никаких `disableBubbleUp`/`sortByAlpha`: они относятся к
    // другому адресу (`/catalog/search/form`) и для `/catalog/product/feed` не
    // подтверждены — выдумывать детали API здесь нельзя, лишний параметр может
    // тихо поменять режим выдачи.
    const data = await postWithRebuild<unknown>(sapId, FEED_PATH, {
      page: 1,
      perPage: PAGE,
      filter: { textQuery: text },
    });
    assertStrictSearch(data, 'пользовательский запрос');
    assertOwnStore(data, sapId, 'пользовательский запрос');
    return normalizePerekrestokFeed(data, ctx);
  }

  async fetchProduct(
    canonicalId: string,
    ctx: { city: string; externalStoreId: string; name?: string },
  ): Promise<ScrapedProduct> {
    const sapId = assertPerekrestokSapId(ctx.externalStoreId);
    const plu = perekrestokPlu(canonicalId);
    const name = ctx.name?.trim();
    if (!name) {
      throw new ProductLookupError(
        'у товара нет названия в базе — найди его поиском, чтобы опрос его видел',
        canonicalId,
      );
    }
    const attempts: string[] = [];
    let sawAnyItems = false;
    for (const query of perekrestokNameQueries(name)) {
      const data = await postWithRebuild<unknown>(sapId, FEED_PATH, {
        page: 1,
        perPage: PAGE,
        filter: { textQuery: query },
      });
      assertStrictSearch(data, `товар «${query.slice(0, 24)}»`);
      assertOwnStore(data, sapId, `товар «${query.slice(0, 24)}»`);
      const items = normalizePerekrestokFeed(data, ctx);
      if (items.length > 0) sawAnyItems = true;
      attempts.push(`«${query.slice(0, 32)}…» товаров=${items.length}`);
      const hit = items.find((p) => p.canonicalId === `perekrestok:${plu}`);
      if (hit !== undefined) return hit;
    }
    if (!sawAnyItems) {
      // Пустая выдача на всех попытках — это сеть или дрейф, а не переименование:
      // выдав это за переименование, мы отключили бы breaker и замолчали историю.
      throw new Error(
        `perekrestok: поиск вернул пустую выдачу на все попытки (${attempts.join('; ')}) — сеть или дрейф ответа`,
      );
    }
    throw new ProductLookupError(
      `товар не найден поиском по названию (${attempts.join('; ')}) — возможно, переименован или снят`,
      `perekrestok-${plu}`,
    );
  }
}

export { closePerekrestokBrowser };