/**
 * Единственная точка, где адаптеры достают Playwright.
 *
 * Зачем порт: браузер нельзя поднять в юнит-тесте (это отдельный процесс, сеть
 * и секунды ожидания на сессию), поэтому модуль подменяется фейком, и поведение
 * по умолчанию остаётся ровно прежним.
 *
 * Почему загрузчик регистрирует ОБОЛОЧКА, а не этот файл: `import('playwright')`
 * внутри `src/core` попадал в бандлер и в Android-сборку — Rolldown честно
 * пытался resolve'ить `chromium-bidi` для браузера, которого в WebView нет и
 * быть не может. Теперь единственный настоящий импорт живёт в
 * `electron/node-playwright.ts`, а Android-мост загрузчик не регистрирует вовсе:
 * попытка поднять браузер там даёт громкую ошибку с честным объяснением, а не
 * молчаливое «сеть недоступна».
 */

export type PlaywrightModule = typeof import('playwright');

let injected: PlaywrightModule | null = null;
let loader: (() => Promise<PlaywrightModule>) | null = null;

/** Подмена для тестов; `null` — вернуть настоящий модуль (или бросить). */
export function __setPlaywrightForTests(pw: PlaywrightModule | null): void {
  injected = pw;
}

export function injectedPlaywright(): PlaywrightModule | null {
  return injected;
}

/**
 * Регистрация настоящего загрузчика. Зовёт ТОЛЬКО оболочка, у которой есть
 * браузерный процесс (Electron). Android-мост этого не делает намеренно.
 */
export function setPlaywrightLoader(fn: (() => Promise<PlaywrightModule>) | null): void {
  loader = fn;
}

/**
 * Playwright для браузерных сетей. Бросает, если браузера в этой сборке нет:
 * молчать нельзя, потому что «сеть молчит» и «сеть недоступна на этой платформе»
 * для пользователя — разные вещи, и ошибка обязана говорить, какая из них.
 *
 * Отказ самого импорта тоже превращается в понятный текст: на Electron это
 * битая сборка (лечится переустановкой), и по голому «Cannot find module» это
 * не выводить.
 *
 * Подмена для тестов (`__setPlaywrightForTests`) побеждает загрузчик: иначе
 * каждый адаптер тащил бы собственную проверку, и ветка «подмены нет»
 * оставалась бы непокрытой в четырёх файлах.
 */
export async function loadPlaywright(): Promise<PlaywrightModule> {
  if (injected !== null) return injected;
  if (loader === null) {
    throw new Error(
      'браузер недоступен в этой сборке: сети Пятёрка, Чижик и Перекрёсток идут через настоящий браузер, а на этой платформе его нет',
    );
  }
  try {
    return await loader();
  } catch (err) {
    throw new Error(
      `не удалось загрузить playwright из сборки — приложение установлено повреждённо, переустанови его: ${String(err).slice(0, 120)}`,
    );
  }
}
