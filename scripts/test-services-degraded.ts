// Тесты ядра в НЕИСПРАВНОМ окружении. Обычные тесты проверяют, что ядро умеет
// работать; этот файл — что оно не врёт и не падает, когда всё сломалось:
// база недоступна, диск только для чтения, кэш витрины протух или повреждён.
//
// Именно эти ветки решают, увидит ли пользователь «цены показаны, но в историю не
// записаны» или пустой экран, поэтому они не должны остаться непроверенными.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCore } from '../src/core/services.js';
import { closeDb, openDb } from '../src/core/db/db.js';
import { fileStorageAt } from '../electron/node-files.js';
import type { ScrapedProduct, StoreAdapter, StoreCategory } from '../src/shared/types.js';
import type { CoreDeps } from '../src/core/platform.js';

type SearchCtx = Parameters<StoreAdapter['search']>[1];

const item = (canonicalId: string, name: string, price: number): ScrapedProduct => ({
  canonicalId,
  storeId: 'magnit',
  city: 'moscow',
  name,
  unit: '1 шт',
  price,
  promoPrice: null,
  oldPrice: null,
  inStock: true,
  url: 'https://magnit.ru/product/1',
  collectedAt: '2026-10-02T10:00:00.000Z',
});

class FakeAdapter implements StoreAdapter {
  readonly storeId = 'magnit' as const;
  categoryCalls = 0;
  failCategory = false;
  categories: StoreCategory[] = [];

  constructor(private readonly items: ScrapedProduct[]) {}

  async search(query: string, ctx: SearchCtx): Promise<ScrapedProduct[]> {
    return this.items
      .filter((i) => i.name.toLowerCase().includes(query.toLowerCase()))
      .map((i) => ({ ...i, city: ctx.city, storeId: 'magnit' }));
  }

  async fetchCategories(): Promise<StoreCategory[]> {
    this.categoryCalls += 1;
    if (this.failCategory) throw new Error('magnit: каталог недоступен');
    return this.categories;
  }

