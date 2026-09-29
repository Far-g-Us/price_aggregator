import { app, BrowserWindow, ipcMain, Menu, Notification, shell } from 'electron';
import electronUpdaterPkg from 'electron-updater';
import log from 'electron-log';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PricesQuery, StoreCatalog, StorePrices } from '../src/shared/api.js';
import type { OurCategoryInfo } from '../src/shared/api.js';
import type { StoreAdapter, StoreCategory, ScrapedProduct } from '../src/shared/types.js';
import { CITY_STORES } from '../src/shared/catalog.js';
import { OUR_CATEGORIES, classifyOurCategories, matchesOurCategory, ourCategoryById } from '../src/shared/taxonomy.js';
import { MagnitAdapter } from '../src/main/adapters/magnit.js';
import { PyaterochkaAdapter } from '../src/main/adapters/pyaterochka.js';
import { close5kaBrowser } from '../src/main/adapters/5ka-browser.js';
import type { Database } from 'sql.js';
import {
  getPriceHistory,
  listCategoryProducts,
  listUnassignedProducts,
  openDb,
  persistDb,
  savePriceIfChanged,
  saveProductCategory,
  toPriceInput,
  type CachedCategoryRow,
} from '../src/main/db/db.js';
import { pollOnce, type PollCounts } from '../src/main/scheduler.js';

const { autoUpdater } = electronUpdaterPkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let win: BrowserWindow | null = null;

async function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    ...(isDev ? { icon: path.join(__dirname, '../../build/icon.png') } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    await win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
}

ipcMain.handle('ping', () => 'pong');

ipcMain.handle('app:version', () => app.getVersion());

const EXTERNAL_ALLOW = ['https://magnit.ru/', 'https://5ka.ru/', 'https://lenta.com/'];

ipcMain.handle('external:open', async (_e, url: unknown) => {
  try {
    if (typeof url !== 'string' || !EXTERNAL_ALLOW.some((p) => url.startsWith(p))) {
      log.warn('external blocked', String(url).slice(0, 80));
      return false;
    }
    await shell.openExternal(url);
    return true;
  } catch (err) {
    log.error('external open failed', err);
    return false;
  }
});

log.transports.file.level = 'info';
autoUpdater.logger = log;
autoUpdater.autoDownload = false;

function notifyUpdate(text: string) {
  if (Notification.isSupported()) new Notification({ title: 'PriceAggregator', body: text }).show();
}

autoUpdater.on('update-available', (info) => {
  notifyUpdate(`Доступна версия ${info.version}, скачиваю…`);
  win?.webContents.send('updates:available', info.version);
  void autoUpdater.downloadUpdate();
});

autoUpdater.on('update-downloaded', (info) => {
  notifyUpdate(`Версия ${info.version} скачана, можно установить`);
  win?.webContents.send('updates:downloaded', info.version);
});

autoUpdater.on('error', (err) => {
  const msg = String(err?.message ?? err);
  log.error('updater error', err);
  if (/404/.test(msg)) return;
  win?.webContents.send('updates:error', msg);
});

ipcMain.handle('updates:check', async () => {
  if (!app.isPackaged) return { packaged: false, current: app.getVersion(), latest: null };
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo.version ?? null;
    const available = latest !== null && latest !== app.getVersion();
    return { packaged: true, current: app.getVersion(), latest, available };
  } catch (err) {
    const msg = String(err);
    log.error('check failed', err);
    if (/404/.test(msg)) return { packaged: true, current: app.getVersion(), latest: null, noReleases: true };
    return { packaged: true, current: app.getVersion(), latest: null, error: msg };
  }
});

ipcMain.handle('updates:install', () => {
  autoUpdater.quitAndInstall(false, true);
});

