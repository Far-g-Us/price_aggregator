// Браузерный транспорт на фейках: поднимаем настоящий код 5ka-browser и
// отката Магнита в Playwright без Firefox и без сети.
//
// Зачем: до этого файла браузерный слой (37% `5ka-browser.ts` и два отката в
// `magnit.ts`) не был закрыт ничем — он исполняется только в настоящем браузере,
// а проверить его юнит-тестами было нечем. Фейк даёт то же самое дерево
// `browser → context → page`, поэтому видны все решения кода: как определяется
// магазин, что считается блокировкой, когда рвётся сессия, что происходит с
// не-JSON и с товаром, которого нет в данных страницы.
//
// Чего фейк НЕ проверяет: реальную вёрстку сайта. Это остаётся за живыми
// пробами — здесь проверяется логика, а не HTML.
import assert from 'node:assert';
import fs from 'node:fs';
import {
  browserCategories,
  browserCategoryProducts,
  browserFetchProduct,
  browserSearch,
  close5kaBrowser,
  detectStore,
  storeCodesFromNextData,
} from '../src/core/adapters/5ka-browser.js';
import { MagnitAdapter } from '../src/core/adapters/magnit.js';
import { PyaterochkaAdapter } from '../src/core/adapters/pyaterochka.js';
import { __setPlaywrightForTests } from '../src/core/adapters/playwright-port.js';

// Витрина Магнита обязана содержать код дважды: в кавычках (его ищет проверка
// отрендеренной страницы) и в query-ссылке (её ищет разбор витрины).
const MAGNIT_HTML =
  '<html><body><script>{"shopCode":"473996"}</script><a href="/catalog/?shopCode=473996">витрина</a></body></html>';

const realFetch = globalThis.fetch;
let fetchMode: 'fail' | 'empty' = 'fail';
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
  if (fetchMode === 'fail') throw new Error(`fake fetch: сеть недоступна (${url})`);
  return {
    ok: true,
    status: 200,
    url,
    text: async () => MAGNIT_HTML,
  } as unknown as Response;
}) as typeof fetch;

const json = (name: string): unknown => JSON.parse(fs.readFileSync(`tests/fixtures/${name}`, 'utf8'));
const searchFixture = json('5ka-search.json') as { products: Record<string, unknown>[] };

// ─── Фейковый Playwright ──────────────────────────────────────────────────
type Canned = { url: string; status?: number; body?: unknown; text?: string; html?: string };

// Таймеры ожиданий живут между кейсами: страница, которая бросила сессию,
// не должна «отстрелять» отказ уже во время следующего теста.
const liveTimers = new Set<ReturnType<typeof setTimeout>>();

interface Waiter {
  pred: (r: FakeResponse) => boolean;
  resolve: (r: FakeResponse) => void;
  timer: NodeJS.Timeout;
}

class FakeResponse {
  constructor(
    private readonly canned: Canned,
    readonly page: FakePage,
  ) {}
  url(): string {
    return this.canned.url;
  }
  status(): number {
    return this.canned.status ?? 200;
  }
  async text(): Promise<string> {
    return this.canned.text ?? (typeof this.canned.body === 'string' ? this.canned.body : JSON.stringify(this.canned.body ?? ''));
  }
  async json(): Promise<unknown> {
    // Разбираем ровно то, что вернул бы text(): не-JSON обязан падать здесь, как
    // в настоящем ответе, иначе проверка «страница не-JSON» ничего не проверяет.
    return JSON.parse(await this.text());
  }
}

class FakeElement {
  constructor(private readonly onFill: (v: string) => void) {}
  async fill(v: string): Promise<void> {
    this.onFill(v);
  }
  async press(): Promise<void> {}
}

type Selector = string | { state?: string };

class FakePage {
  constructor(readonly canned: Canned[]) {}

  visited: string[] = [];
  fills: string[] = [];
  selectors = new Map<string, FakeElement>();
  titleText = '';
  html = '';
  nextData = '';
  /** Когда true, селектор карточек не находится — как на пустой витрине. */
  selectorMissing = false;
  /** Куда страница реально ходила: проверяем, что Магнит открывает `term`. */
  private waiters: Waiter[] = [];

  async goto(url: string): Promise<FakeResponse | null> {
    this.visited.push(url);
    // HTML отдаём по первому canned с разметкой: адрес навигации может отличаться
    // от ключа фикстуры (например, параметры закодированы), а страница одна.
    this.html = this.canned.find((c) => c.url === url)?.html ?? this.canned.find((c) => c.html)?.html ?? this.html;
    this.serve();
    const direct = this.canned.find((c) => c.url === url);
    return direct ? new FakeResponse(direct, this) : null;
  }

  async reload(): Promise<null> {
    this.serve();
    return null;
  }

  /** Выдать каждому ожидающему тот от canned, чей URL подходит под предикат. */
  private serve(): void {
    for (const w of [...this.waiters]) {
      const hit = this.canned.find((c) => w.pred(new FakeResponse(c, this)));
      if (!hit) continue;
      clearTimeout(w.timer);
      liveTimers.delete(w.timer);
      this.waiters = this.waiters.filter((x) => x !== w);
      w.resolve(new FakeResponse(hit, this));
    }
  }

  async waitForResponse(
    pred: (r: FakeResponse) => boolean,
    opts: { timeout?: number } = {},
  ): Promise<FakeResponse> {
    const hit = this.canned.find((c) => pred(new FakeResponse(c, this)));
    if (hit) return new FakeResponse(hit, this);
    return new Promise<FakeResponse>((resolve, reject) => {
      const w: Waiter = { pred, resolve, timer: setTimeout(() => {}, 0) as unknown as NodeJS.Timeout };
      const timer = setTimeout(() => {
        liveTimers.delete(timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error('fake waitForResponse: таймаут'));
      }, opts.timeout ?? 1000);
      liveTimers.add(timer);
      w.timer = timer;
      this.waiters.push(w);
    });
  }

  async title(): Promise<string> {
    return this.titleText;
  }

  async waitForTimeout(): Promise<void> {}

  async waitForSelector(selector: Selector): Promise<FakeElement> {
    const key = typeof selector === 'string' ? selector : '#__NEXT_DATA__';
    if (key === '#__NEXT_DATA__') return new FakeElement(() => {});
    if (this.selectorMissing) throw new Error('fake: селектор не найден');
    const el = new FakeElement((v) => this.fills.push(v));
    this.selectors.set(key, el);
    return el;
  }

  async content(): Promise<string> {
    return this.html;
  }

  async evaluate<T>(fn: (arg: never) => T, arg?: unknown): Promise<T> {
    return (fn as (a: unknown) => T)(arg);
  }
}

class FakeContext {
  constructor(readonly page: FakePage) {}
  cookiesList: { name: string; value: string }[] = [];

  async newPage(): Promise<FakePage> {
    return this.page;
  }

  async cookies(_url: string): Promise<{ name: string; value: string }[]> {
    return this.cookiesList;
  }

