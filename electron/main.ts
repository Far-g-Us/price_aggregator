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
import { MAX_FEED_BYTES, RELEASES_PAGE_URL, isNewerVersion, readFeedVersion } from '../src/core/release-check.js';
import { isExternalAllowed, urlForLog } from './external-links.js';
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

// Политика безопасности ссылок — в ./external-links.ts: её используют и IPC из
// renderer, и клик по уведомлению о portable, поэтому список один.
ipcMain.handle('ping', () => 'pong');

ipcMain.handle('app:version', () => electronShell.version());

ipcMain.handle('external:open', async (_e, url: unknown) => {
  try {
    if (!isExternalAllowed(url)) {
      log.warn('external blocked', urlForLog(url));
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

// Portable не обновляется сам: `app-update.yml` (адрес провайдера) electron-builder
// кладёт только когда в сборке есть nsis, а по ленте portable скачал бы
// NSIS-установщик и поставил бы приложение рядом вместо обновления копии. Поэтому
// portable только спрашивает ленту и сообщает. Метку ставит сам electron-builder
// при распаковке portable-exe. Проверку делает renderer при монтировании через
// `updates:check`: второй запрос при старте был бы тем же ответом впустую.
const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
const RELEASE_FEED_TIMEOUT_MS = 10_000;
const RELEASE_STATE_FILE = 'release-notified.json';
// Показанную версию помним и в userData: иначе portable, отставший от релиза,
// получал бы уведомление при каждом запуске. Файл рядом с базой и в репозиторий
// не попадает. Чтение обёрнуто: недоступный или битый файл не должен ронять
// старт приложения — хуже всего лишнее повторное уведомление, а не тишина.
const releaseState = jsonStore(userDataDir());
let notifiedRelease: string | null = readNotifiedRelease();

function readNotifiedRelease(): string | null {
  try {
    return releaseState.read(RELEASE_STATE_FILE);
  } catch (err) {
    log.warn('release state unreadable', err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function fetchFeedText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(RELEASE_FEED_TIMEOUT_MS) });
  // 404 — не поломка: адрес `/releases/latest/` не отдаёт pre-release, а
  // latest.yml кладут в релиз при публикации. Пишем в лог, чтобы «почему нет
  // уведомления» находилось по журналу, а не гаданием.
  if (!res.ok) {
    void res.body?.cancel();
    log.warn(`release feed ${res.status}: ${urlForLog(url)}`);
    throw new Error(`release feed ${res.status}`);
  }
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) {
    // Тело не читаем, но соединение закрываем: иначе сокет висит до сборки мусора.
    void res.body?.cancel();
    log.warn(`release feed ${declared} байт, лимит ${MAX_FEED_BYTES}`);
    throw new Error('release feed too big');
  }
  // Тело читается потоком с обрывом по лимиту, а не скачивается целиком: база
  // живёт в памяти, и страница на сотни мегабайт от прокси уронила бы процесс
  // вместе с несохранённой историей. Таймаут покрывает и чтение.
  const body = res.body as unknown as AsyncIterable<Uint8Array> | null;
  if (!body) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > MAX_FEED_BYTES) {
      log.warn(`release feed больше ${MAX_FEED_BYTES} байт, чтение прервано`);
      throw new Error('release feed too big');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

type PortableCheck = {
  packaged: boolean;
  current: string;
  latest: string | null;
  available: boolean;
  portable: boolean;
};

// Результат переиспользуется в пределах запуска: запуск даёт и обращение от
// renderer при монтировании, и возможные повторы — им ходить на GitHub заново
// незачем.
//
// Мемоизируется только успех: `readFeedVersion` глотает и сетевую ошибку, и
// неожиданное тело, поэтому отказ приходит как `null` и исключение не бросается.
// Если бы `null` тоже запоминался, portable, запущенный без сети, молчал бы до
// конца сеанса — а процесс живёт днями. Повтор на ту же версию, что уже
// показана, тоже не запоминается: сначала попробуем, уведомление не повторится.
let portableCheck: Promise<PortableCheck> | null = null;

async function runPortableCheck(): Promise<PortableCheck> {
  const current = electronShell.version();
  const latest = await readFeedVersion(fetchFeedText);
  // `readFeedVersion` глотает и сетевую ошибку, и неожиданное тело, поэтому
  // молчание ленты фиксируется здесь: иначе офлайн и «200 с HTML» в журнале
  // не оставляли бы следа.
  if (latest === null) {
    log.warn('лента релизов недоступна: ответ не похож на latest.yml, слишком велик или сети нет');
  }
  const available = latest !== null && isNewerVersion(latest, current);
  if (available && notifiedRelease !== latest) {
    notifiedRelease = latest;
    releaseState.write(RELEASE_STATE_FILE, latest);
    electronShell.notify(
      `Вышла версия ${latest}. Portable сам не обновляется — скачай его заново`,
      RELEASES_PAGE_URL,
    );
  }
  return { packaged: true, current, latest, available, portable: true };
}

const checkPortableRelease = (): Promise<PortableCheck> => {
  if (portableCheck) return portableCheck;
  const pending = runPortableCheck();
  portableCheck = pending;
  void pending.then(
    (result) => {
      // Неудача не запоминается: иначе офлайн на старте молчал бы до конца
      // сеанса, а процесс живёт днями. Успех с новой версией — тоже: повторный
      // вызов в том же сеансе всё равно не показал бы второе уведомление.
      if (result.latest === null || result.available) portableCheck = null;
    },
    () => {
      portableCheck = null;
    },
  );
  return pending;
};

autoUpdater.on('update-available', (info) => {
  electronShell.notify(`Доступна версия ${info.version}, скачиваю…`);
  win?.webContents.send('updates:available', info.version);
  void autoUpdater.downloadUpdate();
});

autoUpdater.on('update-downloaded', (info) => {
  electronShell.notify(`Версия ${info.version} скачана, можно установить`);
  win?.webContents.send('updates:downloaded', info.version);
});

// «Релизов ещё нет» — это не поломка. Пока на GitHub нет обычного релиза
// (есть только pre-release), GitHub отвечает на `/releases/latest` редиректом
// на список релизов, а тот на запрос electron-updater'а с
// `Accept: application/json` отдаёт 406 с пустым телом. Текст этой ошибки —
// простыня заголовков и стеков, и в интерфейсе ей не место: обновляться просто
// неоткуда. В журнал она пишется как есть.
const NO_RELEASES_CODE = 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND';

function isNoReleasesError(err: unknown, message: string): boolean {
  if ((err as { code?: unknown } | null)?.code === NO_RELEASES_CODE) return true;
  // Запасной путь: код есть не во всех сборках electron-updater.
  return /406/.test(message) || /ensure a production release exists/.test(message);
}

autoUpdater.on('error', (err) => {
  const msg = String(err?.message ?? err);
  log.error('updater error', err);
  if (/404/.test(msg) || isNoReleasesError(err, msg)) return;
  win?.webContents.send('updates:error', msg);
});

// Установленная сборка: апдейтер. Результат переиспользуется, потому что запуск
// даёт два обращения к проверке — своя при whenReady и от renderer при
// монтировании, а ответ у них один и тот же.
let updaterCheck: Promise<unknown> | null = null;
const runUpdaterCheck = (): Promise<unknown> => {
  updaterCheck ??= autoUpdater.checkForUpdates().catch((err: unknown) => {
    updaterCheck = null;
    throw err;
  });
  return updaterCheck;
};

ipcMain.handle('updates:check', async () => {
  const current = electronShell.version();
  if (isDev()) return { packaged: false, current, latest: null };
  if (isPortable) return checkPortableRelease();
  try {
    const result = (await runUpdaterCheck()) as { updateInfo?: { version?: string } } | null;
    const latest = result?.updateInfo?.version ?? null;
    // Сравнение строгое, как у portable: тег-откат («v1.2.1» на месте 1.2.2)
    // обновлением не считается.
    const available = latest !== null && isNewerVersion(latest, current);
    return { packaged: true, current, latest, available };
  } catch (err) {
    const msg = String(err);
    log.error('check failed', err);
    // Релизов ещё нет (404 или 406 от списка релизов) — обновляться неоткуда, и
    // это не поломка: показывать в интерфейсе нечего.
    if (/404/.test(msg) || isNoReleasesError(err, msg)) {
      return { packaged: true, current, latest: null };
    }
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
  // Планировщик стартует до сетевой проверки: иначе медленный интернет откладывал
// бы первый опрос на всё время ожидания апдейтера.
getCore().startScheduler();
if (app.isPackaged && !isPortable) {
  // Установленная сборка обновляется апдейтером; portable ленту спрашивает по IPC
  // из renderer (см. комментарий у isPortable).
  void runUpdaterCheck().catch((err: unknown) => log.error('initial check failed', err));
}
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
