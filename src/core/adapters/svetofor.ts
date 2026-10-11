// Светофор: цены лежат отдельным статическим файлом на поддомене региона.
//
// Почему так: страница региона отдаёт `var shopid` (точка по умолчанию для
// этого домена) и `var offersupd` (метка выгрузки), а сам прайс — это
// `GET https://<домен>.svetoforonline.ru/cache/offers-<shopid>-<offersupd>.json`.
// В HTML цен нет — парсить нечего, поэтому адаптер держится на этом файле.
//
// Что проверено на живых ответах (замер 2026-10-08, три региона):
// - файл прайса — МАССИВ объектов, не объект-карта:
//   `[{"id":104255,...}]`. Раньше фикстура была пересобрана руками в
//   `{"2235":{...}}`, из-за чего адапторный отказ на массиве не всплыл, а оба
//   заведённых магазина не отдали бы ни одной цены;
// - `shopid` на странице региона — это точка по умолчанию для домена (в
//   moskovskaya-oblast это 838, а не наш 376), поэтому shopid берётся ТОЛЬКО
//   из конфига, а со страницы региона читается одна метка `offersupd`;
// - `offersupd` региональный и лежит на поддомене региона, а не на
//   svetoforonline.ru: у московских доменов своя пара (домен, метка);
// - `p` — цена в копейках (`p=6290` → 62,90 ₽);
// - `c` — себестоимость, а не старая цена: `0 < c < p` у подавляющего
//   большинства, `c > p` у единиц (данные с ошибкой), `c = 0` тоже бывает.
//   Поэтому `promoPrice` и `oldPrice` всегда `null`, а `c` не пишется: иначе в
//   историю уехала бы закупочная цена;
// - `d` — ПОСТРОЧНАЯ отметка позиции (unixtime), а не дата выгрузки файла: в
//   живом прайсе 552 строк несут 37 разных `d` с размахом в 22 дня. Поэтому резать
//   по нему строки нельзя — живые SKU молча исчезли бы из поиска и из карточки;
//   свежесть прайса судится по максимуму: у заброшенных точек протух весь файл
//   (магазин 376 отдаёт `d` = 2021 год), и тогда это отказ сети, а не пустая полка;
// - `w` — объём/вес упаковки в граммах БЕЗ единицы измерения: и «Молоко 1 л»,
//   и «Арахис 1 кг» — это `w = 1000, ei = 'шт.'`, а у «Сухари 500 гр» в названии
//   стоит `w = 1000`. Поле противоречит названию, поэтому фасовка берётся из
//   названия (см. `svetoforUnit`);
// - `id` — SKU сети: в пределах региона общий (из 553 товаров магазина 820 у
//   488 тот же id, что у 377, у 447 из них та же цена), а между регионами
//   пересечение крошечное (12 из ~550) — assortment регионов разный, но у
//   совпавших id совпадает и название. Значит `canonicalId` = `svt-<id>`
//   без магазина, а вот цена обязана быть per-store;
// - цены ПРИ ЭТОМ per-store: в одном регионе 41 расхождение цены из 488;
//   между Калугой и Москвой цены тоже разные (йогурт 2885 против 3560 на
//   старых метках). Значит выбор магазина обязателен;
// - `articul` — 7-значный артикул магазина, не EAN: в 548 товарах ни одного
//   13-значного. В `barcode` его класть нельзя, расхождение barcode жёстко
//   запрещает склейку и молча убило бы её с любой сеткой с настоящим EAN;
// - `ei` — единица измерения сети («шт.», «кг.»), причём «кг.» означает
//   «продаётся на вес», а не «фасовка в килограммах». В `unit` его не пишем;
// - наличия отдельного флага нет: товар есть в прайсе точки — есть, нет — нет.
//   Исчезновение приходит как ProductLookupError (переименование/снятие), но
//   `in_stock=0` в истории при этом не пишется: сеть не умеет сказать «нет».

import { ProductLookupError, StaleStoreError } from '../adapter-errors.js';
import { normalizeName } from '../../shared/matching.js';
import type { ProductFetchContext, ScrapedProduct, Store, StoreAdapter, StoreCategory } from '../../shared/types.js';

/** Что отдаёт сеть в одной строке прайса. Неизвестные поля игнорируем. */
export interface SvetoforOffer {
  id?: number | string;
  cat?: number | string;
  pod_cat?: string;
  catchpu?: string;
  name?: string;
  chpu?: string;
  articul?: string;
  pn?: string;
  /** Вес/объём в граммах: 1000 у килограммовых, 260 у «Коктейль 260г». */
  w?: number;
  ei?: string;
  rate?: number;
  p?: number;
  c?: number;
  /** Дата выгрузки прайса, unixtime. */
  d?: number;
}

/** Прайс точки — массив строк, ровно как отдаёт сеть. */
export type SvetoforPriceList = SvetoforOffer[];

export const SVETOFOR_ORIGIN = 'https://svetoforonline.ru';

/** Сколько ждём ответа сети. */
export const SVETOFOR_TIMEOUT_MS = 15_000;
/** Сколько живёт файл прайса в памяти до перечитывания. */
export const SVETOFOR_PRICE_TTL_MS = 30 * 60 * 1000;
/** Сколько помним метку прайса региона, не заходя на страницу региона. */
export const SVETOFOR_STAMP_TTL_MS = 60 * 60 * 1000;
/**
 * Порог свежести прайса (по МАКСИМУМУ `d`, см.
 * `assertSvetoforPriceListFresh`). Две недели, а не неделя: у живой точки 820
 * самая «долгая» позиция старше недели на 1 день, и розница вполне может не
 * трогать позицию месяц, оставаясь живой. Зато у по-настоящему заброшенной
 * точки протух весь файл (магазин 376 — 2021 год), так что запас в две недели
 * отсекает именно мёртвые точки и не выключает живые.
 */
export const SVETOFOR_STALE_MS = 14 * 24 * 60 * 60 * 1000;

/** Браузерная заголовка: без них CDN отдаёт пустое тело. */
const SVETOFOR_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0',
  Accept: 'application/json,text/plain,*/*',
  Referer: 'https://svetoforonline.ru/',
} as const;