async function storeItems(
  database: Database | null,
  storeId: string,
  items: ScrapedProduct[],
): Promise<void> {
  if (!database) return;
  try {
    for (const item of items) {
      try {
        savePriceIfChanged(database, toPriceInput(item));
      } catch (err) {
        log.error('db item skipped', item.canonicalId, err);
      }
    }
  } catch (err) {
    log.error('db write failed', storeId, err);
  }
}

// Раскладывает полученные товары по НАШИМ категориям (many-to-many) —
// независимо от того, откуда они пришли: поиск, витринная категория или
// наша. Так «Не разложено» показывает ровно то, что мимо всех полок.
function classifyAndSave(
  database: Database | null,
  storeId: string,
  city: string,
  items: ScrapedProduct[],
): void {
  if (!database) return;
  const rows = items.flatMap((i) =>
    classifyOurCategories(i.name).map((categoryId) => ({
      canonicalId: i.canonicalId,
      storeId,
      city,
      categoryId,
    })),
  );
  if (rows.length === 0) return;
  try {
    saveProductCategory(database, rows);
  } catch (err) {
    log.error('auto classify failed', storeId, String(err).slice(0, 120));
  }
}

const adapters = new Map<string, StoreAdapter>([
  ['magnit', new MagnitAdapter()],
  ['pyaterochka', new PyaterochkaAdapter()],
]);

ipcMain.handle('prices:get', async (_e, args?: PricesQuery): Promise<StorePrices[]> => {
  const city = args?.city ?? 'moscow';
  const query = args?.query?.trim() ?? '';
  if (!query) return [];
  const stores = CITY_STORES[city] ?? [];
  const out: StorePrices[] = [];
  let database: Database | null = null;
  try {
    database = await openDb(path.join(app.getPath('userData'), 'prices.db'));
  } catch (err) {
    log.error('db open failed', err);
  }
  for (const s of stores) {
    if (!s.ready) {
      out.push({ storeId: s.storeId, name: s.name, ready: false, items: [] });
      continue;
    }
    const adapter = adapters.get(s.storeId);
    if (!adapter) {
      out.push({ storeId: s.storeId, name: s.name, ready: false, items: [], error: 'нет адаптера' });
      continue;
    }
    try {
      const items = await adapter.search(query, { city, externalStoreId: s.externalStoreId });
      await storeItems(database, s.storeId, items);
      classifyAndSave(database, s.storeId, city, items);
      out.push({ storeId: s.storeId, name: s.name, ready: true, items });
    } catch (err) {
      log.error('search failed', s.storeId, err);
      out.push({ storeId: s.storeId, name: s.name, ready: true, items: [], error: String(err) });
    }
  }
  try {
    persistDb();
  } catch (err) {
    log.error('persist failed', err);
  }
  return out;
});

const CATALOG_TTL_MS = 7 * 24 * 3600 * 1000;

function catalogCachePath(city: string, storeId: string, externalStoreId: string): string {
  const safe = externalStoreId.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(app.getPath('userData'), `catalog-${city}-${storeId}-${safe}.json`);
}

function readCatalogCache(
  city: string,
  storeId: string,
  externalStoreId: string,
  ignoreTtl = false,
): StoreCategory[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(catalogCachePath(city, storeId, externalStoreId), 'utf-8')) as {
      at: number;
      categories: unknown;
    };
    if (!ignoreTtl && Date.now() - raw.at > CATALOG_TTL_MS) return null;
    if (!Array.isArray(raw.categories)) return null;
    const clean = raw.categories.filter(
      (c): c is StoreCategory =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as StoreCategory).id === 'string' &&
        typeof (c as StoreCategory).name === 'string' &&
        typeof (c as StoreCategory).url === 'string',
    );
    return clean;
  } catch {
    return null;
  }
}

function writeCatalogCache(
  city: string,
  storeId: string,
  externalStoreId: string,
  categories: StoreCategory[],
): void {
  try {
    fs.writeFileSync(
      catalogCachePath(city, storeId, externalStoreId),
      JSON.stringify({ at: Date.now(), categories }),
    );
  } catch (err) {
    log.error('catalog cache write failed', err);
  }
}

