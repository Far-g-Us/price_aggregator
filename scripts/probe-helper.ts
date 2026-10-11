// Общий помощник живых зондов: GET из контекста страницы.
//
// Зачем отдельный файл: браузерный in-page `fetch` нужен и генератору
// справочника, и съёму фикстур, и живым проверкам, и он обязан выглядеть
// одинаково везде — иначе каждый следующий зонд будет изобретать `evaluate`
// заново и получит свою версию ошибок.
//
// Три особенных места, из-за которых этот код такой, какой есть:
//
// 1. Браузеры качаются ТОЛЬКО в проект (`PLAYWRIGHT_BROWSERS_PATH`), см. правило
//    проекта про Playwright. Без этого блока зонд молча упал бы «Executable
//    doesn't exist» у того, кто ставил браузеры по правилам.
// 2. Код внутри `page.evaluate` передаётся ФУНКЦИЕЙ с аргументом, а не строкой:
//    `page.evaluate` со строкой не умеет принимать аргументы (проверено — вернёт
//    `undefined`), а любая вложенная именованная стрелка внутри функции ломает
//    сборку esbuild (`__name is not defined`). Поэтому внутри функции — прямой
//    код без вложенных `const`-стрелок.
// 3. Одна сессия на обход, а не браузер на запрос: при 24 запросах подряд, каждый
//    в своём Firefox, антибот включает 403 уже на третьем (проверено 2026-10-08).
//    Между запросами — пауза, иначе тот же 403.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCAL_BROWSERS = resolve(process.cwd(), '.playwright-browsers');
/** Пауза между запросами внутри сессии: сеть начинает отдавать 403 без неё. */
const GAP_MS = 2000;

export interface InPageSession {
  /** GET по абсолютному адресу с разобранным JSON. */
  get<T>(url: string): Promise<T>;
  /** href со страницы магазина — так находится канонический путь товара. */
  pageLinks(): Promise<string[]>;
  close(): Promise<void>;
}

/** Сессия: Firefox, страница магазина, запросы из её контекста с куками. */
export async function openInPageSession(pageUrl: string): Promise<InPageSession> {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(LOCAL_BROWSERS)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = LOCAL_BROWSERS;
  }
  const { firefox } = await import('playwright');
  const browser = await firefox.launch({ headless: true });
  let busy: Promise<unknown> = Promise.resolve();
  let gap = 0;
  try {
    const page = await browser.newPage({ locale: 'ru-RU' });
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(3000);
    return {
      get: async <T>(url: string): Promise<T> => {
        // Запросы строго по очереди: два параллельных ухода в сеть — лишний
        // повод для антибота.
        const run = busy.then(async () => {
          if (gap > 0) await new Promise((done) => void setTimeout(done, GAP_MS));
          const out = await page.evaluate(async (target: { url: string }) => {
            const res = await fetch(target.url, {
              headers: { accept: 'application/json' },
              credentials: 'include',
              signal: AbortSignal.timeout(90_000),
            });
            return { status: res.status, body: await res.text() };
          }, { url });
          gap = 1;
          if (out.status !== 200) {
            throw new Error(`${url.slice(0, 70)} — HTTP ${out.status}: ${out.body.slice(0, 90)}`);
          }
          try {
            return JSON.parse(out.body) as T;
          } catch {
            throw new Error(`${url.slice(0, 70)} — не JSON (${out.body.slice(0, 60)})`);
          }
        });
        busy = run.catch(() => {});
        return run;
      },
      pageLinks: () =>
        page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? '')),
      close: async () => {
        await busy.catch(() => {});
        await browser.close().catch(() => {});
      },
    };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

/** Один GET в своём браузере: удобно, когда запрос ровно один. */
export async function openInPageFetch(url: string, pageUrl = 'https://app.chizhik.club'): Promise<unknown> {
  const session = await openInPageSession(pageUrl);
  try {
    return await session.get(url);
  } finally {
    await session.close();
  }
}