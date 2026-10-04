// Проверка «вышла ли новая версия» для portable-сборки.
//
// Зачем отдельно: portable не обновляется сам. electron-builder кладёт
// `app-update.yml` (адрес провайдера) в resources, только если в сборке есть
// nsis-цель: проверено сборкой только-portable — файла нет, апдейтеру нечем
// проверять обновления. В сборке nsis+portable файл есть, и portable по ленте
// скачал бы NSIS-установщик, то есть поставил бы приложение рядом вместо
// обновления своей копии. Поэтому portable только сообщает.
//
// Адрес ленты: `releases/latest/` на GitHub отдаёт последний релиз БЕЗ
// pre-release — старый «Beta v1.0» с меткой pre-release в выдачу не попадает, и
// уведомления о нём не будет. Следствие, о котором легко забыть: если 1.2.1
// опубликовать с меткой pre-release, portable её не увидит никогда. Токен не
// нужен, лимиты GitHub API не тратятся (CDN отдаёт файл без API).

/** Лента обновлений: всегда последний стабильный релиз. */
export const RELEASE_FEED_URL =
  'https://github.com/Far-g-Us/price_aggregator/releases/latest/download/latest.yml';

/** Страница релизов: её открывает клик по уведомлению. */
export const RELEASES_PAGE_URL = 'https://github.com/Far-g-Us/price_aggregator/releases';

/**
 * Настоящий `latest.yml` electron-builder'а весит около 300 байт. Порог нужен,
 * чтобы каптив-портал или прокси не подсунул нам страницу на полмегабайта.
 *
 * Здесь длина в символах строки — это второй рубеж, а не мера трафика: байты
 * считаются по потоку при чтении ответа, и тело такого размера просто не
 * дочитывается.
 */
export const MAX_FEED_BYTES = 8 * 1024;

/**
 * Версия из тела `latest.yml`.
 *
 * Требуется не только строка `version:`, но и второй маркер того же формата
 * (`files:`, `path:` или `sha512:`). Одной строки мало: любой 200 с текстом, где
 * есть `version: 9.9.9`, иначе стал бы вечным ложным уведомлением — а снять его
 * `notifiedRelease` уже не даст до перезапуска. Разбор ограничен строками файла,
 * полноценный YAML ради одного числа тут был бы лишним.
 */
export function parseFeedVersion(feed: string): string | null {
  if (feed.length > MAX_FEED_BYTES) return null;
  const version = /^version:\s*["']?([^"'\s]+)["']?\s*$/m.exec(feed)?.[1];
  if (version === undefined) return null;
  const looksLikeFeed = /^files:/m.test(feed) || /^path:/m.test(feed) || /^sha512:/m.test(feed);
  return looksLikeFeed ? version : null;
}

/**
 * Строгое сравнение `x.y.z`. Без префикса `-beta` и без коротких версий вида
 * `1.2`: такие строки не считаем новее, иначе релиз `1.2.2-beta` приравнялся бы
 * к `1.2.2`, а сравнение `1.2` с `1.2.1` вело бы себя как равенство.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  const [aMajor, aMinor, aPatch] = a;
  const [bMajor, bMinor, bPatch] = b;
  if (aMajor !== bMajor) return aMajor > bMajor;
  if (aMinor !== bMinor) return aMinor > bMinor;
  return aPatch > bPatch;
}

/**
 * Версия из ленты по сети. Ошибка сети или разбор — не повод показывать
 * ошибку пользователю: уведомление об обновлении молчит, лог пишет вызывающий.
 */
export async function readFeedVersion(
  fetchText: (url: string) => Promise<string>,
  url: string = RELEASE_FEED_URL,
): Promise<string | null> {
  try {
    return parseFeedVersion(await fetchText(url));
  } catch {
    return null;
  }
}