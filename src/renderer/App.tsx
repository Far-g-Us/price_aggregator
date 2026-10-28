import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Favorite, HistoryPoint, OurCategoryInfo, ProductShelves, RendererApi, SchedulerStatus, StoreCatalog, StorePrices } from '../shared/api';
import type { PriceGroup } from '../shared/matching';
import {
  CITIES,
  networksForCity,
  pointKey,
  pointLabel,
  readyStoresForCity,
  resultBlockVisible,
  storeByCode,
  storesForCity,
  unknownPointLabel,
} from '../shared/catalog';
import type { PointKey, StoreId } from '../shared/catalog';
import { UNKNOWN_STORE_CODE, storeCodeMatches } from '../shared/types';
import { groupByProduct, parseSplitKey } from '../shared/matching';
import {
  filterPriceGroups,
  groupPrice,
  groupPriceRange,
  parsePriceFilter,
  priceRangeInverted,
  type ResultFilters,
} from '../shared/result-filters';
import { formatPrice } from '../shared/format';
import { rootShelves } from '../shared/taxonomy';
import { RELEASES_PAGE_URL } from '../core/release-check';
import { CategoryIcon } from './CategoryIcon';
import { PollProgress } from './PollProgress';

declare global {
  interface Window {
    api: RendererApi;
  }
}

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'available'; latest: string }
  | { kind: 'portable'; latest: string }
  | { kind: 'downloaded'; latest: string }
  | { kind: 'error'; message: string };

