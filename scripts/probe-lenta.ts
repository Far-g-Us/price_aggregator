// Живой зонд Ленты. Главное назначение — снять то, чего нет в capture:
// форму ответа поиска (POST /jrpc/searchItems), дерева категорий
// (GET /catalog/categories) и листинга категории (POST /catalog/items),
// плюс проверить, проходит ли Node fetch через Qrator с этой сети.
//
// Запускать из ДОМАШНЕЙ сети: с дата-центрового IP Qrator режет GET на
// api-gateway (401) и зонд ничего не докажет. Сырые ответы складываются ВНЕ
// репозитория (в них бывает SessionToken), путь меняется через LENTA_OUT;
// перед тем как куда-то отдать, секреты вырезать.
//
//   node scripts/probe-lenta.mjs                      # Москва, магазин 4161
//   LENTA_CITY=ulyanovsk LENTA_STORE=3349 node scripts/probe-lenta.mjs
//   LENTA_ITEM=359472 node scripts/probe-lenta.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CITY_TO_SLUG } from '../src/shared/lenta-regions.js';

const ORIGIN = 'https://lenta.com';
const API = `${ORIGIN}/api-gateway/v1`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0';
const CLIENT = 'angular_web_0.0.2';
const MPK = 'mp300-b1de0bac2c257f3257bf5ef2eea4ecbc';
const OUT = process.env.LENTA_OUT ?? join(tmpdir(), 'lenta-probe');

const store = process.env.LENTA_STORE ?? '4161';
const itemId = process.env.LENTA_ITEM ?? '716637';
const query = process.env.LENTA_QUERY ?? 'молоко';
const categoryId = process.env.LENTA_CATEGORY ?? '0'; // для POST /catalog/items, не для поиска

// X-Domain — это slug РЕГИОНА, а не id города проекта (СПб = spb, Краснодар =
// ksdr). Маппинг один на проект: src/shared/lenta-regions.ts.
const citySlug = CITY_TO_SLUG[process.env.LENTA_CITY ?? 'moscow'] ?? 'moscow';

mkdirSync(OUT, { recursive: true });

let sessionToken = '';
let deviceId = '';

function save(name: string, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  writeFileSync(`${OUT}/${name}`, `${text}\n`, 'utf8');
}

interface ProbeInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

interface ProbeResult {
  status: number;
  json: Record<string, unknown> | null;
}

async function call(label: string, url: string, init: ProbeInit = {}): Promise<ProbeResult> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'User-Agent': UA,
    Referer: `${ORIGIN}/`,
    Origin: ORIGIN,
    'X-Retail-Brand': 'lo',
    'X-Platform': 'omniweb',
    'X-Device-OS': 'Web',
    'X-Delivery-Mode': 'pickup',
    'X-Query-Host': 'lenta.com',
    'App-Version': '0.0.2',
    'X-Domain': citySlug,
    Client: CLIENT,
    'X-Device-Web-Platform': 'desktop_web',
    ...(sessionToken ? { SessionToken: sessionToken } : {}),
    ...(deviceId ? { DeviceID: deviceId, 'X-Device-Id': deviceId } : {}),
    ...(init.headers ?? {}),
  };
  console.log(`\n=== ${label}\n    ${init.method ?? 'GET'} ${url}`);
  const res = await fetch(url, { ...init, headers, redirect: 'manual' });
  const server = res.headers.get('server') ?? '';
  const raw = await res.text();
  const qrator = server.toUpperCase().includes('QRATOR');
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* не JSON */
  }
  console.log(`    -> ${res.status}${qrator ? ' QRATOR' : ''} ${res.headers.get('content-type') ?? ''}`);
  if (res.status >= 400) {
    console.log(`    ${raw.slice(0, 200).replace(/\n/g, ' ')}`);
    console.log(
      res.status === 401 || res.status === 403
        ? '    ВЫВОД: Qrator/WAF не пускает Node fetch с этой сети. Повторить из домашней сети.'
        : '    ВЫВОД: смотри ответ выше.',
    );
    return { status: res.status, json: null };
  }
  console.log(`    ${raw.slice(0, 300).replace(/\n/g, ' ')}`);
  return { status: res.status, json };
}

// 1. Сессия: ровно то, что зовёт сайт (POST /api/rest/sessionGet, ответ кладёт
//    Set-Cookie Utk_SssTkn с тем же токеном). Юзеровые JWT не нужны.
deviceId = crypto.randomUUID();
const head = {
  Head: {
    MarketingPartnerKey: MPK,
    Version: 'web-12.0.823',
    Client: CLIENT,
    Method: 'sessionGet',
    DeviceId: deviceId,
    Domain: citySlug,
  },
  Body: {},
};
const session = await call('sessionGet', `${ORIGIN}/api/rest/sessionGet`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: `request=${encodeURIComponent(JSON.stringify(head))}`,
});
sessionToken = (session.json as { Body?: { SessionToken?: string } } | null)?.Body?.SessionToken ?? '';
console.log(`    SessionToken: ${sessionToken ? `есть (${sessionToken.length} симв.)` : 'НЕТ'}`);
save('session.json', session.json ?? { status: session.status });

