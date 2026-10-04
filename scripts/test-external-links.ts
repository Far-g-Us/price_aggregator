// Политика внешних ссылок проверяется таблицей: адреса товаров приходят из
// ответов сетей, а клик по уведомлению открывает страницу релиза. Проверка по
// разобранному URL, а не по префиксу строки, поэтому кейсы — это в основном
// подделки схемы, хоста и пути.
//
// Проверяемая политика лежит в `electron/external-links.ts`, а область измерения
// `c8` — только `src`, поэтому набор живёт здесь: иначе эти строки не проверял бы
// никто.

import assert from 'node:assert/strict';
import { isExternalAllowed, urlForLog } from '../electron/external-links.js';

const blocked: unknown[] = [
  'http://magnit.ru/',
  'https://magnit.ru.evil.com/',
  'https://5ka.ru.evil.com/catalog',
  'https://lenta.com.evil.com/',
  'https://github.com/Far-g-Us/price_aggregator/releases.evil.com/',
  'https://github.com/Far-g-Us/price_aggregator/releasesXYZ',
  'https://github.com/other/repo/releases/',
  'https://github.com/Far-g-Us/price_aggregator/issues/1',
  'javascript:alert(1)',
  'file:///C:/Windows/System32/calc.exe',
  'smb://host/share',
  'https://magnit.ru/\n//evil.com',
  ' https://magnit.ru/',
  'https://magnit.ru/ ',
  'https://user@evil.com/',
  'https://magnit.ru@evil.com/',
  'https://magnit.ru:8443/catalog',
  'https://magnit.ru./catalog',
  'https://xn--80a.xn--p1ai/catalog',
  'https://github.com\\@evil.com/',
  'https://github.com/Far-g-Us/price_aggregator/releases/../evil',
  'https://github.com/Far-g-Us/price_aggregator/releases%2F..%2Fevil',
  '//evil.com/catalog',
  '',
  null,
  undefined,
  42,
  { href: 'https://magnit.ru/' },
];

const allowed = [
  'https://magnit.ru/',
  'https://magnit.ru/catalog/12345/',
  'https://5ka.ru/catalog/0/',
  'https://lenta.com/catalog/4161/',
  // Адрес без слеша допускается: без него GitHub не редиректит, а со слешем
  // редиректит на себя же с кодом 301 — то есть лишний запрос и лишний шаг.
  'https://github.com/Far-g-Us/price_aggregator/releases',
  'https://github.com/Far-g-Us/price_aggregator/releases/',
  'https://github.com/Far-g-Us/price_aggregator/releases/tag/v1.2.1',
  // Хост в верхнем регистре — тот же хост, а не подмена: схема и хост в URL
  // нормализуются, и сравнение идёт уже по нормализованным значениям.
  'HTTPS://MAGNIT.RU/catalog/1/',
  // Без пути: `new URL` даёт pathname `/`, и домен сети должен остаться доступен.
  'https://magnit.ru',
  // Порт 443 — это тот же origin, что и без порта: сравнение идёт по
  // нормализованному origin, поэтому такой адрес не ложно отклоняется.
  'https://magnit.ru:443/catalog/1/',
  // Обратный слеш URL-парсер считает слешем, и адрес остаётся нашим доменом —
  // отклонять его незачем, это не подмена хоста.
  'https://magnit.ru\\@evil.com/',
];

for (const url of blocked) {
  assert.equal(isExternalAllowed(url), false, `не открываем: ${JSON.stringify(url)}`);
}
for (const url of allowed) {
  assert.equal(isExternalAllowed(url), true, `открываем: ${url}`);
}

assert.equal(urlForLog('https://magnit.ru/\nВЛОМ'), 'https://magnit.ru/ ВЛОМ');
assert.equal(urlForLog('x'.repeat(200)).length, 80);

console.log(`external links: ALL GREEN — разрешено ${allowed.length}, отклонено ${blocked.length}`);