interface FetchLike {
      (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<{
        ok: boolean;
        status: number;
        text(): Promise<string>;
        // Страница региона приходит в windows-1251 (живая проверка заголовка), а
        // `text()` по спецификации Fetch всегда читает UTF-8, игнорируя `charset`:
        // кириллица превращалась в U+FFFD и в UI выглядела ромбиками. Поэтому
        // страницу читаем сами, через заголовок `content-type`.
        headers?: { get(name: string): string | null };
        arrayBuffer?(): Promise<ArrayBuffer>;
      }>;
    }

const cache = new Map<string, { at: number; list: SvetoforPriceList }>();
/**
 * Прайсы, которые сеть не обновляет. Без этого отказ по протухшему файлу
 * скачивал бы его заново на каждом товаре: 40 позиций по 250 КБ — это 10 МБ
 * на один обход, и каждая позиция ещё и ждала бы таймаут. Отказ лежит столько же,
 * сколько лежит свежий прайс, и снимается вместе с ним.
 */
const staleKeys = new Map<string, { at: number; shopId: string; newest: number; key: string }>();
const stampFor = new Map<string, string>();
const stampAt = new Map<string, number>();
/** Больше полок не показываем: на живом прайсе их десять, запас есть. */
const SHELF_LIMIT = 40;
/**
 * Больше товаров одной полки не отдаём. Прайс региона — это весь ассортимент
 * (552 позиции на живой фикстуре), поэтому раздел может оказаться крупнее любого
 * разумного экрана. Обрезка молча выглядела бы как «в полке 400 товаров», хотя
 * показаны первые 300, — поэтому граница объявлена и товары дальше не идут.
 */
const SHELF_PRODUCT_LIMIT = 300;

/** Метка прайса, прочитанная со страницы региона: она региональная, не магазинная. */
export function svetoforStamp(domain: string): string | undefined {
  return stampFor.get(domain);
}

/** Подложить метку вручную: нужно тестам и зондам, которые получили страницу региона. */
export function setSvetoforStamp(domain: string, stamp: string): void {
    stampFor.set(domain, stamp);
    stampAt.set(domain, Date.now());
    // Разметка меню была скачана ДО этой метки и относится к прежней выгрузке.
    // Оставлять её в кэше нельзя: `regionPage` отдал бы меню старше метки как
    // свежее, и витрина показала бы переименованные разделы старой выгрузки.
    pageFor.delete(domain);
  }

export function svetoforPriceUrl(domain: string, shopId: string, stamp: string): string {
  return `https://${domain}.svetoforonline.ru/cache/offers-${shopId}-${stamp}.json`;
}

export function svetoforShopUrl(domain: string): string {
  return `https://${domain}.svetoforonline.ru/`;
}

// --- Полки. ------------------------------------------------------------------
//
// Витрины с отдельным API у сети нет: всё, что нужно для полок, лежит в ПРАЙСЕ.
// В строке товара поле `catchpu` — человекочитаемый путь категории вплоть до
// товара (`bakaleya-i-drugie-produktsiya/bakaleya/pripravi-i-spetsii/`), то есть
// верхний сегмент — это раздел. На 2026-10-08 в живой фикстуре точки 649 так
// получилось ровно 10 разделов на все 552 товара, и адреса разделов открываются
// (проверено: `bakaleya-i-drugie-produktsiya/` → 200, 113 товаров).
//
// Почему полки — верхний уровень, а не 152 листовых `catchpu`: подкатегорий в
// разметке сайта нет (проверено — на странице раздела только товары, ноль ссылок
// на подразделы), а название полки есть лишь в заголовке `h1` самой полки.
// Опрашивать 152 полки ради заголовков — минуты ожидания, тогда как названия
// разделов лежат в меню главной и стоят один запрос. Товары при этом те же самые:
// раздел — это все строки прайса, чей `catchpu` на нём начинается.

/** Раздел верхнего уровня из пути `catchpu`. */
export function svetoforShelf(catchpu: unknown): string {
  const first = String(catchpu ?? '').trim().split('/').filter(Boolean)[0] ?? '';
  return first;
}

/** Товары раздела: строки прайса, у которых `catchpu` начинается с этого пути. */
export function inSvetoforShelf(offer: SvetoforOffer, shelf: string): boolean {
  const first = svetoforShelf(offer.catchpu);
  return first !== '' && first === shelf;
}

/**
 * Адрес полки. Собирается из проверенного раздела, но домен подставляется по
 * справочнику магазина: в ссылке лежит поддомен региона, и чужой в ссылке уехал бы
 * на сайт другого региона — мимо нашего магазина.
 */
export function svetoforShelfUrl(domain: string, shelf: string): string {
  const segments = shelf
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map((segment) => encodeURIComponent(segment));
  return `https://${domain}.svetoforonline.ru/${segments.join('/')}/`;
}

/**
 * Раздел из адреса полки. Проверяем и хост, и путь: адреса других регионов у нас
 * тоже валидные, и без сверки домена клик по полке Пятёрки ушёл бы в Светофор.
 * Возвращаем путь-«ключ», который сравнивают с `svetoforShelf`.
 */
export function svetoforShelfFromUrl(url: string, domain: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
    if (parsed.protocol !== 'https:' || parsed.port !== '') return null;
    if (parsed.hostname !== `${domain}.svetoforonline.ru`) return null;
    // Пустой путь — это корень сайта, а не полка: возвращать `''` нельзя, иначе
    // `canHandleCategoryUrl` счёл бы главную страницу полкой.
    return shelfOfPath(parsed.pathname);
}

/**
 * Раздел из пути URL. Декодирование может бросить URIError на битом процентах
 * (/%zz/), а canHandleCategoryUrl зовут из services ВНЕ try — reject ушёл бы
 * в IPC вместо «не наша полка. Поэтому битый путь — просто не полка.
 */
function shelfOfPath(pathname: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    // `.htm`/`.html` — старые адреса разделов и товаров, не полка верхнего уровня.
    // Больше по форме адреса отличить полку от товара нельзя: в живой выгрузке
    // 549 из 552 `chpu` — односегментные слагы с буквы на первом месте, то есть
    // ровно такие же, как у раздела. Различает их только содержимое прайса,
    // поэтому сверка живёт в `canHandleCategoryUrl` и `fetchCategoryProducts`.
    const segments = decoded.split('/').filter((part) => part !== '');
    // `filter` дал ровно один элемент, поэтому `segments[0]` определён: страховаться
    // через `?? ''` здесь значило бы добавить непокрываемую ветку.
    if (segments.length !== 1) return null;
    const shelf = svetoforShelf(segments[0] as string);
    if (shelf === '' || /\.html?$/i.test(shelf)) return null;
    return shelf;
  }

/**
 * Верхние разделы в уже скачанных прайсах ДОМЕНА. `canHandleCategoryUrl`
 * синхронный и магазина не получает, поэтому сверять можно только с тем, что
 * уже есть в памяти — и только по своему региону: у сети два города, и полка
 * одного региона, которой нет в прайсе другого, иначе отвергалась бы там, где
 * прайс просто не качали (каталог отдан из кэша БД, прайс не трогали).
 * Пустой результат — ещё не «не полка»: прайс мог просто не открываться.
 */
  function cachedShelves(domain: string): Set<string> | null {
    let seen = false;
    const out = new Set<string>();
    for (const [key, { list }] of cache) {
      if (key.split('/')[0] !== domain) continue;
      seen = true;
      for (const offer of list) {
        const shelf = svetoforShelf(offer.catchpu);
        if (shelf !== '') out.add(shelf);
      }
    }
    return seen ? out : null;
  }

/**
 * Полка любого региона Светофора по адресу. Хост сверяется по правилу сети
 * (`<регион>.svetoforonline.ru`): адреса всех регионов валидны, и без сверки домена
 * клик по полке чужой сети ушёл бы в наш обработчик.
 */
export function svetoforShelfFromAnyDomain(url: string): string | null {
  return svetoforRegionOfUrl(url)?.shelf ?? null;
}

/**
 * Адрес любого региона: регион и раздел из него. Возвращаются ОБА значения,
 * потому что `canHandleCategoryUrl` сверяет раздел с прайсом ИМЕННО своего
 * региона, а повторный `new URL` там означал бы второй разбор той же строки.
 */
function svetoforRegionOfUrl(url: string): { domain: string; shelf: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.port !== '') return null;
  // Ведущая точка и есть граница метки: без неё `endsWith` пропустил бы
  // `evil-svetoforonline.ru`, а голый `svetoforonline.ru` без региона и так не
  // проходит (у него нет точки перед именем).
  const suffix = '.svetoforonline.ru';
  if (!parsed.hostname.endsWith(suffix)) return null;
  const shelf = shelfOfPath(parsed.pathname);
  if (shelf === null) return null;
  return { domain: parsed.hostname.slice(0, -suffix.length), shelf };
}

