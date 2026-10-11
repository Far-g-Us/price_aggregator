// Съём фикстуры Светофора: кладёт файл прайса как есть, без преобразований.
//
//   npx tsx scripts/fetch-svetofor-fixture.ts            # магазин по умолчанию
//   npx tsx scripts/fetch-svetofor-fixture.ts 649 kaluga # другая точка
//
// Преобразовывать ответ нельзя: сеть отдаёт МАССИВ строк, и именно этот формат
// проверяет scripts/test-svetofor.ts. Предыдущая фикстура была пересобрана руками
// в объект-карту, из-за чего адаптер, отвергавший массив, проходил тесты.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveSvetoforStamp,
  svetoforPriceUrl,
} from '../src/core/adapters/svetofor.js';
import { svetoforDomain } from '../src/shared/svetofor-regions.js';

const shopId = process.argv[2] ?? '649';
const city = process.argv[3] ?? 'kaluga';
const domain = svetoforDomain(shopId);
const out = resolve(
  dirname(fileURLToPath(import.meta.url)),
  `../tests/fixtures/svetofor/offers-${shopId}.json`,
);

const fetchImpl = globalThis.fetch as unknown as Parameters<typeof resolveSvetoforStamp>[0];
const stamp = await resolveSvetoforStamp(fetchImpl, domain);
const url = svetoforPriceUrl(domain, shopId, stamp);
console.log(`  домен ${domain}, метка ${stamp}`);
console.log(`  ${url}`);

// Заголовки — те же, что у адаптера: без них CDN может отдать HTML вместо JSON,
// и в фикстуру попал бы мусор.
const res = await fetchImpl(url, {
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0',
    Accept: 'application/json,text/plain,*/*',
    Referer: 'https://svetoforonline.ru/',
  },
});
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const body = await res.text();
const parsed: unknown = JSON.parse(body);
if (!Array.isArray(parsed)) {
  console.error('  (!) ответ не массив — фикстуру не сохраняю, формат надо проверить');
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, body, 'utf8');
console.log(`  записано ${out}: ${parsed.length} строк, ${body.length} байт`);