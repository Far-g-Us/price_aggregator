/**
 * Политика внешних ссылок живёт в `src/shared/external-links.ts`: её применяют
 * обе оболочки — Electron и Android-мост. Модуль оставлен как реэкспорт, чтобы
 * существующие импорты в main.ts и тестах не разъехались.
 */
export { isExternalAllowed, urlForLog } from '../src/shared/external-links.js';