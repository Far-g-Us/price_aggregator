// Реализация портов платформы для Node/Electron. Ядро (src/core) не знает
// ничего из этого файла: ни fs, ни app, ни Notification. Вторая оболочка
// (Capacitor/Android) реализует те же интерфейсы своими средствами.
import { app, Notification, shell } from 'electron';
import log from 'electron-log';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { AppShell, BackgroundTasks, CoreLogger } from '../src/core/platform.js';
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
 * Каталоги, в которых ищем браузеры, в порядке приоритета. В сборке Firefox
 * лежит в resources рядом с exe: рабочий каталог упакованного приложения равен
 * папке exe, и «.playwright-browsers» там не ищется. В разработке — в корне
 * репозитория, но только когда приложение не упаковано: внутри app.asar этот
 * путь существует и писать туда нельзя. Один список на поиск и на диагностику:
 * разъехавшиеся копии дают в лог правду, которой сам поиск не пользовался.
 */
function browserRoots(): string[] {
  const roots: string[] = [];
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'browsers'));
  if (!app.isPackaged) roots.push(path.join(app.getAppPath(), '.playwright-browsers'));
  return roots;
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
  notify(text: string): void {
    if (!Notification.isSupported()) return;
    new Notification({ title: 'PriceAggregator', body: text }).show();
  },
  openExternal: async (url: string): Promise<void> => {
    await shell.openExternal(url);
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
