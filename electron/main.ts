import { app, BrowserWindow, ipcMain, Menu, Notification } from 'electron';
import electronUpdaterPkg from 'electron-updater';
import log from 'electron-log';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PricesQuery, StorePrices } from '../src/shared/api.js';
import type { StoreAdapter } from '../src/shared/types.js';
import { CITY_STORES } from '../src/shared/catalog.js';
import { MagnitAdapter } from '../src/main/adapters/magnit.js';
import { getPriceHistory, openDb, persistDb, savePriceIfChanged, toPriceInput } from '../src/main/db/db.js';
import { pollOnce, type PollCounts } from '../src/main/scheduler.js';

const { autoUpdater } = electronUpdaterPkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let win: BrowserWindow | null = null;

async function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
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
  log.error('updater error', err);
  win?.webContents.send('updates:error', String(err?.message ?? err));
});

ipcMain.handle('updates:check', async () => {
  if (!app.isPackaged) return { packaged: false, current: app.getVersion(), latest: null };
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo.version ?? null;
    const available = latest !== null && latest !== app.getVersion();
    return { packaged: true, current: app.getVersion(), latest, available };
  } catch (err) {
    log.error('check failed', err);
    return { packaged: true, current: app.getVersion(), latest: null, error: String(err) };
  }
});

ipcMain.handle('updates:install', () => {
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('prices:get', async (_e, args: PricesQuery): Promise<StorePrices[]> => {
  const city = args.city ?? 'moscow';
  const query = args.query?.trim() ?? '';
  if (!query) return [];
  const stores = CITY_STORES[city] ?? [];
  const out: StorePrices[] = [];
  let database = null;
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
      if (database) {
        try {
          for (const item of items) {
            try {
              savePriceIfChanged(database, toPriceInput(item));
            } catch (err) {
              log.error('db item skipped', item.canonicalId, err);
            }
          }
        } catch (err) {
          log.error('db write failed', s.storeId, err);
        }
      }
      out.push({ storeId: s.storeId, name: s.name, ready: true, items });
    } catch (err) {
      log.error('search failed', s.storeId, err);
      out.push({ storeId: s.storeId, name: s.name, ready: true, items: [], error: String(err) });
    }
  }
  persistDb();
  return out;
});

ipcMain.handle('history:get', async (_e, args: { canonicalId: string; storeId: string; city: string }) => {
  if (!args.canonicalId || !args.storeId || !args.city) return [];
  const database = await openDb(path.join(app.getPath('userData'), 'prices.db'));
  return getPriceHistory(database, args);
});

const adapters = new Map<string, StoreAdapter>([['magnit', new MagnitAdapter()]]);
const schedState = {
  running: false,
  lastRun: null as string | null,
  counts: { inserted: 0, skipped: 0, failed: 0, notReady: 0 },
  intervalHours: 6,
};

async function runScheduled(): Promise<void> {
  if (schedState.running) return;
  schedState.running = true;
  try {
    const database = await openDb(path.join(app.getPath('userData'), 'prices.db'));
    schedState.counts = await pollOnce(database, adapters);
    schedState.lastRun = new Date().toISOString();
  } catch (err) {
    log.error('scheduled poll failed', err);
  } finally {
    schedState.running = false;
  }
}

ipcMain.handle('scheduler:status', () => ({ ...schedState }));
ipcMain.handle('scheduler:run', async () => {
  await runScheduled();
  return { ...schedState };
});

function showPriceAlert(title: string, body: string) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

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
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => persistDb());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

export { showPriceAlert };
