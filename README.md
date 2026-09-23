# PriceAggregator

Локальный агрегатор цен продуктовых магазинов (Пятёрочка / Магнит / Лента).
Desktop-приложение под Windows. Open source, использование личное.

## Что делает

- Сравнение цен одного товара в разных сетях с разделением по городам.
- История изменения цен с датой замера (график в карточке товара).
- Избранное и алерты о снижении цены (Windows-нотификации + tray).
- Автообновление exe из GitHub Releases.

Ключевой принцип: сеть опрашивается по расписанию (без запроса изменение
не узнать), а в историю пишется только если цена/промо/наличие изменились.

## Из чего сделано

- Node 22 + TypeScript (strict + exactOptionalPropertyTypes)
- Electron (main/preload) + Vite + React (renderer)
- SQLite через `sql.js` (WASM — собирается везде без компилятора C++), файл `app-data/prices.db`
- Сборка Windows: `electron-builder` (NSIS-установщик + portable exe)
- Обновления: `electron-updater`, GitHub Releases как источник
- Версия одна — файл `VERSION` в корне, `npm run version:sync` пишет её в package.json

## Структура

```
electron/            main-процесс и preload (IPC: window.api)
src/renderer/        React-интерфейс
src/main/adapters/   адаптеры сетей (реализуют StoreAdapter)
src/main/db/         SQLite: schema.sql, db.ts (savePriceIfChanged)
src/shared/types.ts  контракты: Store, ScrapedProduct, StoreAdapter
scripts/             sync-version.mjs, probe-скрипты для зондирования API
tests/fixtures/      слепки ответов API сетей для unit-тестов адаптеров
```

## Цены и города

У сетей нет «цены города» — цена всегда конкретного магазина:
Пятёрочка — `sapCode`, Магнит — `shopCode` (кука), Лента — `storeId`.
Новый город = новая строка в таблице `stores`. Ключ цены:
(canonicalId, storeId, city).

Важно: цены могут различаться даже между соседними магазинами одной сети
в одном городе (проверено на Магните) — сравнение честно только в пределах
выбранного магазина, приложение так и показывает.

Адаптеры неофициальные (скрытые API сайтов + Playwright-warmup при 401/403).
Только для личного пользования; уважать rate-limit, секреты — в `.env`.

## Команды

```
npm run dev              # Electron + Vite HMR
npm run version:sync     # VERSION -> package.json
npm run typecheck        # оба tsc-конфига
npx electron-builder --win nsis portable   # установщик + portable в dist/
npm run release:win      # то же + публикация в GitHub Release (нужен GH_TOKEN)
```

Playwright-браузеры качаются только в проект:
`PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers npx playwright install chromium`.

## Статус

MVP в разработке: скелет Electron + SQLite-схема + адаптер Пятёрочки (Москва)
готовы, живые id магазинов уточняются.
