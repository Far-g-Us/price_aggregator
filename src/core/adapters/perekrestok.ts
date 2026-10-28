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
import { ProductLookupError } from '../adapter-errors.js';
import { closePerekrestokBrowser, postWithRebuild } from './perekrestok-browser.js';
import {
  assertOwnStore,
  assertPerekrestokSapId,
  assertStrictSearch,
  FEED_PAGE,
  FEED_PATH,
  normalizePerekrestokFeed,
  perekrestokNameQueries,
  perekrestokPlu,
} from './perekrestok-parse.js';

export {
  assertOwnStore,
  assertPerekrestokSapId,
  assertStrictSearch,
  FEED_PATH,
  perekrestokNameQueries,
  perekrestokPlu,
} from './perekrestok-parse.js';

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
      perPage: FEED_PAGE,
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
        perPage: FEED_PAGE,
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