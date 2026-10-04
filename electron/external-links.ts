// Политика внешних ссылок: куда приложение вообще открывает браузер.
//
// Раньше список жил в main.ts и применялся только к IPC `external:open`, то есть
// к ссылкам из renderer. Потом порт `AppShell.notify` получил `actionUrl` для
// клика по уведомлению — и открывал мимо списка. Проверка переехала сюда, чтобы
// оба вызова проходили её и список нельзя было разъехать.
//
// Проверка не по префиксу строки, а по разобранному URL: сравниваются схема,
// хост и начало пути. Префиксом строками «github.com/.../releases» пропускала бы
// и `…/releases.evil.com`, и любой путь оттуда — если у GitHub появится
// open-redirect под releases, уехало бы наружу.

const EXTERNAL_ALLOW = [
  // Домены сетей пускаются целиком (префикс пути `''`): у товара может быть любой
  // путь (`/catalog/…`, `/product/…`), перечислять их нельзя, а смысл фильтра
  // там — сам домен.
  { origin: 'https://magnit.ru', paths: [''] },
  { origin: 'https://5ka.ru', paths: [''] },
  { origin: 'https://lenta.com', paths: [''] },
  { origin: 'https://github.com', paths: ['/Far-g-Us/price_aggregator/releases'] },
];

// Путь совпадает, если он равен префиксу или идёт за ним через слеш. Сравнение
// «равен или начинается с `prefix + /`» вместо голого `startsWith(prefix)` не
// пускает `…/releasesXYZ`, но по-прежнему пускает `…/releases` — без слеша GitHub
// отдаёт страницу сразу, а со слешем отвечает редиректом на себя же. Пустой
// префикс означает «весь домен».
function pathMatches(pathname: string, prefix: string): boolean {
  if (prefix === '') return pathname.startsWith('/');
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isExternalAllowed(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  // URL-парсер молча выбрасывает табы и переводы строк, поэтому строка с
  // управляющими символами проверяется до разбора: иначе `https://magnit.ru/\n@evil`
  // превратился бы в другой валидный адрес.
  if (/[\u0000-\u0020]/.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const rule = EXTERNAL_ALLOW.find((r) => r.origin === parsed.origin);
  return rule ? rule.paths.some((p) => pathMatches(parsed.pathname, p)) : false;
}

/** URL для журнала: без управляющих символов, чтобы строка не дописала запись. */
export function urlForLog(url: unknown): string {
  return String(url)
    .replace(/[\u0000-\u0020]/g, ' ')
    .slice(0, 80);
}