// Реализация портов платформы для Node/Electron. Ядро (src/core) не знает
// ничего из этого файла: ни fs, ни app, ни Notification. Вторая оболочка
// (Capacitor/Android) реализует те же интерфейсы своими средствами.
import { app, Notification, shell } from 'electron';
import log from 'electron-log';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { AppShell, BackgroundTasks, CoreLogger } from '../src/core/platform.js';
import { isExternalAllowed, urlForLog } from './external-links.js';
import { jsonStoreAt, fileStorageAt } from './node-files.js';

export { jsonStoreAt as jsonStore, fileStorageAt as fileStorage };

/**
 * Ревизия Firefox, которую требует установленный playwright-core. Каталог
 * браузера называется ровно `firefox-<revision>`, поэтому искать каталог по
 * префиксу нельзя: после обновления Playwright старый `firefox-*` перебьётся
 * новым, и запуск упадёт с «Executable doesn't exist».
 *
 * browsers.json не входит в `exports` playwright-core (проверено: там только
 * `.`, `./package.json` и несколько lib/*), поэтому require на него падает с
 * ERR_PACKAGE_PATH_NOT_EXPORTED. Идём от package.json — он экспортируется — и
 * читаем соседний файл. Импортировать сам playwright-core здесь нельзя: он
 * замораживает PLAYWRIGHT_BROWSERS_PATH при первом импорте, а переменную мы
 * ставим позже, в whenReady.
 */
function requiredFirefoxRevision(): string {
  const req = createRequire(import.meta.url);
  const pkgJson = req.resolve('playwright-core/package.json');
  const raw = JSON.parse(fs.readFileSync(path.join(path.dirname(pkgJson), 'browsers.json'), 'utf8')) as {
    browsers: { name: string; revision: string }[];
  };
  const firefox = raw.browsers.find((b) => b.name === 'firefox');
  if (!firefox?.revision) throw new Error('в browsers.json playwright-core нет записи firefox');
  return firefox.revision;
}

/**
 * Готов ли Firefox в каталоге `root`: ревизия совпадает, маркер установки на
 * месте и сам бинарник существует. Набор проверок повторяет то, чем
 * пользуется сам Playwright (INSTALLATION_COMPLETE + executablePath), чтобы
 * «готовый браузер» и «каталог, который запустится» совпадали.
 */
function firefoxReadyAt(root: string, revision: string): boolean {
  const dir = path.join(root, `firefox-${revision}`);
  return (
    fs.existsSync(path.join(dir, 'INSTALLATION_COMPLETE')) &&
    fs.existsSync(path.join(dir, 'firefox', 'firefox.exe'))
  );
}

/**
 * Каталоги, в которых ищем браузеры, в порядке приоритета.
 *
 * Firefox НЕ вшивается в установщик: он весит около 340 МБ, а нужен только
 * трём сетям (Пятёрка, Чижик, Перекрёсток) — из-за него установщик весил
 * 210 МБ. Теперь браузер ставится по требованию в каталог пользователя, и
 * порядок поиска такой:
 *   1. `resources/browsers` рядом с exe — если браузер всё-таки положил
 *      установщик (или пользователь положил руками);
 *   2. `userData/browsers` — куда его ставит сам приложение;
 *   3. `.playwright-browsers` в корне репозитория — только в разработке:
 *      внутри app.asar этого пути нет и писать туда нельзя.
 *
 * Один список на поиск и на диагностику: разъехавшиеся копии дают в лог
 * правду, которой сам поиск не пользовался.
 */
function browserRoots(): string[] {
  const roots: string[] = [];
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'browsers'));
  roots.push(path.join(app.getPath('userData'), 'browsers'));
  // Дефолтный каталог самого Playwright: `npx playwright install firefox`
  // кладёт браузер именно туда, и туда же попадёт браузер, поставленный
  // пользователем вручную. Без этого поиска мы говорили бы «браузера нет»
  // про браузер, который Playwright запустил бы без проблем.
  const local = process.env.LOCALAPPDATA;
  if (local) roots.push(path.join(local, 'ms-playwright'));
  if (!app.isPackaged) roots.push(path.join(app.getAppPath(), '.playwright-browsers'));
  return roots;
}

/** Каталог, куда приложение само ставит Firefox по требованию. */
export function userBrowsersDir(): string {
  return path.join(app.getPath('userData'), 'browsers');
}

/**
 * Установка Firefox по требованию.
 *
 * Firefox не вшивается в установщик (около 340 МБ из 210 МБ сборки), а нужен
 * только трём сетям. Ставит его сам Playwright — он умеет и качать, и
 * распаковывать, и знает нужную ревизию: запускаем `playwright install
 * firefox` с PLAYWRIGHT_BROWSERS_PATH, указывающим на каталог пользователя.
 *
 * Из приложения Node запускается как ELECTRON_RUN_AS_NODE: иначе откроется
 * ещё одно окно вместо выполнения скрипта.
 */
