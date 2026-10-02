// Оболочка Electron: окно, IPC, автообновления, жизненный цикл. Вся бизнес-
// логика живёт в src/core/services.ts, порты платформы — в ./node-platform.ts.
// Ничего, кроме регистрации каналов и обновлений, здесь быть не должно.
import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import electronUpdaterPkg from 'electron-updater';
import log from 'electron-log';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PricesQuery, ShelfScope, SplitPair, StoreCatalog, StorePrices } from '../src/shared/api.js';
import { MagnitAdapter } from '../src/core/adapters/magnit.js';
import { PyaterochkaAdapter } from '../src/core/adapters/pyaterochka.js';
import { LentaAdapter } from '../src/core/adapters/lenta.js';
import { close5kaBrowser } from '../src/core/adapters/5ka-browser.js';
import { createCore, type Core } from '../src/core/services.js';
import type { CoreDeps } from '../src/core/platform.js';
import type { StoreAdapter } from '../src/shared/types.js';
import { CITIES } from '../src/shared/catalog.js';
import {
  dbFile,
  describeFirefoxProblem,
  jsonStore,
  electronLogger,
  electronShell,
  fileStorage,
  isDev,
  nodeBackground,
  resolveBrowsersPath,
  userDataDir,
} from './node-platform.js';

const { autoUpdater } = electronUpdaterPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;

const adapters = new Map<string, StoreAdapter>([
  ['magnit', new MagnitAdapter()],
  ['pyaterochka', new PyaterochkaAdapter()],
  ['lenta', new LentaAdapter()],
]);

// Ядро создаётся лениво, при первом обращении. Порядок «создать окно, потом
// core» уже стоил нам пустых категорий: renderer при монтировании сразу шлёт
// catalog:get и ourcategories:get, и при core=null оба падали, а renderer
// глотал ошибку в пустой список. Ленивая инициализация делает такую ошибку
// невозможной, а не просто менее вероятной.
let core: Core | null = null;
const getCore = (): Core => {
  core ??= createCore(createDeps());
  return core;
};
const maybeCore = (): Core | null => core;
const createDeps = (): CoreDeps => ({
  storage: fileStorage(dbFile()),
  json: jsonStore(userDataDir()),
  shell: electronShell,
  background: nodeBackground,
  log: electronLogger,
  adapters,
  // Окно могло закрыться между событием и отправкой: send в разрушенный
  // webContents бросает, а emit зовётся в том числе из finally опроса, то есть
  // падение уезжало бы в unhandled rejection и терялся бы scheduler:done.
  emit: (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  },
});

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    ...(isDev() ? { icon: path.join(__dirname, '../../build/icon.png') } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev()) {
    await win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Рендерер собирается vite в build-renderer/ (не в dist/: там артефакты
    // упаковщика, и vite build вытирал бы их). Путь обязан совпадать с
    // build.files в package.json.
    await win.loadFile(path.join(__dirname, '../../build-renderer/index.html'));
  }
}

// Политика безопасности ссылок: открывать можно только сайты сетей. Проверка
// остаётся в оболочке, потому что openExternal — привилегия оболочки.
const EXTERNAL_ALLOW = ['https://magnit.ru/', 'https://5ka.ru/', 'https://lenta.com/'];

ipcMain.handle('ping', () => 'pong');

ipcMain.handle('app:version', () => electronShell.version());

ipcMain.handle('external:open', async (_e, url: unknown) => {
  try {
    if (typeof url !== 'string' || !EXTERNAL_ALLOW.some((p) => url.startsWith(p))) {
      log.warn('external blocked', String(url).slice(0, 80));
      return false;
    }
    await electronShell.openExternal(url);
    return true;
  } catch (err) {
    log.error('external open failed', err);
    return false;
  }
});

log.transports.file.level = 'info';
autoUpdater.logger = log;
autoUpdater.autoDownload = false;

autoUpdater.on('update-available', (info) => {
  electronShell.notify(`Доступна версия ${info.version}, скачиваю…`);
  win?.webContents.send('updates:available', info.version);
  void autoUpdater.downloadUpdate();
});

autoUpdater.on('update-downloaded', (info) => {
  electronShell.notify(`Версия ${info.version} скачана, можно установить`);
  win?.webContents.send('updates:downloaded', info.version);
});

autoUpdater.on('error', (err) => {
  const msg = String(err?.message ?? err);
  log.error('updater error', err);
  if (/404/.test(msg)) return;
  win?.webContents.send('updates:error', msg);
});