  async fetchProduct(canonicalId: string, ctx: Parameters<StoreAdapter['fetchProduct']>[1]): Promise<ScrapedProduct> {
    const found = this.items.find((i) => i.canonicalId === canonicalId);
    if (!found) throw new Error(`magnit: товар ${canonicalId} не найден`);
    return { ...found, city: ctx.city, storeId: 'magnit' };
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-degr-'));
const real = fileStorageAt(path.join(tmpDir, 'd.db'));
const jsonFiles = new Map<string, string>();
const logs: string[] = [];

// Одно хранилище на весь файл: openDb — синглтон на процесс, второе хранилище
// он не примет. Поэтому «поломки» включаются флагами, а не подменой объекта.
let failRead = false;
let failWrite = false;
const storage = {
  readDb: (): Uint8Array | null => {
    if (failRead) throw new Error('диск недоступен');
    return real.readDb();
  },
  writeDb: (bytes: Uint8Array): void => {
    if (failWrite) throw new Error('диск только для чтения');
    real.writeDb(bytes);
  },
};

const magnit = new FakeAdapter([
  item('d-milk', 'Молоко ПРАВИЛЬНОЕ 3,2%, 930мл', 119),
  item('d-cheese', 'Сыр Hochland Сливочный 55% 200г', 229),
]);
magnit.categories = [{ id: 'c1', name: 'Молоко', url: 'https://magnit.ru/catalog/1-', imageUrl: 'https://img/c1.webp' }];

const deps: CoreDeps = {
  storage,
  json: {
    read: (name) => jsonFiles.get(name) ?? null,
    write: (name, text) => void jsonFiles.set(name, text),
  },
  shell: { version: () => '1.2.1', notify: () => {}, openExternal: async () => {} },
  background: { every: () => {}, after: () => {} },
  log: { error: (...a) => void logs.push(a.join(' ')), warn: () => {}, info: () => {} },
  adapters: new Map([['magnit', magnit]]),
  emit: () => {},
};

const core = createCore(deps);
core.setCurrentCity('moscow');

// --- 1. Каталог сломан, кэша нет: категория недоступна, но сеть видна. -------
{
  magnit.failCategory = true;
  const rows = await core.getCatalogs({ city: 'moscow' });
  const row = rows.find((c) => c.storeId === 'magnit');
  assert.deepEqual(row?.categories, [], 'без кэша и без сети витрина пустая');
  assert.match(row?.error ?? '', /каталог недоступен/, 'и видно почему');
  magnit.failCategory = false;
}

// --- 2. Витрина без картинок в кэш не кладётся: пустые плитки на неделю. ----
// Правило из 30.09 (Магнит 303857): сеть один раз отдала 40 категорий без
// картинок, и недельная TTL закрепила бы пустые плитки на семь суток.
{
  magnit.categories = [{ id: 'c2', name: 'Сыр', url: 'https://magnit.ru/catalog/2-', imageUrl: '' }];
  const rows = await core.getCatalogs({ city: 'moscow' });
  assert.equal(rows.find((c) => c.storeId === 'magnit')?.categories.length, 1, 'витрина показана');
  const key = [...jsonFiles.keys()].find((k) => k.includes('magnit'))!;
  jsonFiles.delete(key);
  const calls = magnit.categoryCalls;
  await core.getCatalogs({ city: 'moscow' });
  assert.equal(magnit.categoryCalls, calls + 1, 'но в кэш не попала — лучше лишний раз в сеть, чем пустые плитки');
  magnit.categories = [{ id: 'c1', name: 'Молоко', url: 'https://magnit.ru/catalog/1-', imageUrl: 'https://img/c1.webp' }];
}

// --- 3. Первый успешный каталог пишет кэш; следующий запрос сети не трогает.
{
  const fresh = await core.getCatalogs({ city: 'moscow' });
  assert.equal(fresh.find((c) => c.storeId === 'magnit')?.categories.length, 1, 'каталог получен');
  const calls = magnit.categoryCalls;
  await core.getCatalogs({ city: 'moscow' });
  assert.equal(magnit.categoryCalls, calls, 'кэш свежий — сеть не дёрнута');

  const key = [...jsonFiles.keys()].find((k) => k.includes('magnit'));
  assert.ok(key, 'кэш лежит в отдельном файле на город и магазин');
  const cached = JSON.parse(jsonFiles.get(key!) ?? '{}') as { at: number; categories: unknown };
  assert.equal(typeof cached.at, 'number', 'в кэше есть метка времени');
  assert.ok(Array.isArray(cached.categories), 'и сами категории');
}

// --- 4. Повреждённый кэш не показывает пустую витрину — идёт в сеть. --------
{
  const key = [...jsonFiles.keys()].find((k) => k.includes('magnit'))!;
  jsonFiles.set(key, '{ это не json');
  const calls = magnit.categoryCalls;
  const rows = await core.getCatalogs({ city: 'moscow' });
  assert.equal(magnit.categoryCalls, calls + 1, 'битый кэш приводит к запросу сети, а не к пустой полке');
  assert.equal(rows.find((c) => c.storeId === 'magnit')?.categories.length, 1, 'витрина восстановлена');
}

// --- 5. Протухший кэш и отказ сети: отдаём протухшее, но не выдумываем. ----
{
  const key = [...jsonFiles.keys()].find((k) => k.includes('magnit'))!;
  const cached = JSON.parse(jsonFiles.get(key)!) as { at: number; categories: unknown };
  jsonFiles.set(key, JSON.stringify({ ...cached, at: Date.now() - 30 * 24 * 3600 * 1000 }));

  magnit.failCategory = true;
  const stale = await core.getCatalogs({ city: 'moscow' });
  const row = stale.find((c) => c.storeId === 'magnit');
  assert.equal(row?.categories.length, 1, 'протухшая витрина лучше пустой: старые товары ещё годны');
  assert.equal(row?.error, undefined, 'и показывается спокойно, без страшной ошибки');
  magnit.failCategory = false;

  // Тот же протухший кэш при живой сети: сеть отвечает, кэш обновляется.
  const refetched = await core.getCatalogs({ city: 'moscow' });
  assert.equal(refetched.find((c) => c.storeId === 'magnit')?.categories.length, 1, 'сеть перебила протухший кэш');
  const fresh = JSON.parse(jsonFiles.get(key)!) as { at: number };
  assert.ok(Date.now() - fresh.at < 60_000, 'и кэш перезаписан свежей меткой времени');
}

// --- 6. База недоступна: цены показываются, но честно помечены, что не записаны.
{
  failRead = true;
  const rows = await core.searchPrices({ query: 'молоко' });
  failRead = false;
  const row = rows.find((s) => s.storeId === 'magnit');
  assert.equal(row?.items.length, 1, 'цены из сети всё равно показаны — пропадать им незачем');
  assert.match(row?.error ?? '', /цены показаны, но в историю не записаны/, 'но интерфейс знает, что истории не будет');
  assert.ok(logs.length > 0, 'причина залогирована, а не съедена молча');
}

// --- 7. Диск только для чтения: сохранение падает тихо, работа продолжается.
{
  failWrite = true;
  const rows = await core.searchPrices({ query: 'молоко' });
  failWrite = false;
  assert.equal(rows.find((s) => s.storeId === 'magnit')?.items.length, 1, 'поиск не сломался');
  assert.ok(
    logs.some((l) => l.includes('persist failed')),
    'а невозможность сохранить базу залогирована',
  );
  const status = core.schedulerStatus();
  assert.equal(status.running, false, 'планировщик после этого тоже не считает себя занятым');
}

// --- 8. Опрос при недоступной записи: сводка честная, состояние не «зелено».
{
  failWrite = true;
  const res = await core.runScheduler({ city: 'moscow' });
  failWrite = false;
  assert.match(res.summary, /Опрос не удался/, 'невозможность сохранить базу видна в сводке, а не прячется за «завершён»');
  assert.equal(res.status.running, false, 'и планировщик освободился');
}

closeDb();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('core degraded: ALL GREEN — нет базы, нет записи, битый и протухший кэш витрины');