/**
 * Мост Android: то же ядро, что на Electron, но с веб-портами.
 *
 * Почему не «написать мост на Kotlin»: ядро — TypeScript, покрытое тестами на
 * 100 %, и цена считается в одном месте. Второе ядро означало бы две схемы
 * миграций и два места, где завтра будет баг; порты (`src/core/platform.ts`)
 * для второй оболочки и проектировались именно как замена Node-API.
 *
 * Чего мост НЕ умеет (честно, а не молча):
 * - Чижик — ему нужен Playwright, а в WebView его нет; транспорт для него на
 *   Android в работе (Фаза 7г), адаптер не регистрируется, и ядро отвечает
 *   честно («нет адаптера»).
 * - Пятёрка и Перекрёсток возможны только через нативный мост «читалки
 *   страниц» (PageReaderPlugin): нативный HTTP X5 режет WAF'ом, открытая
 *   страница (для Перекрёстка — ещё и POST из-под неё) — единственный путь.
 *   Плагина нет (старая сборка) — эти сети не регистрируются.
 * - Системных уведомлений нет: `notify()` поднимает липкий баннер.
 * - Фонового опроса при закрытом приложении нет: таймеры живут в WebView.
 * - Обновлений нет: на Android их ставит магазин.
 */

import { registerPlugin } from '@capacitor/core';
import { createCore } from '../../core/services.js';
import { consoleLogger } from '../../core/platform.js';
import { MagnitAdapter } from '../../core/adapters/magnit.js';
import { LentaAdapter } from '../../core/adapters/lenta.js';
import { SvetoforAdapter } from '../../core/adapters/svetofor.js';
import { PyaterochkaPageAdapter } from '../../core/adapters/5ka-page.js';
import { PerekrestokPageAdapter } from '../../core/adapters/perekrestok-page.js';
import { setPageReaderLoader } from '../../core/adapters/page-reader-port.js';
import { pointKeysForCity, type PointKey } from '../../shared/catalog.js';
import { svetoforDomain } from '../../shared/svetofor-regions.js';
import { isExternalAllowed } from '../../shared/external-links.js';
import type { StoreAdapter } from '../../shared/types.js';
import type { RendererApi, SchedulerDone } from '../../shared/api.js';
import {
  createWebBackground,
  createWebJson,
  createWebShell,
  loadWebStorage,
  openIdb,
} from './platform-web.js';

/**
 * Сети без браузера, которым и WebView хватает нативного HTTP (порт
 * `src/core/http.ts`). Пятёрка сюда не попадает: она подключается ниже, только
 * если жив её нативный мост «читалки страниц».
 */
const baseAdapters = (): Map<string, StoreAdapter> =>
  new Map<string, StoreAdapter>([
    ['magnit', new MagnitAdapter()],
    ['lenta', new LentaAdapter()],
    ['svetofor', new SvetoforAdapter({ domain: (shopId) => svetoforDomain(shopId) })],
  ]);

/**
 * Нативная сторона «читалки страниц» (PageReaderPlugin). Методы диагностики
 * плагина (probe оставлен, readCookies — только отладочная сборка) из
 * прод-интерфейса убраны: ядро не читает куки, ему нужен только текст.
 * Проба проверяет ЖИВОСТЬ МОСТА, а не пропуск WAF: решает это первый
 * реальный опрос — на отказ будет громкая ошибка и пауза через существующий
 * breaker, поэтому обещать сеть заранее мы права не имеем. Мост не отвечает
 * (старая сборка APK без плагина) — эти сети просто не регистрируются, как и
 * сегодня.
 */
interface PageReaderBridge {
  probe(): Promise<{ version: string }>;
  readPage(opts: { url: string }): Promise<{ text: string }>;
  readNextData(opts: { url: string; plu: string }): Promise<{ envelope: string }>;
  warmup(opts: { url: string }): Promise<void>;
  post?(opts: {
    pageUrl: string;
    apiUrl: string;
    bodyJson?: string;
    httpMethod?: string;
  }): Promise<{ status: number; body: string; href?: string }>;
}

const probePageReader = async (): Promise<boolean> => {
  const bridge = registerPlugin<PageReaderBridge>('PageReader');
  try {
    await bridge.probe();
  } catch {
    return false;
  }
  setPageReaderLoader(async () => ({
    probe: () => bridge.probe().then((r) => r.version),
    readPage: (opts) => bridge.readPage(opts).then((r) => r.text),
    readNextData: (opts) => bridge.readNextData(opts).then((r) => r.envelope),
    warmup: (opts) => bridge.warmup(opts),
    ...(bridge.post
      ? {
          post: (opts: {
            pageUrl: string;
            apiUrl: string;
            bodyJson?: string;
            httpMethod?: string;
          }) => bridge.post!(opts),
        }
      : {}),
  }));
  return true;
};