ipcMain.handle('updates:check', async () => {
  const current = electronShell.version();
  if (isDev()) return { packaged: false, current, latest: null };
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo.version ?? null;
    const available = latest !== null && latest !== current;
    return { packaged: true, current, latest, available };
  } catch (err) {
    const msg = String(err);
    log.error('check failed', err);
    if (/404/.test(msg)) return { packaged: true, current, latest: null, noReleases: true };
    return { packaged: true, current, latest: null, error: msg };
  }
});

ipcMain.handle('updates:install', () => {
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('prices:get', async (_e, args?: PricesQuery): Promise<StorePrices[]> => getCore().searchPrices(args));

ipcMain.handle('catalog:get', async (_e, args?: { city?: string }): Promise<StoreCatalog[]> =>
  getCore().getCatalogs(args),
);

ipcMain.handle('category:get', async (_e, args?: { city?: string; url?: string }): Promise<StorePrices[]> =>
  getCore().getCategoryProducts(args),
);

ipcMain.handle('ourcategories:get', (_e, args?: { city?: string }) => getCore().getOurCategories(args));

ipcMain.handle('ourcategory:get', async (_e, args?: { city?: string; id?: string }): Promise<StorePrices[]> =>
  getCore().getOurCategory(args),
);

ipcMain.handle('shelves:get', (_e, args: ShelfScope) => getCore().getShelves(args));

ipcMain.handle(
  'shelves:set',
  (_e, args: ShelfScope & { categoryIds: string[] }) => getCore().setShelves(args),
);

ipcMain.handle('shelves:release', (_e, args: ShelfScope) => getCore().releaseShelves(args));

ipcMain.handle('favorites:get', (_e, args: { city: string }) => getCore().getFavorites(args));
  ipcMain.handle('favorites:set', (_e, args: ShelfScope & { targetPrice: number | null }) =>
    getCore().setFavorite(args),
  );
  ipcMain.handle('favorites:remove', (_e, args: ShelfScope) => getCore().removeFavorite(args));
  ipcMain.handle('splits:set', (_e, args: SplitPair) => getCore().splitProducts(args));
  ipcMain.handle('splits:remove', (_e, args: SplitPair) => getCore().removeSplit(args));
  ipcMain.handle('splits:pairs', (_e, args: { city: string }) => getCore().getSplitPairs(args));
  ipcMain.handle('history:get', (_e, args?: { canonicalId?: string; storeId?: string; city?: string }) =>
    getCore().getHistory(args),
  );

ipcMain.handle('scheduler:status', () => getCore().schedulerStatus());

ipcMain.handle(
  'scheduler:run',
  async (_e, args?: { city?: string }) =>
    getCore().runScheduler(args?.city ? { city: knownCity(args.city) } : undefined),
);
  // Город из интерфейса: без него автоопрос не знает, куда смотреть.
  // Город приходит из интерфейса, а не из сети, поэтому проверяем его по списку:
// иначе опечатка или старый город из сохранённого состояния уехали бы в
// автоопрос как «город без целей», а метка опроса — в БД под несуществующим
// городом.
const knownCity = (value: unknown): string => {
  if (typeof value !== 'string' || !CITIES.some((c) => c.id === value)) {
    throw new Error(`city:set: неизвестный город ${String(value).slice(0, 40)}`);
  }
  return value;
};
ipcMain.handle('city:set', (_e, args: { city: string }) => getCore().setCurrentCity(knownCity(args?.city)));

app.whenReady().then(async () => {
  // Путь к браузеру Playwright знает только оболочка: ядро не читает process.
// Firefox лежит в resources/browsers рядом с exe (в разработке — в корне
// репозитория). Ищем Firefox нужной ревизии, а не просто каталог: частичная
// копия хуже отсутствия, а каталог от другой ревизии выглядит как готовый
// браузер, пока на деле запускаться не будет. Ошибку чтения browsers.json
// переживаем: без неё приложение осталось бы вообще без окна, а с окном и
// внятной записью в логе пользователь может переустановить сборку.
let browsers: string | null = null;
try {
  browsers = resolveBrowsersPath();
} catch (err) {
  log.error('не удалось определить браузер Playwright', err);
}
if (browsers) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  log.info('playwright browsers', browsers);
} else {
  log.warn(`браузер Firefox не найден: Пятёрочка работать не будет — ${describeFirefoxProblem()}`);
}
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
  getCore().startScheduler();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Если ядро так и не создавали (приложение закрылось до первого запроса),
  // сохранять нечего — и создавать его ради этого незачем.
  maybeCore()?.saveAll();
  void close5kaBrowser();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