  async addCookies(cookies: { name: string; value: string }[]): Promise<void> {
    this.cookiesList = cookies;
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
  closed = 0;
}

class FakeBrowser {
  closed = 0;
  constructor(readonly context: FakeContext) {}
  async newContext(): Promise<FakeContext> {
    return this.context;
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

interface Harness {
  page: FakePage;
  context: FakeContext;
  browser: FakeBrowser;
}

let launches = 0;
let current: Harness | null = null;

const install = (canned: Canned[], opts: { title?: string; cookie?: string } = {}): Harness => {
  for (const t of liveTimers) clearTimeout(t);
  liveTimers.clear();
  const page = new FakePage(canned);
  page.titleText = opts.title ?? 'Пятёрочка';
  const context = new FakeContext(page);
  if (opts.cookie) context.cookiesList = [{ name: '5ka_store_id_store', value: opts.cookie }];
  const browser = new FakeBrowser(context);
  launches = 0;
  current = { page, context, browser };
  __setPlaywrightForTests({
    firefox: {
      launch: async () => {
        launches += 1;
        return browser;
      },
    },
    chromium: {
      launch: async () => {
        launches += 1;
        return browser;
      },
    },
  } as unknown as typeof import('playwright'));
  return current;
};

// document нужен коду внутри page.evaluate: он исполняется в Node, но ходит в
// глобальный document, как это было бы в странице.
const setNextData = (jsonText: string | string[]): void => {
  const queue = Array.isArray(jsonText) ? [...jsonText] : [jsonText];
  let reads = 0;
  (globalThis as { document?: unknown }).document = {
    querySelectorAll: () => [],
    getElementById: (id: string) => {
      if (id !== '__NEXT_DATA__') return null;
      const current = queue[Math.min(reads, queue.length - 1)];
      reads += 1;
      return { textContent: current ?? null };
    },
  };
};
const dropDocument = (): void => {
  delete (globalThis as { document?: unknown }).document;
};

// Ответ без снимка страницы: Next.js не дописал данные. Код обязан пережить это,
// а не считать страницу чуждой.
const withEmptyDocument = (): void => {
  (globalThis as { document?: unknown }).document = {
    querySelectorAll: () => [],
    getElementById: () => null,
  };
};

// Отрендеренная карточка Магнина: тексты с ценой лежат в листьях, ссылка —
// в a[title], картинка — в img.
const articleEl = () => ({
  querySelector: (sel: string) =>
    sel === 'a[title]'
      ? { getAttribute: (a: string) => (a === 'title' ? 'Молоко Простоквашино 2,5% 930мл' : '/product/123-moloko?shopCode=473996') }
      : sel === 'img'
        ? { getAttribute: () => '/images/milk.jpg', currentSrc: '', src: '/images/milk.jpg' }
        : null,
  querySelectorAll: (sel: string) =>
    sel === '*'
      ? [
          { children: [], textContent: 'Молоко Простоквашино' },
          { children: [], textContent: '119 ₽' },
          { children: [], textContent: '149 ₽' },
        ]
      : [],
});

// Вторая карточка — намеренно бедная: без ссылки, без картинки и с текстом
// безChildren. Вёрстка такие плитки бывает, и код обязан их пережить.
const sparseArticleEl = () => ({
  querySelector: (sel: string) =>
    sel === 'a[title]' ? { getAttribute: () => '' } : null,
  querySelectorAll: (sel: string) =>
    sel === '*'
      ? [
          { children: [{}], textContent: '99 ₽' },
          { children: [], textContent: null },
        ]
      : [],
});


const CATALOG = (sap: string, tail: string): string => `https://5d.5ka.ru/api/catalog/v4/stores/${sap}/${tail}`;
const ctx = { city: 'moscow', externalStoreId: '35XY' };
const warns: string[] = [];
const realWarn = console.warn;
console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(' '));

// ─── 1. Определение магазина: кука, каталог, отсутствие ────────────────────
{
  // Куки нет, но каталог назвал наш магазин.
  assert.equal(
    await detectStore({ cookies: async () => [] }, '35XY', Promise.resolve('35XY'), 5000),
    '35XY',
    'код из каталога — фолбэк',
  );

  // Каталог назвал чужой магазин: возвращаем чужой код, а не «настроенный».
  // Вызывающий решает, что сказать, — молча подменить код нельзя.
  assert.equal(
    await detectStore({ cookies: async () => [] }, '35XY', Promise.resolve('30ML'), 5),
    '30ML',
    'чужой код из каталога возвращается, а не прячется',
  );

  // Источников нет вообще — вот тут null.
  assert.equal(
    await detectStore({ cookies: async () => [] }, '35XY', Promise.resolve(null), 5),
    null,
    'без источников возвращается null, и вызывающий решает, что говорить',
  );

  // Отказ слушателя каталога не должен ронять определение магазина.
  assert.equal(
    await detectStore(
      { cookies: async () => [{ name: '5ka_store_id_store', value: '35XY' }] },
      '35XY',
      Promise.reject(new Error('таймаут')),
      5000,
    ),
    '35XY',
    'упавший слушатель каталога не мешает куке',
  );
}// ─── 2. Сессия строится и переиспользуется ───────────────────────────────
{
  const h = install(
    [
      { url: CATALOG('35XY', 'categories'), body: [] },
      { url: CATALOG('35XY', 'search?mode=store&q=молоко'), body: { products: searchFixture.products.slice(0, 2) } },
    ],
    { cookie: '35XY' },
  );
  const items = await browserSearch('молоко', ctx);
  assert.equal(items.length, 2, 'поиск вернул товары из перехваченного ответа каталога');
  assert.equal(launches, 1, 'браузер поднят один раз');
  await browserSearch('молоко', ctx);
  assert.equal(launches, 1, 'вторая выдача едет на той же сессии');
  assert.ok(
    h.page.fills.length >= 2 && h.page.fills.every((f) => f === 'молоко'),
    'запрос введён в поле поиска, а не в URL — обе выдачи так и сделали',
  );
  await close5kaBrowser();
  assert.equal(h.browser.closed, 1, 'close5kaBrowser закрыл браузер');
  const before = launches;
  await browserSearch('молоко', ctx);
  assert.equal(launches, before + 1, 'после close сессия не переиспользуется — браузер поднят заново');
  await close5kaBrowser();
}

// ─── 3. Магазин не тот: громкий отказ, сессия не публикуется ──────────────
{
  const h = install([{ url: CATALOG('30ML', 'categories'), body: [] }], { cookie: '30ML' });
  await assert.rejects(
    () => browserSearch('молоко', ctx),
    /браузер работает с магазином 30ML, а настроен 35XY/,
    'чужая точка не принимается молча',
  );
  assert.equal(h.browser.closed, 1, 'браузер закрыт, сессия не осталась висеть');
  await close5kaBrowser();
}

// ─── 4. Сайт отдаёт блокировку по IP ─────────────────────────────────────
{
  const h = install([{ url: CATALOG('35XY', 'categories'), body: [] }], {
    cookie: '35XY',
    title: 'Доступ запрещён',
  });
  await assert.rejects(() => browserSearch('молоко', ctx), /блокировку по IP/);
  assert.equal(h.browser.closed, 1, 'браузер закрыт после блокировки');
  await close5kaBrowser();
}

// ─── 5. Сайт не назвал магазин ───────────────────────────────────────────
{
  install([{ url: CATALOG('30ML', 'categories'), body: [] }], { cookie: '' });
  await assert.rejects(
    () => browserSearch('молоко', ctx),
    /не определил магазин|работает с магазином/,
    'без куки и без своего кода в каталоге мы не выдумываем магазин',
  );
  await close5kaBrowser();
}

// ─── 6. Категории: только дети, картинки фильтруются, пусто — ошибка ───────
{
  const tree = [
    { id: 'root', name: 'Корень', categories: [{ id: '251C17045', name: 'Молоко', image_link: 'https://img/x.webp' }] },
    { id: 'root2', name: 'Корень2', categories: [{ id: '2', name: 'Без картинки', image_link: 'data:image/png;base64,AAA' }] },
    { id: 'root3', name: 'Дубли', categories: [{ id: '251C17045', name: 'Молоко', image_link: 'https://img/y.webp' }] },
  ];
  const h = install([{ url: CATALOG('35XY', 'categories'), body: tree }], { cookie: '35XY' });
  const cats = await browserCategories({ externalStoreId: '35XY' });
  assert.equal(cats.length, 2, 'дубли по id пропали, верхние узлы не попали (у них нет картинок)');
  assert.equal(cats[0]?.url, 'https://5ka.ru/catalog/251C17045/', 'адрес короткий, по id');
  assert.equal(cats[0]?.imageUrl, 'https://img/x.webp', 'картинка сохранена');
  assert.equal(cats[1]?.imageUrl, undefined, 'data:-картинка отброшена');
  void h;
  await close5kaBrowser();

  install([{ url: CATALOG('35XY', 'categories'), body: [] }], { cookie: '35XY' });
  await assert.rejects(
    () => browserCategories({ externalStoreId: '35XY' }),
    /категории пусты/,
    'пустой каталог — смена вёрстки, а не «нет категорий»',
  );
  await close5kaBrowser();
}

// ─── 7. Товары категории: перехват ответа, пусто, негодные позиции ────────
{
  const good = { products: searchFixture.products.slice(0, 3) };
  const url = 'https://5d.5ka.ru/api/catalog/v2/stores/35XY/categories/251C17045/products';
  install([{ url, body: good }], { cookie: '35XY' });
  const items = await browserCategoryProducts('https://5ka.ru/catalog/251C17045/', ctx);
  assert.ok(items.length > 0, 'товары категории пришли');
  assert.ok(items.every((i) => i.storeId === 'pyaterochka'), 'сеть проставлена');
  await close5kaBrowser();

  install([{ url, body: { products: [] } }], { cookie: '35XY' });
  await assert.rejects(
    () => browserCategoryProducts('https://5ka.ru/catalog/251C17045/', ctx),
    /не отдал товары категории/,
    'пустой ответ категории — устаревшая ссылка, а не пустая полка',
  );
  await close5kaBrowser();

  install([{ url, body: { products: [{ plu: 1, name: 'Без цены', prices: { regular: null } }] } }], { cookie: '35XY' });
  await assert.rejects(
    () => browserCategoryProducts('https://5ka.ru/catalog/251C17045/', ctx),
    /ни одна не пригодна/,
    'позиции без цены — смена ответа, а не «товаров нет»',
  );
  await close5kaBrowser();

  install([], { cookie: '35XY' });
  await assert.rejects(
    () => browserCategoryProducts('https://example.com/catalog/x/', ctx),
    /categoryUrl вне каталога/,
    'чужая ссылка отвергается до похода в браузер',
  );
  await close5kaBrowser();
}

// ─── 8. Карточка товара: данные из __NEXT_DATA__, сверка магазина ──────────
{
  const plu = 4439523;
  const product = searchFixture.products.find((p) => Number(p.plu) === plu)!;
  const next = JSON.stringify({
    props: { pageProps: { props: { productStore: JSON.stringify({ product }) } } },
    store: { sapCode: '35XY' },
  });
  const h = install([{ url: CATALOG('35XY', 'categories'), body: [] }], { cookie: '35XY' });
  setNextData(next);
  const fetched = await browserFetchProduct(String(plu), ctx);
  assert.equal(fetched.canonicalId, `5ka-${plu}`, 'id тот же');
  assert.ok(fetched.price > 0, 'цена пришла из данных страницы');
  assert.ok(warns.length === 0, 'на странице ровно один код — предупреждения не было');
  void h;
  await close5kaBrowser();

  await assert.rejects(
    () => browserFetchProduct('не-число', ctx),
    /bad plu/,
    'нечисловой plu отвергается до похода в браузер',
  );
  dropDocument();

  // Финальный снимок страницы назвал чужую точку — цена была бы не наша.
  // Ранний снимок ещё наш (именно так и выглядит подмена на SPA).
  // Порядок чтений в коде: ранний снимок → разбор товара → финальный снимок.
  setNextData([
    JSON.stringify({ store: { sapCode: '35XY' } }),
    next,
    JSON.stringify({ store: { sapCode: '30ML' } }),
  ]);
  install([{ url: CATALOG('35XY', 'categories'), body: [] }], { cookie: '35XY' });
  await assert.rejects(
    () => browserFetchProduct(String(plu), ctx),
    /страница назвала магазины 30ML/,
    'финальная сверка страницы ловит чужой магазин, даже если ранний снимок был наш',
  );
  await close5kaBrowser();
  dropDocument();

  // Источники называют разные магазины — падаем, а не выбираем «удобный».
  setNextData(next);
  const h2 = install([{ url: CATALOG('30ML', 'categories'), body: [] }], { cookie: '30ML' });
  await assert.rejects(
    () => browserFetchProduct(String(plu), { ...ctx, externalStoreId: '30ML' }),
    /источники называют разные магазины|магазин сменился/,
    'расхождение источников — громкий отказ',
  );
  void h2;
  await close5kaBrowser();
  dropDocument();
}

// ─── 9. Карточка не появилась в данных страницы ─────────────────────────
{
  install([{ url: CATALOG('35XY', 'categories'), body: [] }], { cookie: '35XY' });
  setNextData('{"props":{}}');
  const realNow = Date.now;
  // Часы идут быстрее реальных: ждать 20 с в тесте незачем, важна ветка.
  // Шаг чуть больше половины PRODUCT_WAIT_MS (10 с): и ожидание товара
  // выходит сразу, и определение магазина (дедлайн 30 с) успевает найти куку.
  let clock = realNow();
  Date.now = () => (clock += 4_000);
  try {
    await assert.rejects(
      () => browserFetchProduct('4439523', ctx),
      /не появился в данных страницы/,
      'товара нет в данных страницы — товар не выдумывается',
    );
  } finally {
    Date.now = realNow;
  }
  await close5kaBrowser();
  dropDocument();
}

// ─── 10. storeCodesFromNextData: коды со страницы ────────────────────────
{
  const codes = storeCodesFromNextData(
    JSON.stringify({ a: { storeId: '35XY' }, b: [{ sapCode: '30ML' }], c: 'просто строка' }),
  );
  assert.deepEqual(
    [...codes].sort(),
    ['30ML', '35XY'],
    'коды собраны со страницы по всем ключам (storeId/sapCode), порядок обхода не важен',
  );
  assert.deepEqual(
    storeCodesFromNextData('не JSON вовсе'),
    [],
    'битый снимок страницы даёт пустой список, а не исключение',
  );
  assert.deepEqual(
    storeCodesFromNextData(JSON.stringify({ storeId: 'ab', deep: { a: { b: { c: { shopId: '35XY' } } } } })),
    ['35XY'],
    'код находится и в глубине снимка',
  );
}

// document для чтения карточек Магнита: одна отрендеренная карточка.
const withCardDom = (): void => {
  (globalThis as { document?: unknown }).document = {
    querySelectorAll: (sel: string) =>
      sel === 'article.unit-catalog-product-preview' ? [articleEl(), sparseArticleEl()] : [],
    getElementById: () => null,
  };
};

// ─── 11. Откат Магнита в браузер: поиск ──────────────────────────────────
// fetch в этом файле всегда падает, поэтому Магнит обязан уйти в браузер.
// Без куда деваться: откат это не украшение, а рабочий путь на клиентском
// рендере, и он должен возвращать товары с ценой, старой ценой и картинкой.
{
  withCardDom();
  const h = install([{ url: 'https://magnit.ru/search?term=молоко', html: MAGNIT_HTML }], { title: 'Магнит' });
  const adapter = new MagnitAdapter();
  const items = await adapter.search('молоко', { city: 'moscow', externalStoreId: '473996' });
  assert.ok(items.length > 0, 'откат в браузер вернул товары из отрендеренной витрины');
  assert.equal(items[0]?.price, 119, 'цена разобрана из карточки');
  assert.equal(items[0]?.oldPrice, 149, 'старая цена тоже');
  assert.equal(items[0]?.imageUrl, '/images/milk.jpg', 'картинка из карточки');
  assert.equal(items[0]?.storeId, 'magnit', 'сеть проставлена адаптером');
  assert.ok(
    h.page.visited.every((u) => u.includes('term=')),
    'открыт /search?term=, а не ?query= — с query сайт отдаёт популярные товары',
  );
  await close5kaBrowser();
  dropDocument();
}

// ─── 12. Откат Магнита в браузер: витрина по ссылке категории ─────────────
{
  withCardDom();
  // Сеть ответила, но без разметки товаров — тогда Магнит идёт в браузер.
  fetchMode = 'empty';
  install([{ url: 'https://magnit.ru/catalog/1-', html: MAGNIT_HTML }], { title: 'Магнит' });
  const adapter = new MagnitAdapter();
  const items = await adapter.fetchCategoryProducts('https://magnit.ru/catalog/1-', {
    city: 'moscow',
    externalStoreId: '473996',
  });
  assert.ok(items.length > 0, 'откат в браузер вернул товары витрины');
  assert.equal(items[0]?.price, 119, 'цена из карточки витрины');
  fetchMode = 'fail';
  await close5kaBrowser();
  dropDocument();
}

// ─── 13. Пятёрка в браузерном транспорте: адаптер делегирует модулю ──────
// Здесь важна сама делегация: в режиме браузера адаптер не ходит в сеть сам и
// отвечает за нормализацию, модуль — за перехват ответа.
{
  delete process.env.PA5KA_TRANSPORT;
  const plu = 4439523;
  const product = searchFixture.products.find((p) => Number(p.plu) === plu)!;
  const next = JSON.stringify({
    props: { pageProps: { props: { productStore: JSON.stringify({ product }) } } },
    store: { sapCode: '35XY' },
  });
  install(
    [
      {
        url: CATALOG('35XY', 'categories'),
        body: [{ id: 'r', name: 'R', categories: [{ id: '251C17045', name: 'Молоко', image_link: 'https://img/x.webp' }] }],
      },
      { url: CATALOG('35XY', 'search?mode=store&q=молоко'), body: { products: searchFixture.products.slice(0, 2) } },
    ],
    { cookie: '35XY' },
  );
  setNextData(next);
  const adapter = new PyaterochkaAdapter();
  const found = await adapter.search('молоко', ctx);
  assert.equal(found.length, 2, 'поиск Пятёрки ушёл в браузерный транспорт');
  const card = await adapter.fetchProduct(`5ka-${plu}`, ctx);
  assert.equal(card.canonicalId, `5ka-${plu}`, 'карточка Пятёрки прочитана из данных страницы');
  const cats = await adapter.fetchCategories(ctx);
  assert.equal(cats[0]?.id, '251C17045', 'категории пришли из браузерного транспорта');
  await close5kaBrowser();

  const url = 'https://5d.5ka.ru/api/catalog/v2/stores/35XY/categories/251C17045/products';
  install(
    [
      { url: CATALOG('35XY', 'categories'), body: [] },
      { url, body: { products: searchFixture.products.slice(0, 2) } },
    ],
    { cookie: '35XY' },
  );
  setNextData(next);
  const shelf = await adapter.fetchCategoryProducts('https://5ka.ru/catalog/251C17045/', ctx);
  assert.ok(shelf.length > 0, 'товары полки Пятёрки пришли из браузерного транспорта');
  await close5kaBrowser();
  dropDocument();
}

// ─── 14. Магнит: капча, чужая страница, пустая витрина, @graph ───────
{
  // Капча в разметке — это не «пусто», а требование ручного разбора.
  withCardDom();
  install([{ url: 'https://magnit.ru/catalog/1-', html: `<html><body>captcha ${'"473996"'}</body></html>` }], {
    title: 'Магнит',
  });
  fetchMode = 'empty';
  const captcha = new MagnitAdapter();
  await assert.rejects(
    () => captcha.fetchCategoryProducts('https://magnit.ru/catalog/1-', { city: 'moscow', externalStoreId: '473996' }),
    /капча\/блок/,
    'капча на витрине не выглядит как пустая полка',
  );
  fetchMode = 'fail';

  // Страница без следа кода магазина — тоже чужая.
  withCardDom();
  install([{ url: 'https://magnit.ru/catalog/1-', html: '<html><body>чужой магазин</body></html>' }], {
    title: 'Магнит',
  });
  fetchMode = 'empty';
  const foreign = new MagnitAdapter();
  await assert.rejects(
    () => foreign.fetchCategoryProducts('https://magnit.ru/catalog/1-', { city: 'moscow', externalStoreId: '473996' }),
    /чужой магазин/,
    'страница без shopCode отвергнута, а не принята за свою',
  );
  fetchMode = 'fail';

  // Витрина открылась, но карточек нет: возвращаем пусто и проверяем причину.
  (globalThis as { document?: unknown }).document = { querySelectorAll: () => [], getElementById: () => null };
  const h = install([{ url: 'https://magnit.ru/catalog/1-', html: MAGNIT_HTML }], { title: 'Магнит' });
  h.page.selectorMissing = true;
  fetchMode = 'empty';
  const emptyShelf = new MagnitAdapter();
  assert.deepEqual(
    await emptyShelf.fetchCategoryProducts('https://magnit.ru/catalog/1-', { city: 'moscow', externalStoreId: '473996' }),
    [],
    'пустая витрина — пустой результат, а не ошибка парсера',
  );
  fetchMode = 'fail';
  await close5kaBrowser();
  dropDocument();
}

// ─── 15. Магнит: карточка, пришедшая в @graph ────────────────────────────
{
  const ld = JSON.parse(fs.readFileSync('tests/fixtures/magnit-product.json', 'utf8')) as Record<string, unknown>;
  const html = [
    '<html><head>',
    '<link rel="canonical" href="https://magnit.ru/catalog/?shopCode=473996" />',
    '<script type="application/ld+json">',
    JSON.stringify({ '@graph': [ld] }),
    '</script></head><body><a href="/catalog/?shopCode=473996">Молоко</a></body></html>',
  ].join('');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
    return { ok: true, status: 200, url, text: async () => html } as unknown as Response;
  }) as typeof fetch;
  const product = await new MagnitAdapter().fetchProduct('magnit-1000483001', {
    city: 'moscow',
    externalStoreId: '473996',
  });
  assert.equal(product.price, 119, 'карточка из @graph разобрана');
  globalThis.fetch = previousFetch;
}