/** Служебные разделы меню: не полки, а служебные страницы сайта. */
  const NON_SHELF_SEGMENTS = new Set(['shops', 'content', 'novye-postypleniya']);

/**
 * Иконка раздела меню.
 *
 * Сайт отдаёт её отдельным файлом на CDN: у пункта меню есть `id="menu-<N>"`, а
 * картинка лежит по адресу `cdn.binuke.info/projects/svetofor/svg/menu-<N>.svg`
 * (проверено живьём 2026-10-11 на нескольких регионах: 5895, 5947 → 200;
 * несуществующие номера → 404, то есть адрес не «отдаёт что угодно»).
 *
 * В САМОЙ разметке ссылки на иконку нет — она подставляется клиентским
 * скриптом, поэтому в HTML мы ищем только `id` пункта. Номера разным регионам
 * соответствуют одни и те же (5895 = «Молочная продукция» и в Петербурге, и в
 * Твери), то есть адрес зависит только от номера, а не от региона.
 */
export function svetoforCategoryImageUrl(menuId: string): string {
  return `https://cdn.binuke.info/projects/svetofor/svg/${menuId}.svg`;
}

/**
 * Разделы из меню главной: один запрос даёт и названия, и адреса. Меню помечено
 * в разметке, но класс нестабилен между правками сайта, поэтому берём любую
 * ссылку-раздел с непустым текстом и отсеиваем служебные адреса.
 *
 * `menuId` — номер из `id` пункта (`menu-5895` → `5895`), из него собирается адрес
 * иконки. Разбираем именно ближайший предшествующий `<li>`: номер стоит на
 * `<li>`, а не на самой ссылке, и искать его «рядом» со ссылкой можно было бы
 * на соседнем пункте — иконка была бы от чужого раздела.
 */
