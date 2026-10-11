// Зонды сетей, которые не читаются с машины агента. Скрипт только смотрит и
// печатает, ничего не меняя.
//
//   npm run perekrestok:probe   — проверяет, открывается ли Перекрёсток
//   npm run svetofor:probe      — показывает магазин, метку каталога и поддомены регионов
//
// Перекрёсток закрыт антиботом и из домашней сети тоже (проверено 2026-10-08),
// поэтому зонд сразу скажет «сеть закрыта», а не будет листать капчу.
// Светофору переключение магазина не нужно: у каждого региона свой поддомен,
// а каталог с ценами лежит по адресу /cache/offers-<shopid>-<offersupd>.json.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '.playwright-browsers';

const network = process.argv[2];
const outDir = resolve(process.cwd(), '.agent/reference/probe');
mkdirSync(outDir, { recursive: true });

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`таймаут: ${label}`)), ms))]);

async function perekrestok() {
  console.log('=== Перекрёсток ===');
  const { firefox } = await import('playwright');
  const browser = await firefox.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await ctx.newPage();
    await withTimeout(
      page.goto('https://www.perekrestok.ru/', { waitUntil: 'commit', timeout: 60000 }),
      90000,
      'загрузка главной',
    );
    await page.waitForTimeout(12000);
    const url = page.url();
    const title = await page.title().catch(() => '');
    console.log(`  попали на: ${url.slice(0, 110)}`);
    console.log(`  заголовок: ${title.slice(0, 80) || '(пусто)'}`);
    const cookies = await ctx.cookies();
    const captcha = /xpvnsulc|rndcaptcha|is-robot|капч/i.test(url + title + cookies.map((c) => c.name).join(','));
    if (captcha) {
      console.log('  ВЕРДИКТ: открылась антибот-страница (X5, /xpvnsulc/). Сеть закрыта для чтения.');
      console.log('  Это не зависит от адреса: та же страница пришла и из домашней сети.');
      console.log('  Перекрёсток вычеркиваем, дальше работаем с Чижиком и Светофором.');
      return;
    }
    console.log('  ВЕРДИКТ: приложение открылось. Стоит снять список запросов и ключи.');
    console.log(`  куки: ${cookies.map((c) => c.name).join(', ')}`);
    const html = await page.content().catch(() => '');
    for (const k of ['sapCode', 'storeId', 'shopCode', '5d.5ka.ru', 'catalog/v', 'x-tenant-id', 'tc4_store_id']) {
      console.log(`    ${k}: ${html.includes(k) ? 'есть' : '—'}`);
    }
    writeFileSync(resolve(outDir, 'perekrestok.html'), html);
  } finally {
    await browser.close();
  }
}

async function svetofor() {
  console.log('=== Светофор ===');
  const home = await withTimeout(
    fetch('https://svetoforonline.ru/', { headers: { 'User-Agent': UA } }).then((r) => r.text()),
    60000,
    'загрузка главной',
  );
  const shopid = (home.match(/var shopid=(\d+)/) || [])[1] ?? '—';
  const stamp = (home.match(/var offersupd=(\d+)/) || [])[1] ?? '—';
  const region = (home.match(/geomapStartRegion=(\d+)/) || [])[1] ?? '—';
  const address = (home.match(/"streetAddress"\s*:\s*"([^"]+)"/) || [])[1] ?? '—';
  console.log(`  твой магазин: shopid=${shopid}, метка каталога offersupd=${stamp}`);
  console.log(`  регион в шапке: ${region}`);
  console.log(`  адрес: ${address}`);

  const shops = await withTimeout(
    fetch('https://svetoforonline.ru/api.php?mode=getShops', { headers: { 'User-Agent': UA } })
      .then((r) => r.json())
      .catch(() => ({ shops: [] })),
    60000,
    'список магазинов',
  );
  const list = shops.shops ?? [];
  console.log(`\n  магазинов в сети: ${list.length}`);
  const byDomain = new Map();
  for (const s of list) {
    const d = s.domain ?? '—';
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(s);
  }
  console.log(`  регионов (поддоменов): ${byDomain.size}`);
  console.log('  как читать чужой город — поддомен региона + его магазин:');
  for (const [d, items] of [...byDomain.entries()].slice(0, 12)) {
    const s = items[0];
    console.log(`    https://${d}.svetoforonline.ru  → магазинов ${items.length}, пример id=${s.id} «${String(s.name).trim().slice(0, 34)}»`);
  }

  // Проверяем, что каталоги читаются по этому правилу
  console.log('\n=== проверка чтения каталога по правилу ===');
  for (const d of [...byDomain.keys()].slice(0, 3)) {
    const host = `https://${d}.svetoforonline.ru`;
    try {
      const h = await withTimeout(fetch(host, { headers: { 'User-Agent': UA } }).then((r) => r.text()), 45000, host);
      const sid = (h.match(/var shopid=(\d+)/) || [])[1];
      const st = (h.match(/var offersupd=(\d+)/) || [])[1];
      if (!sid || !st) {
        console.log(`  ${d}: магазин не определён (shopid=${sid}, offersupd=${st})`);
        continue;
      }
      const json = await withTimeout(
        fetch(`${host}/cache/offers-${sid}-${st}.json`, { headers: { 'User-Agent': UA } }).then((r) => r.text()),
        45000,
        `каталог ${d}`,
      );
      let count = 0;
      let sample = '';
      try {
        const j = JSON.parse(json);
        // Прайс — МАССИВ строк (проверено живьём 2026-10-08). Раньше зонд брал
        // Object.keys, и на массиве это давало индексы вместо товаров, то есть
        // зонд показывал мусор и не мог увидеть дрейф формата.
        const rows = Array.isArray(j) ? j : Object.values(j);
        count = rows.length;
        const first = rows[0] ?? {};
        const dates = rows.map((r) => r?.d).filter(Boolean);
        const newest = dates.length > 0 ? new Date(Math.max(...dates) * 1000).toISOString().slice(0, 10) : '—';
        sample = `${first.name ?? '—'} — ${(first.p ?? 0) / 100} ₽ (арт. ${first.articul ?? '—'}), свежайшая позиция ${newest}`;
      } catch {
        sample = json.slice(0, 60);
      }
      console.log(`  ${d}: shopid=${sid}, товаров ${count}${count ? `, пример: ${sample.slice(0, 76)}` : ''}`);
    } catch (e) {
      console.log(`  ${d}: ${e.message.slice(0, 70)}`);
    }
  }
  console.log('\n  Значит: магазин подставляется поддоменом региона, цены лежат в статическом JSON.');
  console.log('  Ничего кликать не нужно — адаптер будет читать эти адреса сам.');
}

try {
  if (network === 'perekrestok') await perekrestok();
  else if (network === 'svetofor') await svetofor();
  else console.log('usage: node scripts/probe-new-stores.mjs <perekrestok|svetofor>');
} catch (err) {
  console.error(`зонд упал: ${err.message}`);
  process.exit(1);
}