// ─── 16. Снимок страницы: пустая оболочка, дописанный товар ────────────
{
  // Реальная гонка: снимок на момент commit ещё пуст, товар Next.js дописывает
  // позже. Первый чтение обязано вернуть пустую строку, а не упасть, иначе мы бы
  // теряли сессию на каждом открытии карточки.
  const plu = Number(searchFixture.products[1]!.plu);
  const payload = JSON.stringify({
    props: { pageProps: { props: { productStore: JSON.stringify(searchFixture.products[1]) } } },
  });
  let reads = 0;
  (globalThis as { document?: unknown }).document = {
    querySelectorAll: () => [],
    getElementById: (id: string) => (id === '__NEXT_DATA__' ? { textContent: ++reads === 1 ? null : payload } : null),
  };
  // Сессия без куки: код магазина определён по каталогу на старте сессии.
  const probe = install([{ url: CATALOG('35XY', 'categories'), body: [] }]);
  await assert.rejects(
    () => browserCategories({ externalStoreId: '35XY' }),
    /категории пусты/,
    'сессия поднялась, каталог пуст',
  );
  // Ответы каталога убираем из страницы: иначе сверка снова получит код из
  // служебного запроса и решит, что магазин известен.
  probe.page.canned.length = 0;
  // Теперь ни куки, ни кода в снимке, ни служебного ответа каталога: код
  // магазина неоткуда взять, и сверка обязана это заметить, а не выдумать.
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.map(String).join(' '));
  const card = await browserFetchProduct(String(plu), ctx);
  console.warn = realWarn;
  assert.equal(card.canonicalId, `5ka-${plu}`, 'карточка прочитана, хотя первый снимок был пуст');
  assert.ok(
    warned.some((w) => /кодов на странице 0 .*ни одного/.test(w)),
    `и код не выдумал магазин: в лог ушло, что кодов нет вовсе: ${JSON.stringify(warned)}`,
  );
  await close5kaBrowser();

  // Ответ по товару без цен: сказано прямо, что это не товар. Товар приходит
  // из снимка страницы, а не из ответа каталога, — тестируем именно этот путь.
  const noPrice = { ...searchFixture.products[1], prices: null };
  install(
    [{ url: `https://5d.5ka.ru/api/catalog/v2/stores/35XY/products/${plu}?mode=store`, body: noPrice }],
    { cookie: '35XY' },
  );
  setNextData(
    JSON.stringify({ props: { pageProps: { props: { productStore: JSON.stringify(noPrice) } } }, store: { sapCode: '35XY' } }),
  );
  await assert.rejects(
    () => browserFetchProduct(String(plu), ctx),
    /без цены/,
    'ответ по товару без цены не превращается в товар',
  );
  await close5kaBrowser();

  await close5kaBrowser();
}