export function parseSvetoforMenu(html: string, domain?: string): { shelf: string; name: string; menuId: string }[] {
  const out: { shelf: string; name: string; menuId: string }[] = [];
  const seen = new Set<string>();
  // Регулярка с ДВУМЯ группами захвата всегда даёт обе: `match[1]` и `match[2]` не
  // могут быть `undefined`, поэтому проверки тут были бы мёртвыми ветками.
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(re)) {
    const [, hrefRaw = '', nameRaw = ''] = match;
    // Номер пункта меню ищем в том фрагменте разметки, который стоит ПЕРЕД
    // ссылкой: сам `<a>` номера не содержит, а следующий пункт — уже другой
    // раздел. Всё, что до конца предыдущего `</li>` (или начала строки с
    // `<ul`), — это и есть наш пункт.
    const before = html.slice(0, match.index);
    const itemStart = Math.max(before.lastIndexOf('<li'), before.lastIndexOf('<ul'));
    const menuId = /id=["']menu-(\d+)["']/.exec(before.slice(itemStart))?.[1] ?? '';
    // Ссылка может быть относительной (`/razdel/`) или абсолютной
    // (`https://<регион>.svetoforonline.ru/razdel/`). Во втором случае разбор
    // строки дал бы фиктивный раздел `https:` — а такие ссылки сайт начнёт
    // отдавать рано или поздно, и витрина схлопнулась бы в один пункт.
    let path = hrefRaw.trim();
    if (/^[a-z]+:\/\//i.test(path)) {
      try {
        const parsed = new URL(path);
        // Меню может вести на соседний регион. Название оттуда у нас было бы, а
        // товары — из нашего прайса, то есть подпись врала бы: свой раздел с чужим
        // именем. Хост сверяем, когда регион известен.
        if (domain !== undefined && parsed.hostname !== `${domain}.svetoforonline.ru`) continue;
        path = parsed.pathname;
      } catch {
        continue;
      }
    }
    // `?utm=…` и `#якорь` у относительной ссылки остались бы в пути и раздел
    // молча выпал бы из витрины: у абсолютных их срезает `URL.pathname`. `split`
    // всегда даёт первый элемент, поэтому `?? ''` был бы непокрываемой веткой.
    path = path.split(/[?#]/)[0] as string;
    path = path.replace(/^\/+/, '');
    const name = nameRaw
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (path === '' || name.length === 0 || name.length > 90) continue;
    // Служебные адреса сверяем по первому сегменту: `/novye-postypleniya` без
    // завершающего слеша иначе прошёл бы и стал бы кандидатом в полку.
    if (NON_SHELF_SEGMENTS.has(svetoforShelf(path))) continue;
    // Пункт меню — это раздел верхнего уровня, а всё, что глубже одного сегмента
    // (вложенные разделы, товары), — не полка. Имя берём из меню, а не из
    // `catchpu`: там транслит.
    const shelf = svetoforShelf(path);
    // Набор символов слага — по живой выгрузке, где есть и точки, и запятые
    // (`posuda,-hoz.tovari,-mebel`): запретив точку, мы бы молча выкинули целый
    // раздел. Первая буква или цифра отсекает адрес товара (у `chpu` она всегда
    // дефис), кириллица в `href` — служебная или битая ссылка.
    if (shelf === '' || !/^[a-z0-9][a-z0-9,.-]*$/i.test(shelf) || shelf !== path.replace(/\/$/, '')) continue;
    if (seen.has(shelf)) continue;
    seen.add(shelf);
    out.push({ shelf, name, menuId });
  }
  return out;
}

/**
 * Адрес товара на сайте. `chpu` приходит из прайса и уходит в путь URL, поэтому
 * кодируется: иначе строка вида `../../admin` уехала бы за пределы магазина, а
 * пробелы и кириллица (в `chpu` их нет, но проверить надо) дали бы битый адрес.
 */
export function svetoforProductUrl(domain: string, chpu: string): string {
  const path = chpu
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    // Сегменты `.` и `..` выбрасываем: `encodeURIComponent('..')` возвращает
    // `..` без изменений, то есть кодирование тут не помогает и такой сегмент
    // ушёл бы на уровень выше магазина. В живой фикстуре встречается `..`
    // ВНУТРИ сегмента (`galoshi-art..m-001-...`), и такие сегменты безопасны —
    // режется только сегмент, равный точке.
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://${domain}.svetoforonline.ru/${path}`;
}

/**
 * Картинка товара. Путь не в самом прайсе (там только `img` — это unixtime
 * позиции, не путь), поэтому адрес собран по шаблону и проверен живыми
 * запросами 2026-10-08: `/data/share/item_<id>.jpg` отдаёт настоящий JPEG
 * (`image/jpeg`, 30 КБ для 97759, 20 КБ для 104255, заголовок FFD8), а
 * несуществующий id даёт 404, а не заглушку-картинку. Работает и на
 * поддомене региона, поэтому оба адреса валидны.
 */
export function svetoforImageUrl(id: number | string): string {
  return `${SVETOFOR_ORIGIN}/data/share/item_${id}.jpg`;
}

/**
 * Идентификатор товара для нашей БД: `svt-<id>`, где `id` — SKU сети.
 * Магазина в ключе нет намеренно: в пределах региона id общий у точек одного
 * региона (и цена per-store отслеживается полем магазина), а SKU в разных
 * регионах — те же товары.
 */
export function svetoforCanonicalId(id: number | string): string {
  // `String.trim()` обязателен: с пробела в id получается `svt- 104255`, то есть
  // тот же товар под другим ключом и вторая кривая история цен.
  return `svt-${String(id).trim()}`;
}

/** Цена в рублях из копеек. */
export function svetoforPrice(kopecks: unknown): number | null {
  const value = typeof kopecks === 'string' ? Number(kopecks.trim()) : kopecks;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value) / 100;
}

/**
 * Фасовка из названия, тем же разбором, что и в `matching.normalizeName`.
 *
 * Поле `w` для этого не годится: в живых данных оно противоречит названию
 * («Сухари с изюмом 500 гр» при `w = 1000`), а у литров и килограммов одно и то
 * же значение (и «Молоко 1 л», и «Арахис 1 кг» — это `w = 1000`, `ei = 'шт.'`),
 * то есть это объём/вес упаковки в граммах без единицы. Единицу измерения сеть
 * пишет в `ei` родным словом («шт.», «кг.»), но в `unit` его класть нельзя:
 * у соседних сетей фасовка живёт в названии, и `sameProduct` отсекает пару по
 * неравному `unit`, то есть штучные товары Светофора не склеились бы ни с
 * одной сеткой. В названии фасовка есть у 448 строк из 553.
 */
export function svetoforUnit(name: unknown): string | undefined {
  // Порядок важен: `кг`/`мл` должны проверяться раньше `г`/`л`, иначе из «1 кг»
// получится «1 г», а из «580 мл» — «580 л».
const hit = String(name ?? '')
    .replace(/ё/g, 'е')
    .match(/(\d+(?:[.,]\d+)?)\s*(кг|мл|гр|г|л)(?![а-яa-z0-9])/i);
  if (!hit?.[1] || !hit[2]) return undefined;
  // Регекс берёт только группу с цифрами, поэтому Number всегда конечен и
  // проверка на мусор не нужна.
  const value = Number(hit[1].replace(',', '.'));
  const unit = hit[2].toLowerCase();
  if (unit === 'кг') return `${trimZeros(value)} кг`;
  // Миллилитры в литры переводим только от килолитра: «580 мл» — это «580 мл»,
  // а не «580 л».
  if (unit === 'мл') return value >= 1000 ? `${trimZeros(value / 1000)} л` : `${trimZeros(value)} мл`;
  if (unit === 'л') return `${trimZeros(value)} л`;
  // Граммы в килограммы — от килограмма: «1000 г» это то же, что «1 кг».
  return value >= 1000 && Number.isInteger(value)
    ? `${trimZeros(value / 1000)} кг`
    : `${trimZeros(value)} г`;
}

/** Дробное число без хвостовых нулей: 1.50 → 1.5, но 2.25 остаётся 2.25. */
function trimZeros(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** Дата прайса строки в миллисекундах, если она похожа на unixtime. */
export function svetoforOfferDate(offer: { d?: unknown }): number | null {
  const raw = offer.d;
  const d = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) return null;
  // Секунды: 10 цифр у 2026 года, миллисекунды — 13.
  return d < 1e11 ? d * 1000 : d;
}

/**
 * Строка прайса в товар для нашей БД. Возвращает `null`, если товар нельзя
 * показать: нет названия, нет цены, нет `id` (без него нельзя построить
 * устойчивый ключ — ключ из названия ломает фичу «разные товары», где разделитель
 * пары — пробел, и такой id туда нельзя).
 */
export function normalizeSvetoforOffer(
  offer: SvetoforOffer,
  ctx: { city: string; domain: string },
): ScrapedProduct | null {
  const name = String(offer.name ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name === '') return null;
  const price = svetoforPrice(offer.p);
  if (price === null) return null;
  const id = offer.id;
  if (id === undefined || (typeof id === 'string' && id.trim() === '')) return null;

  const product: ScrapedProduct = {
    canonicalId: svetoforCanonicalId(id),
    storeId: 'svetofor',
    city: ctx.city,
    name,
    price,
    promoPrice: null,
    oldPrice: null,
    inStock: true,
    collectedAt: new Date().toISOString(),
  };
  const unit = svetoforUnit(name);
  if (unit !== undefined) product.unit = unit;
  product.imageUrl = svetoforImageUrl(id);
  const chpu = typeof offer.chpu === 'string' ? offer.chpu.trim() : '';
  if (chpu !== '') product.url = svetoforProductUrl(ctx.domain, chpu);
  return product;
}

/** Метка нужна, чтобы поставить её в ключ кэша: без неё файл не адресовать. */
function cacheKey(domain: string, shopId: string, stamp: string): string {
  return `${domain}/${shopId}/${stamp}`;
}

/**
 * Разметка страницы региона. Она нужна и для метки прайса, и для меню с разделами
 * — это ОДИН и тот же адрес, поэтому страница кэшируется целиком: два запроса на
 * один URL означали бы, что второй всегда попадает в сеть при кэше.
 */
const pageFor = new Map<string, string>();

/**
 * Метка прайса региона. Без неё файл прайса не адресовать, а лежит она в
 * `var offersupd=…` на странице региона, поэтому при первом обращении метка
 * читается оттуда. Час: метка меняется раз в сутки, но и лежит она на том же
 * поддомене, что и сам прайс, так что час — с запасом и без суток простоя.
 *
 * Кэшируется ТОЛЬКО успешно разобранная страница: страница без метки (капча,
 * блокировка) в кэш не попадает, иначе следующий вызов получил бы из кэша ошибку
 * вместо свежего ответа, и заведомо исправный обход молчал бы до конца часа.
 */
export async function resolveSvetoforStamp(
  fetchImpl: FetchLike,
  domain: string,
  now: () => number = Date.now,
): Promise<string> {
  const known = stampFor.get(domain);
  const at = stampAt.get(domain);
  if (known !== undefined && at !== undefined && now() - at < SVETOFOR_STAMP_TTL_MS) return known;
  return (await readRegion(fetchImpl, domain, now)).stamp;
}

/**
 * Разметка страницы региона для меню разделов. Свой запрос не делается: адрес
 * тот же, что и у метки, а разметка уже лежит в кэше — иначе открытие витрины
 * качало бы главную страницу второй раз подряд.
 *
 * Метка при этом может быть подставлена вручную (тесты так делают через
 * `setSvetoforStamp`), и разметки тогда в кэше нет: витрина читает страницу
 * заново — иначе меню было бы пустым, а кода разбора метки на разметке нет.
 */
async function regionPage(fetchImpl: FetchLike, domain: string, now: () => number): Promise<string> {
  const cached = pageFor.get(domain);
  const at = stampAt.get(domain);
  if (cached !== undefined && at !== undefined && now() - at < SVETOFOR_STAMP_TTL_MS) return cached;
  return (await readRegion(fetchImpl, domain, now)).html;
}

/** Страница региона: читается один раз, отдаёт и метку прайса, и меню разделов. */
async function readRegion(
  fetchImpl: FetchLike,
  domain: string,
  now: () => number,
): Promise<{ stamp: string; html: string }> {
  const res = await fetchImpl(svetoforShopUrl(domain), {
    signal: AbortSignal.timeout(SVETOFOR_TIMEOUT_MS),
    headers: { ...SVETOFOR_HEADERS },
  });
  if (!res.ok) throw new Error(`svetofor: страница региона ${domain} — HTTP ${res.status}`);
  const html = await readHtml(res);
  const stamp = html.match(/offersupd\s*=\s*"?(\d+)"?/)?.[1];
  if (stamp === undefined) {
    throw new Error(`svetofor: на странице региона ${domain} нет метки прайса offersupd`);
  }
  stampFor.set(domain, stamp);
  stampAt.set(domain, now());
  pageFor.set(domain, html);
  return { stamp, html };
}

/**
 * Текст страницы с учётом кодировки из заголовка.
 *
 * Живая страница региона приходит как `text/html; charset=windows-1251`, а
 * `Response.text()` по спецификации Fetch всегда декодирует UTF-8 и `charset`
 * игнорирует: кириллица в названиях разделов превращалась в U+FFFD, а такой символ
 * рисуется глифом фиксированной ширины — в UI это выглядело как моноширинный
 * шрифт с ромбиками. Поэтому декодируем сами, а `arrayBuffer` недоступен (тестовые
 * harness отдают только `text`) — тогда берём `text()`.
 *
 * Кодировку берём из заголовка, но доверяем ей не полностью: без `arrayBuffer`
 * декодировать нечем, поэтому неизвестную или неподдерживаемую метку считаем
 * windows-1251 (живой ответ сайта), а utf-8 — единственной, где `text()` честен.
 */
async function readHtml(res: {
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
  arrayBuffer?(): Promise<ArrayBuffer>;
}): Promise<string> {
  const charset = res.headers?.get('content-type')?.match(/charset=["']?([\w-]+)/i)?.[1]?.toLowerCase();
  // Декодируем сами ТОЛЬКО когда сеть сама назвала кодировку из известного списка.
  // Без заголовка честный путь один — `text()` (UTF-8): угадывать windows-1251
  // наугад значило бы превратить нормальный UTF-8-ответ в «мохибаке».
  const label = charset === 'windows-1251' || charset === 'koi8-r' || charset === 'koi8-u' ? charset : null;
  if (label === null || res.arrayBuffer === undefined) return res.text();
  const bytes = new Uint8Array(await res.arrayBuffer());
  return new TextDecoder(label).decode(bytes);
}
/** Забыть метку региона: после 404 на файле прайса она протухла. */
export function forgetSvetoforStamp(domain: string): void {
  stampFor.delete(domain);
  stampAt.delete(domain);
  // Разметку сбрасываем вместе с меткой: приехала новая страница региона, значит
  // и разделы в меню могли переехать.
  pageFor.delete(domain);
}

/**
 * Убрать ключи домена, у которых метка выгрузки уже не та.
 *
 * Важно: вытесняются именно ключи с ДРУГОЙ меткой, а не все ключи домена.
 * Домен — это регион, и в нём около 16 точек (636 на 40 доменов), так что
 * вытеснение по домену целиком означало бы, что опрос двух точек одного региона
 * перечитывает прайс каждой по разу на товар (проверено: 8 товаров двух точек
 * давали 8 загрузок вместо 2). Освободить надо только память от меток, которых
 * больше нет.
 */
function evictDomain(domain: string, stamp: string): void {
  const prefix = `${domain}/`;
  const suffix = `/${stamp}`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix) && !key.endsWith(suffix)) cache.delete(key);
  }
  for (const key of [...staleKeys.keys()]) {
    if (key.startsWith(prefix) && !key.endsWith(suffix)) staleKeys.delete(key);
  }
}

