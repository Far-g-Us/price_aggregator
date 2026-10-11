// Живая проверка ВСЕХ сетей и городов каталога: поиск и получение карточки.
//
//   npx tsx scripts/live-check.ts            # все сети и все города
//   npx tsx scripts/live-check.ts magnit     # только одна сеть
//   npx tsx scripts/live-check.ts svetofor moscow
//
// Ходит в настоящие сети, поэтому нужен только для ручной проверки: тесты из
// `npm test` сети не трогают (в них подменён `globalThis.fetch`). Результат —
// честный ответ на вопрос «работает ли живой поиск и выдача товара», потому что
// мёртвый адаптер на фикстурах выглядит ровно так же.
//
// Что проверяем по каждой паре «сеть + город»:
//  1. `search` — сколько товаров и с какими ценами;
//  2. `fetchProduct` по первому найденному — приходит ли та же цена;
//  3. `fetchCategories` — есть ли витрина (у части сетей её нет by design).
//
// Паузы между запросами нет: сети здесь раз вручную, а не по расписанию.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CITY_STORES } from '../src/shared/catalog.js';
import { MagnitAdapter } from '../src/core/adapters/magnit.js';
import { PyaterochkaAdapter } from '../src/core/adapters/pyaterochka.js';
import { LentaAdapter } from '../src/core/adapters/lenta.js';
import { SvetoforAdapter, clearSvetoforCache } from '../src/core/adapters/svetofor.js';
import { svetoforDomain } from '../src/shared/svetofor-regions.js';
import type { StoreAdapter } from '../src/shared/types.js';

// Браузеры Playwright лежат в проекте (`.playwright-browsers`), а playwright-core
// по умолчанию смотрит в системный профиль. Приложение задаёт путь само
// (`electron/main.ts`), а скрипту это надо сделать здесь — иначе Пятёрка падает
// с «Executable doesn't exist» и выглядит как упавшая сеть.
//
// Путь берём такой же, как в `probe-lenta-browser.mjs`: папка в корне проекта.
// Звать `resolveBrowsersPath` из `electron/node-platform.ts` нельзя — тот файл
// импортирует `electron`, а скрипт запускается обычным Node.
const localBrowsers = resolve(process.cwd(), '.playwright-browsers');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(localBrowsers)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsers;
}
if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
  console.log(`  браузеры Playwright: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
} else {
  console.log('  браузеры Playwright не найдены: Пятёрка не проверяется');
  console.log('  поставь: PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers npx playwright install firefox');
}

type NetId = 'magnit' | 'pyaterochka' | 'lenta' | 'svetofor';

const ADAPTERS = new Map<NetId, StoreAdapter>([
  ['magnit', new MagnitAdapter()],
  ['pyaterochka', new PyaterochkaAdapter()],
  ['lenta', new LentaAdapter()],
  ['svetofor', new SvetoforAdapter({ domain: (shopId) => svetoforDomain(shopId) })],
]);

const wantedNet = process.argv[2] as NetId | undefined;
const wantedCity = process.argv[3];

const sleep = (ms: number): Promise<void> => new Promise((r) => void setTimeout(r, ms));
const QUERY = 'молоко';

/**
 * Потолок на одну операцию. Пятёрка поднимает браузер и проходит warmup, а
 * без этого скрипт висит на ней минутами и непонятно, отвечает сеть или нет.
 * Превышение — это тоже результат («не ответила за N с»), а не молчание.
 */
const OP_TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS ?? 120_000);
async function withTimeout<T>(what: string, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`не ответила за ${Math.round(OP_TIMEOUT_MS / 1000)} с`)),
          OP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void what;
  }
}

const rows: Array<{
  net: string;
  city: string;
  shop: string;
  ready: boolean;
  search: string;
  card: string;
  categories: string;
}> = [];

for (const [city, stores] of Object.entries(CITY_STORES)) {
  if (wantedCity && city !== wantedCity) continue;
  for (const store of stores) {
    if (wantedNet && store.storeId !== wantedNet) continue;
    const adapter = ADAPTERS.get(store.storeId as NetId);
    if (!adapter) continue;
    const ctx = { city, externalStoreId: store.externalStoreId };
    const label = `${store.storeId}/${city}/${store.externalStoreId}${store.ready ? '' : ' (ready:false)'}`;

    let search: string;
    let firstCanonical = '';
    let firstName = '';
    try {
      const found = await withTimeout('search', () => adapter.search(QUERY, ctx));
      const withPrice = found.filter((p) => p.price > 0).length;
      search = found.length === 0 ? '0 товаров' : `${found.length} товаров, с ценой ${withPrice}`;
      const sample = found[0];
      if (sample) {
        firstCanonical = sample.canonicalId;
        firstName = sample.name;
        search += `, первый «${sample.name.slice(0, 38)}» ${sample.price} ₽`;
      }
    } catch (err) {
      search = `ОТКАЗ: ${String((err as Error).message).slice(0, 70)}`;
    }

    let card = '—';
    if (firstCanonical !== '') {
      try {
        const product = await withTimeout('fetchProduct', () =>
          adapter.fetchProduct(firstCanonical, {
            city,
            externalStoreId: store.externalStoreId,
            name: firstName,
          }),
        );
        card = `${product.price} ₽ ${product.price > 0 ? 'ок' : 'БЕЗ ЦЕНЫ'}`;
      } catch (err) {
        const e = err as Error;
        card = `${e.name === 'ProductLookupError' ? 'НЕ НАЙДЕН' : 'ОТКАЗ'}: ${e.message.slice(0, 60)}`;
      }
    } else {
      card = 'нечего проверять';
    }

    let categories = 'нет метода';
    if (adapter.fetchCategories) {
      try {
        const cats = await withTimeout('fetchCategories', async () => {
        // Метод обязательно зовём через `adapter`: оторванный от объекта он теряет
        // `this` и падает на `this.headers(...)`.
        const fetchCategories = adapter.fetchCategories?.bind(adapter);
        return fetchCategories === undefined ? [] : fetchCategories(ctx);
      });
        categories = `${cats.length} категорий, пример «${(cats[0]?.name ?? '—').slice(0, 34)}»`;
      } catch (err) {
        categories = `ОТКАЗ: ${String((err as Error).message).slice(0, 60)}`;
      }
    }

    rows.push({ net: store.storeId, city, shop: store.externalStoreId, ready: store.ready, search, card, categories });
    console.log(`  ${label}`);
    console.log(`     поиск:      ${search}`);
    console.log(`     карточка:   ${card}`);
    console.log(`     категории:  ${categories}`);
    await sleep(400);
  }
}

clearSvetoforCache();

const broken = rows.filter((r) => r.search.startsWith('ОТКАЗ') || r.card.includes('ОТКАЗ') || r.card.includes('НЕ НАЙДЕН'));
console.log(`\n=== итог: ${rows.length} пар сеть+город, проблемных ${broken.length} ===`);
for (const row of broken) {
  console.log(`  ${row.net}/${row.city}/${row.shop}: поиск «${row.search}», карточка «${row.card}»`);
}
const dead = broken.filter((r) => r.search.startsWith('ОТКАЗ'));
console.log(dead.length > 0 ? `  СЕТЬ ЛЕЖИТ: ${[...new Set(dead.map((r) => r.net))].join(', ')}` : '  сетевых отказов нет');