// ─── 17. Пятёрка: разбор снимка страницы на краях ────────────────────────
{
  const plu = 4439523;
  const product = searchFixture.products.find((p) => Number(p.plu) === plu)!;
  const withProduct = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ props: { pageProps: { props: { productStore: JSON.stringify({ product }) } } }, ...extra });

  // Кодов на странице нет — предупреждение и опора на сессию.
  install([{ url: CATALOG('35XY', 'categories'), body: [] }], { cookie: '35XY' });
  warns.length = 0;
  setNextData(withProduct());
  const viaSession = await browserFetchProduct(String(plu), ctx);
  assert.ok(viaSession.price > 0, 'товар прочитан даже без кодов на странице');
  assert.ok(
    warns.some((w) => w.includes('кодов на странице 0')),
    'и сказано вслух, что оперлись на сессию',
  );
  await close5kaBrowser();

  // Товар спрятан в массиве и рядом битая вложенная строка.
  install([{ url: CATALOG('35XY', 'categories'), body: [] }], { cookie: '35XY' });
  setNextData(JSON.stringify({ props: { pageProps: { props: { productStore: '[{"oops"' } } }, items: [[product]] }));
  const inArray = await browserFetchProduct(String(plu), ctx);
  assert.equal(inArray.canonicalId, `5ka-${plu}`, 'товар найден даже внутри массива');
  await close5kaBrowser();

  // Снимок не разбирается вовсе — ждём и перезагружаем, потом честно падаем.
  install([{ url: CATALOG('35XY', 'categories'), body: [] }], { cookie: '35XY' });
  setNextData('{ это не json');
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => (clock += 4_000);
  try {
    await assert.rejects(
      () => browserFetchProduct(String(plu), ctx),
      /не появился в данных страницы/,
      'битый снимок не превращается в выдуманный товар',
    );
  } finally {
    Date.now = realNow;
  }
  await close5kaBrowser();
  dropDocument();

