// Лента релизов: разбор тела `latest.yml` и сравнение версий. Проверяется то,
// на чём держится уведомление portable о новой версии: если разбор или
// сравнение ошибутся, уведомление либо не придёт, либо придёт на ровной версии.
//
// Кейсы сравнения — таблицей, как в test-taxonomy-matcher: с версией 1.2.1 в
// работе и с откатами, потому что «новее» обязано быть строгим.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  MAX_FEED_BYTES,
  RELEASES_PAGE_URL,
  RELEASE_FEED_URL,
  isNewerVersion,
  parseFeedVersion,
  readFeedVersion,
} from '../src/core/release-check.js';

type FeedCase = { body: string; version: string | null; why: string };

const feedCases: FeedCase[] = [
  {
    body: 'version: 1.2.1\nfiles:\n  - url: PriceAggregator-1.2.1-setup.exe\n    sha512: AAAA\n      size: 1\npath: PriceAggregator-1.2.1-setup.exe\nsha512: AAAA\n',
    version: '1.2.1',
    why: 'настоящее тело latest.yml',
  },
  { body: 'version: 1.2.1\r\npath: a\r\n', version: '1.2.1', why: 'CRLF' },
  { body: 'version: "1.2.1"\nsha512: AAAA\n', version: '1.2.1', why: 'кавычки' },
  { body: "version: '1.2.1'\nfiles:\n", version: '1.2.1', why: 'апострофы' },
  { body: 'version:1.2.1\npath:a\n', version: '1.2.1', why: 'без пробелов' },
  { body: 'version: 1.2.1\npath: a\nversion: 9.9.9\npath: b\n', version: '1.2.1', why: 'берётся первая' },
  { body: 'version: 9.9.9\n', version: null, why: 'нет второго маркера — каптив-портал не поверим' },
  { body: 'page.version: 9.9.9\npath: a\n', version: null, why: 'version не в начале строки' },
  { body: 'files:\n  - url: x\nsha512: version: 1.0.0\n', version: null, why: 'совпадение не в строке version' },
  { body: '<html>404</html>', version: null, why: 'HTML прокси' },
  { body: 'path: PriceAggregator-1.2.1-setup.exe\n', version: null, why: 'ленты нет' },
  { body: 'version:\npath: a\n', version: null, why: 'значение пустое' },
  { body: `version: 9.9.9\npath: a\n${'x'.repeat(MAX_FEED_BYTES)}`, version: null, why: 'тело больше лимита' },
];

type VerCase = { latest: string; current: string; newer: boolean; why?: string };

const verCases: VerCase[] = [
  { latest: '1.2.2', current: '1.2.1', newer: true, why: 'патч' },
  { latest: '1.3.0', current: '1.2.9', newer: true, why: 'минор' },
  { latest: '2.0.0', current: '1.99.99', newer: true, why: 'мажор' },
  { latest: '10.0.0', current: '9.9.9', newer: true, why: 'двузначные сегменты' },
  { latest: ' 1.2.2 ', current: '1.2.1', newer: true, why: 'пробелы' },
  { latest: '1.2.1', current: '1.2.1', newer: false, why: 'ровная версия' },
  { latest: '1.2.0', current: '1.2.1', newer: false, why: 'откат патча' },
  { latest: '1.1.0', current: '1.2.0', newer: false, why: 'откат минора' },
  { latest: '1.0.0', current: '2.0.0', newer: false, why: 'откат мажора' },
  { latest: '1.2.2-beta.1', current: '1.2.1', newer: false, why: 'pre-release не считаем' },
  { latest: '1.2', current: '1.2.1', newer: false, why: 'короткая версия' },
  { latest: 'v1.2.2', current: '1.2.1', newer: false, why: 'с префиксом v' },
  { latest: '', current: '1.2.1', newer: false, why: 'пусто' },
];

for (const c of feedCases) {
  assert.equal(parseFeedVersion(c.body), c.version, `разбор: ${c.why}`);
}
for (const c of verCases) {
  assert.equal(isNewerVersion(c.latest, c.current), c.newer, `сравнение: ${c.why}`);
}

// Сеть подставляется, поэтому проверяется условие, а не побочный эффект: и что
// адрес ленты запрашивается ровно один, и что ошибка или мусор не превращаются в
// уведомление.
const asked: string[] = [];
const seen = await readFeedVersion(async (url) => {
  asked.push(url);
  return 'version: 1.3.0\npath: PriceAggregator-1.3.0-setup.exe\n';
});
assert.equal(seen, '1.3.0', 'версия из ленты читается');
assert.deepEqual(asked, [RELEASE_FEED_URL], 'запрашивается адрес ленты');

assert.equal(
  await readFeedVersion(async () => {
    throw new Error('сети нет');
  }),
  null,
  'ошибка сети молчит',
);
assert.equal(await readFeedVersion(async () => '<html>404</html>'), null, 'мусор молчит');

// Адрес ленты продублирован из package.json: переименование репозитория иначе
// сломало бы фичу молча, а узнать об этом можно было бы только по 404 в логе.
const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
  build: { publish: { provider: string; owner: string; repo: string }[] };
};
const publish = pkg.build.publish[0];
assert.ok(publish, 'в конфиге сборки есть publish');
assert.equal(publish.provider, 'github', 'провайдер сборки — github');
assert.ok(
  RELEASE_FEED_URL.startsWith(`https://github.com/${publish.owner}/${publish.repo}/`),
  'лента того же репозитория',
);
assert.ok(
  RELEASES_PAGE_URL.startsWith(`https://github.com/${publish.owner}/${publish.repo}/`),
  'страница релизов того же репозитория',
);

console.log(
  `release-check: ALL GREEN — разбор ${feedCases.length} тел, сравнение ${verCases.length} пар, ` +
    `лента ${RELEASE_FEED_URL}`,
);