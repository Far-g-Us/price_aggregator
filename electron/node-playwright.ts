/**
 * Настоящий Playwright для Electron-оболочки.
 *
 * Единственное место в проекте, где пакет `playwright` импортируется по-настоящему.
 * Отдельным модулем он именно потому, что в `src/core` лежит только порт: иначе
 * динамический импорт из адаптеров попадал в бандлер и в Android-сборку, где
 * бандлер пытался resolve'ить `chromium-bidi` — библиотеку настоящего браузера,
 * которого в WebView нет и быть не может.
 */

import { setPlaywrightLoader } from '../src/core/adapters/playwright-port.js';

/**
 * Импорт остаётся динамическим намеренно: пакет ставится отдельно
 * (`npx playwright install chromium`), и оболочка обязана падать громко, если
 * его нет, а не молча ехать без браузера.
 */
export const installNodePlaywright = (): void => {
  setPlaywrightLoader(() => import('playwright'));
};