// Страница вообще не назвала магазин.
    install([], { cookie: '' });
    const realNow2 = Date.now;
    let clock2 = realNow2();
    Date.now = () => (clock2 += 11_000);
    try {
      await assert.rejects(
        () => browserSearch('молоко', ctx),
        /не определил магазин/,
        'ни куки, ни каталога — магазин не выдумывается',
      );
    } finally {
      Date.now = realNow2;
    }
    await close5kaBrowser();

    // Тот же отказ, но сессия перестраивается: раньше пользователю показывалась
    // ошибка и пустые категории Пятёрки, хотя со второй попытки сеть отвечала.
    const flaky = install([], { cookie: '' });
    let launchesFlaky = 0;
    __setPlaywrightForTests({
      firefox: {
        launch: async () => {
          launchesFlaky += 1;
          return flaky.browser;
        },
      },
      chromium: {
        launch: async () => {
          launchesFlaky += 1;
          return flaky.browser;
        },
      },
    } as unknown as typeof import('playwright'));
    const realNow3 = Date.now;
    let clock3 = realNow3();
    Date.now = () => (clock3 += 11_000);
    try {
      await assert.rejects(
        () => browserSearch('молоко', ctx),
        /не определил магазин/,
        'и после повтора сеть молчит — ошибка остаётся ошибкой',
      );
      assert.equal(launchesFlaky, 2, 'сессия строится повторно: пользователю нажимать не нужно');
    } finally {
      Date.now = realNow3;
    }
    await close5kaBrowser();
  }