ipcMain.handle('catalog:get', async (_e, args?: { city?: string }) => {
  const city = args?.city ?? 'moscow';
  const stores = CITY_STORES[city] ?? [];
  const out: StoreCatalog[] = [];
  for (const s of stores) {
    const adapter = adapters.get(s.storeId);
    if (!s.ready || !adapter || typeof adapter.fetchCategories !== 'function') {
      out.push({ storeId: s.storeId, name: s.name, categories: [] });
      continue;
    }
    try {
      const cached = readCatalogCache(city, s.storeId, s.externalStoreId);
      if (cached) {
        out.push({ storeId: s.storeId, name: s.name, categories: cached });
        continue;
      }
      const categories = await adapter.fetchCategories({ city, externalStoreId: s.externalStoreId });
      writeCatalogCache(city, s.storeId, s.externalStoreId, categories);
      out.push({ storeId: s.storeId, name: s.name, categories });
    } catch (err) {
      log.error('catalog failed', s.storeId, err);
      const stale = readCatalogCache(city, s.storeId, s.externalStoreId, true);
      if (stale) {
        out.push({ storeId: s.storeId, name: s.name, categories: stale });
      } else {
        out.push({ storeId: s.storeId, name: s.name, categories: [], error: String(err) });
      }
    }
  }
  return out;
});

ipcMain.handle('category:get', async (_e, args?: { city?: string; url?: string }): Promise<StorePrices[]> => {
  const city = args?.city ?? 'moscow';
  if (!args?.url) return [];
  const stores = CITY_STORES[city] ?? [];
  const out: StorePrices[] = [];
  let database: Database | null = null;
  try {
    database = await openDb(path.join(app.getPath('userData'), 'prices.db'));
  } catch (err) {
    log.error('db open failed', err);
  }
  for (const s of stores) {
    const adapter = adapters.get(s.storeId);
    if (!s.ready || !adapter || typeof adapter.fetchCategoryProducts !== 'function') {
      out.push({ storeId: s.storeId, name: s.name, ready: false, items: [] });
      continue;
    }
    try {
      const items = await adapter.fetchCategoryProducts(args.url, { city, externalStoreId: s.externalStoreId });
      await storeItems(database, s.storeId, items);
      classifyAndSave(database, s.storeId, city, items);
      out.push({ storeId: s.storeId, name: s.name, ready: true, items });
    } catch (err) {
      log.error('category failed', s.storeId, err);
      out.push({ storeId: s.storeId, name: s.name, ready: true, items: [], error: String(err) });
    }
  }
  try {
    persistDb();
  } catch (err) {
    log.error('persist failed', err);
  }
  return out;
});

const OUR_QUERY_PAUSE_MS = 2000;
const OUR_MAX_PER_QUERY = 12;
const OUR_MAX_PER_CATEGORY = 150;
const UNASSIGNED_ID = '__unassigned__';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

ipcMain.handle('ourcategories:get', async (_e, args?: { city?: string }) => {
  const city = args?.city ?? 'moscow';
  const stores = CITY_STORES[city] ?? [];
  const readyStores = stores.filter((s) => s.ready && adapters.has(s.storeId)).length;
  const out: OurCategoryInfo[] = OUR_CATEGORIES.map((c) => ({
    id: c.id,
    name: c.name,
    parentId: c.parentId,
    queryCount: c.queries.length,
    storeCount: readyStores,
  }));
  out.push({
    id: UNASSIGNED_ID,
    name: 'Не разложено',
    parentId: null,
    queryCount: 0,
    storeCount: readyStores,
    virtual: true,
  });
  return out;
});