function HistoryChart({ points }: { points: HistoryPoint[] }) {
  /** Спарклайн истории цены в карточке товара. */
  if (points.length === 0)
    return <p className="mt-1 text-xs text-muted">Пока нет замеров — появятся после опросов.</p>;
  const eff = points.map((p) => p.promo_price ?? p.price);
  if (points.length === 1) {
    const only = points[0];
    return (
      <p className="mt-1 text-xs text-muted">
        Один замер: {formatPrice(only?.price ?? 0)} ({only?.collected_at.slice(0, 10)}). График появится со второго.
      </p>
    );
  }
  const min = Math.min(...eff);
  const max = Math.max(...eff);
  const span = max - min || 1;
  const w = 280;
  const h = 80;
  const dots = points
    .map((p, i) => {
      const v = p.promo_price ?? p.price;
      const x = (i / (points.length - 1)) * w;
      const y = h - 6 - ((v - min) / span) * (h - 16);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const first = points[0]?.collected_at.slice(0, 10) ?? '';
  const last = points[points.length - 1]?.collected_at.slice(0, 10) ?? '';
  const promoMarks = points.filter((p) => p.promo_price != null).length;
  return (
    <div className="mt-2 border-t border-line pt-2">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`История цены: мин ${Math.round(min)}, макс ${Math.round(max)}`} className="block h-[90px] w-full">
        <polyline points={dots} fill="none" stroke="#059669" strokeWidth="2" />
        {points.map((p, i) => {
          const v = p.promo_price ?? p.price;
          const x = (i / (points.length - 1)) * w;
          const y = h - 6 - ((v - min) / span) * (h - 16);
          return (
            <circle key={i} cx={x} cy={y} r="2.5" fill={v === min ? '#d97706' : '#059669'}>
              <title>{`${p.collected_at.slice(0, 16).replace('T', ' ')} — ${formatPrice(v)}${p.promo_price != null ? ' (акция)' : ''}`}</title>
            </circle>
          );
        })}
      </svg>
      <p className="mt-1 text-xs text-muted">
        мин {formatPrice(min)} · макс {formatPrice(max)} · замеров {points.length}
        {promoMarks > 0 ? ` · из них по акции ${promoMarks}` : ''} · {first} → {last}
      </p>
      <ul className="mb-0 mt-1.5 pl-4 text-xs text-muted">
        {points.slice(-5).reverse().map((p, i) => (
          <li key={i}>
            {p.collected_at.slice(0, 16).replace('T', ' ')} — {formatPrice(p.promo_price ?? p.price)}
            {p.promo_price != null ? ' (акция)' : ''}
            {p.in_stock === 0 ? ' · нет в наличии' : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Текст ошибки из main-процесса приходит в виде строки или Error с префиксом
// цепочки ("Error invoking remote method 'x': Error: ..."), плюс ядро местами
// пишет String(err). Чистим префиксы, чтобы в UI не было «Error: Error:», и
// режем по проектной конвенции — длинные сообщения ломают вёрстку.
/**
 * Успешная сводка опроса начинается ровно с «Опрос завершён» — всё остальное
 * (отказ, «уже идёт», «отложен», «отслеживаемых товаров пока нет») жёлтое.
 * Правило fail-closed: новый вариант текста не сможет оказаться зелёным по
 * умолчанию, а перечисление отказов пришлось бы дополнять при каждом новом.
 */
function isWarnSummary(summary: string): boolean {
  // Правило fail-closed: успешна только сводка, начавшаяся с «Опрос завершён»,
  // не содержащая «товаров пока нет» и не содержащая протухших магазинов. Тот
  // случай в ядре тоже оформляется как «Опрос завершён», но проходом он не
  // является; протухшая точка — сеть жива, но её цены заморожены, то есть по
  // этим товарам проверки фактически не было, и зелёный баннер вводил бы в
  // заблуждение.
  return (
    !summary.startsWith('Опрос завершён') ||
    summary.includes('отслеживаемых товаров пока нет') ||
    summary.includes('Сеть не обновляет')
  );
}

function useDismissableMenu(
  open: boolean,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  ref: React.RefObject<HTMLElement | null>,
  btnRef: React.RefObject<HTMLButtonElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onFocusIn = (e: FocusEvent) => {
      const to = e.target as Node | null;
      if (to && ref.current && !ref.current.contains(to)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, btnRef, setOpen]);
}

// Восстановленный блок App.tsx, потерянный правкой 2026-10-02.
// Собран по скомпилированному бандлу сборки 22:30 (build-renderer/assets/index-*.js):
// список и порядок состояний, их инициализация, логика эффектов и помощников взяты
// оттуда, наименования — по выжившей разметке и tsc-инвентаризации.

// Картинка товара. У сетей она может не прийти вовсе или отдаться битой, поэтому
// вместо пустоты рисуется коробка: карточка не «схлопывается» и товар остаётся
// узнаваемым по названию и цене.
function ProductImage({
  src,
  name,
  tall = false,
}: {
  src: string | null | undefined;
  name: string;
  tall?: boolean;
}): React.ReactElement {
  const [failed, setFailed] = React.useState(false);
  // Карточка переиспользуется React'ом по ключу группы, поэтому после новой
  // выдачи с прежним битым src заглушка залипла бы навсегда.
  React.useEffect(() => setFailed(false), [src]);
  // В модалке картинка не режется по высоте: у товара пропорции важнее рамки,
  // а отступ до описания задаёт сам блок.
  const frame = tall ? 'mb-4 max-h-64' : 'h-40 sm:h-48';
  if (!src || failed) {
    return (
      <div className={`${frame} w-full rounded-xl bg-cream`} aria-hidden="true">
        <div className="flex h-full w-full items-center justify-center">
          <svg viewBox="0 0 24 24" className="h-10 w-10 text-line" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z" strokeLinejoin="round" />
            <path d="M3.5 7.5 12 12m0 9V12m8.5-4.5L12 12" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={name}
      loading="lazy"
      className={`${frame} w-full rounded-xl bg-cream object-contain`}
      onError={() => setFailed(true)}
    />
  );
}

/** Текст ошибки для баннера: без «Error:» и прочей обвязки, с обрезкой. */
function errText(err: unknown): string {
  return (typeof err === 'string' ? err : err instanceof Error ? err.message : String(err))
    // Обёртка `invoke` от Electron приходит ПЕРВОЙ и всегда: `Error invoking
    // remote method 'канал': Error: <текст>`. Старый регекс её не снимал
    // (через `\w*\s*` перескочить слово «invoking remote method» нельзя), и
    // пользователь читал в баннере имя канала вместо причины. Это правило чинит
    // ВСЕ баннеры приложения, а не только ошибку выбора магазинов.
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^(\s*(?:\w*\s*)?Error:\s*)+/i, '')
    .trim()
    .slice(0, 200);
}

const EMPTY_SHELF_PLAIN = 'Категория пуста — попробуй соседнюю или поиск.';

/**
 * Ошибка от ядра о выборе магазинов — по-человечески. Внутренний код канала
 * («stores:set: магазин magnit:303857 не найдена в городе moscow») пользователю
 * ничего не говорит: магазин и город у нас есть в справочнике, значит имена
 * можно назвать.
 */
function storesErrorText(err: unknown, city: string): string {
  const raw = errText(err).replace(/^stores:set:\s*/i, '');
  const cityName = CITIES.find((c) => c.id === city)?.name ?? city;
  const readable = raw.replace(
    /магазин (\S+):(\S+) не найден в городе \S+/,
    (_all, storeId: string, code: string) => {
      const point = storeByCode(storeId as StoreId, city, code);
      return `магазин «${point ? pointLabel(point) : `${storeId}:${code}`}» не найден в городе «${cityName}»`;
    },
  );
  return `Не получилось применить выбор магазинов: ${readable}`;
}
const EMPTY_SHELF_VIRTUAL =
  'Полка собирает только уже найденное и в магазины не ходит. Найди что-нибудь в поиске или открой полку любой сети.';

/** Сторож загрузки полки: сеть молчит дольше — показываем текст, а не вечный спиннер. */
const SHELF_TIMEOUT_MS = 45_000;
/**
 * Порог сторожа под конкретную полку и город.
 *
 * Полка «Молочное и яйца» — это до восьми запросов на точку, а точки одной сети
 * обходятся ПОСЛЕДОВАТЕЛЬНО с паузой между запросами (иначе два запроса уходят в
 * один домен подряд). Значит худший случай — не «город», а самая многоточечная
 * сеть города, и при 4+ точках фиксированные 45 секунд срабатывали всегда: сеть
 * ещё честно отвечала, а интерфейс уже кричал «магазин не ответил».
 *
 * Длительность одного запроса берём из таймаутов самих адаптеров: браузерные сети
 * (Пятёрка, Чижик, Перекрёсток) висят до 60 секунд, Магнит — до 30, Лента — до
 * 25. Пауза между запросами — та же константа, что и в ядре
 * (`SAME_STORE_POINT_PAUSE_MS`).
 */
const NETWORK_REQUEST_BUDGET_MS: Record<string, number> = {
  pyaterochka: 65_000,
  chizhik: 65_000,
  perekrestok: 65_000,
  magnit: 35_000,
  lenta: 30_000,
  svetofor: 20_000,
};
/** Потолок: восемь запросов по 65 секунд — это восемь минут молчания, а к этому
 *  моменту пользователь уже решил, что приложение зависло. */
const SHELF_WATCHDOG_CAP_MS = 180_000;
const SAME_STORE_POINT_PAUSE_MS = 1200;

const PAGE_SIZE = 24;

function Spinner({ className = 'h-3.5 w-3.5' }: { className?: string }): React.ReactElement {
  return (
    <svg className={`flex-none animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Заглушка сетки товаров на время загрузки: форма совпадает с карточкой. */
function SkeletonCards({ label }: { label: string }): React.ReactElement {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <section className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-3" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="animate-pulse rounded-2xl border border-line bg-card p-4">
            <div className="h-40 w-full rounded-xl bg-line/60 sm:h-48" />
            <div className="mt-3 h-4 w-4/5 rounded bg-line/60" />
            <div className="mt-1.5 h-4 w-3/5 rounded bg-line/60" />
            <div className="mt-3 h-8 w-24 rounded-lg bg-line/40" />
            <div className="mt-3 border-t border-line pt-1.5">
              <div className="h-5 w-2/3 rounded bg-line/40" />
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

/** Русское склонение: 1 запрос, 2 запроса, 5 запросов. */
function plural(n: number, one: string, few: string, many: string): string {
  const i = n % 10;
  const a = n % 100;
  return `${n} ${i === 1 && a !== 11 ? one : i >= 2 && i <= 4 && (a < 12 || a > 14) ? few : many}`;
}

function queriesPhrase(n: number): string {
  return plural(n, 'запрос', 'запроса', 'запросов');
}

function sectionsPhrase(n: number): string {
  return plural(n, 'раздел', 'раздела', 'разделов');
}

/** Хвост сводки опроса в подвале: ненулевые счётчики через запятую. */
function pollCountsText(c: { inserted: number; skipped: number; failed: number }): string {
  const parts: string[] = [];
  if (c.inserted > 0) parts.push(`добавлено ${c.inserted}`);
  if (c.skipped > 0) parts.push(`без изменений ${c.skipped}`);
  if (c.failed > 0) parts.push(`ошибок ${c.failed}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function Chevron({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {open ? <path d="M6 9l6 6 6-6" /> : <path d="M9 6l6 6-6 6" />}
    </svg>
  );
}

export default function App(): React.ReactElement {
  const [status, setStatus] = useState('...');
  const [version, setVersion] = useState('...');
  const [update, setUpdate] = useState<UpdateState>({ kind: 'idle' });
  /**
 * Город из прошлого запуска. Без этого каждое открытие возвращало в Москву, а
 * пользователь каждый раз заново выбирал город и смотрел, как обнуляется выбор
 * магазинов («Магазины: 0/5» в чужом городе).
 */
function readCity(): string {
  try {
    const saved = localStorage.getItem('pa.city');
    return saved !== null && CITIES.some((c) => c.id === saved) ? saved : 'moscow';
  } catch {
    return 'moscow';
  }
}

const [city, setCity] = useState(readCity);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StorePrices[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [catLoading, setCatLoading] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [catalog, setCatalog] = useState<StoreCatalog[] | null>(null);
  /**
   * Сети, для которых в этой сборке есть адаптер. null — список ещё не пришёл:
   * до этого момента считаем по справочнику, чтобы счётчик на старте не пугал.
   *
   * На Android адаптеров три (Магнит, Лента, Светофор), а справочник городов —
   * на все шесть сетей. Считать «Магазины: 0/6» при трёх сетях под рукой —
   * значит обещать опрос, которого не будет.
   */
  const [supportedNetworks, setSupportedNetworks] = useState<string[] | null>(null);
  /**
   * Список сетей не пришёл. Это НЕ «доступны все сети»: мост есть (иначе
   * приложение не работает вовсе), но вызов упал — и тогда честнее сказать об
   * этом в меню, чем молча показать все шесть сетей доступными.
   */
  const [supportedError, setSupportedError] = useState(false);
  /**
   * Браузер для Пятёрки, Чижика и Перекрёстка. В установщик он не вшит
   * (около 340 МБ из 210 МБ сборки), поэтому ставится по требованию — и пока
   * его нет, об этом надо сказать прямо: иначе «сеть молчит» выглядит как
   * поломка сети, а она тут ни при чём.
   */
  const [browser, setBrowser] = useState<{ installed: boolean; message: string } | null>(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  /**
   * Магазин (сеть), для которого показываются адреса. null — «пока не выбран»:
   * тогда берётся первый доступный, чтобы список адресов не был пустым.
   */
  const [storeMenuNetwork, setStoreMenuNetwork] = useState<string | null>(null);
  /**
   * Что сказала установка. Показывается и при успехе: браузер ставится, но
   * Playwright читает путь к нему один раз — сети заработают только после
   * перезапуска, и об этом надо сказать, а не просто убрать кнопку.
   */
  const [browserNote, setBrowserNote] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [catError, setCatError] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  // Выбранные сети города. Модель явная: ключ отсутствует = сеть ВЫКЛЮЧЕНА.
// Раньше было наоборот («нет ключа = включена»), и потому выбрать одну сеть
// было невозможно: стартовое состояние пустое означало «все включены», а
// пользователь при этом рассчитывал опрос одного магазина.
//
// При ПЕРВОМ запуске не выбрано НИ ОДНОГО магазина: обход всех сетей города
// бьёт по пяти точкам сразу, а пользователь об этом не просил. Со второй
// запуска приложение помнит свой выбор (и город) — это и есть смысл галочек.
//
// Ключ версионирован (`v2`): модель инвертирована, и старое значение в старом
// ключе прочиталось бы наоборот — «всё, кроме Пятёрки» превратилось бы в
// «не выбрано ничего». Старые данные просто игнорируются.

/**
 * Ключ точки для выбора магазинов и подписей.
 *
 * Именно точка, а не сеть: у двух точек одной сети в городе одна галочка означала
 * бы, что вторую точку нельзя ни выбрать, ни снять отдельно.
 */
const pointKeyOf = (s: { storeId: string; externalStoreId: string }): PointKey =>
  pointKey(s.storeId, s.externalStoreId);

/**
 * Виден ли блок выдачи/полки при текущем выборе. Правило живёт в catalog.ts
 * (resultBlockVisible), потому что блок перенесённых цен с кодом '?' виден при
 * выборе любой точки той же сети — и точное сравнение ключа здесь уже один раз
 * съедало эти цены вместе с товарами.
 */
const blockVisible = (storeId: string, storeCode: string): boolean =>
  resultBlockVisible(storeOn, storesForCity(city), storeId, storeCode);

/** Ключ хранения выбора сетей города: версия в имени, чтобы смена смысла ключа
 *  не читала старые данные наоборот. */
function storesKeyFor(cityId: string): string {
  return `pa.stores.v3.${cityId}`;
}

/**
 * Все готовые точки города включены — для кнопки «выбрать все магазины».
 *
 * Сети без адаптера в выбор не входят: опросить их всё равно нечем, а в ядро
 * такие ключи попадать не должны (иначе счётчик «3/3» расходился бы с меню, где
 * отмечено шесть точек, и опрос считал бы их «не проверено»).
 */
function allStoresOn(cityId: string, supported: string[] | null): Record<PointKey, boolean> {
  return Object.fromEntries(
    readyStoresForCity(cityId)
      .filter((s) => supported === null || supported.includes(s.storeId))
      .map((s) => [pointKeyOf(s) as PointKey, true]),
  );
}

/**
 * Сохранённый выбор города: пусто, если его ещё нет. Берём только ТОЧКИ, которые
 * в этом городе есть и готовы, и только логические значения — битое значение
 * (массив, «true», незнакомый код точки) иначе превратилось бы в «не выбрано
 * ничего» тихо, и пользователь не понял бы, почему опрос молчит.
 */
const readStores = (c: string): Record<PointKey, boolean> => {
  try {
    const raw = localStorage.getItem(storesKeyFor(c));
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const saved = parsed as Record<string, unknown>;
    const out: Record<PointKey, boolean> = {};
    for (const s of storesForCity(c)) {
      const key = pointKeyOf(s);
      if (s.ready && saved[key] === true) out[key] = true;
    }
    return out;
  } catch {
    // Повреждённое значение молча заменяем пустым: выбор магазинов не должен
    // быть причиной, по которой приложение не запускается.
    return {};
  }
};

/**
 * Выбор сетей хранится ВМЕСТЕ с городом, одним состоянием. Раздельные `storeOn`
 * и флаг «город уже перечитан» ловились гонкой: при смене города эффект записи
 * успевал положить выбор ПРОШЛОГО города в ключ нового (самокоррекция спасала
 * через кадр, но между двумя записями хранилище было испорчено, и комментарий
 * обещал гарантию, которой не было). Здесь выбор нового города становится
 * производным значением, поэтому гонки не существует по построению.
 */
// Тип именно `Record<PointKey, boolean>`, и это защита, а не формальность: с
// `Record<string, boolean>` чтение `storeOn[storeId]` снова компилировалось бы,
// и тот же баг (выбор по сети при состоянии по точкам) вернулся бы молча — без
// ошибки компилятора и без падения покрытия, ведь renderer вне гейта.
const [storeSel, setStoreSel] = useState<{ city: string; on: Record<PointKey, boolean> }>(() => ({
  city,
  on: readStores(city),
}));
const storeOn = React.useMemo(
  () => (storeSel.city === city ? storeSel.on : readStores(city)),
  [storeSel, city],
);
const setStoreOn = (
  next: Record<PointKey, boolean> | ((prev: Record<PointKey, boolean>) => Record<PointKey, boolean>),
): void => setStoreSel({ city, on: typeof next === 'function' ? next(storeOn) : next });

  const [promoOnly, setPromoOnly] = useState(false);
  const [stockOnly, setStockOnly] = useState(false);
  const [sort, setSort] = useState<'none' | 'asc' | 'desc'>('none');
  // Границы цены — строки, а не числа: пустое поле должно быть возможно, а
  // разбор отделён в `parsePriceFilter` и сносит мусор в `null`. Пересчёт идёт
  // на КАЖДЫЙ символ, и это осознанно: отбор идёт по уже загруженной выдаче
  // (десятки карточек), запросов к сетям не добавляет, а номер страницы сам
  // ужимается под новую длину списка. Коммита по blur здесь нет намеренно —
  // иначе поле «до 120» не сузило бы выдачу, пока пользователь не ушёл
  // кликом, и результат выглядел бы как «фильтр не работает».
/** Имя СЕТИ по идентификатору: подписи блоков и строк цены берут его отсюда, а не
 *  от `name` блока — у перенесённых цен блок несёт имя соседней точки. */
  const storeName = (id: string) => networksForCity(city).find((s) => s.storeId === id)?.name ?? id;

  /**
   * Точки города, которые в этой сборке реально опрашиваются, и сети, которых
   * в сборке нет. Обе величины считаются по списку адаптеров из ядра: справочник
   * городов про сборку не знает, а на Android адаптеров три из шести.
   *
   * Пока список не пришёл (`null`), считаем по справочнику — на старте счётчик
   * не должен прыгать и пугать; пришедший список его уточнит.
   */
  const supportedPoints = React.useMemo(
    () =>
      supportedNetworks === null
        ? readyStoresForCity(city)
        : readyStoresForCity(city).filter((s) => supportedNetworks.includes(s.storeId)),
    [supportedNetworks, city],
  );
  const unavailableNetworks = React.useMemo(
    () =>
      supportedNetworks === null
        ? []
        : networksForCity(city).filter((s) => !supportedNetworks.includes(s.storeId)),
    [supportedNetworks, city],
  );

  /**
   * Подпись блока выдачи по ТОЧКЕ, а не по сети: блок несёт `storeCode`, и у двух
   * точек одной сети названия должны различаться, а подпись — быть той же
   * функцией, что в шапке и в строке цены.
   */
  const resultPointLabel = (s: { storeId: string; storeCode: string; name: string }): string => {
  // Перенесённые цены: точки нет, и подпись обязана это говорить. Имя сети берём
  // из СПРАВОЧНИКА, а не из `s.name` блока — иначе sentinel-блок унаследовал бы
  // имя соседней точки и выглядел бы как цена выбранного магазина.
  if (s.storeCode === UNKNOWN_STORE_CODE) return unknownPointLabel(storeName(s.storeId));
  const point = storeByCode(s.storeId as StoreId, city, s.storeCode);
  return point ? pointLabel(point) : s.name;
};

const [priceDraft, setPriceDraft] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [minStores, setMinStores] = useState(1);
  // Сколько СЕТЕЙ реально ответили в текущей выдаче: блоки выдачи — это точки,
  // а фильтр «в N сетях» считает сети (`groupStoreCount`). Считать блоки было бы
  // враньём: две точки одной сети дали бы «в 2 сетях» при одной сети на
  // самом деле, и верхняя граница списка предлагала бы пустую выдачу.
  // Неготовые (`ready: false`) в списке есть, но их не спрашивали. Отдельно от
  // этого числа клампится minStores — иначе выбранное «в 3 сетях» пережило бы
  // смену выдачи, где ответили две, и `<select>` показался бы пустым при
  // непустом фильтре.
  const readyStoresInResults = results
    ? new Set(results.filter((s) => s.ready).map((s) => s.storeId)).size
    : undefined;

  /**
   * Разобранные условия отбора.
   *
   * Отдельная переменная нужна, чтобы мемоизация выдачи зависела от чисел, а не
   * от строк черновика: набор символов в поле не должен пересчитывать отбор,
   * пока человек не закончил печатать. Мусорный ввод разбирается в null и
   * условие просто выключается — `NaN` до сравнения не доходит.
   */
  const resultFilters: ResultFilters = useMemo(
    () => ({
      priceFrom: parsePriceFilter(priceDraft.from),
      priceTo: parsePriceFilter(priceDraft.to),
      // Кламп здесь, а не только в `<option>`: фильтр обязан быть не строже
      // того, что реально есть в выдаче. Считаем по `results`, а не по
      // `groups` — тот объявлен ниже и здесь ещё не существует.
      minStores: Math.min(minStores, Math.max(1, readyStoresInResults ?? 1)),
    }),
    [priceDraft.from, priceDraft.to, minStores, readyStoresInResults],
  );
  const priceRangeBroken = priceRangeInverted(resultFilters);
  const [page, setPage] = useState(1);
  const [openHist, setOpenHist] = useState<string | null>(null);
  const [hist, setHist] = useState<Record<string, HistoryPoint[] | 'error'>>({});
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [histLoading, setHistLoading] = useState<Record<string, boolean>>({});
  const [shelves, setShelves] = useState<Record<string, ProductShelves | 'error'>>({});
  const [shelfBusy, setShelfBusy] = useState<Record<string, boolean>>({});
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  // Ключ карточки: магазин + товар + город + ТОЧКА. Порядок важен только внутри
  // себя — он же используется как ключ хранения истории, полок и черновиков
  // цены. Код точки в ключе обязателен: с ним у точки Б своя история, свой
  // черновик и своё состояние загрузки; без него две точки одной сети в одном
  // городе делили бы одну ячейку, и график второй не открылся бы вовсе.
  const histKey = (canonicalId: string, storeId: string, cityCode: string, storeCode: string): string =>
    `${storeId}:${canonicalId}:${cityCode}:${storeCode}`;
  const favKey = histKey;
  // Отметка принадлежит точке, а не сети: иначе звёздочка у товара точки А
  // закрывала бы и отметку точки Б той же сети в том же городе, и наоборот —
  // снять одну из двух было бы невозможно.
  const isFav = (canonicalId: string, storeId: string, cityCode: string, storeCode: string): boolean =>
    favorites.some(
      (f) =>
        f.canonicalId === canonicalId &&
        f.storeId === storeId &&
        f.city === cityCode &&
        storeCodeMatches(f.storeCode, storeCode),
    );
  const favTarget = (canonicalId: string, storeId: string, cityCode: string, storeCode: string): number | null =>
    favorites.find(
      (f) =>
        f.canonicalId === canonicalId &&
        f.storeId === storeId &&
        f.city === cityCode &&
        storeCodeMatches(f.storeCode, storeCode),
    )?.targetPrice ?? null;

  const [sched, setSched] = useState<SchedulerStatus | null>(null);
  const [pollMsg, setPollMsg] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);
  const [storeMenuOpen, setStoreMenuOpen] = useState(false);
  const [cityMenuOpen, setCityMenuOpen] = useState(false);
  const [lastAction, setLastAction] = useState<
    | { kind: 'search'; query: string; city: string }
    | { kind: 'category'; url: string; city: string }
    | { kind: 'our'; id: string; city: string }
    | null
  >(null);
  const [source, setSource] = useState<'ours' | 'stores' | 'favorites'>('ours');
  const [ourCategories, setOurCategories] = useState<OurCategoryInfo[] | null>(null);
  const [catalogListError, setCatalogListError] = useState<string | null>(null);
  const [ourError, setOurError] = useState<string | null>(null);
  const [splits, setSplits] = useState<Set<string>>(new Set());
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [favBusy, setFavBusy] = useState<string | null>(null);
  const [targetDraft, setTargetDraft] = useState<Record<string, string>>({});
  const [splitBusy, setSplitBusy] = useState<string | null>(null);
  const [nameCache, setNameCache] = useState<Record<string, string>>({});
  const [favError, setFavError] = useState<string | null>(null);
  // Раскрытие блока витрины — по ТОЧКЕ: у сети две точки дают два блока, и
  // общий флаг закрывал бы оба разом, а дубли id ломали бы aria-controls.
  const [storeOpen, setStoreOpen] = useState<Record<PointKey, boolean>>({});

  const storeMenuRef = useRef<HTMLDivElement | null>(null);
  const storeMenuBtnRef = useRef<HTMLButtonElement | null>(null);
  const cityMenuRef = useRef<HTMLDivElement | null>(null);
  const cityMenuBtnRef = useRef<HTMLButtonElement | null>(null);
  // Подвал липкий, поэтому его высота нужна странице как запас снизу: без
  // резерва элемент в фокусе (последняя строка сетки, кнопки пагинации)
  // уезжал под подвал (WCAG 2.2 SC 2.4.11). Высота меняется — перенос текста,
  // появление кнопки «Прервать», узкое окно, — поэтому она ИЗМЕРЯЕТСЯ, а не
  // зашита в CSS константой.
  const footerRef = useRef<HTMLElement | null>(null);
  // Позиция прокрутки перед последним действием: возвращаться назад нужно туда,
  // а не «наверх», поэтому она снимается до загрузки, а не после.
  const catScrollRef = useRef(0);
  // Токен защиты от гонок: пока шёл опрос, полка или новый поиск могли занять
  // экран, и их данные обновлять уже нельзя.
  const shelfTokenRef = useRef(0);
  // Текущий статус опроса нужен вне рендера: markRunning вызывается из
  // обработчиков прогресса и должна видеть «статус уже приходил или нет».
  const schedRef = useRef<SchedulerStatus | null>(null);
  const [scrollIntent, setScrollIntent] = useState<{ top: number; n: number } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const scrollPage = (top: number): void => {
    setScrollIntent((prev) => ({ top, n: (prev?.n ?? 0) + 1 }));
  };

  // Ответ на избранное от ядра приходит с полным списком: сет заменяется, но
  // только если он пришёл для того же города, иначе подставился бы чужой.
  const applyFavorites = (next: Favorite[], cityCode: string): void => {
    if (cityCode === city) setFavorites(next);
  };

  const toggleFavorite = async (canonicalId: string, storeId: string, cityCode: string, storeCode: string): Promise<void> => {
    if (!window.api) return;
    const key = histKey(canonicalId, storeId, cityCode, storeCode);
    setFavBusy(key);
    try {
      if (isFav(canonicalId, storeId, cityCode, storeCode)) {
        applyFavorites(await window.api.removeFavorite({ canonicalId, storeId, city: cityCode, storeCode }), cityCode);
      } else {
        applyFavorites(await window.api.setFavorite({ canonicalId, storeId, city: cityCode, storeCode, targetPrice: null }), cityCode);
      }
    } catch (err) {
      console.error('favorite toggle failed', err);
      setFavError('Не удалось изменить избранное: ' + errText(err));
    } finally {
      setFavBusy(null);
    }
  };

  const setTargetPrice = async (
    canonicalId: string,
    storeId: string,
    cityCode: string,
    storeCode: string,
    target: number | null,
  ): Promise<void> => {
    if (!window.api) return;
    const key = histKey(canonicalId, storeId, cityCode, storeCode);
    setFavBusy(key);
    try {
      applyFavorites(
        await window.api.setFavorite({ canonicalId, storeId, city: cityCode, storeCode, targetPrice: target }),
        cityCode,
      );
    } catch (err) {
      console.error('favorite target failed', err);
      setFavError('Не удалось сохранить целевую цену: ' + errText(err));
    } finally {
      setFavBusy(null);
    }
  };

  const undoSplit = async (key: string): Promise<void> => {
    if (!window.api) return;
    setSplitBusy(key);
    try {
      setFavError(null);
      const pair = parseSplitKey(key);
      if (!pair) {
        setSplitBusy(null);
        setFavError('Не удалось вернуть товары в одну карточку: нечитаемая пара в списке.');
        await loadSplits();
        return;
      }
      const [a, b] = pair;
      await window.api.removeSplit({ canonicalIdA: a, canonicalIdB: b });
      await loadSplits();
    } catch (err) {
      console.error('undo split failed', err);
      setFavError('Не удалось вернуть товары в одну карточку: ' + errText(err));
    } finally {
      setSplitBusy(null);
    }
  };

  const nameOf = (canonicalId: string): string => nameCache[canonicalId] ?? canonicalId;

  // Разрыв склейки: пары строятся только между РАЗНЫМИ магазинами — два товара
  // одной сети с одинаковым названием почти всегда один товар, и делить нечем.
/**
   * Пары для разрыва склейки в карточке.
   *
   * Пара — это два РАЗНЫХ товара, которые склеились по ошибке. Две точки одной
   * сети дают один и тот же canonicalId (sku общий, различается только код
   * точки), то есть пара (X, X): разрывать нечего, и слой БД такой разрыв
   * ещё и отвергает. Кнопка рисуется по длине списка, а не по числу офферов,
   * иначе в карточке из двух точек одной сети была бы кнопка, которая всегда
   * падает с «Не удалось разделить товары».
   */
  const splitPairsOf = (g: PriceGroup): [string, string][] => {
    const pairs: [string, string][] = [];
    for (let i = 0; i < g.offers.length; i += 1) {
      for (let j = i + 1; j < g.offers.length; j += 1) {
        const a = g.offers[i];
        const b = g.offers[j];
        if (!a || !b) continue;
        if (a.storeId !== b.storeId || a.storeCode !== b.storeCode) {
          pairs.push([a.product.canonicalId, b.product.canonicalId]);
        }
      }
    }
    return pairs.filter(([a, b]) => a !== b);
  };

  const splitGroup = async (g: PriceGroup): Promise<void> => {
    const pairs = splitPairsOf(g);
    if (!window.api || pairs.length === 0) return;
    setSplitBusy(g.key);
    try {
      setFavError(null);
      for (const [a, b] of pairs) {
        await window.api.splitProducts({ canonicalIdA: a, canonicalIdB: b });
      }
      await loadSplits();
    } catch (err) {
      console.error('split failed', err);
      setFavError('Не удалось разделить товары: ' + errText(err));
    } finally {
      setSplitBusy(null);
    }
  };

  const loadFavorites = useCallback(async (): Promise<void> => {
    if (!window.api) return;
    try {
      setFavorites(await window.api.getFavorites({ city }));
    } catch (err) {
      console.error('favorites failed', err);
    }
  }, [city]);

  const loadSplits = useCallback(async (): Promise<void> => {
    if (!window.api) return;
    try {
      setSplits(new Set(await window.api.getSplitPairs({ city })));
    } catch (err) {
      console.error('splits failed', err);
    }
  }, [city]);

  // Ядро само знает выбранный город: автоопрос бьёт только по нему, а не по всем.
  useEffect(() => {
    if (window.api) window.api.setCurrentCity(city).catch((e) => console.error('city:set failed', e));
    // Отбор выдачи — про ВЫДАЧУ этого города: «в 2 сетях» в Москве в другом
    // городе обычно не имеет смысла (там другая сеть и другая цена), и человек
    // пришёл бы к пустому экрану, не понимая почему. Сброс на смене города
    // делается здесь, а не ключеванием состояния по городу: состояний стало
    // много, а общее у них одно — они не имеют смысла вне своей выдачи.
    setPriceDraft({ from: '', to: '' });
    setMinStores(1);
  }, [city]);

  // Имена товаров копим из выдачи и из избранного: карточка разрыва и «снова
  // один товар» должны называть товар, а не показывать его id.
  useEffect(() => {
    if (!results) return;
    setNameCache((prev) => {
      const next = { ...prev };
      for (const s of results) for (const item of s.items) next[item.canonicalId] = item.name;
      return next;
    });
  }, [results]);
  useEffect(() => {
    if (favorites.length === 0) return;
    setNameCache((prev) => {
      const next = { ...prev };
      for (const f of favorites) if (f.name && f.name !== f.canonicalId) next[f.canonicalId] = f.name;
      return next;
    });
  }, [favorites]);

  useEffect(() => {
    void loadFavorites();
    void loadSplits();
  }, [loadFavorites, loadSplits]);

  useDismissableMenu(storeMenuOpen, setStoreMenuOpen, storeMenuRef, storeMenuBtnRef);
  useDismissableMenu(cityMenuOpen, setCityMenuOpen, cityMenuRef, cityMenuBtnRef);

  // Прокрутка выполняется в эффекте, а не в обработчике: разметка должна
  // сначала перерисоваться, иначе браузер прокрутит по старой высоте.
  useEffect(() => {
    if (!scrollIntent) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: Math.min(scrollIntent.top, Math.max(0, max)) });
  }, [scrollIntent]);

  // Новая выдача всегда начинается с первой страницы: иначе после поиска
  // пользователь оказывался на пустой странице 7 из 7.
  useEffect(() => {
    if (results === null) return;
    setPage(1);
    scrollPage(0);
  }, [results]);

  // Старт приложения: без preload-моста показываем внятную ошибку, а не пустое
  // окно. События обновлений и сводки опроса снимаются здесь же и снимаются
  // при размонтировании — иначе подписчик жил бы после ухода экрана.
  useEffect(() => {
    if (!window.api) {
      // Мост ставится ДО рендера (см. android/main-android.tsx), поэтому его
      // отсутствие здесь означает одно: установка не удалась. Текст зависит от
      // среды — на Android совет про `dist-electron` только сбивал бы с толку.
      const isAndroid = /Android/i.test(navigator.userAgent);
      setFatal(
        isAndroid
          ? 'Не поднялся мост к ядру: переустанови приложение. Если повторяется — база на устройстве недоступна, и цены показаны не будут.'
          : 'Не загрузился preload-мост (window.api). Перезапусти приложение; если повторяется — сломана сборка dist-electron.',
      );
      return;
    }
    window.api.ping().then((p) => setStatus(p)).catch(() => setStatus('no-electron'));
    window.api.getVersion().then((v) => setVersion(v)).catch(() => setVersion('dev'));
    window.api
      .getSupportedNetworks()
      .then((ids) => {
        setSupportedNetworks(ids);
        setSupportedError(false);
      })
      .catch(() => {
        setSupportedNetworks(null);
        setSupportedError(true);
      });
    window.api
      .browserStatus()
      .then((s) => setBrowser(s))
      .catch(() => setBrowser(null));
    const off = window.api.onUpdateEvent((kind, payload) => {
      if (kind === 'available' || kind === 'downloaded') setUpdate({ kind, latest: String(payload) });
      else if (kind === 'error') setUpdate({ kind: 'error', message: String(payload) });
    });
      window.api
        .checkUpdates()
        .then((r) => {
          if (r.available && r.latest) {
            setUpdate(r.portable ? { kind: 'portable', latest: r.latest } : { kind: 'available', latest: r.latest });
          }
        })
        .catch(() => {});
    window.api.getSchedulerStatus().then((s) => {
      schedRef.current = s;
      setSched(s);
    }).catch(() => {});
    const offDone = window.api.onSchedulerDone((d) => {
      schedRef.current = d.status;
      setSched(d.status);
      setPollMsg({ text: d.summary, tone: isWarnSummary(d.summary) ? 'warn' : 'ok' });
    });
    // Уведомления ядра. На Electron это системная лента (её показывает сама
    // оболочка), а в Android-мосте — баннер в этом же окне: системного
    // уведомления без плагина там нет, а молчать нельзя, иначе пользователь не
    // узнает, что порог сработал.
    const onNotify = (e: Event) => {
      const detail = (e as CustomEvent<{ text: string }>).detail;
      if (typeof detail?.text !== 'string') return;
      setPollMsg({ text: detail.text, tone: 'ok' });
    };
    window.addEventListener('pa:notify', onNotify);
    return () => {
      off();
      offDone();
      window.removeEventListener('pa:notify', onNotify);
    };
  }, []);

  const fetchHist = (key: string, args: { canonicalId: string; storeId: string; city: string; storeCode: string }): void => {
    setHistLoading((prev) => ({ ...prev, [key]: true }));
    window.api
      .getHistory(args)
      .then((points) => setHist((prev) => ({ ...prev, [key]: points })))
      .catch(() => setHist((prev) => ({ ...prev, [key]: 'error' })))
      .finally(() => setHistLoading((prev) => ({ ...prev, [key]: false })));
  };

  const fetchShelves = (key: string, scope: { canonicalId: string; storeId: string; city: string; storeCode: string }): void => {
    window.api
      .getShelves(scope)
      .then((s) => setShelves((prev) => ({ ...prev, [key]: s })))
      .catch(() => setShelves((prev) => ({ ...prev, [key]: 'error' })));
  };

  const saveShelves = async (
    key: string,
    scope: { canonicalId: string; storeId: string; city: string; storeCode: string },
    categoryIds: string[],
  ): Promise<void> => {
    setShelfBusy((prev) => ({ ...prev, [key]: true }));
    try {
      const saved = await window.api.setShelves({ ...scope, categoryIds });
      setShelves((prev) => ({ ...prev, [key]: saved }));
    } catch (err) {
      setPollMsg({ text: `Полки не сохранились: ${errText(err)}`, tone: 'warn' });
    } finally {
      setShelfBusy((prev) => ({ ...prev, [key]: false }));
    }
  };

  const releaseShelvesAction = async (
    key: string,
    scope: { canonicalId: string; storeId: string; city: string; storeCode: string },
  ): Promise<void> => {
    setShelfBusy((prev) => ({ ...prev, [key]: true }));
    try {
      const after = await window.api.releaseShelves(scope);
      setShelves((prev) => ({ ...prev, [key]: after }));
    } catch (err) {
      setPollMsg({ text: `Не вернулось под автораскладку: ${errText(err)}`, tone: 'warn' });
    } finally {
      setShelfBusy((prev) => ({ ...prev, [key]: false }));
    }
  };

// Причины сбоя загрузки живут РЯДОМ со своим списком, а не в общем баннере
  // pollMsg: тот же баннер показывает сводку опроса, и ошибка списка его
  // затирала бы (и наоборот). Каналов ровно три, и каждый про своё:
  // catalogListError — список категорий сети, ourError — список наших полок,
  // catError — товары открытой полки. Смешивать их нельзя ещё и потому, что
  // запросы летят одновременно: в один канал попало бы только последнее.
  const reloadLists = useCallback(() => {
    if (!window.api) return;
    setCatalog(null);
    setOurCategories(null);
    setCatalogListError(null);
    setOurError(null);
    // Сообщение о прошлой полке относится к прошлому городу: оставленное
    // «ничего не нашлось» висит поверх свежего списка и выглядит как его ошибка.
    setCatError(null);
    setSearchError(null);
    window.api
      .getCatalog({ city })
      .then((c) => setCatalog(c ?? []))
      .catch((e) => {
        setCatalog([]);
        setCatalogListError(`Категории из магазина не загрузились: ${errText(e)}`);
      });
    // `?? []` — не перестраховка ради красоты: без него ответ IPC без поля
    // (undefined) уходит в состояние, и проверка `ourCategories !== null`
    // ниже падает на `.length` — приложение белым экраном без единого слова.
    window.api
      .getOurCategories({ city })
      .then((c) => setOurCategories(c ?? []))
      .catch((e) => {
        setOurCategories([]);
        setOurError(`Наши категории не загрузились: ${errText(e)}`);
      });
  }, [city]);

  useEffect(() => {
    if (!window.api) return;
    setResults(null);
    setLastAction(null);
    setDetailKey(null);
    setOurCategories(null);
    reloadLists();
  }, [reloadLists]);

  // Высота липкого подвала уходит в CSS-переменную: страница резервирует под
  // неё место при прокрутке к элементу в фокусе, иначе фокус оказывался под
  // подвалом. Измеряется, а не задаётся константой: высота футера меняется
  // вместе с текстом, кнопкой «Прервать» и шириной окна.
  useEffect(() => {
    const el = footerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const apply = (): void => {
      document.documentElement.style.setProperty('--footer-h', `${Math.ceil(el.offsetHeight)}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty('--footer-h');
    };
  }, []);

// Выбор магазинов живёт в двух местах: в интерфейсе (галочки, фильтр выдачи) и
  // в ядре (кому вообще можно ходить за ценами). Раньше второго не было, и опрос
  // обходил все сети города, пока интерфейс показывал «28 из 445» при одном
  // выбранном магазине.
  //
  // Ключи — ТОЧКИ (`storeId:storeCode`): выбор по сети у двух точек одной сети
  // дал бы одну галочку на два разных магазина.
  //
  // Сети без адаптера отсекаются: на Android их три из шести, и опросить их
  // нечем. В ядро такие ключи попадать не должны — иначе опрос считал бы их
  // «не проверено» и счётчик в шапке расходился бы с меню.
  const selectedStores = storesForCity(city)
    .filter((s) => s.ready && storeOn[pointKeyOf(s)] === true)
    .filter((s) => supportedNetworks === null || supportedNetworks.includes(s.storeId))
    .map(pointKeyOf);

  // Пишем в хранилище только выбор СВОЕГО города: пока в состоянии лежит выбор
  // прошлого города, его место в ключе нового — это порча данных (сама по себе
  // она исправлялась следующим кадром, но между записями хранилище было неверным).
  const storesKey = storesKeyFor(city);
  useEffect(() => {
    if (storeSel.city !== city) return;
    try {
      localStorage.setItem(storesKey, JSON.stringify(storeOn));
    } catch {
      // Без localStorage выбор живёт только до перезапуска — это полезно, но не
      // повод показывать ошибку: магазины всё равно переключаются.
    }
  }, [storesKey, storeOn, city, storeSel.city]);

  useEffect(() => {
    if (!window.api) return;
    // Guard здесь НЕ нужен: `setCurrentCity` уже обнуляет выбор в ядре, а окно в
    // одну долю секунды, пока летит `stores:set`, означало бы «опросить все сети».
    // Отправляем всегда, даже если выбор ещё не перечитан: хуже, чем одно лишнее
    // IPC-сообщение со старым городом, не будет ничего.
    // Пустой массив уходит как пустой массив, а не как null: null в ядре значит
    // «пользователь ещё не выбирал» и включает опрос ВСЕХ сетей города, то есть
    // снятие последней галочки тихо возвращало бы полный обход.
    void window.api.setCurrentStores(city, selectedStores).catch((e: unknown) => {
      // Ядро отвергло выбор (сеть не найдена в городе) — говорим честно, потому
      // что иначе опрос молча пошёл бы по всем сетям города.
      setPollMsg({ text: storesErrorText(e, city), tone: 'warn' });
    });
  }, [city, selectedStores.join(',')]);

  useEffect(() => {
    if (detailKey === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDetailKey(null);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeBtnRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [detailKey]);

  const openDetail = (key: string) => {
    setDetailKey(key);
    const g = groups?.groups.find((x) => x.key === key);
    if (!g || !window.api) return;
    for (const o of g.offers) {
      const hkey = histKey(o.product.canonicalId, o.storeId, city, o.product.storeCode);
      // Гарды независимые: история могла уже грузиться из карточки («история»),
      // и общий continue глушил бы загрузку полок — фича просто не появлялась.
      if (hist[hkey] === undefined || hist[hkey] === 'error') {
        fetchHist(hkey, {
          canonicalId: o.product.canonicalId,
          storeId: o.storeId,
          city,
          storeCode: o.product.storeCode,
        });
      }
      if (shelves[hkey] === undefined || shelves[hkey] === 'error') {
        fetchShelves(hkey, {
          canonicalId: o.product.canonicalId,
          storeId: o.storeId,
          city,
          storeCode: o.product.storeCode,
        });
      }
    }
  };

  const toggleHist = (key: string, args: { canonicalId: string; storeId: string; city: string; storeCode: string }) => {
    if (!window.api) return;
    if (openHist === key) {
      setOpenHist(null);
      return;
    }
    setOpenHist(key);
    if (hist[key] !== undefined && hist[key] !== 'error') return;
    fetchHist(key, args);
  };

  const runPoll = () => {
    if (!window.api) return;
    setPollMsg(null);
    const action = lastAction;
    // Флаг «идёт» ставим сразу, до ответа ядра: пока он не приедет (а он
    // приезжает по завершении), кнопка в подвале продолжала бы предлагать
    // «Опросить сейчас», и второй клик получал бы отказ «Опрос уже идёт».
    markRunning(true);
    // Город передаём явно: кнопка «Опросить сейчас» в подвале не привязана к
    // последнему открытому списку, и без city ядро опрашивало бы все города.
    window.api
      .runScheduler({ city, pointKeys: selectedStores })
      .then((d) => {
        // Ответ по ПРОШЛОМУ прогону не имеет права гасить флаг у текущего:
        // без проверки кнопка на мигнувший срок возвращалась бы в «Опросить
        // сейчас» и «Прервать» исчезала — то есть исходная жалоба вернулась бы
        // узким окном. Свежий статус всегда с running: false, поэтому сравниваем
        // с тем, что уже есть в состоянии.
        setSched((prev) => {
          // Тот же ref держим в актуальном состоянии: markRunning смотрит на
          // schedRef, а не на prev из этого апдейтера.
          const next =
            prev?.running === true && d.status.running === false ? prev : d.status;
          schedRef.current = next;
          return next;
        });
        // Тот же вопрос по возврату runScheduler: ядро отвечает «Опрос уже идёт»,
        // когда проход занял флаг, и зелёный баннер врал бы.
        setPollMsg({ text: d.summary, tone: isWarnSummary(d.summary) ? 'warn' : 'ok' });
        if (!window.api) return;
        if (action?.kind === 'search' && action.city === city) {
          // Токен берётся здесь, а не до `runScheduler`: пока шёл опрос, полка или
          // новый поиск могли занять экран, и их данные обновлять уже нельзя.
          const token = ++shelfTokenRef.current;
          window.api
            .getPrices({ city, query: action.query })
            .then((r) => {
              if (token !== shelfTokenRef.current) return;
              setResults(r ?? []);
            })
            .catch((e) => {
              if (token !== shelfTokenRef.current) return;
              setSearchError(`Поиск не удался: ${errText(e)}`);
            });
        } else if (action?.kind === 'category' && action.city === city) {
          const token = ++shelfTokenRef.current;
          window.api
            .getCategory({ city, url: action.url })
            .then((r) => {
              if (token !== shelfTokenRef.current) return;
              setResults(r ?? []);
            })
            .catch((e) => {
              if (token !== shelfTokenRef.current) return;
              setSearchError(`Товары категории не загрузились: ${errText(e)}`);
            });
        }
      })
.catch((e) => {
            // Флаг снимаем ДО баннера: оптимистический running живёт до конца
            // прогона, и если IPC оборвётся (или emit бросит в finally ядра), подвал
            // остался бы с неактивной кнопкой «Опрашиваю…» навсегда — ровно тот
            // мёртвый класс, который правка чинит.
            markRunning(false);
            // Причина обязательна: «Опрос не удался» без текста — это ровно тот
            // молчаливый отказ, который чинили в категориях.
            setPollMsg({ text: `Опрос не удался: ${errText(e)}`, tone: 'warn' });
          });
  };

  /**
   * Прервать идущий опрос.
   *
   * Кнопка не гасится после клика: отмена кооперативная и срабатывает на границе
   * товара, то есть в браузерных сетях через минуту. Ранняя блокировка обещала бы
   * мгновенную остановку и вводила в заблуждение — «я нажал, а ничего не
   * происходит». Итоговую сводку приносит тот же `runScheduler`, который висел:
   * он вернётся с «Опрос прерван: … осталось N».
   */
  /**
   * Отметка «опрос идёт» для подвала.
   *
   * Раньше этот флаг приезжал только ответом на runScheduler — то есть в самом
   * конце прогона. Пока он не приезжал, кнопка в подвале оставалась «Опросить
   * сейчас», а повторный клик получал от ядра «Опрос уже идёт — дождись
   * завершения»: выглядело, как сломанная кнопка. Теперь флаг ставится по
   * первому событию прогресса и снимается по событию завершения.
   */
  const markRunning = (running: boolean): void => {
    if (schedRef.current === null) {
      // Статус ещё не приходил (окно только открылось, автозапуск уже пошёл).
      // Запрос уходит ЗДЕСЬ, а не внутри апдейтера состояния: апдейтеры должны
      // быть чистыми, а побочный запрос в них — это неразборчивая отладка.
      // Ответ берём с поправкой на `|| running`: к моменту ответа прогон уже
      // начат, и ядро успело бы вернуть running: false — ровно тот мёртвый
      // флаг, который мы чиним.
      if (running) {
        window.api
          .getSchedulerStatus()
          .then((s) => {
            const next = { ...s, running: true };
            // Ref обязателен и здесь: без него следующий markRunning(false) из
            // .catch прогона увидел бы null, вышел на return и оставил флаг
            // включённым — то есть мёртвая кнопка в окне до первого ответа.
            schedRef.current = next;
            setSched(next);
          })
          .catch(() => {});
      }
      return;
    }
    setSched((prev) => {
      const next = prev === null || prev.running === running ? prev : { ...prev, running };
      schedRef.current = next;
      return next;
    });
  };

  // «Идёт ли опрос» в одном месте вместо пяти `sched?.running === true`:
  // разъезд этих проверок и есть источник «кнопка горит, а Прервать не показан».
  const pollRunning = sched?.running === true;

  const stopPoll = () => {
    if (!window.api) return;
    window.api
      .cancelScheduler()
      .then((stopped) => {
        if (!stopped) return;
        setPollMsg({
          text: 'Останавливаю на текущем товаре — собранное сохранится.',
          tone: 'warn',
        });
      })
      .catch((e) => setPollMsg({ text: `Не удалось прервать: ${errText(e)}`, tone: 'warn' }));
  };

  /**
   * Порог сторожа под конкретную полку и город. Живёт внутри компонента: нужны
   * текущие полки и город, а не значения на момент импорта модуля.
   *
   * Длина одного запроса берётся из ХУДШЕЙ готовой сети города, а не из
   * константы: браузерные сети (Пятёрка, Чижик, Перекрёсток) висят до 60 секунд,
   * и фиксированные 10 с на запрос давали для полки «Молочное и яйца» порог
   * ~100 с при реальных 240+ — то есть сторож ложно срабатывал ровно на тех
   * сетях, ради которых и вводился. Верхняя отсечка: восемь запросов по 65 с —
   * это восемь минут молчания, а пользователь к тому моменту уже решил, что
   * приложение зависло.
   */
  const shelfWatchdogMs = (categoryId: string): number => {
    const queries = Math.max(1, (ourCategories ?? []).find((c) => c.id === categoryId)?.queryCount ?? 1);
    // Самая многоточечная сеть города: сети идут параллельно, внутри сети — нет.
    const pointsByNetwork = new Map<string, number>();
    let worstRequestMs = 0;
    for (const s of readyStoresForCity(city)) {
      pointsByNetwork.set(s.storeId, (pointsByNetwork.get(s.storeId) ?? 0) + 1);
      worstRequestMs = Math.max(worstRequestMs, NETWORK_REQUEST_BUDGET_MS[s.storeId] ?? 15_000);
    }
    const worstNetwork = Math.max(1, ...pointsByNetwork.values());
    return Math.min(
      SHELF_WATCHDOG_CAP_MS,
      Math.max(
        SHELF_TIMEOUT_MS,
        worstNetwork * queries * (worstRequestMs + SAME_STORE_POINT_PAUSE_MS) + worstRequestMs,
      ),
    );
  };

  const openCategory = (url: string) => {
    if (!window.api) return;
    catScrollRef.current = window.scrollY;
    const token = ++shelfTokenRef.current;
    setResults(null);
    setCatLoading(true);
    setCatError(null);
    setLastAction({ kind: 'category', url, city });
    // Проверка токена в таймауте — обязательна, иначе таймер покинутой полки
    // сорвёт загрузку той полки, которую открыли вместо неё: скелет исчезнет на
    // середине, а над результатами появится ложная ошибка про магазин, который
    // пользователь уже закрыл.
    const watchdog = shelfWatchdogMs('category');
    const stalled = setTimeout(() => {
      if (token !== shelfTokenRef.current) return;
      setCatLoading(false);
      setCatError({ kind: 'error', text: `Магазин не ответил за ${Math.round(watchdog / 1000)} секунд — попробуй открыть полку ещё раз.` });
    }, watchdog);
    window.api
      .getCategory({ city, url })
      .then((r) => {
        // Токен проверяется ДО записи результата: пока пользователь ждал этой
        // полки, он мог запустить поиск (тот поднимает тот же счётчик). Раньше
        // setResults стоял выше проверки, и поздний ответ по полке затирал
        // результаты поиска — пользователь видел не то, что искал.
        if (token !== shelfTokenRef.current) return;
        setResults(r ?? []);
        if (r.every((s) => s.items.length === 0)) {
          const err = r.map((s) => s.error).find((e) => e);
          // Префикс обязателен: строка из сервиса может начинаться с технического
          // «Error invoking remote method…», а соседние сообщения всегда
          // называют действие.
          setCatError(
            err
              ? { kind: 'error', text: `Товары категории не загрузились: ${errText(err)}` }
              : { kind: 'info', text: EMPTY_SHELF_PLAIN },
          );
        } else {
          // Товары пришли — прошлая ошибка сторожа над готовым списком не нужна.
          setCatError(null);
        }
      })
      .catch((e) => {
        if (token !== shelfTokenRef.current) return;
        setResults([]);
        setCatError({ kind: 'error', text: errText(e) });
      })
      .finally(() => {
        clearTimeout(stalled);
        // Чужой ответ не должен гасить индикатор новой загрузки: счётчик уже
        // другой, значит и «Загружаю…» относится к нему.
        if (token === shelfTokenRef.current) setCatLoading(false);
      });
  };

  const backToCategories = () => {
    const y = catScrollRef.current;
    shelfTokenRef.current += 1;
    setResults(null);
    // Сообщение относится к покинутой полке: на списке категорий оно только
    // путает — иначе следующий пустой результат унаследует чужой текст.
    setCatError(null);
    // Возврат к категориям — это «на главную»: поиск здесь лишний.
    setSearchOpen(false);
// Уход с грузящейся полки: снимаем блокировку кнопок, иначе список вернётся
    // серым и некликабельным. Поздний ответ сети отбрасывается по счётчику выше.
    setCatLoading(false);
    setSearching(false);
    scrollPage(y);
  };

  const openOurCategory = (id: string) => {
    if (!window.api) return;
    catScrollRef.current = window.scrollY;
    const token = ++shelfTokenRef.current;
    // Виртуальность читаем до запроса: внутри .then состояние списка уже могло
    // смениться (смена города, перезагрузка списка) и подсказка молча откатилась
    // бы в общий текст.
    const isVirtual = (ourCategories ?? []).some((c) => c.id === id && c.virtual === true);
    setResults(null);
    setCatLoading(true);
    setCatError(null);
    setLastAction({ kind: 'our', id, city });
    // Проверка токена в таймауте — обязательна, иначе таймер покинутой полки
    // сорвёт загрузку той полки, которую открыли вместо неё: скелет исчезнет на
    // середине, а над результатами появится ложная ошибка про магазин, который
    // пользователь уже закрыл.
    //
    // Порог считается под ЭТУ полку: у неё своё число запросов (до восьми), а
    // точки одной сети обходятся с паузой, поэтому фиксированные 45 секунд при
    // нескольких точках срабатывали на живой сети.
    const watchdog = shelfWatchdogMs(id);
    const stalled = setTimeout(() => {
      if (token !== shelfTokenRef.current) return;
      setCatLoading(false);
      setCatError({ kind: 'error', text: `Магазин не ответил за ${Math.round(watchdog / 1000)} секунд — попробуй открыть полку ещё раз.` });
    }, watchdog);
    window.api
      .getOurCategory({ city, id })
      .then((r) => {
        // Проверка токена до записи — как в openCategory: пока шла эта полка,
        // пользователь мог уйти в поиск, и его результат не должен утонуть.
        if (token !== shelfTokenRef.current) return;
        setResults(r ?? []);
        if (r.every((s) => s.items.length === 0)) {
          const err = r.map((s) => s.error).find((e) => e);
          setCatError(
            err
              ? { kind: 'error', text: `Товары полки не загрузились: ${errText(err)}` }
              : { kind: 'info', text: isVirtual ? EMPTY_SHELF_VIRTUAL : EMPTY_SHELF_PLAIN },
          );
        } else {
          // Товары пришли — прошлая ошибка сторожа (или пустая полка) больше не
          // должна висеть над готовым списком.
          setCatError(null);
        }
      })
      .catch((e) => {
        if (token !== shelfTokenRef.current) return;
        setResults([]);
        setCatError({ kind: 'error', text: errText(e) });
      })
      .finally(() => {
        clearTimeout(stalled);
        if (token === shelfTokenRef.current) setCatLoading(false);
      });
  };

const doSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.api || !query.trim()) return;
    catScrollRef.current = window.scrollY;
    // Поиск занимает тот же счётчик, что и открытие полки: он тоже меняет
    // выдачу, поэтому должен гасить подвисший ответ по полке. И наоборот —
    // свой токен поиск обязан помнить сам, иначе «поиск → назад к категориям →
    // открыть полку» заканчивается экраном поиска поверх грузящейся полки.
    const token = ++shelfTokenRef.current;
    setResults(null);
    setSearchError(null);
    setCatError(null);
    setCatLoading(false);
    setLastAction({ kind: 'search', query: query.trim(), city });
    setSearching(true);
    window.api
      .getPrices({ city, query: query.trim() })
      .then((r) => {
        if (token !== shelfTokenRef.current) return;
        setResults(r ?? []);
      })
      .catch((err) => {
        if (token !== shelfTokenRef.current) return;
        setResults([]);
        setSearchError(errText(err));
      })
      .finally(() => {
        if (token === shelfTokenRef.current) setSearching(false);
      });
  };

  // Виртуальная полка «Не разложено» стоит отдельной панелью под списком: она
  // диагностическая, а не рабочая, и в общем списке спорила с девятью полками.
  // Дети больше не рисуются: полки плоские, каждый элемент списка —
  // самостоятельная полка со своими запросами.
  const virtualShelf = (ourCategories ?? []).find((c) => c.virtual === true) ?? null;
  const realShelves = rootShelves(ourCategories ?? []);
  // Уточнения широких полок («Молоко» внутри «Молочного и яиц»). Раньше они
  // стояли рядом с широкими как равные полки — и читались как дубль: широкая
  // полка собирает товар по восьми запросам, узкая — по одному, причём товар
  // попадал в обе. Теперь у узкой есть родитель, и она показана как подборка.
  const subShelves = (ourCategories ?? []).filter(
    (c) => c.parentId !== null && c.virtual !== true,
  );
  /**
   * Адреса для отдельного выбора: точки ВЫБРАННОЙ сети. Показывать адреса
   * всех сетей сразу нельзя — список в них перемешивается (у Магнита это
   * десятки адресов), и непонятно, к какому магазину относится строка.
   *
   * Список сетей в меню — по названию, а адрес выбирается здесь: двадцать
   * строк одного магазина в общем списке читались бы как двадцать магазинов.
   */
  /** Сеть, для которой по умолчанию показываются адреса: первая доступная. */
  const defaultNetworkId = React.useMemo(() => {
    const nets = networksForCity(city).filter(
      (net) => supportedNetworks === null || supportedNetworks.includes(net.storeId),
    );
    const withPoints = nets.find((net) =>
      storesForCity(city, net.storeId).some((p) => p.ready),
    );
    return (withPoints ?? nets[0])?.storeId ?? null;
  }, [city, supportedNetworks]);
  const selectedNetwork = storeMenuNetwork ?? defaultNetworkId;
  const addressOptions = React.useMemo(
    () =>
      selectedNetwork === null
        ? []
        : storesForCity(city, selectedNetwork as StoreId).filter(
            (p) => p.ready && (supportedNetworks === null || supportedNetworks.includes(p.storeId)),
          ),
    [city, selectedNetwork, supportedNetworks],
  );
  const addressSelected = addressOptions.find((p) => storeOn[pointKeyOf(p)] === true);
  const addressValue = addressSelected
    ? pointKeyOf(addressSelected)
    : addressOptions[0]
      ? pointKeyOf(addressOptions[0])
      : '';  const subShelvesOf = (id: string): OurCategoryInfo[] =>
    subShelves.filter((s) => s.parentId === id);
  const parentNameOf = (id: string): string => {
    const parent = (ourCategories ?? []).find((c) => c.id === id)?.parentId;
    return (ourCategories ?? []).find((c) => c.id === parent)?.name ?? '';
  };

  const groups = useMemo(() => {
    if (!results) return null;
    const rawCount = results.reduce((n, s) => n + s.items.length, 0);
    // Разрыв склейки в пределах одного магазина невозможен по смыслу: два
    // товара одной сети с одинаковым названием — это почти всегда один товар,
    // а если нет — они и так в одной карточке, и разделить их нечем.
    // Фильтр по выбору НЕ применяется, пока не выбрана ни одна ТОЧКА: клик по
    // поиску или полке сам по себе согласие на запрос, ядро спрашивает все
    // готовые точки, и выбрасывать их ответ («ничего не выбрано — показывать
    // нечего») значило заплатить полным обходом и показать пустоту. Молчит при
    // этом планировщик: он фильтр соблюдает.
    const anyStoreOn = storesForCity(city).some(
      (s) =>
        s.ready &&
        storeOn[pointKeyOf(s)] === true &&
        (supportedNetworks === null || supportedNetworks.includes(s.storeId)),
    );
    const items = results.flatMap((s) =>
      anyStoreOn && !blockVisible(s.storeId, s.storeCode)
        ? []
        : s.items.filter((p) => {
            if (promoOnly && p.oldPrice == null && p.promoPrice == null) return false;
            if (stockOnly && p.inStock === false) return false;
            return true;
          }),
    );
    const allList = groupByProduct(items, splits);
    // Счётчик «Найдено N товаров» обязан остаться про ВСЮ выдачу сети, иначе
    // после постановки границы «до 100» он начнёт врать: «Найдено 3 товара»
    // при 130 найденных. Поэтому фильтрованный список и полный расходятся
    // явно, и интерфейс печатает «N из M».
    const list = filterPriceGroups(allList, resultFilters);
    // Сортировка по той же величине, что и границы цены: groupPrice в общем
    // модуле — это minOf ниже, одно определение цены на всю выдачу.
    const minOf = (g: (typeof list)[number]) => groupPrice(g);
    if (sort !== 'none') list.sort((a, b) => (sort === 'asc' ? minOf(a) - minOf(b) : minOf(b) - minOf(a)));
    return { groups: list, allCount: allList.length, stores: results, rawCount };
    // splits в зависимостях обязателен: без него React держит мемоизацию при
    // неизменных аргументах, и после отметки «это разные товары» карточка
    // осталась бы склеенной до смены фильтра — пользователь счёл бы кнопку
    // сломанной. Границы цены и число сетей — там же: без них отбор пересчитывался
    // бы только по смене выдачи, и поля выглядели бы рабочими, а выдача — нет.
  }, [results, storeOn, promoOnly, stockOnly, sort, splits, resultFilters]);

  // Постраничный срез отсчитывается от groups.groups (все отфильтрованные
  // товары), а не от результата по сети. Если фильтр урезал выдачу до одной
  // страницы, номер страницы сам ужимается до неё — «пустая» страница с
  // нулевым товаром недостижима ни через одну комбинацию фильтров.
  const pageCount = groups ? Math.max(1, Math.ceil(groups.groups.length / PAGE_SIZE)) : 1;
  const pageNo = Math.min(Math.max(1, page), pageCount);
  const pagedGroups = groups ? groups.groups.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE) : [];

// Смена страницы: сначала номер, потом фокус на сетку. setPage асинхронен,
// поэтому фокусируем сетку сразу — она останется на месте при любой странице,
// а вот кнопка «вперёд» после прокрутки уходит из поля зрения.
//
// `preventScroll: true` обязателен. Без него браузер скроллит к элементу сам,
// причём «минимальным» движением: со страницы 2 он возвращал на страницу 1
// где-то в середину ленты — не в начало и не в конец, потому что верх сетки
// после смены страницы оказался выше вьюпорта, и браузер доменял элемент ровно
// настолько, чтобы тот «стал виден». Прокрутка задаётся явно через scrollPage.
  const goPage = (n: number) => {
    setPage(Math.min(Math.max(1, n), pageCount));
    resultsRef.current?.focus({ preventScroll: true });
    scrollPage(0);
  };

// Фильтры меняют groups, но не results, поэтому сброса на [results] для них
  // не хватает: сняли галочку магазина на 5-й странице ( стало 2 страницы —
  // вид ужат), вернули галочку — и выдача молча прыгнула на товары 97–120.
  // Массив зависимостей здесь НЕ exhaustive и это намеренно: pageNo — сводное
  // значение (page и pageCount), а читать из эффекта надо только pageNo.
  // Если добавить page в зависимости ради «правильности», синхронизация с
  // фильтрами перестанет работать. ESLint в проекте нет, поэтому предупредить
  // об этом некому — предупреждение здесь.
  // Приводим state к фактической странице; для обычного клика «вперёд» это
  // no-op, потому что pageNo там и так равен page.
  useEffect(() => {
    setPage(pageNo);
  }, [pageNo]);

/**
   * Подпись строки цены: сеть плюс ТОЧКА.
   *
   * Две точки одной сети в карточке выглядят как «Магнит 119 ₽» и «Магнит
   * 105 ₽» — сравнение цен между точкам бессмысленно, если не сказано,
   * где какая. Точка приходит из товара, а её имя лежит в справочнике.
   * Sentinel «?» — это перенесённая из старой базы цена, точки у неё нет:
   * подпись называет сеть и прямо говорит, что точка не указана.
   */
  const offerPointLabel = (storeId: string, storeCode: string): string => {
    // Перенесённая цена точки не имеет: подпись обязана сказать об этом прямо,
    // иначе строка выглядела бы как цена выбранного магазина той же сети.
    if (storeCode === UNKNOWN_STORE_CODE) return unknownPointLabel(storeName(storeId));
    // Именно storeByCode, а не networksForCity: тот отдаёт по одной записи на
    // СЕТЬ, то есть вторую точку той же сети он найти не может никогда.
    const point = storeByCode(storeId as StoreId, city, storeCode);
    // Адрес из сети, если он есть: у двух точек одной сети имена одинаковые, и
    // без адреса строки цены выглядели бы как две одинаковые подписи.
    return point ? pointLabel(point) : storeName(storeId);
  };

    // Крестик у баннеров обновления: уведомление приходит само, повторяться не
    // будет, а перекрывать собой поиск оно не должно.
    const dismissUpdate = () => setUpdate({ kind: 'idle' });

  return (
    // Отступы системных полос — внешним слоем, а не на корневом контейнере:
    // шапка и футер растягиваются на всю ширину через `-mx-3`/`-mx-6`, и
    // внутренний отступ увеличил бы и их, то есть обратно залез бы под
    // статус-бар. Липкая шапка дополнительно целится в `top-[var(--safe-top)]`,
    // потому что sticky отсчитывает порог от вьюпорта, а не от рамки родителя.
    <div
      className="flex min-h-dvh flex-col bg-cream"
      style={{
        paddingTop: 'var(--safe-top)',
        paddingBottom: 'var(--safe-bottom)',
        paddingLeft: 'var(--safe-left)',
        paddingRight: 'var(--safe-right)',
      }}
    >
    {/* Флекс-колонка на всю высоту окна: подвал прижат к низу (`mt-auto`),
        а липкий (`sticky bottom-…`) не уезжает при прокрутке. Раньше он был
        обычным блоком в конце потока, поэтому «плавал» вместе с содержимым:
        то прижимался к низу короткой страницы, то уезжал за экран на длинной.
        Высота задана внешнему слою, а внутренний тянется (`flex-auto`): свой
        `min-h-dvh` внутри с отступами под системные полосы дал бы лишнюю
        прокрутку на Android. Нижний отступ подвала (`pb-3`) — это воздух
        внутри самого подвала; системный инсет остаётся на внешнем слое, и
        липкий подвал целит его через `bottom-[var(--safe-bottom)]`. */}
    <div className="mx-auto flex w-full max-w-6xl flex-auto flex-col bg-cream px-3 text-ink sm:px-6">
      {/* Мобильная шапка: горизонтальная лента вместо `-mx-6` и `px-6` —
          на телефоне поля съедали бы по 24px с каждой стороны, то есть треть
          ширины. На широком экране поля остаются прежними. */}
      <header className="sticky top-[var(--safe-top)] z-10 -mx-3 border-b border-line bg-cream px-3 py-2 sm:-mx-6 sm:bg-cream/95 sm:px-6 sm:py-3 sm:backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 sm:gap-3">
          <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-primary sm:h-10 sm:w-10 sm:rounded-xl" aria-hidden="true">
            {/* Один рисунок в двух размерах: на телефоне 18px в квадрате 32px,
                на десктопе прежние 22px в 40px. Два svg вместо одного с
                размером через класс — потому что `width`/`height` у svg задаются
                атрибутами, а не классами. */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" className="sm:hidden">
              <path d="M6 7h15l-1.5 9h-12z" />
              <path d="M6 7l-1-4H2" />
              <circle cx="9" cy="20" r="1.5" />
              <circle cx="17" cy="20" r="1.5" />
            </svg>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" className="hidden sm:block">
              <path d="M6 7h15l-1.5 9h-12z" />
              <path d="M6 7l-1-4H2" />
              <circle cx="9" cy="20" r="1.5" />
              <circle cx="17" cy="20" r="1.5" />
            </svg>
          </span>
          <h1 className="m-0 min-w-0 truncate text-[17px] font-bold tracking-tight sm:text-[22px]">PriceAggregator</h1>
          <button
              type="button"
              className="relative flex h-10 w-10 flex-none cursor-pointer items-center justify-center rounded-full border border-line bg-card text-ink transition-colors after:absolute after:-inset-1 after:content-[''] hover:border-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary sm:h-9 sm:w-9 sm:after:hidden"
              onClick={() => {
                setSearchOpen((v) => !v);
                // Открываем — сразу в поле: иначе пришлось бы ещё раз кликать.
                if (!searchOpen) setTimeout(() => searchInputRef.current?.focus(), 0);
              }}
              aria-expanded={searchOpen}
              aria-controls="q"
              aria-label={searchOpen ? 'Скрыть поиск' : 'Найти товар'}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
            </button>
            <div className="relative ml-auto" ref={cityMenuRef}>
            <button
              ref={cityMenuBtnRef}
              className="relative flex min-h-10 cursor-pointer items-center gap-1 rounded-full border border-line bg-card px-3 py-1.5 text-[13px] text-ink transition-colors after:absolute after:-inset-1 after:content-[''] hover:border-primary sm:min-h-9 sm:gap-1.5 sm:px-3.5 sm:py-1.5 sm:text-sm sm:after:hidden"
              onClick={() => setCityMenuOpen((v) => !v)}
              aria-expanded={cityMenuOpen}
              aria-label={`Город: ${CITIES.find((c) => c.id === city)?.name ?? city}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M12 21s7-6.5 7-11a7 7 0 1 0-14 0c0 4.5 7 11 7 11z" />
                <circle cx="12" cy="10" r="2.5" />
              </svg>
              {CITIES.find((c) => c.id === city)?.name ?? city}
              <span aria-hidden="true">▾</span>
            </button>
            {cityMenuOpen && (
              // Прокрутка внутри списка: городов уже 15, дальше будет больше, и без
              // неё дно списка уезжает за край окна и недоступно. max-h убран из
              // класса — он задаётся здесь, чтобы высота не зависела от ширины.
              <div
                className="absolute right-0 top-full z-20 mt-1 min-w-64 rounded-xl border border-line bg-card p-2 shadow-lg"
                role="group"
                aria-label="Выбор города"
              >
                <div className="max-h-[min(22rem,60vh)] overflow-y-auto overscroll-contain">
                {CITIES.map((c) => {
                  const stores = networksForCity(c.id);
                  const readyStores = stores.filter((s) => s.ready);
                  const active = city === c.id;
                  return (
                    <button
                      key={c.id}
                      aria-current={active}
                      className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-ink hover:bg-cream"
                      onClick={() => {
                  // Смена города гасит всё, что грузится: без инкремента счётчика
                  // поздний ответ полки старого города проходит проверку токена
                  // и кладёт московские цены под шапкой «Ульяновск». Идентичность
                  // цены включает город (ключ = canonicalId + storeId + city),
                  // так что это не косметика, а подмена данных.
                  shelfTokenRef.current += 1;
                  setCatLoading(false);
                  setSearching(false);
                  setCity(c.id);
                  // Город запоминается между запусками: выбор магазинов хранится
                  // по городам, и без этого после перезапуска он был бы виден не
                  // для того города, к которому относится.
                  try {
                    localStorage.setItem('pa.city', c.id);
                  } catch {
                    // Без localStorage город просто не запомнится — это не повод
                    // мешать переключению.
                  }
                  setResults(null);
                  setCityMenuOpen(false);
                  cityMenuBtnRef.current?.focus();
                  scrollPage(0);
                }}
                    >
                      <span
                        className={active ? 'flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full bg-primary' : 'flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border border-line'}
                        aria-hidden="true"
                      >
                        {active && (
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3">
                            <path d="M4 12.5 9.5 18 20 6.5" />
                          </svg>
                        )}
                      </span>
                      <span className="flex-1">{c.name}</span>
                      <span className="text-xs text-muted">
                        {/* Считаем по сетям с адаптером: «6 из 6 сетей» в городе,
                            где доступны три, — враньё на одном экране с меню
                            магазинов, где эти три помечены «(нет адаптера)». */}
                        {supportedNetworks === null
                          ? `${readyStores.length} из ${stores.length} сетей`
                          : `${stores.filter((s) => supportedNetworks.includes(s.storeId)).length} из ${stores.length} сетей`}
                      </span>
                    </button>
                  );
                })}
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="pt-4">
        {fatal && (
          <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="alert">
            {fatal}
          </div>
        )}
{update.kind === 'available' && (
            <div className="my-3 flex items-start gap-2 rounded-xl bg-warnbg p-2.5 px-3.5 text-sm" role="status">
              <span className="max-h-36 flex-1 overflow-y-auto break-all">
                Доступна версия {update.latest}.
                <button
                  type="button"
                  className="ml-2 min-h-9 cursor-pointer"
                  onClick={() =>
                    window.api
                      .downloadUpdate()
                      .catch(() => setUpdate({ kind: 'error', message: 'не удалось скачать обновление' }))
                  }
                >
                  Скачать обновление
                </button>
              </span>
              <button type="button" className="min-h-11 min-w-11 px-1 sm:min-h-9 sm:min-w-0" onClick={dismissUpdate} aria-label="Скрыть">
                ×
              </button>
            </div>
          )}
          {update.kind === 'portable' && (
            <div className="my-3 flex items-start gap-2 rounded-xl bg-warnbg p-2.5 px-3.5 text-sm" role="status">
              <span className="max-h-36 flex-1 overflow-y-auto break-all">
                Вышла версия {update.latest}. Portable не обновляется сам — скачай его заново
                <button
                  type="button"
                  className="cursor-pointer underline"
                  onClick={() => void window.api.openExternal(RELEASES_PAGE_URL)}
                >
                  на странице релизов
                </button>
                .
              </span>
              <button type="button" className="min-h-11 min-w-11 px-1 sm:min-h-9 sm:min-w-0" onClick={dismissUpdate} aria-label="Скрыть">
                ×
              </button>
            </div>
          )}
          {update.kind === 'downloaded' && (
            <div className="my-3 flex items-start gap-2 rounded-xl bg-okbg p-2.5 px-3.5 text-sm" role="status">
              <span className="max-h-36 flex-1 overflow-y-auto break-all">
                Версия {update.latest} скачана.
                <button
                  type="button"
                  className="ml-2 min-h-9 cursor-pointer"
                  onClick={() =>
                    window.api.installUpdate().catch(() => setUpdate({ kind: 'error', message: 'не удалось запустить установку' }))
                  }
                >
                  Установить и перезапустить
                </button>
              </span>
              <button type="button" className="min-h-11 min-w-11 px-1 sm:min-h-9 sm:min-w-0" onClick={dismissUpdate} aria-label="Скрыть">
                ×
              </button>
            </div>
          )}
          {update.kind === 'error' && (
            <div className="my-3 flex items-start gap-2 rounded-xl bg-warnbg p-2.5 px-3.5 text-sm" role="alert">
              <span className="max-h-36 flex-1 overflow-y-auto break-all">Ошибка обновлений: {update.message}</span>
              <button type="button" className="min-h-11 min-w-11 px-1 sm:min-h-9 sm:min-w-0" onClick={dismissUpdate} aria-label="Скрыть">
                ×
              </button>
            </div>
          )}

        {/* Поиск живёт под иконкой в шапке: на главной он занимал целую полосу ради
            одного поля, а при открытой полке отнимал место у результатов.

            Гейт на мост: без него пользователь набирал бы запрос, жал «Найти» и
            получал тишину — `doSearch` выходит по `if (!window.api) return`. */}
        {window.api && searchOpen && (
          <form className="mb-2 mt-2 flex gap-2" onSubmit={doSearch}>
            <label htmlFor="q" className="absolute -left-[9999px]">
              Поиск товара
            </label>
            <input
              id="q"
              ref={searchInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearchOpen(false);
              }}
              placeholder="Молоко, яйца, хлеб…"
              autoComplete="off"
              className="min-h-10 flex-1 rounded-l-xl rounded-r-none border border-r-0 border-line bg-card px-3 py-1.5 text-base text-ink focus:outline-2 focus:outline-primary sm:min-h-11 sm:px-3.5 sm:py-2"
            />
            <button
              type="submit"
              className="flex min-h-10 min-w-[6rem] cursor-pointer items-center justify-center gap-2 sm:min-h-11 sm:min-w-[7.5rem] rounded-l-none rounded-r-xl border-none bg-primary-dark px-6 text-base text-white transition-colors hover:bg-primary-dark/90 disabled:cursor-not-allowed disabled:opacity-70"
              disabled={searching}
            >
              {searching && <Spinner />}
              {searching ? 'Ищу…' : 'Найти'}
            </button>
          </form>
        )}
        {/* Меню выбора магазинов — под тем же гейтом, что и остальные экраны
            данных: без моста галки меняют состояние, на которое никто не
            смотрит, то есть обещали бы работу, которой нет. */}
        {window.api && (
        <>
        <div className="relative mb-1" ref={storeMenuRef}>
          <button
            ref={storeMenuBtnRef}
            className="min-h-10 cursor-pointer rounded-full border border-line bg-card px-3 py-1.5 text-[13px] text-ink sm:min-h-9 sm:px-3.5 sm:py-1.5 sm:text-sm"
            onClick={() => setStoreMenuOpen((v) => !v)}
            aria-expanded={storeMenuOpen}
            title="Выбрано магазинов сетей, где есть адаптер, из всех таких магазинов"
          >
            {/* Пока список сетей не пришёл, число неизвестно — и «6/6» было бы
                враньём, которое через кадр сменилось бы на «3/6». */}
            Магазины:{' '}
            {supportedNetworks === null
              ? '…'
              : `${supportedPoints.filter((s) => storeOn[pointKeyOf(s)] === true).length}/${supportedPoints.length}`}{' '}
            ▾
          </button>
          {storeMenuOpen && (
            <div
              className="absolute left-0 top-full z-20 mt-1 max-h-[min(24rem,60vh)] max-w-[min(26rem,92vw)]
              min-w-64 overflow-y-auto overscroll-contain rounded-xl border border-line bg-card p-2 shadow-lg"
              role="group"
              aria-label="Фильтр магазинов"
            >
              {/* СПИСОК СЕТЕЙ, а не точек. Точек у сети бывает много (у Магнита
                  в Петербурге их десятки), и двадцать строк одного магазина в
                  общем списке читались бы как двадцать магазинов. Адрес
                  выбирается отдельным списком ниже — там, где точек несколько. */}
              {supportedError && (
                <p className="mb-1 px-2 text-xs leading-relaxed text-warnline">
                  Не удалось узнать, какие сети доступны в этой сборке. Показываю
                  все сети города — опрос всё равно идёт только по тем, для которых
                  есть адаптер.
                </p>
              )}
              {unavailableNetworks.length > 0 && (
                <p className="mb-1 px-2 text-xs leading-relaxed text-muted">
                  В этой сборке нет адаптера: {unavailableNetworks.map((s) => s.name).join(', ')}.
                  Они не опрашиваются — счётчик выше считает только магазины сетей,
                  где адаптер есть.
                </p>
              )}
              {networksForCity(city).map((net) => {
                const netAvailable =
                  supportedNetworks === null || supportedNetworks.includes(net.storeId);
                const netPoints = storesForCity(city, net.storeId).filter((p) => p.ready);
                const on = netPoints.some((p) => storeOn[pointKeyOf(p)] === true);
                const locked = !netAvailable || netPoints.length === 0;
                const current = selectedNetwork === net.storeId;
                return (
                  <div
                    key={net.storeId}
                    role="button"
                    tabIndex={0}
                    aria-pressed={current}
                    onClick={() => setStoreMenuNetwork(net.storeId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setStoreMenuNetwork(net.storeId);
                      }
                    }}
                    className={
                      locked
                        ? 'flex min-h-9 cursor-not-allowed items-center gap-2 rounded-lg px-2 py-1 text-sm'
                        : `flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-cream${current ? ' bg-cream' : ''}`
                    }
                  >
                    <input
                      type="checkbox"
                      className="h-[18px] w-[18px] accent-primary"
                      checked={on && netAvailable}
                      disabled={locked}
                      onChange={(e) =>
                        setStoreOn((prev) => {
                          // Галочка на сети включает ВСЕ её точки: у сети их
                          // бывает много, и «включить сеть» должно значить
                          // «опрашивать её целиком».
                          const next = { ...prev };
                          for (const p of storesForCity(city, net.storeId)) {
                            if (!p.ready) continue;
                            next[pointKeyOf(p)] = e.target.checked;
                          }
                          return next;
                        })
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{net.name}</span>
                    <span className="tabular-nums whitespace-nowrap text-xs text-muted">
                      {netPoints.length > 1
                        ? `${netPoints.length} точек`
                        : (netPoints[0]?.externalStoreId ?? '—')}
                    </span>
                    {!netAvailable && (
                      <span className="whitespace-nowrap text-xs text-muted">(нет адаптера)</span>
                    )}
                    {netAvailable && netPoints.length === 0 && (
                      <span className="whitespace-nowrap text-xs text-muted">(скоро)</span>
                    )}
                  </div>
                );
              })}
              {/* Адреса — только того магазина, который выбран в списке выше. */}
              {addressOptions.length > 0 && (
                <div className="mt-1.5 border-t border-line px-2 pt-2">
                  <label htmlFor="store-address" className="mb-1 block text-xs text-muted">
                    Адрес магазина
                  </label>
                  <select
                    id="store-address"
                    className="min-h-10 w-full rounded-lg border border-line bg-card px-2 text-sm text-ink"
                    value={addressValue}
                    onChange={(e) => {
                      const key = e.target.value;
                      const point = addressOptions.find((p) => pointKeyOf(p) === key);
                      if (!point) return;
                      // Выбор адреса сужает выбор сети до одной точки: за
                      // «этим магазином» нельзя считать и соседний.
                      setStoreOn((prev) => {
                        const next = { ...prev };
                        for (const p of storesForCity(city, point.storeId)) {
                          if (!p.ready) continue;
                          next[pointKeyOf(p)] = pointKeyOf(p) === key;
                        }
                        return next;
                      });
                    }}
                  >
                    {addressOptions.map((p) => (
                      <option key={pointKeyOf(p)} value={pointKeyOf(p)}>
                        {pointLabel(p)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}
        </div>
        {/* Недоступность должна быть видна БЕЗ открытия меню: иначе факт «три
            сети в этой сборке не опрашиваются» известен только из раскрытого
            списка, а счётчик в кнопке молча делится на 3. */}
        {unavailableNetworks.length > 0 && (
          <p className="mb-1 text-xs leading-relaxed text-muted">
            В сборке без адаптера: {unavailableNetworks.map((s) => s.name).join(', ')} — они не
            опрашиваются.
          </p>
        )}
        {/* Браузер нужен трём сетям. Пока его нет, сказать об этом надо прямо:
            иначе Пятёрка молчит и выглядит как сломанная сеть. */}
        {browserNote && (
          <p className="mb-2 rounded-xl border border-line bg-card p-2.5 text-xs leading-relaxed">
            {browserNote}
          </p>
        )}
        {browser && !browser.installed && (
          <div className="mb-2 rounded-xl border border-line bg-card p-2.5 text-xs leading-relaxed">
            <p className="m-0">
              Пятёрка, Чижик и Перекрёсток работают через браузер, а он не установлен (около
              340 МБ). Без него эти сети не опрашиваются.
            </p>
            <button
              type="button"
              className="mt-1.5 min-h-9 cursor-pointer rounded-lg border border-line bg-cream px-2.5 py-1 text-xs text-ink disabled:cursor-not-allowed disabled:opacity-60"
              disabled={browserBusy}
              onClick={() => {
                setBrowserBusy(true);
                window.api
                  .installBrowser()
                  .then((r) => {
                    setBrowser({ installed: r.ok, message: r.message });
                    setBrowserNote(r.message);
                  })
                  .catch((e: unknown) => {
                    const text = String(e).slice(0, 200);
                    setBrowser({ installed: false, message: text });
                    setBrowserNote(text);
                  })
                  .finally(() => setBrowserBusy(false));
              }}
            >
              {browserBusy ? 'Ставлю браузер…' : 'Установить браузер'}
            </button>
            {browserBusy && (
              <p className="mt-1.5 mb-0 text-muted">
                Качайется около 340 МБ — это надолго, окно можно свернуть.
              </p>
            )}
          </div>
        )}
        </>
        )}
        <PollProgress onRunningChange={markRunning} />
        {pollMsg && (
          <div
            className={
              pollMsg.tone === 'warn'
                ? 'my-3 flex items-center gap-2 rounded-xl bg-warnbg p-2.5 pl-3.5 text-sm'
                : 'my-3 flex items-center gap-2 rounded-xl bg-okbg p-2.5 pl-3.5 text-sm'
            }
            role={pollMsg.tone === 'warn' ? 'alert' : 'status'}
          >
            <span className="min-w-0 flex-1 break-all">{pollMsg.text}</span>
            {/* Сводка опроса — фоновая вещь: она висит до следующего опроса и
                мешает, когда с ней всё понятно. Закрывается крестиком. */}
            <button
              type="button"
              className="-mr-1 min-h-8 w-8 flex-none cursor-pointer rounded-full text-muted transition-colors hover:bg-card hover:text-ink"
              onClick={() => setPollMsg(null)}
              aria-label="Скрыть сводку опроса"
            >
              ✕
            </button>
          </div>
        )}
          <p className="m-0 mb-3 text-xs leading-relaxed text-muted">
          Цены — по конкретному магазину, не «в среднем по городу»: даже соседние
          магазины одной сети могут стоять по-разному. Один и тот же товар
          в разных сетях склеивается по штрих-коду, иначе — по названию, бренду и фасовке.
        </p>

        {/* Списки категорий живут, пока пользователь на главной. Как только начат
            поиск или открыта полка — они уходят, иначе под результатами
            торчит дубль того же списка. Возвращает их «← к категориям». */}
        {/* Гейт на мост: без него экраны ниже вечно показывали бы «Загружаю…»
            (reloadLists выходит по `if (!window.api) return`, значит состояния
            вечно null), а кнопки подвала и меню магазинов — делали бы вид, что
            что-то опрашивают. На Android моста пока нет, и экран должен говорить
            ровно одно: здесь пока оболочка. */}
        {window.api && results === null && !searching && !catLoading && (
          <section aria-label="Категории товаров">
            <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Источник категорий">
              <button
                className={
                  source === 'ours'
                    ? 'min-h-10 flex-1 cursor-pointer rounded-full border border-primary bg-primary-dark px-3 py-1.5 text-[13px] text-white sm:min-h-9 sm:flex-none sm:px-3.5 sm:py-1.5 sm:text-sm'
                    : 'min-h-10 flex-1 cursor-pointer rounded-full border border-line bg-card px-3 py-1.5 text-[13px] text-ink hover:border-primary sm:min-h-9 sm:flex-none sm:px-3.5 sm:py-1.5 sm:text-sm'
                }
                onClick={() => setSource('ours')}
                aria-pressed={source === 'ours'}
              >
                <span className="sm:hidden">Категории</span>
                <span className="hidden sm:inline">Наши категории</span>
              </button>
              <button
                className={
                  source === 'stores'
                    ? 'min-h-10 flex-1 cursor-pointer rounded-full border border-primary bg-primary-dark px-3 py-1.5 text-[13px] text-white sm:min-h-9 sm:flex-none sm:px-3.5 sm:py-1.5 sm:text-sm'
                    : 'min-h-10 flex-1 cursor-pointer rounded-full border border-line bg-card px-3 py-1.5 text-[13px] text-ink hover:border-primary sm:min-h-9 sm:flex-none sm:px-3.5 sm:py-1.5 sm:text-sm'
                }
                onClick={() => setSource('stores')}
                aria-pressed={source === 'stores'}
              >
                <span className="sm:hidden">В магазинах</span>
                <span className="hidden sm:inline">Как в магазинах</span>
              </button>
              <button
                className={
                  source === 'favorites'
                    ? 'min-h-10 flex-1 cursor-pointer rounded-full border border-primary bg-primary-dark px-3 py-1.5 text-[13px] text-white sm:min-h-9 sm:flex-none sm:px-3.5 sm:py-1.5 sm:text-sm'
                    : 'min-h-10 flex-1 cursor-pointer rounded-full border border-line bg-card px-3 py-1.5 text-[13px] text-ink hover:border-primary sm:min-h-9 sm:flex-none sm:px-3.5 sm:py-1.5 sm:text-sm'
                }
                onClick={() => setSource('favorites')}
                aria-pressed={source === 'favorites'}
              >
                <span className="sm:hidden">Избранное</span>
                <span className="hidden sm:inline">Избранное{favorites.length > 0 ? ` (${favorites.length})` : ''}</span>
              </button>
            </div>
            {source === 'ours' && (
              <>
                {ourCategories === null && (
                  <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="status">
                    Загружаю наши категории…
                  </div>
                )}
                {ourError !== null && (
                  <div
                    className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted"
                    role="alert"
                  >
                    {ourError}
                    <div className="mt-2">
                      <button type="button" className="underline" onClick={() => reloadLists()}>
                        Попробовать снова
                      </button>
                    </div>
                  </div>
                )}
                {ourCategories !== null && ourCategories.length === 0 && ourError === null && (
                  <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="status">
                    Пока нет ни одной нашей категории.
                  </div>
                )}
                {realShelves.length > 0 && (
                  <>
                    {/* Пояснений под табами нет ни на мобильном, ни на
                        десктопе: «Единый список для всех сетей…», «Полка ищет
                        в 3 сетях…» и «Ни одного магазина не выбрано…» были
                        описанием интерфейса, а не данными — и занимали по
                        месту, где человек ждёт плитки полок. Из этих трёх
                        остался только ДЕЙСТВУЮЩИЙ элемент: кнопка «выбрать
                        все магазины города». Строка с ней резервируется
                        ВСЕГДА (min-h-5), иначе переключение последней галочки
                        в шапке дёргало бы сетку плиток на 20 px, а
                        переключатель магазинов находится на 600 px выше. */}
                    <div className="mb-1.5 flex min-h-5 flex-wrap items-center gap-2">
                      {selectedStores.length === 0 && (
                        <button
                          className="min-h-10 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-[13px] text-ink sm:min-h-8 sm:px-2.5 sm:text-xs"
                          onClick={() => setStoreOn(allStoresOn(city, supportedNetworks))}
                        >
                          выбрать все магазины города
                        </button>
                      )}
                    </div>
                    {/* Плоский список плиток — тем же видом, что витрина сети
                        (акцент слева, скруглённая карточка, сетка). Раньше здесь
                        был <ul> с раскрываемыми детьми; вложенность снята, и
                        список из 16 полок читается так же, как каталог магазина.

                        Иерархия полок (широкая полка и её уточнения) показывается
                        подписью в широкой плитке: «Молоко · Кефир и йогурты ·
                        Сыры · Масло». Без неё две почти одинаковые плитки рядом
                        читались как дубль, а не как полка и её подборки. */}
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2 sm:gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(140px,1fr))]">
                      {realShelves.map((c) => (
                        <button
                          key={c.id}
                          className="flex min-h-11 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-line border-l-4 border-l-primary bg-card p-2.5 text-center text-[13px] leading-snug text-ink transition-colors hover:border-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() => openOurCategory(c.id)}
                          disabled={catLoading}
                        >
                          {/* Иконка крупнее, чем в карточке товара: у витрины сети
                              в плитке фото 96px, и 32px на фоне белой карточки
                              читалось пустовато — система иконок на больших
                              размерах только чище (детали не сливаются).
                              44 px, а не 40: у «вилки» («Мясо и птица») зазоры
                              между зубцами около 1,7 px, и на 40 px зубцы
                              слипались в гребень.

                              Обёртка с фиксированной высотой и резерв под две
                              строки названия: иначе плитка с названием в одну
                              строку («Мука») поднимала иконку выше соседней с
                              названием в две («Молочное и яйца») — колонка
                              «прыгала» по вертикали. Резерв — ровно две строки
                              (13 px × leading-snug 1,375 = 35,75 px), иначе
                              плитки отличаются на пару пикселей. */}
                          <span className="flex h-11 w-full items-center justify-center">
                            <CategoryIcon id={c.id} className="h-11 w-11 flex-none" />
                          </span>
                          <span className="min-h-[2.75em] leading-snug">{c.name}</span>
                          {/* Число запросов остаётся: после снятия вложенности
                              это единственный сигнал, что полка широкая и клик
                              по ней дорогой (8 сетевых запросов). */}
                          <span className="text-xs font-normal text-muted">{queriesPhrase(c.queryCount)}</span>
                          {subShelvesOf(c.id).length > 0 && (
                            <span className="text-[11px] leading-tight text-muted">
                              {subShelvesOf(c.id).map((s) => s.name).join(' · ')}
                            </span>
                          )}
                        </button>
                      ))}
                      {/* Уточнения широких полок — своими плитками, сразу под
                          всеми широкими: так видно, что «Молоко» — часть
                          «Молочного и яиц», а не вторая такая же полка. */}
                      {subShelves.map((c) => (
                        <button
                          key={c.id}
                          className="flex min-h-11 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-line border-l-4 border-l-primary/40 bg-card p-2.5 text-center text-[13px] leading-snug text-ink transition-colors hover:border-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() => openOurCategory(c.id)}
                          disabled={catLoading}
                        >
                          <span className="flex h-11 w-full items-center justify-center">
                            <CategoryIcon id={c.id} className="h-11 w-11 flex-none" />
                          </span>
                          <span className="min-h-[2.75em] leading-snug">{c.name}</span>
                          <span className="text-xs font-normal text-muted">{queriesPhrase(c.queryCount)}</span>
                          <span className="text-[11px] leading-tight text-muted">
                            часть «{parentNameOf(c.id)}»
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {virtualShelf && (
                  <div className="mt-2 flex items-center gap-3 rounded-2xl border border-warnline bg-warnbox px-3 py-2">
                    <CategoryIcon id={virtualShelf.id} className="h-6 w-6 flex-none sm:h-9 sm:w-9" accent />
                    <button
                      className="min-w-0 flex-1 cursor-pointer text-left text-sm text-ink transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => openOurCategory(virtualShelf.id)}
                      disabled={catLoading}
                    >
                      {virtualShelf.name} <span className="text-muted">— товары вне наших полок</span>
                    </button>
                  </div>
                )}
              </>
            )}
            {source === 'stores' && (
              <>
            {catalog === null && (
              <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="status">
                Загружаю категории каталога…
              </div>
            )}
          {catalog !== null && catalog.every((s) => s.categories.length === 0) && (catalogListError !== null || catalog.some((s) => s.error)) && (
            <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="alert">
              {catalogListError ??
                catalog
                  .map((s) => s.error)
                  .find((e) => e) ??
                'Попробуй поиск выше.'}
              <div className="mt-2">
                <button type="button" className="underline" onClick={() => reloadLists()}>
                  Попробовать снова
                </button>
              </div>
            </div>
          )}
          {catalog !== null &&
            catalog.some((s) => s.categories.length > 0) &&
            catalog.every((s) => storeOn[pointKey(s.storeId, s.storeCode)] !== true) && (
              <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="status">
                Все магазины выключены в фильтре «Магазины» — включи хотя бы один: с пустым
                  выбором не опрашивается ни один магазин, и приложение молчит.
              </div>
            )}
            {(catalog ?? []).map(
              (s) =>
                storeOn[pointKey(s.storeId, s.storeCode)] === true &&
                s.categories.length > 0 && (
                  <div key={pointKey(s.storeId, s.storeCode)}>
                    {/* Сетка разделов у Магнита и Пятёрки — это 40–80 плиток на
                        сеть. Свернутый блок оставляет на экране список сетей
                        и одну строку на каждую: иначе до Ленты с её 1400
                        разделов нельзя было добраться, не прокрутив пол-экрана
                        чужих плиток. Кнопка лежит внутри <h2>, а не наоборот:
                        <button> по стандарту содержит только phrasing content,
                        а <h2> — flow, и вне заголовка навигация скринридера по
                        сетям в этом разделе заканчивалась на h1. */}
                    <h2 className="m-0">
                      <button
                        className="mt-5 flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-xl border border-line bg-card px-3.5 py-2 text-left transition-colors hover:border-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
                        aria-expanded={storeOpen[pointKey(s.storeId, s.storeCode)] !== false}
                        aria-controls={`cat-panel-${pointKey(s.storeId, s.storeCode).replace(':', '-')}`}
                        onClick={() =>
                          setStoreOpen((prev) => ({
                      ...prev,
                      [pointKey(s.storeId, s.storeCode)]:
                        prev[pointKey(s.storeId, s.storeCode)] === false,
                    }))
                        }
                      >
                        <Chevron open={storeOpen[pointKey(s.storeId, s.storeCode)] !== false} />
                        <span className="flex-1 text-base font-semibold">{resultPointLabel(s)}</span>
                        <span className="text-xs font-normal text-muted tabular-nums">
                          {sectionsPhrase(s.categories.length)}
                        </span>
                      </button>
                    </h2>
                    {storeOpen[pointKey(s.storeId, s.storeCode)] !== false && (
                      <div
                        id={`cat-panel-${pointKey(s.storeId, s.storeCode).replace(':', '-')}`}
                        className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2 sm:gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(140px,1fr))]"
                      >
                        {s.categories.map((c) => (
                          <button
                            key={c.id}
                            className="flex min-h-11 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-line border-l-4 border-l-primary bg-card p-2.5 text-center text-[13px] leading-snug text-ink transition-colors hover:border-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
                            onClick={() => openCategory(c.url)}
                          >
                            {c.imageUrl && (
                              <img
                                src={c.imageUrl}
                                alt=""
                                loading="lazy"
                                // Плитка картинки раздела — КВАДРАТ 80×80 и
                                // `object-contain`, и это не вкусовое решение, а
                                // проверка живых данных 2026-11-11:
                                //   - Магнит: 7 из 8 разделов отдают квадрат
                                //     192×192 png, «Алкоголь» — баннер 464×192;
                                //   - Светофор: квадратные SVG-иконки разделов.
                                // Прежняя плитка была `h-24 w-full` + object-cover
                                // («картинки у Магнита вертикальные 318×384» —
                                // утверждение из ранней разведки, сетью давно не
                                // подтверждается). В широкой низкой плитке квадрат
                                // срезался object-cover больше чем наполовину по
                                // высоте: у «Молочного» оставалась только крышка
                                // банки. Сайт при этом ничего не менял — ломала
                                // вёрстка.
                                // `object-contain` единым правилом и для квадрата,
                                // и для баннера, и для вектора: квадрат ложится
                                // вплотную, широкое изображение просто не
                                // обрезается. Правило по расширению файла
                                // (`isSvgIcon`) для этого не нужно и удалено.
                                className="h-16 w-16 rounded-lg bg-cream object-contain p-1 sm:h-20 sm:w-20"
                                onError={(e) => {
                                  e.currentTarget.style.display = 'none';
                                }}
                              />
                            )}
                            <span>{c.name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ),
                )}
              </>
            )}
            {source === 'favorites' && (
              <div className="mt-3">
                {/* Откат разрывов. Отметка «это разные товары» необратима была:
                    кнопка existed, а снять её было нечем, и ошибка оставалась
                    навсегда даже когда товары перестали путаться. */}
                {splits.size > 0 && (
                  <details className="mb-3 rounded-xl border border-line bg-card p-3 text-sm">
                    <summary className="cursor-pointer text-muted">
                      Разделено товаров: {splits.size} {splits.size === 1 ? 'пара' : 'пар'} (по всем городам)
                    </summary>
                    <ul className="mt-2 flex flex-col gap-1.5">
                      {[...splits].sort().map((key) => {
                        // parseSplitKey бросает на неразбираемом ключе, а
                        // error-boundary в renderer нет: throw здесь снёс бы
                        // дерево в пустое окно.
                        const pair = parseSplitKey(key);
                        if (!pair) return null;
                        const [a, b] = pair;
                        return (
                          <li key={key} className="flex flex-wrap items-center justify-between gap-2">
                            <span className="min-w-0 truncate text-xs text-muted">
                              {nameOf(a)} ↔ {nameOf(b)}
                            </span>
                            <button
                              className="min-h-8 flex-none cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-ink disabled:opacity-60"
                              disabled={splitBusy === key}
                              onClick={() => void undoSplit(key)}
                            >
                              {splitBusy === key ? 'возвращаю…' : 'снова один товар'}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                )}
                {favorites.length === 0 ? (
                  <div role="status" className="rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted">
                    Пока пусто. Нажми ★ у цены в любой карточке — товар попадёт сюда,
                    а целевая цена добавит уведомление о снижении.
                  </div>
                ) : (
                  <>
                    <p className="mb-3 text-xs text-muted">
                      {favorites.length} {favorites.length === 1 ? 'товар' : 'товаров'}. Цена — последняя,
                      которую записал опрос; целевая сработает, когда сеть отдаст ниже.
                    </p>
                    <section className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-3" aria-label="Избранные товары">
                      {favorites.map((f) => {
                        const fkey = favKey(f.canonicalId, f.storeId, f.city, f.storeCode);
                        const hit = f.targetPrice !== null && f.price !== null && f.price < f.targetPrice;
                        return (
                          <article key={fkey} className="rounded-2xl border border-line bg-card p-4">
                            <h2 className="mb-1 mt-0 text-base font-semibold leading-snug">{f.name}</h2>
                            <div className="flex items-baseline justify-between gap-2 text-sm">
                              <span className="text-muted">
                                {/* Отметка принадлежит точке, значит и подпись у неё
                                    точечная: два отмеченных товара одной сети в разных
                                    магазинах не должны называться одинаково. Подпись
                                    берётся той же функцией, что и в выдаче, — иначе
                                    перенесённый товар в двух местах назывался бы
                                    по-разному. */}
                                {offerPointLabel(f.storeId, f.storeCode)}
                              </span>
                              <span className="tabular-nums">
                                {f.price === null ? (
                                  <span className="text-muted">цены пока нет</span>
                                ) : (
                                  <span className="text-lg font-bold">{formatPrice(f.price)}</span>
                                )}
                              </span>
                            </div>
                            <label className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                              сообщить при цене ниже
                              <input
                                type="number"
                                inputMode="decimal"
                                min="0.01"
                                step="0.01"
                                className="w-24 min-h-8 rounded-lg border border-line bg-card px-2 py-1 text-sm text-ink"
                                placeholder="без порога"
                                aria-label={`Целевая цена: ${f.name}`}
                                value={targetDraft[fkey] ?? (f.targetPrice === null ? '' : String(f.targetPrice))}
                                onChange={(e) => setTargetDraft((prev) => ({ ...prev, [fkey]: e.target.value }))}
                                onBlur={() => {
                                  const raw = targetDraft[fkey];
                                  if (raw === undefined || raw.trim() === '') return;
                                  const parsed = Number(raw.replace(',', '.'));
                                  setTargetDraft((prev) => {
                                    const next = { ...prev };
                                    delete next[fkey];
                                    return next;
                                  });
                                  if (!Number.isFinite(parsed) || parsed <= 0) return;
                                  void setTargetPrice(f.canonicalId, f.storeId, f.city, f.storeCode, parsed);
                                }}
                              />
                              ₽
                            </label>
                            {hit && f.targetPrice !== null && (
                              <p className="mt-2 text-xs font-medium text-primary-dark" role="status">
                                Цель достигнута: {formatPrice(f.price ?? 0)} ниже {formatPrice(f.targetPrice)}
                              </p>
                            )}
                            <button
                              className="mt-2 min-h-8 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-ink disabled:opacity-60"
                              disabled={favBusy === fkey}
                              onClick={() => void toggleFavorite(f.canonicalId, f.storeId, f.city, f.storeCode)}
                            >
                              снять отметку
                            </button>
                          </article>
                        );
                      })}
                    </section>
                  </>
                )}
              </div>
            )}
          </section>
        )}

        {/* Кнопка возврата нужна и пока полка грузится: списки на это время убраны,
            и без неё пользователь сидит перед «Загружаю…» до ответа сети. */}
        {(results !== null || catLoading || searching) && (
          <p className="my-2">
            <button
              className="min-h-10 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-[13px] text-ink sm:min-h-8 sm:px-2.5 sm:text-xs"
              onClick={backToCategories}
            >
              ← к категориям
            </button>
          </p>
        )}

{/* Списки убраны на время поиска, поэтому без этого блока между интро
            и подвалом остаётся пустое место. Показываем карточки той же высоты,
            что и настоящие: приход данных не сдвигает карточки. Скелет ОДИН на
            оба состояния — раньше `searching` и `catLoading` рисовались рядом
            при быстром «открыл полку → тут же ищет», и пользователь получал
            две сетки пустышек и два live-объявления одного и того же ожидания. */}
        {(searching || catLoading) && (
          <div className="mt-3">
            <SkeletonCards label={searching ? 'Ищу товары' : 'Загружаю товары категории'} />
          </div>
        )}
        {catError && (
          <div
            className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted"
            role={catError.kind === 'error' ? 'alert' : 'status'}
          >
            {catError.text}
          </div>
        )}
        {/* Ошибка правки избранного/разрыва — отдельно от ошибок выдачи:
            она относится к действию, а не к сети. */}
        {favError && (
          <div
            className="mt-3 rounded-xl border border-dashed border-line bg-card p-4 text-sm text-muted"
            role="alert"
          >
            {favError}{' '}
            <button
              className="min-h-10 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-[13px] text-ink sm:min-h-8 sm:px-2.5 sm:text-xs"
              onClick={() => setFavError(null)}
            >
              скрыть
            </button>
          </div>
        )}
        {groups && (
          <p className="m-0 mb-4 text-xs text-muted" aria-live="polite">
            {/* Число найденного объявляется здесь же: строка сетей ниже
                сообщает только о состоянии запросов, и по ней нельзя понять,
                пришли товары или нет. Считаем groups.length, а не rawCount:
                rawCount — это позиции по сетям до склейки, и один товар в трёх
                магазинах дал бы «120 товаров» при 40 карточках на экране. */}
            {/* Только ВЫБРАННЫЕ сети: при «Магазины: 1/5» строка не должна
                перечислять ошибки сетей, которые выключены и в опрос не идут.
                Список считается заранее (`onStores`): при нуле выбранных сетей
                `join` даёт пустую строку, и после «Найдено 120 товаров · »
                висел разделитель. Пустое состояние выдачи ниже ветвится по
                тому же множеству — иначе оно blames «фильтры», когда виновата
                конкретная сеть, а не фильтр. */}
            {(() => {
              const onStores = groups.stores.filter((s) => blockVisible(s.storeId, s.storeCode));
              if (groups.rawCount === 0 && onStores.length === 0) return null;
              return (
                <>
                  {groups.rawCount > 0 &&
                    `Найдено ${plural(groups.groups.length, 'товар', 'товара', 'товаров')}${
                      groups.groups.length < groups.allCount ? ` из ${groups.allCount}` : ''
                    }`}
                  {groups.rawCount > 0 && onStores.length > 0 && ' · '}
                  {onStores
                    .map((s) =>
                      s.ready && !s.error
                        ? `${resultPointLabel(s)}: ${
                            s.storeCode === UNKNOWN_STORE_CODE
                              ? 'перенесённые цены'
                              : s.cached
                                ? 'из локальной базы'
                                : 'опрошен'
                          }`
                        : s.error
                          ? `${resultPointLabel(s)}: ошибка (${s.error.slice(0, 80)})`
                          : `${resultPointLabel(s)}: скоро`,
                    )
                    .join(' · ')}
                </>
              );
            })()}
          </p>
        )}

        {groups && groups.groups.length === 0 && groups.rawCount > 0 && (
          <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="status">
            {(() => {
              // Причину называем по ИМЕННОГО множества, по которому фильтруем:
              // «ничего не выбрано» и «выбранная сеть ничего не вернула» — разные
              // ситуации, и кнопка сброса во втором случае была мёртвой.
              const onStores = groups.stores.filter((s) => blockVisible(s.storeId, s.storeCode));
              if (onStores.length === 0) {
                return (
                  <>
                    Ни одного магазина не выбрано — показывать нечего.{' '}
                    <button
                      className="min-h-10 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-[13px] text-ink sm:min-h-8 sm:px-2.5 sm:text-xs"
                      onClick={() => setStoreOn(allStoresOn(city, supportedNetworks))}
                    >
                      выбрать все магазины города
                    </button>
                  </>
                );
              }
              const silent = onStores.filter((s) => s.items.length === 0 && !s.error);
              if (silent.length > 0) {
                // Подпись та же, что и в строке статуса: один магазин не должен называться в
                // двух местах двумя именами.
                return (
                  <>
                    {silent.length === 1 && silent[0] ? resultPointLabel(silent[0]) : 'Выбранные магазины'}{' '}
                    не вернули товаров по этому запросу. Включи в фильтре «Магазины» другой
                    магазин или попробуй другой запрос.
                  </>
                );
              }
              return (
                <>
                  Всё скрыто фильтрами.{' '}
                  <button
                    className="min-h-10 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-[13px] text-ink sm:min-h-8 sm:px-2.5 sm:text-xs"
                    onClick={() => {
                      // Возвращаем РАБОЧЕЕ состояние: магазины — те же, что были
                      // выбраны, а гасятся только промо/наличие/сортировка и
                      // границы отбора. Раньше здесь стояло «снять выбор
                      // магазинов», и на пустом выборе кнопка была
                      // саморазрушительной: жал и оставался с тем же пустым
                      // экраном, только ещё и без запросов.
                      setPromoOnly(false);
                      setStockOnly(false);
                      setSort('none');
                      setPriceDraft({ from: '', to: '' });
                      setMinStores(1);
                    }}
                  >
                    сбросить фильтры
                  </button>
                </>
              );
            })()}
          </div>
        )}
        {searchError && (
          <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="alert">
            Поиск не удался: {searchError.slice(0, 200)}
          </div>
        )}
        {groups && groups.groups.length === 0 && groups.rawCount === 0 && !catLoading && !searchError && !catError && (
          <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="status">
            {query.trim()
              ? `По запросу «${query.trim()}» ничего не нашлось. Проверь название или попробуй позже — сети иногда отвечают с задержкой.`
              : 'Категория пуста — выбери другую.'}
          </div>
        )}

        {/* Фильтры выдачи.

            На телефоне панель переносится в несколько строк компактными чипами:
            так помещаются все фильтры сразу, и ничего не уезжает за край. Раньше
            здесь был горизонтальный скролл, но при ширине 336px он обрезал
            половину («без сортировки» превращалось в «без…») и прятал самые
            нужные поля цены. На широком экране — прежний ряд с прежними
            размерами. */}
        {groups && groups.rawCount > 0 && (
          <div className="-mx-3 px-3 sm:mx-0 sm:px-0">
            <div className="mb-3 rounded-xl border border-line bg-card px-3 py-2 sm:border-0 sm:bg-transparent sm:p-0">
            <div
              role="group"
              aria-label="Фильтры выдачи"
              className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm sm:gap-3"
            >
            {/* Точки в ленте — только на широком экране. На телефоне подписи
                скрываются (пять точек по ~215px в ленте шириной 336px показывали
                полторы галочки), а без подписей ряд голых флажков выглядит как
                сломанный интерфейс. Выбор точек на мобильном живёт в меню шапки
                («Магазины: N/M») — там крупные строки с адресом. */}
            <div className="hidden sm:contents">
            {groups.stores.map((s) =>
              // Блок перенесённых цен ('?') галочкой не управляется: у него нет
              // точки в справочнике, и запись в localStorage по ключу 'network:?'
              // была бы мусором, который readStores на следующем кадре отбросит.
              // Он виден, пока выбрана хоть одна точка этой сети.
              s.storeCode === UNKNOWN_STORE_CODE ? (
                <span
                  key={pointKey(s.storeId, s.storeCode)}
                  className="flex min-h-9 items-center gap-1.5"
                >
                  {resultPointLabel(s)}
                </span>
              ) : (
                <label key={pointKey(s.storeId, s.storeCode)} className="flex min-h-11 cursor-pointer items-center gap-1.5 sm:min-h-9">
                  <input
                    type="checkbox"
                    className="h-[18px] w-[18px] accent-primary"
                    // Подпись видима на широком экране, а на телефоне весь блок
                    // точек скрыт — но имя флажку задаём в любом случае: без него
                    // скринридер читал бы безымянный «флажок».
                    aria-label={`Фильтр по магазину: ${resultPointLabel(s)}`}
                    checked={storeOn[pointKey(s.storeId, s.storeCode)] === true}
                    disabled={!s.ready}
                    onChange={(e) =>
                      setStoreOn((prev) => ({ ...prev, [pointKey(s.storeId, s.storeCode)]: e.target.checked }))
                    }
                  />
                  {/* Подпись та же функция, что и в шапке: один магазин не должен
                      называться в двух местах двумя разными именами. */}
                  {resultPointLabel(s)}
                </label>
              ),
            )}
            </div>
            <label className="flex min-h-10 cursor-pointer items-center gap-1.5 rounded-lg bg-cream px-2 text-[13px] sm:min-h-9 sm:bg-transparent sm:px-0 sm:text-sm">
              <input type="checkbox" className="h-4 w-4 accent-primary sm:h-[18px] sm:w-[18px]" checked={promoOnly} onChange={(e) => setPromoOnly(e.target.checked)} />
              Только со скидкой
            </label>
            <label className="flex min-h-10 cursor-pointer items-center gap-1.5 rounded-lg bg-cream px-2 text-[13px] sm:min-h-9 sm:bg-transparent sm:px-0 sm:text-sm">
              <input type="checkbox" className="h-4 w-4 accent-primary sm:h-[18px] sm:w-[18px]" checked={stockOnly} onChange={(e) => setStockOnly(e.target.checked)} />
              В наличии
            </label>
            <label className="flex min-h-10 cursor-pointer items-center gap-1.5 rounded-lg bg-cream px-2 text-[13px] sm:min-h-9 sm:bg-transparent sm:px-0 sm:text-sm">
              <span className="text-muted sm:hidden">Сорт.</span>
              <span className="hidden sm:inline">Сортировка</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as 'none' | 'asc' | 'desc')} className="min-h-9 rounded-lg border border-line bg-card px-1.5 py-1 text-[13px] text-ink sm:min-h-9 sm:px-2.5 sm:py-1.5 sm:text-sm">
                <option value="none">без сортировки</option>
                <option value="asc">сначала дешевле</option>
                <option value="desc">сначала дороже</option>
              </select>
            </label>
            {/* Цена и число сетей — один элемент строки, а не три: иначе «от»
                уехал бы в конец первой строки, а «до» — в начало второй. */}
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5" role="group" aria-label="Фильтр по цене">
                <span className="text-muted">Цена</span>
                {/* Поля денежные, поэтому type="text" + inputMode="decimal", а НЕ type="number".
                    Причины конкретные: Chromium санитизирует значение number до
                    «валидного float», и русское «100,50» превращается в пустое
                    поле с хвостом «50» — человек увидел бы «50» и получил бы
                    фильтр «до 50». `numeric` на мобильной клавиатуре вообще не
                    даёт запятой (Фаза 7 — Android). Колесо мыши над полем тоже
                    меняло бы границу вместо прокрутки ленты. */}
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label="Цена от, в рублях"
                  aria-invalid={priceRangeBroken || undefined}
                  placeholder="от"
                  value={priceDraft.from}
                  onChange={(e) => setPriceDraft((prev) => ({ ...prev, from: e.target.value }))}
                  onWheel={(e) => e.currentTarget.blur()}
                  className="min-h-9 w-14 rounded-lg border border-line bg-card px-1.5 py-1 text-[13px] text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary sm:min-h-9 sm:w-20 sm:px-2 sm:text-sm"
                />
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label="Цена до, в рублях"
                  aria-invalid={priceRangeBroken || undefined}
                  placeholder="до"
                  value={priceDraft.to}
                  onChange={(e) => setPriceDraft((prev) => ({ ...prev, to: e.target.value }))}
                  onWheel={(e) => e.currentTarget.blur()}
                  className="min-h-9 w-14 rounded-lg border border-line bg-card px-1.5 py-1 text-[13px] text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary sm:min-h-9 sm:w-20 sm:px-2 sm:text-sm"
                />
              </div>
              {/* Подписью, а не подсказкой: тултип на десктопе не читается, а
                  placeholder как единственная подпись — антипаттерн форм.
                  Здесь же главное неочевидное правило: цена карточки —
                  минимальная по сетям, поэтому «до 100» пропустит товар, у
                  которого в одной сети 90, а в другой 400.

                  Постоянная подсказка на телефоне не помещается в три ряда чипов
                  и потому скрыта. ОШИБКА границ — наоборот, видна всегда и в
                  `role="status"`: прятать её вместе с подсказкой нельзя, иначе
                  на узком экране человек увидит «всё скрыто фильтрами» и не
                  поймёт, что перепутал «от» и «до». */}
              {priceRangeBroken ? (
                <p role="status" className="m-0 text-xs text-warnline">
                  «от» больше, чем «до» — проверь границы
                </p>
              ) : (
                <p className="m-0 hidden text-xs text-muted sm:block">
                  цена — минимальная по сетям
                </p>
              )}
            </div>
            <label className="flex min-h-10 cursor-pointer items-center gap-1.5 rounded-lg bg-cream px-2 text-[13px] sm:min-h-9 sm:bg-transparent sm:px-0 sm:text-sm">
              <span className="text-muted sm:hidden">Сети</span>
              <span className="hidden sm:inline">Найдено в сетях</span>
              {/* Верхняя граница — число СЕТЕЙ, которые реально ответили и были
                  готовы к опросу: `ready: false` в списке есть, но их не
                  спрашивали, и предлагать «в 6 сетях» при двух отвечавших —
                  значит гарантировать пустую выдачу. */}
              <select
                value={minStores}
                onChange={(e) => setMinStores(Number(e.target.value))}
                aria-label="Минимум сетей, где нашёлся товар"
                className="min-h-9 rounded-lg border border-line bg-card px-1.5 py-1 text-[13px] text-ink sm:min-h-9 sm:px-2.5 sm:py-1.5 sm:text-sm"
              >
                <option value={1}>в любой</option>
                {Array.from({ length: Math.max(0, (readyStoresInResults ?? 1) - 1) }, (_, i) => i + 2).map((n) => (
                  <option key={n} value={n}>
                    в {n} и более
                  </option>
                ))}
              </select>
            </label>
            </div>
            </div>
          </div>
        )}

        {groups && groups.groups.length > 0 && (
          <section
            ref={resultsRef}
            tabIndex={-1}
            aria-busy={searching || catLoading}
            aria-label={`Найденные товары, страница ${pageNo} из ${pageCount}`}
            className="grid scroll-mt-20 grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-3 focus-visible:outline-2 focus-visible:outline-primary"
          >
            {pagedGroups.map((g) => (
              <article key={g.key} className="rounded-2xl border border-line bg-card p-4">
                <ProductImage src={g.imageUrl} name={g.name} />
                <h2 className="mb-2 mt-1 text-base font-semibold leading-snug">{g.name}</h2>
                {/* Агрегат карточки. При нескольких точках одна цифра была бы
                    враньём: у двух магазинов одной сети цены разные, и шапка
                    обязана сказать «от … до …» и сколько точек в карточке. */}
                {(() => {
                  const range = groupPriceRange(g);
                  if (range.points < 2) return null;
                  // Диапазон цен честен только когда в карточке ОДИН товар в
                  // разных точках. Склейка идёт по названию/бренду/фасовке, и
                  // две точки с разными фасовками дают карточку с двумя разными
                  // товарами — «от … до …» тогда сравнивает несравнимое.
                  const oneProduct = new Set(g.offers.map((o) => o.product.canonicalId)).size === 1;
                  return (
                    <p className="mb-1 text-sm text-muted">
                      {oneProduct && range.min !== range.max
                        ? `от ${formatPrice(range.min)} до ${formatPrice(range.max)}`
                        : null}
                      {oneProduct ? ' · ' : ''}
                      {plural(range.points, 'точка', 'точки', 'точек')}
                    </p>
                  );
                })()}
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <button
                    className="min-h-10 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-[13px] text-ink sm:min-h-8 sm:px-2.5 sm:text-xs"
                    onClick={() => openDetail(g.key)}
                  >
                    Подробнее
                  </button>
                  {/* Кнопка только когда в карточке есть что разделять. Две точки одной сети
                      дают один и тот же sku, то есть разводить нечего, и такая
                      кнопка всегда падала бы с отказом. */}
                  {splitPairsOf(g).length > 0 && (
                    <button
                      className="min-h-10 cursor-pointer rounded-lg border border-warnline bg-warnbox px-2.5 py-1 text-[13px] text-ink disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-8 sm:px-2 sm:text-xs"
                      onClick={() => void splitGroup(g)}
                      disabled={splitBusy === g.key}
                    >
                      {splitBusy === g.key ? 'разделяю…' : 'это разные товары'}
                    </button>
                  )}
                </div>
                {g.offers.map((o) => {
                  const effective = o.product.promoPrice ?? o.product.price;
                  const struck = o.product.oldPrice ?? (o.product.promoPrice != null ? o.product.price : null);
                  const hkey = histKey(o.product.canonicalId, o.storeId, city, o.product.storeCode);
                  const fkey = favKey(o.product.canonicalId, o.storeId, city, o.product.storeCode);
                  const faved = isFav(o.product.canonicalId, o.storeId, city, o.product.storeCode);
                  const target = favTarget(o.product.canonicalId, o.storeId, city, o.product.storeCode);
                  return (
                    <div key={hkey}>
                      <div className="flex items-baseline justify-between gap-2 border-t border-line py-1.5 text-sm first:border-t-0">
                          <span className="min-w-0 truncate text-muted">{offerPointLabel(o.storeId, o.product.storeCode)}</span>
                        <span className="tabular-nums">
                          {struck !== null && struck !== undefined && (
                            <span className="mr-1.5 text-[13px] text-muted line-through">{formatPrice(struck)}</span>
                          )}
                          <span className="whitespace-nowrap text-lg font-bold">{formatPrice(effective)}</span>{' '}
                          <button
                            className="min-h-10 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-[13px] text-ink sm:min-h-8 sm:px-2.5 sm:text-xs"
                            onClick={() =>
                              toggleHist(hkey, {
                                canonicalId: o.product.canonicalId,
                                storeId: o.storeId,
                                city,
                                storeCode: o.product.storeCode,
                              })
                            }
                          >
                            {openHist === hkey ? 'скрыть' : 'история'}
                          </button>
                          <button
                            className={`relative ml-1 aspect-square min-h-10 min-w-10 cursor-pointer rounded-lg border px-2 py-1 text-[13px] after:absolute after:-inset-1 after:content-[''] sm:min-h-8 sm:min-w-8 sm:px-2 sm:text-xs sm:after:hidden ${
                              faved ? 'border-primary bg-primary-dark text-white' : 'border-line bg-card text-ink'
                            } disabled:cursor-not-allowed disabled:opacity-60`}
                            aria-pressed={faved}
                            aria-label={
                              faved
                                ? `Убрать «${o.product.name}» из избранного`
                                : `Добавить «${o.product.name}» в избранное`
                            }
                            disabled={favBusy === fkey}
                            onClick={() => void toggleFavorite(o.product.canonicalId, o.storeId, city, o.product.storeCode)}
                          >
                            {faved ? '★' : '☆'}
                          </button>
                        </span>
                      </div>
                      {/* Порог уведомления виден только у отмеченного товара:
                          неотмеченной ценеtarget неоткуда взять. */}
                      {faved && (
                        <label className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                          сообщить при цене ниже
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0.01"
                            step="0.01"
                            className="w-24 min-h-8 rounded-lg border border-line bg-card px-2 py-1 text-sm text-ink"
                            placeholder="без порога"
                            value={targetDraft[fkey] ?? (target === null ? '' : String(target))}
                            onChange={(e) => setTargetDraft((prev) => ({ ...prev, [fkey]: e.target.value }))}
                            onBlur={() => {
                              const raw = targetDraft[fkey];
                              if (raw === undefined || raw.trim() === '') return;
                              const parsed = Number(raw.replace(',', '.'));
                              // Ключ УДАЛЯЕМ, а не пишем '': пустая строка не
                              // nullish, поэтому `draft ?? saved` перестал бы
                              // подставлять сохранённый порог и поле
                              // пустовало бы до конца сессии — восстановить
                              // цену без перезапуска было бы нельзя.
                              setTargetDraft((prev) => {
                                const next = { ...prev };
                                delete next[fkey];
                                return next;
                              });
                              // Мусор в поле не портит порог: без проверки
                              // Number('abc') дал бы NaN, и он ушёл бы в БД.
                              if (!Number.isFinite(parsed) || parsed <= 0) return;
                              void setTargetPrice(o.product.canonicalId, o.storeId, city, o.product.storeCode, parsed);
                            }}
                          />
                          ₽
                        </label>
                      )}
                      {openHist === hkey &&
                        (histLoading[hkey] === true ? (
                          <p className="mt-1 text-xs text-muted" role="status">
                            Загружаю историю…
                          </p>
                        ) : hist[hkey] === 'error' ? (
                          <p className="mt-1 text-xs text-muted" role="alert">
                            Не удалось загрузить историю.{' '}
                            <button
                              className="min-h-10 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-[13px] text-ink sm:min-h-8 sm:px-2.5 sm:text-xs"
                              onClick={() =>
                                fetchHist(hkey, {
                                  canonicalId: o.product.canonicalId,
                                  storeId: o.storeId,
                                  city,
                                storeCode: o.product.storeCode,
                                })
                              }
                            >
                              повторить
                            </button>
                          </p>
                        ) : (
                          <HistoryChart points={hist[hkey] ?? []} />
                        ))}
                    </div>
                  );
                })}
              </article>
            ))}
          </section>
        )}

        {/* Счётчик «показано 1–24 из 130» стоит под сеткой, а не над ней: он
            описывает уже показанное, и сверху он отнимал бы место у первого
            ряда карточек. Без него непонятно, что сетка не обрезана. Кнопки
            «в начало/в конец» нужны на длинных полках, где до последней
            страницы двадцать нажатий «вперёд». */}
        {groups && pageCount > 1 && (
          <nav
            className="mt-4 flex flex-wrap items-center justify-center gap-2 text-sm"
            aria-label="Страницы товаров"
          >
            <button
              className="min-h-11 cursor-pointer rounded-lg border border-line bg-card px-3 py-1.5 text-sm text-ink sm:min-h-9 sm:text-xs focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => goPage(1)}
              disabled={pageNo === 1}
            >
              в начало
            </button>
            <button
              className="min-h-11 cursor-pointer rounded-lg border border-line bg-card px-3 py-1.5 text-sm text-ink sm:min-h-9 sm:text-xs focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => goPage(pageNo - 1)}
              disabled={pageNo === 1}
            >
              ← назад
            </button>
            <span className="px-1 tabular-nums text-muted" aria-live="polite">
              Страница {pageNo} из {pageCount}
            </span>
            <button
              className="min-h-11 cursor-pointer rounded-lg border border-line bg-card px-3 py-1.5 text-sm text-ink sm:min-h-9 sm:text-xs focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => goPage(pageNo + 1)}
              disabled={pageNo === pageCount}
            >
              вперёд →
            </button>
            <button
              className="min-h-11 cursor-pointer rounded-lg border border-line bg-card px-3 py-1.5 text-sm text-ink sm:min-h-9 sm:text-xs focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => goPage(pageCount)}
              disabled={pageNo === pageCount}
            >
              в конец
            </button>
            <span className="w-full text-center text-xs text-muted tabular-nums">
              показано {(pageNo - 1) * PAGE_SIZE + 1}–{Math.min(pageNo * PAGE_SIZE, groups.groups.length)} из {groups.groups.length}
            </span>
          </nav>
        )}

        {/* Сетка, а не flex с justify-between: текст опроса меняет длину
            («(добавлено 1, без изменений 22)»), и при flex кнопка «Опросить
            сейчас» уезжала вбок на 40+ пикселей — футер «танцевал». Первая
            колонка забирает всю свободную ширину, остальные стоят на месте. */}
        {/* Подвал живёт ПОСЛЕ контентной обёртки, а не внутри неё: липкий
            элемент держится в рамках своего родителя, и внутри обёртки он
            уезжал вместе с контентом (а `mt-auto` в блочном контейнере не
            работает вовсе). На телефоне пять колонок в 411px дают кашу из
            обрезков, поэтому там — две строки: сплошной текст сверху, кнопки и
            версия снизу, с крупными тап-зонами. На широком экране — прежняя
            сетка.

            Гейт на мост: без preload/IPC кнопка «Опросить сейчас» и строка про
            IPC обещали бы работу, которой нет. На Android оболочка пока без ядра,
            и подвал с «опросом» был бы враньём. */}
        {detailKey !== null &&
          (() => {
            const g = groups?.groups.find((x) => x.key === detailKey);
            if (!g) return null;
            const first = g.offers[0]?.product;
            return (
              <div
                className="fixed inset-0 z-30 overflow-y-auto bg-ink/60 p-3 sm:p-4"
                role="dialog"
                aria-modal="true"
                aria-label={g.name}
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) setDetailKey(null);
                }}
              >
                {/* На телефоне карточка товара идёт почти во всю ширину экрана:
                    поля 24px при 411px — это шестая часть полезной площади. */}
                <div className="mx-auto my-4 max-w-2xl rounded-2xl bg-card p-4 sm:my-8 sm:p-6">
                  <div className="mb-4 flex items-start justify-between gap-4">
                    <h2 className="m-0 text-xl font-bold">{g.name}</h2>
                    <button
                      ref={closeBtnRef}
                      className="min-h-11 min-w-11 flex-none cursor-pointer rounded-full border border-line bg-card px-3.5 sm:min-h-9 sm:min-w-0 py-1.5 text-sm"
                      onClick={() => setDetailKey(null)}
                      aria-label="Закрыть"
                    >
                      ✕
                    </button>
                  </div>
                  <ProductImage src={g.imageUrl} name={g.name} tall />
                  <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    {g.brand && (
                      <>
                        <dt className="text-muted">Бренд</dt>
                        <dd className="m-0">{g.brand}</dd>
                      </>
                    )}
                    {g.unit && (
                      <>
                        <dt className="text-muted">Фасовка</dt>
                        <dd className="m-0">{g.unit}</dd>
                      </>
                    )}
                    {first?.barcode && (
                      <>
                        <dt className="text-muted">Штрих-код</dt>
                        <dd className="m-0">{first.barcode}</dd>
                      </>
                    )}
                    {first?.description && (
                      <>
                        <dt className="text-muted">Описание</dt>
                        <dd className="m-0">
                          {first.description.length > 400
                            ? `${first.description.slice(0, 397).replace(/\s+\S*$/, '')}…`
                            : first.description}
                        </dd>
                      </>
                    )}
                  </dl>
                  {g.offers.map((o) => {
                    const hkey = histKey(o.product.canonicalId, o.storeId, city, o.product.storeCode);
                    const effective = o.product.promoPrice ?? o.product.price;
                    return (
                      <section key={hkey} className="mb-4 rounded-xl border border-line p-3">
                        <div className="flex items-baseline justify-between">
                          <strong>{offerPointLabel(o.storeId, o.product.storeCode)}</strong>
                          <span className="tabular-nums text-lg font-bold">{formatPrice(effective)}</span>
                        </div>
                        {(() => {
                          // Цена по полочкам. Строку «Акция» не дублируем: в
                          // заголовке offer'а уже стоит акционная цена, здесь
                          // показываем, от чего её отбили.
                          const p = o.product;
                          const promo =
                            typeof p.promoPrice === 'number' && p.promoPrice > 0 && p.promoPrice < p.price
                              ? p.promoPrice
                              : null;
                          const old =
                            typeof p.oldPrice === 'number' && p.oldPrice > 0 && p.oldPrice > p.price
                              ? p.oldPrice
                              : null;
                          const crossed = promo !== null ? p.price : old;
                          // Округляем ДО сравнения: у Ленты цены в копейках, и без
                          // этого на экране появлялось «−0 ₽», а «120 − 89 = 31»
                          // расходилось с показанными «−30 ₽».
                          const offRub = crossed !== null ? Math.round(crossed - (promo ?? p.price)) : null;
                          const offPct =
                            offRub !== null && crossed !== null && crossed > 0
                              ? Math.round((offRub / crossed) * 100)
                              : null;
                          return (
                            <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                              {crossed !== null && (
                                <>
                                  <dt className="text-muted">
                                    {promo !== null ? 'Цена без акции' : 'Старая цена'}
                                  </dt>
                                  <dd className="m-0">
                                    <s className="tabular-nums text-muted">{formatPrice(crossed)}</s>
                                    {offRub !== null && offRub > 0 && (
                                      <span className="ml-2 tabular-nums font-semibold text-primary-dark">
                                        −{formatPrice(offRub)}
                                        {offPct !== null && offPct > 0 ? ` (−${offPct}%)` : ''}
                                      </span>
                                    )}
                                  </dd>
                                </>
                              )}
                              {p.unitPrice && (
                                <>
                                  <dt className="text-muted">За единицу</dt>
                                  <dd className="m-0 tabular-nums">{p.unitPrice}</dd>
                                </>
                              )}
                              <dt className="text-muted">Наличие</dt>
                              <dd className="m-0">
                                {p.inStock === false ? <span className="font-semibold">нет в наличии</span> : 'в наличии'}
                              </dd>
                              {p.collectedAt && (
                                <>
                                  <dt className="text-muted">Замерено</dt>
                                  <dd className="m-0 tabular-nums text-muted">
                                    {p.collectedAt.slice(0, 16).replace('T', ' ')}
                                  </dd>
                                </>
                              )}
                            </dl>
                          );
                        })()}
                        <p className="m-0 text-xs text-muted">
                          {o.product.url ? (
                            <button
                              className="min-h-9 cursor-pointer rounded px-2 text-xs text-primary-dark underline"
                              onClick={() =>
                                window.api
                                  ?.openExternal(o.product.url ?? '')
                                  .then((ok) => {
                                    if (!ok) setPollMsg({ text: 'Ссылка не из списка магазинов.', tone: 'warn' });
                                  })
                                  .catch(() => setPollMsg({ text: 'Не удалось открыть ссылку.', tone: 'warn' }))
                              }
                            >
                              открыть в магазине
                            </button>
                          ) : (
                            'ссылка недоступна'
                          )}
                        </p>
                        {histLoading[hkey] === true ? (
                          <p className="mt-1 text-xs text-muted" role="status">
                            Загружаю историю…
                          </p>
                        ) : hist[hkey] === 'error' ? (
                          <p className="text-xs text-muted" role="alert">
                            История не загрузилась.
                          </p>
                        ) : (
                          <HistoryChart points={hist[hkey] ?? []} />
                        )}
                        {(() => {
                          const scope = { canonicalId: o.product.canonicalId, storeId: o.storeId, city, storeCode: o.product.storeCode };
                          const s = shelves[hkey];
                          const busy = shelfBusy[hkey] === true;
                          if (s === undefined || s === 'error') return null;
                          const current = s.categoryIds;
                          const byId = new Map((ourCategories ?? []).map((c) => [c.id, c.name]));
                          const rest = (ourCategories ?? []).filter((c) => !c.virtual && !current.includes(c.id));
                          return (
                            <div className="mt-3 border-t border-line pt-2">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="text-xs font-bold text-muted">Наши полки</span>
                                <span className="text-xs text-muted">
                                  {busy ? (
                                    <span className="flex items-center gap-1.5" role="status">
                                      <Spinner />
                                      сохраняю…
                                    </span>
                                  ) : s.manual
                                    ? 'разложено вручную'
                                    : s.categoryIds.length > 0
                                      ? 'разложено по названию'
                                      : 'ждёт автораскладку'}
                                </span>
                              </div>
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {current.length === 0 ? (
                                  <span className="text-xs text-muted">
                                    без полок — товар лежит в «Не разложено»
                                  </span>
                                ) : (
                                  current.map((id) => (
                                    <button
                                      key={id}
                                      type="button"
                                      disabled={busy}
                                      className="min-h-9 cursor-pointer rounded-full border border-primary px-2.5 text-xs disabled:opacity-50"
                                      aria-label={`Снять полку ${byId.get(id) ?? id}`}
                                      onClick={() => void saveShelves(hkey, scope, current.filter((c) => c !== id))}
                                    >
                                      {byId.get(id) ?? id} ✕
                                    </button>
                                  ))
                                )}
                              </div>
                              {rest.length > 0 && (
                                <select
                                  className="mt-2 min-h-9 w-full cursor-pointer rounded-lg border border-line bg-card px-2 text-xs"
                                  value=""
                                  disabled={busy}
                                  aria-label="Добавить полку"
                                  onChange={(e) => {
                                    const id = e.target.value;
                                    if (id) void saveShelves(hkey, scope, [...current, id]);
                                  }}
                                >
                                  <option value="">добавить полку…</option>
                                  {rest.map((c) => (
                                    <option key={c.id} value={c.id}>
                                      {c.name}
                                    </option>
                                  ))}
                                </select>
                              )}
                              {s.manual && (
                                <button
                                  type="button"
                                  disabled={busy}
                                  className="mt-2 min-h-9 cursor-pointer rounded px-1 text-xs text-primary-dark underline disabled:opacity-50"
                                  onClick={() => void releaseShelvesAction(hkey, scope)}
                                >
                                  вернуть автораскладку
                                </button>
                              )}
                            </div>
                          );
                        })()}
                      </section>
                    );
                  })}
                </div>
              </div>
            );
          })()}
      </main>

      {/* Подвал — сосед контента, а не его часть: только так он может быть
          липким (`sticky bottom-…` держится в рамках РОДИТЕЛЯ) и прижатым к
          низу окна (`mt-auto` в flex-колонке). Внутри контентной обёртки он
          уезжал вместе с содержимым страницы.

          `bottom-[var(--safe-bottom)]` — зеркало липкой шапки
          (`top-[var(--safe-top)]`): на Android 15+ edge-to-edge футер без
          этого заезжал бы под жестовую навигацию, а в конце страницы ещё и
          прыгал вверх на величину инсета. На Windows инсет равен нулю.

          Раскладка: на телефоне две строки — «опрос каждые N ч» и ряд
          кнопок с версией, а техническая строка про SQLite/IPC скрыта
          (на 390px она стоила отдельного ряда, а футер съедал 23 % экрана).
          На широком экране всё в одну строку, три колонки. Число колонок НЕ
          зависит от `pollRunning`: раньше «Опросить сейчас» уезжала влево, а
          на телефоне футер вырастал ещё на ряд — липкий подвал дёргался на
          глазах. Обе кнопки живут в одной ячейке именно поэтому. */}
      {window.api && (
      <footer
        ref={footerRef}
        className="sticky bottom-[var(--safe-bottom)] z-10 mt-auto grid grid-cols-1 items-center gap-x-3 gap-y-2 border-t border-line bg-cream pb-3 pt-2 text-xs text-muted sm:grid-cols-[1fr_auto_auto] sm:gap-y-1"
      >
        <span className="hidden min-w-0 text-xs leading-relaxed sm:block sm:line-clamp-2">Локально · SQLite · IPC: {status} · запись в историю только при изменении цены</span>
        <span className="min-w-0 text-xs leading-relaxed sm:line-clamp-2">
          {sched && sched.lastRun
          ? `опрос каждые ${sched.intervalHours}ч · последний: ${sched.lastRun.slice(0, 16).replace('T', ' ')}`
          : `опрос каждые ${sched?.intervalHours ?? 6}ч · ещё не было`}
        </span>
        {/* Кнопка опроса намеренно мелкая и без min-w: в подвале это служебное
            действие, а не главный призыв, и 184 пикселя ширины рядом с
            версией выглядели как баннер. min-w держали только ради того, чтобы
            футер не «танцевал» — но левая колонка и так забирает всю
            свободную ширину, поэтому фиксировать ширину нечего. Размер
            совпадает с соседними мелкими кнопками файла (min-h-8/text-xs), а на
            телефоне — крупнее: пальцем по 32px не попасть. */}
        <div className="flex items-center gap-3 sm:justify-self-end">
          <button
            type="button"
            className="flex min-h-11 cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-line bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:min-h-8 sm:border-0 sm:bg-transparent sm:text-xs"
            onClick={runPoll}
            disabled={pollRunning}
          >
            {pollRunning && <Spinner className="h-3 w-3" />}
            {pollRunning ? 'Опрашиваю…' : 'Опросить сейчас'}
          </button>
          {/* Прервать показываем ТОЛЬКО во время прогона: вне его кнопка была бы
              лишней и предлагала бы действие, которого нечего отменять.
              Отмена кооперативная — уже начатый запрос доживает, поэтому
              кнопка остаётся активной до конца, а не гаснет после первого клика. */}
          {pollRunning && (
            <button
              type="button"
              className="flex min-h-11 cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-line bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:min-h-8 sm:border-0 sm:bg-transparent sm:text-xs"
              onClick={stopPoll}
            >
              Прервать
            </button>
          )}
          {/* Версия в одном ряду с кнопками: на телефоне она стоила отдельного
              ряда, а подвал и без того съедал четверть экрана. */}
          <span className="whitespace-nowrap tabular-nums">v{version}</span>
        </div>
      </footer>
      )}
    </div>
    </div>
  );
}