// 2. Выбор магазина: серверная привязка сессии к точке. На несуществующий
//    storeId сеть отвечает 409 «Pickup store with id N not found» — то есть
//    ответ подтверждает привязку, а не просто эхо нашего запроса.
const set = await call('delivery/mode/set', `${API}/delivery/mode/set`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'pickup', storeId: Number(store) }),
});
save('delivery-mode-set.json', set.json ?? { status: set.status });
console.log(`    привязка: ${set.status === 200 ? 'магазин принят сетью' : `отказ (${set.status}) — сверка не пройдена`}`);
const mode = await call('delivery/mode', `${API}/delivery/mode`);
save('delivery-mode.json', mode.json ?? {});
const modeJson = mode.json as { storeId?: number | string; userStores?: { id: number; alias: string; title: string; marketType: string; regionId: number }[] } | null;
const picked = (modeJson?.userStores ?? []).find((s) => String(s.id) === String(store));
console.log(
  `    магазин: id=${modeJson?.storeId} alias=${picked?.alias ?? '?'} title=${picked?.title ?? '?'} ` +
    `marketType=${picked?.marketType ?? '?'} regionId=${picked?.regionId ?? '?'}`,
);
if (String(modeJson?.storeId) !== String(store)) {
  console.log('    ВЫВОД: сайт выбрал чужой магазин — сверка не пройдена.');
}

// 3. Карточка товара: цены, наличие, alias в теле.
const card = await call(`catalog/items/${itemId}`, `${API}/catalog/items/${itemId}`);
save('product.json', card.json ?? {});
const cardJson = card.json as
  | {
      id?: number;
      storeId?: number;
      count?: number;
      saleLimit?: { maxSaleQuantity?: number };
      features?: { isBlockedForSale?: boolean };
      prices?: Record<string, number | boolean>;
    }
  | null;
if (cardJson) {
  console.log(
    `    id=${cardJson.id} storeId(alias)=${cardJson.storeId} count=${cardJson.count} ` +
      `maxSale=${cardJson.saleLimit?.maxSaleQuantity} isBlockedForSale=${cardJson.features?.isBlockedForSale} ` +
      `price=${cardJson.prices?.price} regular=${cardJson.prices?.priceRegular} ` +
      `promo=${cardJson.prices?.isPromoactionPrice} loyalty=${cardJson.prices?.isLoyaltyCardPrice} ` +
      `quant=${cardJson.prices?.isQuantPrice}`,
  );
  console.log('    ВАЖНО: count больше maxSale -> count это остаток, а не лимит заказа.');
  console.log(`    совпадение alias: ${String(cardJson.storeId) === String(picked?.alias)}`);
}

// 4. Регионы: отсюда берётся slug для X-Domain (не id города проекта).
const regions = await call('region/list', `${API}/region/list`);
if (regions.json) {
  save('region-list.json', regions.json);
  const want = ['moscow', 'spb', 'ulyanovsk', 'ksdr', 'irkutsk'];
  const list = (regions.json as { regions?: { id: number; slug: string }[] }).regions ?? [];
  console.log(
    '    нужные регионы: ' +
      list
        .filter((g) => want.includes(g.slug))
        .map((g) => `${g.id}=${g.slug}`)
        .join(', '),
  );
}

// 5. Дерево категорий.
const cats = await call('catalog/categories', `${API}/catalog/categories`, {
  headers: { team: 'SE' },
});
save('categories.json', cats.json ?? {});

// 6. Листинг категории: POST /catalog/items (в HAR такого запроса не было,
//    эндпоинт взят из сгенерированного клиента сайта).
const listing = await call('catalog/items', `${API}/catalog/items`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', team: 'SE' },
  body: JSON.stringify({ categoryId: Number(categoryId), query: '', limit: 24, offset: 0 }),
});
save('listing.json', listing.json ?? {});

// 7. Поиск: JSON-RPC /jrpc/searchItems. ВАЖНО: categoryId в params НЕ передаём
//    — с categoryId: 0 сеть отвечает 200 с total: 0 вместо выдачи.
const search = await call('jrpc/searchItems', `${ORIGIN}/jrpc/searchItems`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', MarketingPartnerKey: MPK },
  body: JSON.stringify({
    method: 'searchItems',
    params: { query, count: 6, offset: 0, filters: [] },
    jsonrpc: '2.0',
  }),
});
save('search.json', search.json ?? {});
if (search.json) {
  const result = (search.json.result ?? search.json) as {
      total?: number;
      items?: {
        id?: number;
        name?: string;
        storeId?: number;
        count?: number;
        netWeight?: number;
        unitName?: string;
        package?: string;
        isBlockedForSale?: boolean;
        features?: { isWeight?: boolean; isBlockedForSale?: boolean };
        prices?: { price?: number; priceRegular?: number; cost?: number; costRegular?: number };
      }[];
    };
    const list = result.items ?? [];
    console.log(`    total=${result.total ?? '?'} items=${list.length}`);
    // Полный список ключей item: форма выдачи менялась (2026-09-29 → 2026-10-01
    // стало 15 ключей вместо 9, признак продажи уехал в features, вес пришёл
    // верхним уровнем). Без этого печати нельзя заметить следующий дрейф.
    if (list[0]) {
      console.log(`    ключи item: ${Object.keys(list[0]).sort().join(', ')}`);
    }
    for (const it of list.slice(0, 5)) {
      console.log(
        `      ${it.id} alias=${it.storeId ?? '—'} count=${it.count ?? '—'} price=${it.prices?.price}/${it.prices?.priceRegular} cost=${it.prices?.cost ?? '—'} net=${it.netWeight ?? '—'}${it.unitName ? ` ${it.unitName}` : ''} вес=${it.features?.isWeight === true} blocked=${it.features?.isBlockedForSale ?? it.isBlockedForSale ?? '—'} ${String(it.name ?? '').slice(0, 40)}`,
      );
    }
}

console.log(`\nСырые ответы: ${OUT}/ (секреты вырезать перед фикстурами)`);