// Кэш из БД в тот же формат, что отдаёт живой сбор.
function cachedToStorePrices(
  rows: CachedCategoryRow[],
  city: string,
): StorePrices[] {
  const byStore = new Map<StorePrices['storeId'], ScrapedProduct[]>();
  for (const r of rows) {
    const product: ScrapedProduct = {
      canonicalId: r.canonicalId,
      storeId: r.storeId,
      city,
      name: r.name,
      price: r.price,
      promoPrice: r.promoPrice,
      oldPrice: r.oldPrice,
      inStock: r.inStock,
      collectedAt: r.collectedAt,
    };
    if (r.imageUrl) product.imageUrl = r.imageUrl;
    if (r.unit) product.unit = r.unit;
    if (r.brand) product.brand = r.brand;
    if (r.url) product.url = r.url;
    const list = byStore.get(r.storeId) ?? [];
    list.push(product);
    byStore.set(r.storeId, list);
  }
  return [...byStore.entries()].map(([storeId, items]) => ({
    storeId,
    name: CITY_STORES[city]?.find((s) => s.storeId === storeId)?.name ?? storeId,
    ready: true,
    items,
  }));
}

ipcMain.handle('ourcategory:get', async (_e, args?: { city?: string; id?: string }) => {
  const city = args?.city ?? 'moscow';
  const categoryId = args?.id ?? '';
  const category = categoryId === UNASSIGNED_ID ? undefined : ourCategoryById(categoryId);
  if (!category && categoryId !== UNASSIGNED_ID) throw new Error('ourcategory:get: неизвестная категория');
  const stores = CITY_STORES[city] ?? [];
  const out: StorePrices[] = [];
  let database: Database | null = null;
  try {
    database = await openDb(path.join(app.getPath('userData'), 'prices.db'));
  } catch (err) {
    log.error('db open failed', err);
  }
  for (const s of stores) {
    const adapter = adapters.get(s.storeId);
    if (!s.ready || !adapter) {
      out.push({ storeId: s.storeId, name: s.name, ready: false, items: [] });
      continue;
    }
    const byId = new Map<string, ScrapedProduct>();
    const errors: string[] = [];
    if (category) {
      for (const query of category.queries) {
        // Пауза между запросами: сеть враждебная, а запросов на категорию
        // до восьми на магазин (иначе один клик = шторм).
        if (byId.size > 0) await sleep(OUR_QUERY_PAUSE_MS);
        try {
          const found = await adapter.search(query, { city, externalStoreId: s.externalStoreId });
          for (const item of found.slice(0, OUR_MAX_PER_QUERY)) {
            // Слова из названия решают, попадает ли товар в нашу полку:
            // без этого в «Молоко» попадали коктейли молочные.
            if (!matchesOurCategory(category, item.name)) continue;
            const prev = byId.get(item.canonicalId);
            if (!prev || item.collectedAt > prev.collectedAt) byId.set(item.canonicalId, item);
          }
        } catch (err) {
          log.error('ourcategory query failed', s.storeId, query, String(err).slice(0, 160));
          errors.push(`${query}: ${String(err).slice(0, 100)}`);
        }
      }
    } else {
      // «Не разложено» в сеть не ходим — это про уже увиденные товары.
      if (database) {
        const rows = listUnassignedProducts(database, { city }).filter((r) => r.storeId === s.storeId);
        const cached = cachedToStorePrices(rows, city);
        out.push(cached[0] ?? { storeId: s.storeId, name: s.name, ready: true, items: [] });
        continue;
      }
    }
    const items = [...byId.values()].slice(0, OUR_MAX_PER_CATEGORY);
    await storeItems(database, s.storeId, items);
    if (database && category) {
      try {
        saveProductCategory(
          database,
          items.map((i) => ({
            canonicalId: i.canonicalId,
            storeId: s.storeId,
            city,
            categoryId: category.id,
          })),
        );
      } catch (err) {
        log.error('product category write failed', category.id, err);
      }
    }
    // Плюс автораскладка по названию: товар должен лежать на всех
    // подходящих полках, а не только в той, откуда пришёл.
    classifyAndSave(database, s.storeId, city, items);
    const entry: StorePrices = {
      storeId: s.storeId,
      name: s.name,
      ready: true,
      items,
    };
    // Сеть не ответила — отдаём кэш, но честно говорим, что он из кэша.
    if (errors.length > 0 || items.length === 0) {
      const cached = database
        ? cachedToStorePrices(
            category
              ? listCategoryProducts(database, { city, categoryId: category.id }).filter(
                  (r) => r.storeId === s.storeId,
                )
              : [],
            city,
          )
        : [];
      const cachedItems = cached[0]?.items ?? [];
      if (cachedItems.length > 0) {
        entry.items = cachedItems;
        entry.cached = true;
        entry.error = `сеть не ответила, показаны цены из кэша (${new Date().toISOString().slice(0, 10)})`;
      } else if (errors.length > 0) {
        entry.error =
          items.length === 0
            ? `ни один запрос не сработал (${errors.length}): ${errors[0]}`
            : `часть запросов не удалась (${errors.length} из ${category?.queries.length ?? 0}): ${errors[0]}`;
      }
    }
    out.push(entry);
  }
  try {
    persistDb();
  } catch (err) {
    log.error('persist failed', err);
  }
  return out;
});