// ─── 18. Магнит: блок по IP, пустой пейлоад, витрина без карточек ──────
{
  // Блок по IP на витрине — это пауза, а не пустая полка.
  withCardDom();
  install([{ url: 'https://magnit.ru/catalog/1-', html: '<html><body>выключите VPN</body></html>' }], {
    title: 'Магнит',
  });
  fetchMode = 'empty';
  const blocked = new MagnitAdapter();
  await assert.rejects(
    () => blocked.fetchCategoryProducts('https://magnit.ru/catalog/1-', { city: 'moscow', externalStoreId: '473996' }),
    /блок по IP/,
    'блок по IP отличим от пустой витрины',
  );
  fetchMode = 'fail';

  // Поиск: fetch упал, витрина в браузере пуста — возвращаем пусто, не ошибку.
  (globalThis as { document?: unknown }).document = { querySelectorAll: () => [], getElementById: () => null };
  const h = install([{ url: 'https://magnit.ru/search?term=молоко', html: MAGNIT_HTML }], { title: 'Магнит' });
  h.page.selectorMissing = true;
  assert.deepEqual(
    await new MagnitAdapter().search('молоко', { city: 'moscow', externalStoreId: '473996' }),
    [],
    'пустой рендер витрины — пустой результат, а не исключение',
  );
  await close5kaBrowser();
  dropDocument();

  // Пейлоад без товара: ссылки на витрину есть, товаров нет.
  const empty = '<html><body><script id="__NUXT_DATA__" type="application/json">["x"]</script><a href="/product/1?shopCode=473996">x</a></body></html>';
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
    return { ok: true, status: 200, url, text: async () => empty } as unknown as Response;
  }) as typeof fetch;
  const none = new MagnitAdapter();
  // Витрина по ссылке без единого товара уходит в браузер, а тот пуст.
  (globalThis as { document?: unknown }).document = { querySelectorAll: () => [], getElementById: () => null };
  assert.deepEqual(
    await none.fetchCategoryProducts('https://magnit.ru/catalog/1-', { city: 'moscow', externalStoreId: '473996' }),
    [],
    'витрина без товаров — пустой результат',
  );
  globalThis.fetch = previousFetch;
  dropDocument();
}

// ─── 19. Пятёрка: категории и полка при не-JSON и пустом пейлоаде ─────────
{
  const plu = 4439523;
  const product = searchFixture.products.find((p) => Number(p.plu) === plu)!;
  const next = JSON.stringify({
    props: { pageProps: { props: { productStore: JSON.stringify({ product }) } } },
  });

  // Ответ каталога категорий — HTML вместо JSON (одна фикстура: адреса
  // пересекаются, и вторая отдача забрала бы первый ответ).
  install([{ url: CATALOG('35XY', 'categories'), text: '<html>капча</html>' }], { cookie: '35XY' });
  await assert.rejects(
    () => browserCategories({ externalStoreId: '35XY' }),
    /не JSON/,
    'каталог не-JSON говорит о смене вёрстки, а не «категорий нет»',
  );
  await close5kaBrowser();

  // Категория вернула не массив.
  install(
    [
      { url: CATALOG('35XY', 'categories'), body: [] },
      { url: CATALOG('35XY', 'categories/251C17045/products'), body: { products: 'не массив' } },
    ],
    { cookie: '35XY' },
  );
  await assert.rejects(
    () => browserCategoryProducts('https://5ka.ru/catalog/251C17045/', ctx),
    /не отдал товары категории/,
    'ответ не массивом — устаревшая ссылка, а не пусто',
  );
  await close5kaBrowser();

  // Товар в данных страницы, но рядом битая вложенная строка.
  install([{ url: CATALOG('35XY', 'categories'), body: [] }], { cookie: '35XY' });
  setNextData(JSON.stringify({ broken: '{oops', props: { pageProps: { props: { productStore: JSON.stringify({ product }) } } } }));
  const withBroken = await browserFetchProduct(String(plu), ctx);
  assert.equal(withBroken.canonicalId, `5ka-${plu}`, 'битая вложенная строка не мешает найти товар');
  await close5kaBrowser();
  dropDocument();
}

// ─── 20. Пятёрка: чужой запрос не наследует чужую сессию ───────────────
// Пока строится сессия одного магазина, приходит запрос по другому. Такой запрос
// обязан построить СВОЮ сессию, а не получить чужую (иначе цена точки А уехала бы
// в историю точки Б). Здесь его собственная сессия не построится — сеть отдаёт
// 35XY, — и это отдельная громкая ошибка, а не тихое наследование.
{
  const second = { city: 'moscow', externalStoreId: '35XY' };
  const ours = { city: 'moscow', externalStoreId: '30ML' };
  install(
    [
      { url: CATALOG('30ML', 'categories'), body: [] },
      { url: CATALOG('30ML', 'search?mode=store&q=молоко'), body: { products: searchFixture.products.slice(0, 1) } },
    ],
    { cookie: '30ML' },
  );
  setNextData('{"props":{}}');
  const first = browserSearch('молоко', ours);
  const other = browserSearch('картофель', second);
  await assert.rejects(
    other,
    /работает с магазином 30ML, а настроен 35XY/,
    'чужой запрос не получил чужую сессию молча — он получил свою проверку',
  );
  await first.catch(() => []);
  await close5kaBrowser();
  await assert.rejects(
    browserSearch('картофель', second),
    /работает с магазином 30ML, а настроен 35XY/,
    'после чужого запроса поведение то же: подмены точки не случилось',
  );
  await close5kaBrowser();
  assert.equal(
    (await browserSearch('картофель', ours)).length,
    1,
    'а первый магазин после чужого запроса работает: его сессия не залипла',
  );
  await close5kaBrowser();
  dropDocument();
}

// ─── 21. Пятёрка: битый снимок в storeCodesFromNextData ──────────────────
{
  const snapshot = JSON.stringify({
    good: { storeId: '35XY' },
    // Вложенная строка, которая начинается как JSON, но им не является:
    // раньше на этом месте разбор падал целиком.
    broken: '{oops',
  });
  assert.deepEqual(
    storeCodesFromNextData(snapshot).sort(),
    ['35XY'],
    'битая вложенная строка пропускается, а разбор продолжается',
  );
}