export const installAndroidApi = async (wasmUrl: string, version: string): Promise<void> => {
  const idb = await openIdb();
  const storage = await loadWebStorage(idb, wasmUrl);  const progressListeners = new Set<
    (done: number, total: number, storeId?: string, storeCode?: string) => void
  >();
  const doneListeners = new Set<(done: SchedulerDone) => void>();
  // Город и его точки — для сверки выбора магазинов (см. setCurrentStores).
  let currentCity = 'moscow';
  let knownPoints = new Set<PointKey>(pointKeysForCity(currentCity));
  const shell = createWebShell(version, (url) => {
    // Политика ссылок — та же, что на Electron, и из того же модуля: список
    // один на обе оболочки, иначе правка разъехалась бы (см. shared/external-links).
    if (url && isExternalAllowed(url)) window.open(url, '_blank', 'noopener');
  });

  // Пишущий вызов всегда завершается сбросом буфера на диск. Иначе последняя
  // пачка цен (до 1.5 с дебаунса) жила бы только в памяти: pagehide в
  // single-activity WebView не приходит, а процесс может быть убит без
  // visibilitychange — то есть цена была бы потеряна молча.
  const saved = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const result = await fn();
    await storage.flush();
    return result;
  };

  // Пятёрка и Перекрёсток регистрируются только при живом нативном мосте:
  // без него остаётся ровно сегодняшнее поведение (3 сети, честное «нет
  // адаптера»). Перекрёсток ходит тем же портом через post-метод донора.
  const adaptersMap = baseAdapters();
  if (await probePageReader()) {
    adaptersMap.set('pyaterochka', new PyaterochkaPageAdapter());
    adaptersMap.set('perekrestok', new PerekrestokPageAdapter());
  }

  const core = createCore({
    storage,
    json: createWebJson(),
    shell,
    background: createWebBackground(),
    log: consoleLogger,
    adapters: adaptersMap,
    emit: (channel, payload) => {
      if (channel === 'scheduler:progress') {
        const o = payload as { done: number; total: number; storeId?: string; storeCode?: string };
        for (const cb of progressListeners) cb(o.done, o.total, o.storeId, o.storeCode);
      } else if (channel === 'scheduler:done') {
        for (const cb of doneListeners) cb(payload as SchedulerDone);
      }
    },
    closeBrowsers: async () => {},
  });
  core.startScheduler();

  const api: RendererApi = {
    ping: async () => 'android',
    getVersion: async () => version,
    getPrices: async (args) => saved(() => core.searchPrices(args)),
    openExternal: async (url) => {
      // Возвращаем ФАКТ открытия, как на Electron: интерфейс по нему решает,
      // показывать ли ссылку вообще. Молчаливый `true` обещал бы ссылку, которая
      // на Android закрыта политикой.
      if (!isExternalAllowed(url)) return false;
      await shell.openExternal(url);
      return true;
    },
    getCatalog: async (args) => core.getCatalogs(args),
    getSupportedNetworks: async () => core.getSupportedNetworks(),
    downloadUpdate: async () => {
      // Автообновления на Android нет: сборка ставится из apk, а не из ленты.
    },
    installBrowser: async () => ({
      ok: false,
      message:
        'на Android браузер не поднимается: Пятёрка и Перекрёсток читаются страницами, остальным сетям хватает нативного HTTP',
    }),
    browserStatus: async () => ({
      // Браузер на Android не используется: Пятёрочке и Перекрёстку хватает
      // «читалки страниц» (PageReaderPlugin), остальным сетям — нативного HTTP.
      installed: true,
      message: 'браузер на Android заменён чтением страниц',
    }),
    getCategory: async (args) => saved(() => core.getCategoryProducts(args)),
    getOurCategories: async (args) => core.getOurCategories(args),
    getOurCategory: async (args) => saved(() => core.getOurCategory(args)),
    getShelves: async (args) => core.getShelves(args),
    setShelves: async (args) => saved(() => core.setShelves(args)),
    releaseShelves: async (args) => saved(() => core.releaseShelves(args)),
    getFavorites: async (args) => core.getFavorites(args),
    setFavorite: async (args) => saved(() => core.setFavorite(args)),
    removeFavorite: async (args) => saved(() => core.removeFavorite(args)),
    splitProducts: async (args) => core.splitProducts(args),
    removeSplit: async (args) => core.removeSplit(args),
    getSplitPairs: async (args) => core.getSplitPairs(args),
    getHistory: async (args) => core.getHistory(args),
    getSchedulerStatus: async () => core.schedulerStatus(),
    cancelScheduler: async () => {
      core.cancelScheduler();
      return true;
    },
    runScheduler: async (args) => saved(() => core.runScheduler(args)),
    setCurrentCity: async (city) => {
      currentCity = city;
      knownPoints = new Set(pointKeysForCity(city));
      core.setCurrentCity(city);
    },
    setCurrentStores: async (city, keys) => {
      // Метод на стороне renderer принимает город отдельным аргументом, а ядро
      // живёт в текущем городе. На Electron расхождение отвергает main
      // (`knownPoints`), здесь — мост: иначе выбор молча уехал бы в другой город
      // и опросил бы не то, что на экране.
      if (city !== currentCity) throw new Error(`города расходятся: интерфейс ${city}, мост ${currentCity}`);
      if (keys !== null && !keys.every((k) => knownPoints.has(k as PointKey))) {
        throw new Error('в выборе есть точка, которой нет в городе');
      }
      core.setCurrentStores(keys);
    },
    onSchedulerProgress: (cb) => {
      progressListeners.add(cb);
      return () => progressListeners.delete(cb);
    },
    onSchedulerDone: (cb) => {
      doneListeners.add(cb);
      return () => doneListeners.delete(cb);
    },
    checkUpdates: async () => ({ packaged: false, current: version, latest: null }),
    installUpdate: async () => {},
    onUpdateEvent: () => () => undefined,
  };
  window.api = api;
};