ipcMain.handle('history:get', async (_e, args?: { canonicalId: string; storeId: string; city: string }) => {
  try {
    if (!args?.canonicalId || !args?.storeId || !args?.city) return [];
    const database = await openDb(path.join(app.getPath('userData'), 'prices.db'));
    return getPriceHistory(database, args);
  } catch (err) {
    log.error('history failed', err);
    return [];
  }
});

const schedState = {
  running: false,
  lastRun: null as string | null,
  counts: { inserted: 0, skipped: 0, failed: 0, notReady: 0 },
  intervalHours: 6,
};

function pollSummary(): string {
  const c = schedState.counts;
  const total = c.inserted + c.skipped + c.failed + c.notReady;
  if (total === 0) {
    return 'Опрос завершён: отслеживаемых товаров пока нет — найди что-нибудь поиском или категорией.';
  }
  return `Опрос завершён: проверено ${c.inserted + c.skipped}, новых цен ${c.inserted}, ошибок ${c.failed}.`;
}

async function runScheduled(): Promise<void> {
  if (schedState.running) return;
  schedState.running = true;
  try {
    const database = await openDb(path.join(app.getPath('userData'), 'prices.db'));
    schedState.counts = await pollOnce(database, adapters, 2000, (done, total) => {
      win?.webContents.send('scheduler:progress', { done, total });
    });
    schedState.lastRun = new Date().toISOString();
    notifyUpdate(pollSummary());
  } catch (err) {
    log.error('scheduled poll failed', err);
  } finally {
    schedState.running = false;
    win?.webContents.send('scheduler:done', {
      status: { ...schedState },
      summary: pollSummary(),
    });
  }
}

ipcMain.handle('scheduler:status', () => ({ ...schedState }));
ipcMain.handle('scheduler:run', async () => {
  if (schedState.running) {
    return { status: { ...schedState }, summary: 'Опрос уже идёт — дождись завершения.' };
  }
  await runScheduled();
  return { status: { ...schedState }, summary: pollSummary() };
});

app.whenReady().then(async () => {
  await createWindow();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Вид',
        submenu: [
          { role: 'toggleDevTools', label: 'Консоль разработчика', accelerator: 'F12' },
          { type: 'separator' },
          { role: 'reload', label: 'Перезагрузить' },
        ],
      },
    ]),
  );
  if (app.isPackaged) {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      log.error('initial check failed', err);
    }
  }
  setInterval(
    () => void runScheduled(),
    schedState.intervalHours * 3600 * 1000,
  );
  setTimeout(() => void runScheduled(), 30000);
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  persistDb();
  void close5kaBrowser();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