// ─── 22. Ответы не по форме: сеть обязана говорить, а не молчать ─────────
{
  // Каталог без формы объекта: код ждёт массив корней.
  install([{ url: CATALOG('35XY', 'categories'), body: { 'не массив': true } }], { cookie: '35XY' });
  await assert.rejects(
    () => browserCategories({ externalStoreId: '35XY' }),
    /категории пусты/,
    'каталог не массивом — дрейф вёрстки, а не пустой магазин',
  );
  await close5kaBrowser();

  // Узлы без id, без имени и без картинки: пропускаются, но не роняют разбор.
  install(
    [
      {
        url: CATALOG('35XY', 'categories'),
        body: [
          { 'без детей': true },
          {
            categories: [
              { name: 'Без id', image_link: 'https://img/a.png' },
              { id: 'c2', image_link: 'https://img/b.png' },
              { id: 'c3', name: '  ', image_link: 'https://img/c.png' },
              { id: 'c4', name: 'Без картинки' },
              { id: 'c5', name: 'Битая картинка', image_link: 'data:image/png;base64,AAA' },
              { id: 'c6', name: 'Обычная', image_link: 'https://img/d.png' },
            ],
          },
        ],
      },
    ],
    { cookie: '35XY' },
  );
  const cats = await browserCategories({ externalStoreId: '35XY' });
  assert.deepEqual(
    cats.map((c) => c.id),
    ['c4', 'c5', 'c6'],
    'без id, без имени и с пустым именем узлы отброшены, остальные пригодны',
  );
  assert.equal(cats.find((c) => c.id === 'c5')?.imageUrl, undefined, 'картинка data: не показывается в плитке');
  assert.equal(cats.find((c) => c.id === 'c6')?.imageUrl, 'https://img/d.png', 'обычная картинка сохранена');
  await close5kaBrowser();

  // Поиск может прийти массивом вместо {products: [...]}: пустой результат —
  // честный, а не исключение.
  install(
    [{ url: CATALOG('35XY', 'search?mode=store&q=молоко'), body: searchFixture.products.slice(0, 1) }],
    { cookie: '35XY' },
  );
  setNextData('');
  assert.deepEqual(await browserSearch('молоко', ctx), [], 'поиск-массив прочитан, но без products пуст');
  await close5kaBrowser();

  // Товары полки: массив, объект без products и объект с товарами.
  const catUrl = 'https://5ka.ru/catalog/251C17045/';
  const catApi = 'https://5d.5ka.ru/api/catalog/v2/stores/35XY/categories/251C17045/products';
  install(
    [
      { url: CATALOG('35XY', 'categories'), body: [] },
      { url: catApi, body: searchFixture.products.slice(0, 2) },
    ],
    { cookie: '35XY' },
  );
  setNextData('');
  const asArray = await browserCategoryProducts(catUrl, ctx);
  assert.equal(asArray.length, 2, 'товары полки пришли массивом');
  await close5kaBrowser();

  install(
    [
      { url: CATALOG('35XY', 'categories'), body: [] },
      { url: catApi, body: { products: [] } },
    ],
    { cookie: '35XY' },
  );
  setNextData('');
  await assert.rejects(
    () => browserCategoryProducts(catUrl, ctx),
    /не отдал товары категории/,
    'пустой список товаров полки — устаревшая ссылка, а не пустое приложение',
  );
  await close5kaBrowser();
}

// ─── 23. Отказы по странице и по её содержимому ──────────────────────────
{
  const plu = Number(searchFixture.products[1]!.plu);
  const product = searchFixture.products[1]!;
  const withProduct = JSON.stringify({
    props: { pageProps: { props: { productStore: JSON.stringify(product) } } },
    store: { sapCode: '35XY' },
  });

  // Поиск вернул не-JSON: сказано про смену вёрстки, а не «пусто».
  install([{ url: CATALOG('35XY', 'search?mode=store&q=молоко'), text: '<html>капча</html>' }], { cookie: '35XY' });
  setNextData('');
  await assert.rejects(
    () => browserSearch('молоко', ctx),
    /не JSON/,
    'не-JSON в поиске говорит о смене вёрстки',
  );
  await close5kaBrowser();

  // Страница товара отдала 404: это «товара нет», а не «страница сломалась».
  install([{ url: `https://5ka.ru/product/${plu}/`, status: 404, body: {} }], { cookie: '35XY' });
  setNextData(withProduct);
  await assert.rejects(
    () => browserFetchProduct(String(plu), ctx),
    /отдала HTTP 404/,
    'HTTP-отказ страницы товара назван своим кодом',
  );
  await close5kaBrowser();

  // Снимок называет чужой магазин: цена отрендерирована для другой точки —
  // сказать об этом обязательно, а не записать её в историю нашего магазина.
  install([{ url: CATALOG('35XY', 'categories'), body: [] }], { cookie: '35XY' });
  setNextData(
    JSON.stringify({
      props: { pageProps: { props: { productStore: JSON.stringify(product) } } },
      store: { storeId: '30ML' },
    }),
  );
  await assert.rejects(
    () => browserFetchProduct(String(plu), ctx),
    /магазин сменился на 30ML|источники называют разные магазины/,
    'снимок с чужим кодом не проходит сверку молча',
  );
  await close5kaBrowser();
  dropDocument();
}

// ─── 24. Ручной режим: окно браузера видно глазом ────────────────────────
// PA5KA_HEADFUL=1 нужен ровно для разбора капчи человеком; по умолчанию окно
// скрыто. Если флаг потеряется, капчу станет нечем разобрать.
{
  process.env.PA5KA_HEADFUL = '1';
  const seenOptions: unknown[] = [];
  const h = install([{ url: CATALOG('35XY', 'search?mode=store&q=молоко'), body: { products: [] } }], { cookie: '35XY' });
  const fakeLaunch = async (opts: unknown): Promise<FakeBrowser> => {
    seenOptions.push(opts);
    return h.browser;
  };
  __setPlaywrightForTests({
    firefox: { launch: fakeLaunch },
    chromium: { launch: fakeLaunch },
  } as unknown as typeof import('playwright'));
  setNextData('');
  await browserSearch('молоко', ctx);
  assert.deepEqual(seenOptions[0], { headless: false }, 'headful-режим дошёл до запуска браузера');
  delete process.env.PA5KA_HEADFUL;
  await close5kaBrowser();
}

// ─── 25. Коды магазина в снимке: значения не-объекты ─────────────────────
{
  assert.deepEqual(
    storeCodesFromNextData(JSON.stringify({ a: { storeId: 0 }, b: { storeId: false }, c: { storeId: { sapCode: '35XY' } } })),
    ['35XY'],
    'код лежит даже под не-объектом в ключе storeId',
  );
}

// ─── 26. Ни одного источника кода: сверка молчит, но говорит ─────────────
// Ни куки, ни кода в снимке, ни служебного ответа: код магазина неоткуда
// взять, и страница обязана признать это вслух, а не взять «хоть что-то».
{
  const plu = Number(searchFixture.products[1]!.plu);
  const product = searchFixture.products[1]!;
  const probe = install([{ url: CATALOG('35XY', 'categories'), body: [] }]);
  await assert.rejects(
    () => browserCategories({ externalStoreId: '35XY' }),
    /категории пусты/,
    'сессия поднялась по каталогу, без куки',
  );
  probe.page.canned.length = 0;
  let reads = 0;
  (globalThis as { document?: unknown }).document = {
    querySelectorAll: () => [],
    getElementById: (id: string) => (id === '__NEXT_DATA__' ? { textContent: ++reads > 1 ? JSON.stringify({ props: { pageProps: { props: { productStore: JSON.stringify(product) } } } }) : null } : null),
  };
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(' '));
  const card = await browserFetchProduct(String(plu), ctx);
  console.warn = realWarn;
  assert.equal(card.canonicalId, `5ka-${plu}`, 'товар прочитан даже без единого источника кода');
  assert.ok(
    warns.some((w) => /ни одного/.test(w)),
    `и код не выдумал магазин: ${JSON.stringify(warns)}`,
  );
  await close5kaBrowser();
  dropDocument();
}