/**
 * Прайс точки. 404 означает протухшую метку: снимаем её, читаем регион заново и
 * делаем один повтор — иначе после суточной смены выгрузки процесс молчал бы
 * до суток. Повтор ровно один, чтобы не кружить при уехавшем магазине.
 */
export async function loadSvetoforPriceList(
  fetchImpl: FetchLike,
  domain: string,
  shopId: string,
  stamp: string,
  now: () => number = Date.now,
): Promise<SvetoforPriceList> {
  const key = cacheKey(domain, shopId, stamp);
  const hit = cache.get(key);
  if (hit && now() - hit.at < SVETOFOR_PRICE_TTL_MS) return hit.list;
  const stale = staleKeys.get(key);
  if (stale && now() - stale.at < SVETOFOR_PRICE_TTL_MS) {
    throw new StaleStoreError(stalePriceError(stale.shopId, stale.newest, now()), stale.key);
  }
  staleKeys.delete(key);
  const first = await fetchSvetoforPriceList(fetchImpl, domain, shopId, stamp, key, now);
  if (first !== null) return first;
  forgetSvetoforStamp(domain);
  const fresh = await resolveSvetoforStamp(fetchImpl, domain, now);
  if (fresh === stamp) {
    throw new Error(`svetofor: прайс магазина ${shopId} недоступен по свежей метке ${stamp}`);
  }
  const retried = await fetchSvetoforPriceList(fetchImpl, domain, shopId, fresh, cacheKey(domain, shopId, fresh), now);
  if (retried === null) {
    throw new Error(`svetofor: прайс магазина ${shopId} недоступен по свежей метке ${fresh}`);
  }
  return retried;
}