export function installFirefox(
  onProgress: (line: string) => void,
): Promise<{ ok: boolean; message: string }> {
  const dir = userBrowsersDir();
  const req = createRequire(import.meta.url);
  let cli: string;
  try {
    // `require.resolve('playwright/cli.js')` не работает: в `exports` пакета
    // playwright подпути `./cli.js` нет (там только `.`, `./package.json` и
    // несколько `./lib/*`), и Node бросает ERR_PACKAGE_PATH_NOT_EXPORTED.
    // Идём через package.json — он экспортируется — и строим путь рядом.
    const pkgJson = req.resolve('playwright/package.json');
    cli = path.join(path.dirname(pkgJson), 'cli.js');
    if (!fs.existsSync(cli)) throw new Error(`по пути ${cli} нет файла установщика`);
  } catch (err) {
    return Promise.resolve({
      ok: false,
      message: `не найден установщик браузера (playwright) в сборке: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [cli, 'install', 'firefox'],
      {
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
      },
    );
    let last = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.trim() === '' || text === last) return;
      last = text;
      onProgress(text.trim().slice(0, 200));
    });
    child.stderr?.on('data', (chunk: Buffer) => onProgress(chunk.toString().trim().slice(0, 200)));
    child.on('error', (err) => resolve({ ok: false, message: `установка не началась: ${err.message}` }));
    child.on('close', (code) => {
      if (code === 0) {
        // Playwright читает PLAYWRIGHT_BROWSERS_PATH ОДИН раз — при первом
        // импорте. Поэтому переменную надо выставить сразу, а сеть всё равно
        // заработает только после перезапуска приложения: об этом и говорим
        // пользователю прямо, а не молча ждём, что сети оживут сами.
        process.env.PLAYWRIGHT_BROWSERS_PATH = dir;
        const found = resolveBrowsersPath();
        resolve(
          found
            ? { ok: true, message: `браузер установлен: ${found}. Перезапустите приложение — сети заработают.` }
            : { ok: false, message: 'установщик отработал, но браузер не найден' },
        );
      } else {
        resolve({ ok: false, message: `установка браузера прервалась (код ${code ?? '—'})` });
      }
    });
  });
}

/**
 * Корень с готовым Firefox нужной ревизии или null. Бросает, если не читается
 * browsers.json (битая установка) — вызывающий обязан это пережить, иначе
 * приложение не стартует вовсе.
 */
export function resolveBrowsersPath(): string | null {
  const revision = requiredFirefoxRevision();
  for (const root of browserRoots()) {
    if (firefoxReadyAt(root, revision)) return root;
  }
  return null;
}

/**
 * Человеческое объяснение, почему браузера нет: нужную ревизию, что нашли и
 * где искали. Без него сообщение «Пятёрочка не работает» не лечится — молчаливая
 * подмена папки выглядит как поломка сети. Не бросает: этот текст зовут ровно
 * тогда, когда с самим поиском что-то не так.
 */
export function describeFirefoxProblem(problem?: unknown): string {
  let revision: string;
  try {
    revision = requiredFirefoxRevision();
  } catch (err) {
    return `не удалось прочитать browsers.json playwright-core (${err instanceof Error ? err.message : String(err)}) — приложение установлено повреждённо`;
  }
  const found: string[] = [];
  for (const root of browserRoots()) {
    try {
      found.push(...fs.readdirSync(root).filter((d) => d.startsWith('firefox-')).map((d) => `${d} (${root})`));
    } catch {
      // каталога нет — это штатный случай, а не ошибка
    }
  }
  const prefix = problem === undefined ? '' : `${problem instanceof Error ? problem.message : String(problem)}; `;
  const need = `нужен Firefox ревизии ${revision}`;
  return `${prefix}${found.length ? `${need}; нашлось: ${found.join(', ')}` : `${need}; каталогов с Firefox не найдено`}`;
}

export const electronShell: AppShell = {
  version: () => app.getVersion(),
  notify(text: string, actionUrl?: string): void {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: 'PriceAggregator', body: text });
    if (actionUrl) {
      n.on('click', () => {
        // Клик — это обработчик события: его отказ никто не поймает, а
        // openExternalChecked бросает и при блокировке, и при отказе самой
        // системы. Без catch это unhandled rejection в main-процессе.
        openExternalChecked(actionUrl).catch((err: unknown) =>
          log.error('notification action failed', err instanceof Error ? err.message : String(err)),
        );
      });
    }
    n.show();
  },
  openExternal: async (url: string): Promise<void> => {
    await openExternalChecked(url);
  },
};

export const nodeBackground: BackgroundTasks = {
  every: (ms, task) => {
    setInterval(task, ms);
  },
  after: (ms, task) => {
    setTimeout(task, ms);
  },
};

export const electronLogger: CoreLogger = {
  error: (...args) => log.error(...(args as [unknown])),
  warn: (...args) => log.warn(...(args as [unknown])),
  // info — это замеры: «полка за 12с», «запрос за 3с». Без них задержку
  // приходится угадывать, а не измерять.
  info: (...args) => log.info(...(args as [unknown])),
};

export const userDataDir = (): string => app.getPath('userData');
export const dbFile = (): string => path.join(app.getPath('userData'), 'prices.db');
export const isDev = (): boolean => !app.isPackaged;

// Открытие браузера всегда через список разрешённых адресов: и клик по
// уведомлению, и порт для ядра. Список в ./external-links.ts, здесь только
// исполнение — иначе достаточно одного нового вызова, чтобы обойти политику.
const openExternalChecked = async (url: string): Promise<void> => {
  if (!isExternalAllowed(url)) {
    log.warn('external blocked', urlForLog(url));
    throw new Error('external blocked');
  }
  await shell.openExternal(url);
};