// ─── 27. Гонка за сессией: второй запрос ждёт первый ─────────────────────
// Пока сессия строится, приходит второй запрос того же магазина. Он обязан
// дождаться той же сессии, а не поднять вторую (или отвергнуть чужую).
{
  const plu = Number(searchFixture.products[0]!.plu);
  const product = searchFixture.products[0]!;
  await close5kaBrowser();
  const cannedRace: Canned[] = [
    { url: CATALOG('35XY', 'categories'), body: [] },
    { url: CATALOG('35XY', 'search?mode=store&q=молоко'), body: { products: [product] } },
  ];
  let openGate: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  __setPlaywrightForTests({
    firefox: {
      launch: async () => {
        await gate;
        return new FakeBrowser(new FakeContext(new FakePage(cannedRace)));
      },
    },
  } as unknown as typeof import('playwright'));
  setNextData('');
  const first = browserSearch('молоко', ctx);
  const second = browserSearch('молоко', ctx);
  const release = openGate as (() => void) | null;
  release?.();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.length, 1, 'первый запрос отдал товар');
  assert.equal(b.length, 1, 'второй дождался той же сессии и тоже отдал товар');
  await close5kaBrowser();
  void plu;
}

// ─── 28. Единственный источник кода называет чужой магазин ───────────────
// Если источник один и он чужой, сверка обязана упасть: молча взять «первый
// попавшийся» здесь означало бы записать цену чужого магазина в нашу историю.
{
  const plu = Number(searchFixture.products[1]!.plu);
  const product = searchFixture.products[1]!;
  await close5kaBrowser();
  const probe = install([{ url: CATALOG('35XY', 'categories'), body: [] }]);
  await assert.rejects(
    () => browserCategories({ externalStoreId: '35XY' }),
    /категории пусты/,
    'сессия поднялась по каталогу, без куки',
  );
  probe.page.canned.length = 0;
  let reads = 0;
  (globalThis as { document?: unknown }).document = {
    querySelectorAll: () => [],
    getElementById: (id: string) => {
      if (id !== '__NEXT_DATA__') return null;
      reads += 1;
      // Первый снимок называет чужой магазин; дальше — данные товара.
      return {
        textContent:
          reads === 1
            ? JSON.stringify({ props: { pageProps: { props: { productStore: JSON.stringify(product) } } }, store: { sapCode: '30ML' } })
            : JSON.stringify({ props: { pageProps: { props: { productStore: JSON.stringify(product) } } }, store: { sapCode: '35XY' } }),
      };
    },
  };
  await assert.rejects(
    () => browserFetchProduct(String(plu), ctx),
    /магазин сменился на 30ML/,
    'единственный источник назвал чужой магазин — это отказ, а не подсказка',
  );
  await close5kaBrowser();
  dropDocument();
}

// ─── 29. Сессия: параллельный вход разных магазинов ──────────────────────
// Второй запрос не должен получить чужую сессию: цена чужого магазина в
// истории своего — самая дорогая из ошибок, которые здесь вообще возможны.
{
  const cannedTwo: [Canned[], Canned[]] = [
    [
      { url: CATALOG('35XY', 'categories'), body: [] },
      { url: CATALOG('35XY', 'search?mode=store&q=молоко'), body: { products: [searchFixture.products[0]!] } },
    ],
    [
      { url: CATALOG('30ML', 'categories'), body: [] },
      { url: CATALOG('30ML', 'search?mode=store&q=молоко'), body: { products: searchFixture.products.slice(0, 2) } },
    ],
  ];
  // У настоящего Playwright каждый запуск браузера — отдельная сессия со своей
  // страницей и своими куками. Здесь так же: первая сессия обслуживает первый
  // запрос (35XY), вторая — второй (30ML). Общая страница с общей кукой
  // сделала бы вторую сессию «чужой» — ровно то, что здесь и проверяется.
  let launchNo = 0;
  __setPlaywrightForTests({
    firefox: {
      launch: async () => new FakeBrowser(new FakeContext(new FakePage(cannedTwo[launchNo++] ?? cannedTwo[0]!))),
    },
  } as unknown as typeof import('playwright'));
  setNextData('');
  const [a, b] = await Promise.all([
    browserSearch('молоко', ctx),
    browserSearch('молоко', { city: 'ulyanovsk', externalStoreId: '30ML' }),
  ]);
  assert.equal(a.length, 1, 'первый магазин отдал свою выдачу');
  assert.equal(b.length, 2, 'вторый магазин отдал свою, а не сессию первого');
  await close5kaBrowser();

  // Товары полки: ответ буквально null. Это не «пусто», это дрейф ответа, и
  // полка обязана сказать об этом, а не показывать пустую витрину.
  install(
    [
      { url: CATALOG('35XY', 'categories'), body: [] },
      { url: 'https://5d.5ka.ru/api/catalog/v2/stores/35XY/categories/251C17045/products', body: 'null' },
    ],
    { cookie: '35XY' },
  );
  setNextData('');
  await assert.rejects(
    () => browserCategoryProducts('https://5ka.ru/catalog/251C17045/', ctx),
    /не отдал товары категории/,
    'ответ null на месте списка товаров — дрейф, а не пустая полка',
  );
  await close5kaBrowser();
}

// ─── 30. Снимок дописывается на ходу: пустая оболочка и пустой финал ─────
{
  const plu = Number(searchFixture.products[1]!.plu);
  const product = searchFixture.products[1]!;
  const payload = JSON.stringify({
    props: { pageProps: { props: { productStore: JSON.stringify(product) } } },
    store: { sapCode: '35XY' },
  });
  // Чтения снимка по порядку: ранний (с кодом), первая попытка разбора (пусто —
  // ждём дописывания), вторая (товар есть), финальный (пусто — сверяться не на
  // чем, и код обязан сказать об этом вслух).
  let reads = 0;
  (globalThis as { document?: unknown }).document = {
    querySelectorAll: () => [],
    getElementById: (id: string) => {
      if (id !== '__NEXT_DATA__') return null;
      reads += 1;
      // Пусто на первой попытке разбора и на финальной сверке.
      return { textContent: reads === 2 || reads === 4 ? null : payload };
    },
  };
  install(
    [
      { url: CATALOG('35XY', 'categories'), body: [] },
      { url: `https://5d.5ka.ru/api/catalog/v2/stores/35XY/products/${plu}?mode=store`, body: product },
    ],
    { cookie: '35XY' },
  );
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(' '));
  const card = await browserFetchProduct(String(plu), ctx);
  console.warn = realWarn;
  assert.equal(card.canonicalId, `5ka-${plu}`, 'товар дождался дописанного снимка');
  assert.ok(
    warns.some((w) => /кодов на странице 0/.test(w)),
    `пустой финальный снимок не выдан за подтверждение: ${JSON.stringify(warns)}`,
  );
  assert.ok(reads >= 4, `снимок перечитывался, пока товар не появился: ${reads} чтений`);
  await close5kaBrowser();
  dropDocument();
}

__setPlaywrightForTests(null);
console.warn = realWarn;
globalThis.fetch = realFetch;
dropDocument();
console.log('browser transport: ALL GREEN — сессия, магазин, блокировки, категории, карточка, откаты, Пятёрка');