/** Один запрос прайса. `null` — метка протухла, пора перечитать регион. */
async function fetchSvetoforPriceList(
  fetchImpl: FetchLike,
  domain: string,
  shopId: string,
  stamp: string,
  key: string,
  now: () => number,
): Promise<SvetoforPriceList | null> {
  const res = await fetchImpl(svetoforPriceUrl(domain, shopId, stamp), {
    signal: AbortSignal.timeout(SVETOFOR_TIMEOUT_MS),
    headers: { ...SVETOFOR_HEADERS },
  });
  if (!res.ok) {
    // Вытесняем кэш только когда файл уехал (метка протухла). На 503 кэш не
    // трогаем: иначе один кратковременный сбой заставил бы каждый следующий
    // товар того же домана заново качать 0,26 МБ.
    if (res.status === 404) {
      evictDomain(domain, stamp);
      return null;
    }
    throw new Error(`svetofor: прайс магазина ${shopId} — HTTP ${res.status}`);
  }
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Не-JSON и не-массив — это дрейф формата, а не уехавший файл: кэш домена
    // тут НЕ вычищаем, иначе один сбой CDN заставил бы заново качать прайс всем
    // остальным магазинам региона (0,26 МБ на точку).
    throw new Error(`svetofor: прайс магазина ${shopId} — не JSON (${body.slice(0, 60)})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `svetofor: прайс магазина ${shopId} — ожидался массив, получено ${parsed === null ? 'null' : typeof parsed}`,
    );
  }
  const list = parsed.filter((row): row is SvetoforOffer => typeof row === 'object' && row !== null);
  const { newest } = assertSvetoforNewestDate(shopId, list);
  evictDomain(domain, stamp);
  if (now() - newest > SVETOFOR_STALE_MS) {
    // Отказ кэшируется: протухший прайс не перечитывается на каждом товаре,
    // иначе один опрос 40 позиций скачал бы файл 40 раз.
    const storeKey = `svetofor:${shopId}`;
    staleKeys.set(key, { at: now(), shopId, newest, key: storeKey });
    throw new StaleStoreError(stalePriceError(shopId, newest, now()), storeKey);
  }
  cache.set(key, { at: now(), list });
  return list;
}

/**
 * Свежесть прайса — по файлу, а не по строке.
 *
 * `d` — это построчная отметка позиции (дата, когда сеть последний раз
 * трогала именно этот товар), а не дата выгрузки файла: в живом прайсе 552
 * строк несут 37 разных `d` с размахом 22 дня, и 7 из них старше недели — это
 * обычные позиции, которые просто давно не менялись. Резать по построчной
 * метке нельзя: такой SKU навсегда исчез бы из поиска и из карточки, то есть
 * цена перестала бы обновляться, а счётчик ошибок рос бы на каждом опросе.
 *
 * Заброшенные точки видно по максимуму: у магазина 376 весь файл от 2021 года,
 * и тогда свежайшая строка тоже протухшая — это уже не позиция, а прайс, который
 * сеть перестала обновлять. Такой отказ — `StaleStoreError`, а не сетевой: сеть
 * отвечает и живой магазин того же города работает, поэтому выключать сеть нельзя
 * (иначе две протухшие позиции подряд погасят и её).
 */
export function assertSvetoforNewestDate(shopId: string, list: readonly SvetoforOffer[]): { newest: number } {
  const dates = list.map((row) => svetoforOfferDate(row)).filter((value): value is number => value !== null);
  // Дат нет вовсе — это дрейф формата (сеть переименовала поле), а не «свежий
  // прайс»: молча пропустить здесь означало бы вписать в историю цены
  // неизвестного возраста с сегодняшним `collectedAt`. Поэтому громкий отказ.
  // Дат нет вовсе — это дрейф формата поля `d`, а не свойство одной точки: сеть
  // переименовала его для всех магазинов региона. Поэтому это обычный `Error`,
  // а не `StaleStoreError`: breaker должен поставить сети паузу, иначе опрос
  // будет заново качать файл по разу на каждую позицию (40 × 0,26 МБ за проход).
  if (dates.length === 0) {
    throw new Error(
      `svetofor: в прайсе магазина ${shopId} нет ни одной даты позиции (${list.length} строк) — формат изменился`,
    );
  }
  const newest = Math.max(...dates);
  return { newest };
}

/** Текст отказа по протухшему прайсу. */
function stalePriceError(shopId: string, newest: number, at: number): string {
  const age = at - newest;
  return `svetofor: прайс магазина ${shopId} протух — свежайшая позиция от ${new Date(newest)
    .toISOString()
    .slice(0, 10)} (${Math.round(age / 86_400_000)} дн.), сеть его не обновляет`;
}

/** Сброс кэша: нужен тестам и смене региона. */
export function clearSvetoforCache(): void {
  cache.clear();
  staleKeys.clear();
  stampFor.clear();
  stampAt.clear();
  // Разметка страницы региона — тоже кэш: без сброса тест (и смена метки) увидел
  // бы старую страницу, то есть и старые разделы меню.
  pageFor.clear();
}

/**
 * Поиск по названию. Сравниваем через `normalizeName`, иначе «мёд» не найдёт
 * «мед», а «Печенье 570ГР» не найдётся по запросу «печенье 570 гр» — и это ровно
 * тот текст, который присылает сеть.
 */
function matches(offer: SvetoforOffer, needle: string): boolean {
  return normalizeName(String(offer.name ?? '')).includes(needle);
}

/**
 * Совпадение названий в обе стороны. У Ленты лестница обрезает запрос, потому
 * что там название из БД короче сетевого. У Светофора наоборот: сеть режет
 * фасовку, а в БД она может быть дописана, поэтому сравниваем префиксы: кто
 * короче, тот должен начинаться с длинного. Порог 8 знаков отсекает совпадения
 * из пары слов вроде «молоко».
 */
export function nameMatches(offerName: unknown, dbName: string): boolean {
  const a = String(offerName ?? '')
    .trim()
    .toLowerCase();
  const b = String(dbName ?? '')
    .trim()
    .toLowerCase();
  if (a === '' || b === '') return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 8) return false;
  return longer.startsWith(shorter);
}

/**
 * Переименование принимается только если совпали и числа названия. Без этой
 * проверки «Хлеб ржаной 400 г» в БД матчится с «Хлеб ржаной 400 г зёрновой с
 * изюмом» из прайса — это разные SKU, и цена чужого товара ушла бы в историю
 * под нашим id. Числа сравниваем по нормализованному имени, тем же
 * `normalizeName`, что и склейка в matching.ts.
 */
export function numbersAgree(offerName: unknown, dbName: string): boolean {
  const offer = String(offerName ?? '').trim();
  const db = String(dbName ?? '').trim();
  // Без названия сверять нечего, и пустое имя не должно проходить как совпадение.
  if (offer === '' || db === '') return false;
  const a = numbersIn(offer);
  const b = numbersIn(db);
  // Ни в одном имени нет чисел (например «Хлеб ржаной») — сверять нечего, и это
  // не повод отвергать: «с чисел нечего сверить» ≠ «товар другой».
  if (a.length === 0 && b.length === 0) return true;
  // Сравниваем в обе стороны: расхождение по любой стороне означает другой SKU.
  // Однозначные числа тоже важны — фасовка «500 г» против «900 г» различает
  // товар, а отбрасывать их было бы ровно тем молчаливым стопом, ради которого
  // проверка и написана.
  return a.every((n) => b.includes(n)) && b.every((n) => a.includes(n));
}

/** Числа названия в виде строк, как их видит `normalizeName`. */
function numbersIn(raw: string): string[] {
  return normalizeName(raw).match(/\d+(?:[.,]\d+)?/g) ?? [];
}

export class SvetoforAdapter implements StoreAdapter {
  readonly storeId: Store['id'] = 'svetofor';

  constructor(
    private readonly ctx: { domain: (shopId: string) => string },
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
    // Часы внедряются ради теста TTL: иначе протухание кэша не проверить.
    private readonly now: () => number = Date.now,
  ) {}

  /** Поиск по названию идёт локально по прайсу: отдельного поискового эндпоинта нет. */
  async search(query: string, ctx: { city: string; externalStoreId: string }): Promise<ScrapedProduct[]> {
    const domain = this.ctx.domain(ctx.externalStoreId);
    const stamp = await resolveSvetoforStamp(this.fetchImpl, domain, this.now);
    const list = await loadSvetoforPriceList(this.fetchImpl, domain, ctx.externalStoreId, stamp, this.now);
    // Пустой запрос из приложения не приходит (services отдаёт для него пустой
    // список), поэтому ветки «отдать всё» здесь нет — только поиск по названию.
    const needle = normalizeName(query);
    const out: ScrapedProduct[] = [];
    for (const offer of list) {
      if (!matches(offer, needle)) continue;
      const product = normalizeSvetoforOffer(offer, { city: ctx.city, domain });
      if (product) out.push(product);
      if (out.length >= 40) break;
    }
    return out;
  }

  /**
   * Карточки по id у сети нет, поэтому товар ищется по названию из нашей БД.
   * Пустая выдача по всем попыткам — отказ сети (дрейф формата, снятый файл),
   * и должен быть обычный `Error`, иначе breaker поставит сети паузу. А вот
   * «выдача была, нашего товара нет» — переименование, и это
   * `ProductLookupError`.
   */
  async fetchProduct(canonicalId: string, ctx: ProductFetchContext): Promise<ScrapedProduct> {
    const domain = this.ctx.domain(ctx.externalStoreId);
    const stamp = await resolveSvetoforStamp(this.fetchImpl, domain, this.now);
    const list = await loadSvetoforPriceList(this.fetchImpl, domain, ctx.externalStoreId, stamp, this.now);
    for (const offer of list) {
      // Строка без `id` не может быть нашим товаром: её нечем опознать, а ключ
      // из названия ломает фичу «разные товары» (разделитель пары — пробел).
      if (offer.id === undefined || String(offer.id).trim() === '') continue;
      if (svetoforCanonicalId(offer.id) !== canonicalId) continue;
      const product = normalizeSvetoforOffer(offer, { city: ctx.city, domain });
      if (product) return product;
      // Наш `id` в прайсе есть, но строка без цены или без названия. Искать дальше
      // по названию нельзя: под этим `canonicalId` в историю уехал бы ЧУЖОЙ товар.
      // Это переименование/поломка формата у нашего товара, а не отказ сети.
      throw new ProductLookupError(
        `svetofor: товар ${canonicalId} есть в прайсе, но без цены или без названия`,
        canonicalId,
      );
    }
    const name = (ctx.name ?? '').trim();
    if (name !== '') {
      const byName = list.filter(
        (offer) => nameMatches(offer.name, name) && numbersAgree(offer.name, name),
      );
      if (byName.length === 0) {
        throw new ProductLookupError(
          `svetofor: товара ${canonicalId} («${name}») нет в прайсе магазина`,
          canonicalId,
        );
      }
      const normalized = byName
        .map((offer) => normalizeSvetoforOffer(offer, { city: ctx.city, domain }))
        .filter((product): product is ScrapedProduct => product !== null);
      // Совпадения по своему `canonicalId` здесь быть не может: id-цикл выше
      // уже вернул бы такой товар, а строки без цены или названия в `normalized`
      // не попадают. Поэтому сразу проверяем единственность кандидата.
      // Угадывать нельзя: под «Арахис» в прайсе и обжаренный, и необжаренный.
      // Единственное совпадение — это переименование, его принимаем; несколько —
      // ProductLookupError, пусть оператор разберётся (иначе в историю цен
      // попал бы чужой товар).
      const only = normalized.length === 1 ? normalized[0] : undefined;
      if (only !== undefined) return only;
      // Сообщение различает два случая: строки нашлись, но без цены (формат
      // поехал), и строк несколько (надо разбираться вручную).
      throw new ProductLookupError(
        normalized.length === 0
          ? `svetofor: по названию «${name}» строки без цены — цены в прайсе нет`
          : `svetofor: по названию «${name}» в прайсе ${normalized.length} товаров — нужен productId`,
        canonicalId,
      );
    }
    throw new ProductLookupError(`svetofor: товара ${canonicalId} нет в прайсе магазина`, canonicalId);
  }

  /**
   * Полки для витрины. Отдельного API у сети нет, поэтому разделы собираются из
   * прайса, а названия — из меню главной (один запрос, покрытый тем же кэшем, что и
   * прайс: без кэша открытие витрины качало бы и меню, и прайс заново).
   */
  async fetchCategories(ctx: { city: string; externalStoreId: string }): Promise<StoreCategory[]> {
    const domain = this.ctx.domain(ctx.externalStoreId);
    const stamp = await resolveSvetoforStamp(this.fetchImpl, domain, this.now);
    const list = await loadSvetoforPriceList(this.fetchImpl, domain, ctx.externalStoreId, stamp, this.now);
    // Что реально лежит в прайсе: раздел без товаров в витрине не нужен, а меню
    // сайта может опережать выгрузку.
    const inPrice = new Set(list.map((offer) => svetoforShelf(offer.catchpu)).filter((shelf) => shelf !== ''));
    const menu = parseSvetoforMenu(await regionPage(this.fetchImpl, domain, this.now), domain);
    const out: StoreCategory[] = [];
    const missing: string[] = [];
    // `parseSvetoforMenu` уже отдаёт разделы без повторов, поэтому второго `seen`
    // здесь не нужно: дубликат раздела был бы мёртвой веткой.
    for (const { shelf, name, menuId } of menu) {
      // Раздел меню без товаров в выгрузке — это дрейф сети (переименование
      // слага или раздел убрали). Молча пропускать нельзя: витрина сжалась бы с
      // 9 полок до 7 без единого слова, и это выглядело бы как «так у них».
      if (!inPrice.has(shelf)) {
        missing.push(shelf);
        continue;
      }
      const category: StoreCategory = { id: shelf, name, url: svetoforShelfUrl(domain, shelf) };
      // Иконка необязательна: номера может не оказаться (правка вёрстки) — тогда
      // плитка просто останется без картинки. Битый адрес убирает `onError`
      // в интерфейсе, поэтому проверять его заранее не нужно.
      if (menuId !== '') category.imageUrl = svetoforCategoryImageUrl(`menu-${menuId}`);
      out.push(category);
      if (out.length >= SHELF_LIMIT) break;
    }
    if (missing.length > 0) {
      console.warn(
        `[svetofor] разделы меню ${domain} не найдены в прайсе и пропущены: ${missing.join(', ')}`,
      );
    }
    if (out.length === 0) {
      throw new Error('svetofor: ни один раздел меню не найден в прайсе (смена вёрстки или выгрузки?)');
    }
    return out;
  }

  /**
   * Полка этого магазина или нет. Метод не получает магазин, поэтому сверяем хост
   * по общему правилу сети: `<регион>.svetoforonline.ru`. Точный домен проверить
   * нельзя, но и не нужно — чужие ссылки (Пятёрка, Магнит, Лента) так не пройдут,
   * а товары полки всё равно берутся из ПРАЙСА нашего магазина, то есть лишняя
   * ссылка не покажет чужие цены.
   *
   * Адрес КАРТОЧКИ по форме неотличим от адреса полки (односегментный слаг), так
   * что, как только прайс лежит в кэше, раздел сверяется с ним: иначе клик по
   * ссылке на товар считался бы полкой. Прайс не качали — отвечаем по форме.
   */
canHandleCategoryUrl(categoryUrl: string): boolean {
      const region = svetoforRegionOfUrl(categoryUrl);
      if (region === null) return false;
      const known = cachedShelves(region.domain);
      return known === null || known.has(region.shelf);
    }

  /** Товары полки: фильтр по разделу в уже загруженном прайсе, без запросов в сеть. */
  async fetchCategoryProducts(
    categoryUrl: string,
    ctx: { city: string; externalStoreId: string },
  ): Promise<ScrapedProduct[]> {
    const domain = this.ctx.domain(ctx.externalStoreId);
    const shelf = svetoforShelfFromUrl(categoryUrl, domain);
    // Адрес карточки по форме такой же, как у полки, поэтому отказ здесь —
    // ожидаемый исход клика по ссылке на товар, а не ошибка каталога.
    if (!shelf) throw new Error('svetofor: это не раздел (товар или служебная страница)');
    const stamp = await resolveSvetoforStamp(this.fetchImpl, domain, this.now);
    const list = await loadSvetoforPriceList(this.fetchImpl, domain, ctx.externalStoreId, stamp, this.now);
    const out: ScrapedProduct[] = [];
    let cut = false;
    for (const offer of list) {
      if (!inSvetoforShelf(offer, shelf)) continue;
      if (out.length >= SHELF_PRODUCT_LIMIT) {
        cut = true;
        break;
      }
      const product = normalizeSvetoforOffer(offer, { city: ctx.city, domain });
      if (product) out.push(product);
    }
    if (cut) {
      console.warn(`[svetofor] полка ${domain}/${shelf} обрезана на ${SHELF_PRODUCT_LIMIT} товарах`);
    }
    if (out.length === 0) {
      throw new Error(`svetofor: полка «${shelf}» в прайсе пуста — раздел выпал из выгрузки`);
    }
    return out;
  }

}