import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryPoint, OurCategoryInfo, RendererApi, SchedulerStatus, StoreCatalog, StorePrices } from '../shared/api';
import { CITIES, CITY_STORES } from '../shared/catalog';
import { groupByProduct } from '../shared/matching';
import { formatPrice } from '../shared/format';
import { hasOurChildren, visibleOurCategories } from '../shared/taxonomy';
import { CategoryIcon } from './CategoryIcon';

declare global {
  interface Window {
    api: RendererApi;
  }
}

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'available'; latest: string }
  | { kind: 'downloaded'; latest: string }
  | { kind: 'error'; message: string };

function HistoryChart({ points }: { points: HistoryPoint[] }) {
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

export default function App() {
  const [status, setStatus] = useState('...');
  const [version, setVersion] = useState('...');
  const [update, setUpdate] = useState<UpdateState>({ kind: 'idle' });
  const [city, setCity] = useState<string>('moscow');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StorePrices[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<StoreCatalog[] | null>(null);
  const [catLoading, setCatLoading] = useState(false);
  const [catError, setCatError] = useState<string | null>(null);
  const [storeOn, setStoreOn] = useState<Record<string, boolean>>({});
  const [promoOnly, setPromoOnly] = useState(false);
  const [stockOnly, setStockOnly] = useState(false);
  const [sort, setSort] = useState<'none' | 'asc' | 'desc'>('none');
  const [openHist, setOpenHist] = useState<string | null>(null);
  const [hist, setHist] = useState<Record<string, HistoryPoint[] | 'error'>>({});
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [histLoading, setHistLoading] = useState<Record<string, boolean>>({});
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const [sched, setSched] = useState<SchedulerStatus | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [pollMsg, setPollMsg] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);
  const [storeMenuOpen, setStoreMenuOpen] = useState(false);
  const [cityMenuOpen, setCityMenuOpen] = useState(false);
  const [lastAction, setLastAction] = useState<
    | { kind: 'search'; query: string; city: string }
    | { kind: 'category'; url: string; city: string }
    | { kind: 'our'; id: string; city: string }
    | null
  >(null);
  const [source, setSource] = useState<'ours' | 'stores'>('ours');
  const [ourCategories, setOurCategories] = useState<OurCategoryInfo[] | null>(null);
  const [ourOpen, setOurOpen] = useState<Record<string, boolean>>({});
  const storeMenuRef = useRef<HTMLDivElement | null>(null);
  const storeMenuBtnRef = useRef<HTMLButtonElement | null>(null);
  const cityMenuRef = useRef<HTMLDivElement | null>(null);
  const cityMenuBtnRef = useRef<HTMLButtonElement | null>(null);
  const catScrollRef = useRef(0);
  const [scrollIntent, setScrollIntent] = useState<{ top: number; n: number } | null>(null);
  const [fatal, setFatal] = useState(false);

  const scrollPage = (top: number) => setScrollIntent((p) => ({ top, n: (p?.n ?? 0) + 1 }));

  useEffect(() => {
    if (!scrollIntent) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: Math.min(scrollIntent.top, Math.max(0, max)) });
  }, [scrollIntent]);

  useEffect(() => {
    if (results === null) return;
    scrollPage(0);
  }, [results]);

  useEffect(() => {
    if (!window.api) {
      setFatal(true);
      return;
    }
    window.api.ping().then((p) => setStatus(p)).catch(() => setStatus('no-electron'));
    window.api.getVersion().then((v) => setVersion(v)).catch(() => setVersion('dev'));
    const off = window.api.onUpdateEvent((kind, payload) => {
      if (kind === 'available' || kind === 'downloaded')
        setUpdate({ kind, latest: String(payload) });
      else if (kind === 'error') setUpdate({ kind: 'error', message: String(payload) });
    });
    window.api
      .checkUpdates()
      .then((r) => {
        if (r.available && r.latest) setUpdate({ kind: 'available', latest: r.latest });
      })
      .catch(() => {});
    window.api.getSchedulerStatus().then((s) => setSched(s)).catch(() => {});
    const offProg = window.api.onSchedulerProgress((done, total) => setProgress({ done, total }));
    const offDone = window.api.onSchedulerDone((d) => {
      setSched(d.status);
      setProgress(null);
      const warn =
        d.summary.startsWith('Опрос уже идёт') || d.summary.includes('отслеживаемых товаров пока нет');
      setPollMsg({ text: d.summary, tone: warn ? 'warn' : 'ok' });
    });
    return () => {
      off();
      offProg();
      offDone();
    };
  }, []);

  const fetchHist = (key: string, args: { canonicalId: string; storeId: string; city: string }) => {
    setHistLoading((prev) => ({ ...prev, [key]: true }));
    window.api
      .getHistory(args)
      .then((h) => setHist((prev) => ({ ...prev, [key]: h })))
      .catch(() => setHist((prev) => ({ ...prev, [key]: 'error' })))
      .finally(() => setHistLoading((prev) => ({ ...prev, [key]: false })));
  };

  useEffect(() => {
    if (!storeMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (storeMenuRef.current && !storeMenuRef.current.contains(e.target as Node)) {
        setStoreMenuOpen(false);
      }
    };
    const onFocusOut = (e: FocusEvent) => {
      if (storeMenuRef.current && !storeMenuRef.current.contains(e.relatedTarget as Node | null)) {
        setStoreMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setStoreMenuOpen(false);
        storeMenuBtnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [storeMenuOpen]);

  useEffect(() => {
    if (!cityMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (cityMenuRef.current && !cityMenuRef.current.contains(e.target as Node)) {
        setCityMenuOpen(false);
      }
    };
    const onFocusOut = (e: FocusEvent) => {
      if (cityMenuRef.current && !cityMenuRef.current.contains(e.relatedTarget as Node | null)) {
        setCityMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCityMenuOpen(false);
        cityMenuBtnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [cityMenuOpen]);

  useEffect(() => {
    if (!window.api) return;
    setCatalog(null);
    setResults(null);
    setStoreOn({});
    setLastAction(null);
    setDetailKey(null);
    setOurOpen({});
    window.api
      .getCatalog({ city })
      .then((c) => setCatalog(c))
      .catch(() => setCatalog([]));
    window.api
      .getOurCategories({ city })
      .then((c) => setOurCategories(c))
      .catch(() => setOurCategories([]));
  }, [city]);

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
      const hkey = `${o.storeId}:${o.product.canonicalId}:${city}`;
      if (hist[hkey] !== undefined && hist[hkey] !== 'error') continue;
      fetchHist(hkey, {
        canonicalId: o.product.canonicalId,
        storeId: o.storeId,
        city,
      });
    }
  };

  const toggleHist = (key: string, args: { canonicalId: string; storeId: string; city: string }) => {
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
    setProgress(null);
    const action = lastAction;
    window.api
      .runScheduler()
      .then((d) => {
        setSched(d.status);
        setProgress(null);
        setPollMsg({ text: d.summary, tone: 'ok' });
        if (!window.api) return;
        if (action?.kind === 'search' && action.city === city) {
          window.api
            .getPrices({ city, query: action.query })
            .then((r) => setResults(r))
            .catch(() => {});
        } else if (action?.kind === 'category' && action.city === city) {
          window.api
            .getCategory({ city, url: action.url })
            .then((r) => setResults(r))
            .catch(() => {});
        }
      })
      .catch(() => {
        setProgress(null);
        setPollMsg({ text: 'Опрос не удался.', tone: 'warn' });
      });
  };

  const openCategory = (url: string) => {
    if (!window.api) return;
    catScrollRef.current = window.scrollY;
    setResults(null);
    setCatLoading(true);
    setCatError(null);
    setLastAction({ kind: 'category', url, city });
    window.api
      .getCategory({ city, url })
      .then((r) => {
        setResults(r);
        if (r.every((s) => s.items.length === 0)) {
          const err = r.map((s) => s.error).find((e) => e);
          setCatError(err ?? 'Категория пуста — возможно, товары не загрузились.');
        }
      })
      .catch((e) => {
        setResults([]);
        setCatError(String(e));
      })
      .finally(() => setCatLoading(false));
  };

  const backToCategories = () => {
    const y = catScrollRef.current;
    setResults(null);
    scrollPage(y);
  };

  const openOurCategory = (id: string) => {
    if (!window.api) return;
    catScrollRef.current = window.scrollY;
    setResults(null);
    setCatLoading(true);
    setCatError(null);
    setLastAction({ kind: 'our', id, city });
    window.api
      .getOurCategory({ city, id })
      .then((r) => {
        setResults(r);
        if (r.every((s) => s.items.length === 0)) {
          const err = r.map((s) => s.error).find((e) => e);
          setCatError(err ?? 'Категория пуста — попробуй соседнюю или поиск.');
        }
      })
      .catch((e) => {
        setResults([]);
        setCatError(String(e));
      })
      .finally(() => setCatLoading(false));
  };

  const doSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.api || !query.trim()) return;
    catScrollRef.current = window.scrollY;
    setResults(null);
    setSearchError(null);
    setLastAction({ kind: 'search', query: query.trim(), city });
    window.api
      .getPrices({ city, query: query.trim() })
      .then((r) => setResults(r))
      .catch((err) => {
        setResults([]);
        setSearchError(String(err));
      });
  };

  const groups = useMemo(() => {
    if (!results) return null;
    const rawCount = results.reduce((n, s) => n + s.items.length, 0);
    const items = results.flatMap((s) =>
      storeOn[s.storeId] === false
        ? []
        : s.items.filter((p) => {
            if (promoOnly && p.oldPrice == null && p.promoPrice == null) return false;
            if (stockOnly && p.inStock === false) return false;
            return true;
          }),
    );
    const list = groupByProduct(items);
    const minOf = (g: (typeof list)[number]) =>
      Math.min(...g.offers.map((o) => o.product.promoPrice ?? o.product.price));
    if (sort !== 'none') list.sort((a, b) => (sort === 'asc' ? minOf(a) - minOf(b) : minOf(b) - minOf(a)));
    return { groups: list, stores: results, rawCount };
  }, [results, storeOn, promoOnly, stockOnly, sort]);

  const storeName = (id: string) =>
    CITY_STORES[city]?.find((s) => s.storeId === id)?.name ?? id;

  return (
    <div className="mx-auto max-w-6xl bg-cream px-6 pb-10 text-ink">
      <header className="sticky top-0 z-10 -mx-6 border-b border-line bg-cream/95 px-6 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-primary" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
              <path d="M6 7h15l-1.5 9h-12z" />
              <path d="M6 7l-1-4H2" />
              <circle cx="9" cy="20" r="1.5" />
              <circle cx="17" cy="20" r="1.5" />
            </svg>
          </span>
          <h1 className="m-0 text-[22px] font-bold tracking-tight">PriceAggregator</h1>
          <div className="relative ml-auto" ref={cityMenuRef}>
            <button
              ref={cityMenuBtnRef}
              className="flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-card px-3.5 py-1.5 text-sm text-ink transition-colors hover:border-primary"
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
              <div className="absolute right-0 top-full z-20 mt-1 min-w-64 rounded-xl border border-line bg-card p-2 shadow-lg" role="group" aria-label="Выбор города">
                {CITIES.map((c) => {
                  const stores = CITY_STORES[c.id] ?? [];
                  const readyStores = stores.filter((s) => s.ready);
                  const active = city === c.id;
                  return (
                    <button
                      key={c.id}
                      aria-current={active}
                      className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-ink hover:bg-cream"
                      onClick={() => {
                        setCity(c.id);
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
                        {readyStores.length} из {stores.length} сетей
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="pt-4">
        {fatal && (
          <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="alert">
            Не загрузился preload-мост (window.api). Перезапусти приложение;
            если повторяется — сломана сборка dist-electron.
          </div>
        )}
        {update.kind === 'available' && (
          <p className="my-3 max-h-36 overflow-y-auto rounded-xl bg-warnbg p-2.5 px-3.5 text-sm break-all" role="status">
            Доступна версия {update.latest}, скачиваю из GitHub Releases…
          </p>
        )}
        {update.kind === 'downloaded' && (
          <p className="my-3 max-h-36 overflow-y-auto rounded-xl bg-okbg p-2.5 px-3.5 text-sm break-all" role="status">
            Версия {update.latest} скачана.
            <button
              className="ml-2 min-h-9 cursor-pointer"
              onClick={() =>
                window.api.installUpdate().catch(() => setUpdate({ kind: 'error', message: 'не удалось запустить установку' }))
              }
            >
              Установить и перезапустить
            </button>
          </p>
        )}
        {update.kind === 'error' && (
          <p className="my-3 max-h-36 overflow-y-auto rounded-xl bg-warnbg p-2.5 px-3.5 text-sm break-all" role="alert">
            Ошибка обновлений: {update.message}
          </p>
        )}

        <form className="mb-2 mt-5 flex gap-2" onSubmit={doSearch}>
          <label htmlFor="q" className="absolute -left-[9999px]">
            Поиск товара
          </label>
          <input
            id="q"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Молоко, яйца, хлеб…"
            autoComplete="off"
            className="min-h-11 flex-1 rounded-l-xl rounded-r-none border border-r-0 border-line bg-card px-3.5 text-base text-ink focus:outline-2 focus:outline-primary"
          />
          <button
            type="submit"
            className="min-h-11 cursor-pointer rounded-l-none rounded-r-xl border-none bg-primary px-6 text-base text-white transition-colors hover:bg-primary-dark"
          >
            Найти
          </button>
        </form>
        <div className="relative mb-1" ref={storeMenuRef}>
          <button
            ref={storeMenuBtnRef}
            className="min-h-9 cursor-pointer rounded-full border border-line bg-card px-3.5 py-1.5 text-sm text-ink"
            onClick={() => setStoreMenuOpen((v) => !v)}
            aria-expanded={storeMenuOpen}
          >
            Магазины: {(CITY_STORES[city] ?? []).filter((s) => s.ready && storeOn[s.storeId] !== false).length}/
            {(CITY_STORES[city] ?? []).filter((s) => s.ready).length} ▾
          </button>
          {storeMenuOpen && (
            <div className="absolute left-0 top-full z-20 mt-1 min-w-52 rounded-xl border border-line bg-card p-2 shadow-lg" role="group" aria-label="Фильтр магазинов">
              {(CITY_STORES[city] ?? []).map((s) => (
                <label
                  key={s.storeId}
                  className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-cream"
                  style={s.ready ? undefined : { opacity: 0.55 }}
                >
                  <input
                    type="checkbox"
                    className="h-[18px] w-[18px] accent-primary"
                    checked={storeOn[s.storeId] !== false}
                    disabled={!s.ready}
                    onChange={(e) => setStoreOn((prev) => ({ ...prev, [s.storeId]: e.target.checked }))}
                  />
                  {s.name}
                  {!s.ready && <span className="text-xs text-muted">(скоро)</span>}
                </label>
              ))}
            </div>
          )}
        </div>
        {progress && (
          <p className="m-0 mb-4 text-[13px] text-muted" role="status">
            Опрашиваю… {progress.done}/{progress.total}
          </p>
        )}
        {pollMsg && (
          <p
            className={
              pollMsg.tone === 'warn'
                ? 'my-3 max-h-36 overflow-y-auto rounded-xl bg-warnbg p-2.5 px-3.5 text-sm break-all'
                : 'my-3 max-h-36 overflow-y-auto rounded-xl bg-okbg p-2.5 px-3.5 text-sm break-all'
            }
            role="status"
          >
            {pollMsg.text}
          </p>
        )}
        <p className="m-0 mb-4 text-[13px] text-muted">
          Цены — по конкретному магазину, не «в среднем по городу»: даже соседние
          магазины одной сети могут стоить по-разному. Один и тот же товар
          в разных сетях склеивается по штрих-коду, иначе — по названию, бренду и фасовке.
        </p>

        {results === null && (
          <section aria-label="Категории товаров">
            <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Источник категорий">
              <button
                className={
                  source === 'ours'
                    ? 'min-h-9 cursor-pointer rounded-full border border-primary bg-primary px-3.5 py-1.5 text-sm text-white'
                    : 'min-h-9 cursor-pointer rounded-full border border-line bg-card px-3.5 py-1.5 text-sm text-ink hover:border-primary'
                }
                onClick={() => setSource('ours')}
                aria-pressed={source === 'ours'}
              >
                Наши категории
              </button>
              <button
                className={
                  source === 'stores'
                    ? 'min-h-9 cursor-pointer rounded-full border border-primary bg-primary px-3.5 py-1.5 text-sm text-white'
                    : 'min-h-9 cursor-pointer rounded-full border border-line bg-card px-3.5 py-1.5 text-sm text-ink hover:border-primary'
                }
                onClick={() => setSource('stores')}
                aria-pressed={source === 'stores'}
              >
                Как в магазинах
              </button>
              <span className="text-[13px] text-muted">
                {source === 'ours'
                  ? 'Единый список для всех сетей: тот же хлеб и то же молоко рядом, цены сравниваются.'
                  : 'Витрина выбранной сети, как на сайте магазина.'}
              </span>
            </div>
            {source === 'ours' && (
              <>
                {ourCategories === null && (
                  <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="status">
                    Загружаю наши категории…
                  </div>
                )}
                {ourCategories !== null && ourCategories.length === 0 && (
                  <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="alert">
                    Список категорий пуст.
                  </div>
                )}
                <ul className="m-0 list-none space-y-1 p-0">
                  {visibleOurCategories(ourOpen, ourCategories ?? []).map((c) => {
                    const isChild = c.parentId !== null;
                    const expandable = hasOurChildren(c.id);
                    return (
                      <li key={c.id} style={isChild ? { paddingLeft: 20 } : undefined}>
                        <div className="flex items-stretch gap-1">
                          {expandable ? (
                            <button
                              className="min-h-11 w-8 flex-none cursor-pointer rounded-lg border border-line bg-card text-xs text-muted hover:border-primary"
                              aria-expanded={ourOpen[c.id] === true}
                              aria-label={`${ourOpen[c.id] === true ? 'Скрыть' : 'Показать'} вложенные категории`}
                              onClick={() =>
                                setOurOpen((p) => ({ ...p, [c.id]: !(p[c.id] === true) }))
                              }
                            >
                              {ourOpen[c.id] === true ? '▾' : '▸'}
                            </button>
                          ) : (
                            <span className="w-8 flex-none" aria-hidden="true" />
                          )}
                          <button
                            className="flex min-h-11 flex-1 cursor-pointer items-center gap-2.5 rounded-xl border border-line bg-card px-3 py-2 text-left text-sm text-ink transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-60"
                            onClick={() => openOurCategory(c.id)}
                            disabled={catLoading}
                          >
                            <CategoryIcon
                              id={c.id}
                              className="h-7 w-7 flex-none rounded-lg bg-cream p-1"
                              accent={c.virtual === true}
                            />
                            <span className="flex-1">
                              {c.name}
                              <span className="ml-2 text-xs text-muted">
                                {c.virtual
                                  ? 'товары вне наших полок'
                                  : `${c.queryCount} запр. · проверяем в ${c.storeCount} сет.`}
                              </span>
                            </span>
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {source === 'stores' && (
              <>
            {catalog === null && (
              <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="status">
                Загружаю категории каталога…
              </div>
            )}
          {catalog !== null && catalog.every((s) => s.categories.length === 0) && (
            <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="alert">
              Категории не загрузились.
              {catalog
                .map((s) => s.error)
                .find((e) => e) ?? ' Попробуй поиск выше.'}
            </div>
          )}
          {catalog !== null &&
            catalog.some((s) => s.categories.length > 0) &&
            catalog.every((s) => storeOn[s.storeId] === false) && (
              <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="status">
                Все магазины выключены в фильтре «Магазины» — включи хотя бы один.
              </div>
            )}
            {(catalog ?? []).map(
              (s) =>
                storeOn[s.storeId] !== false &&
                s.categories.length > 0 && (
                  <div key={s.storeId}>
                    <h2 className="mt-5 text-base font-semibold">{s.name}</h2>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2.5">
                      {s.categories.map((c) => (
                        <button
                          key={c.id}
                          className="flex min-h-11 cursor-pointer items-center justify-center rounded-xl border border-line border-l-4 border-l-primary bg-card p-2.5 text-center text-[13px] leading-snug text-ink transition-colors hover:border-primary"
                          onClick={() => openCategory(c.url)}
                        >
                          {c.imageUrl && (
                          <img
                            src={c.imageUrl}
                            alt=""
                            loading="lazy"
                            className="h-24 w-full rounded-lg bg-cream object-cover"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                            }}
                          />
                          )}
                          <span>{c.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ),
            )}
              </>
            )}
          </section>
        )}

        {results !== null && (
          <p className="my-2">
            <button
              className="min-h-8 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-ink"
              onClick={backToCategories}
            >
              ← к категориям
            </button>
          </p>
        )}

        {catLoading && (
          <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="status">
            Загружаю товары категории…
          </div>
        )}
        {catError && (
          <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="alert">
            {catError}
          </div>
        )}
        {groups && (
          <p className="m-0 mb-4 text-[13px] text-muted" aria-live="polite">
            {groups.stores
              .map((s) =>
                s.ready && !s.error
                  ? `${s.name}: опрошен`
                  : s.error
                    ? `${s.name}: ошибка (${s.error.slice(0, 80)})`
                    : `${s.name}: скоро`,
              )
              .join(' · ')}
          </p>
        )}

        {groups && groups.groups.length === 0 && groups.rawCount > 0 && (
          <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="status">
            Всё скрыто фильтрами.{' '}
            <button
              className="min-h-8 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-ink"
              onClick={() => {
                setStoreOn({});
                setPromoOnly(false);
                setStockOnly(false);
                setSort('none');
              }}
            >
              сбросить фильтры
            </button>
          </div>
        )}
        {searchError && (
          <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="alert">
            Поиск не удался: {searchError.slice(0, 200)}
          </div>
        )}
        {groups && groups.groups.length === 0 && groups.rawCount === 0 && !catLoading && !searchError && (
          <div className="mt-3 rounded-xl border border-dashed border-line bg-card p-7 text-center text-muted" role="status">
            {query.trim()
              ? `По запросу «${query.trim()}» ничего не нашлось. Проверь название или попробуй позже — сети иногда отвечают с задержкой.`
              : 'Категория пуста — выбери другую.'}
          </div>
        )}

        {groups && groups.groups.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-card px-3.5 py-2 text-sm" role="group" aria-label="Фильтры выдачи">
            {groups.stores.map((s) => (
              <label key={s.storeId} className="flex min-h-9 cursor-pointer items-center gap-1.5" style={s.ready ? undefined : { opacity: 0.55 }}>
                <input
                  type="checkbox"
                  className="h-[18px] w-[18px] accent-primary"
                  checked={storeOn[s.storeId] !== false}
                  disabled={!s.ready}
                  onChange={(e) => setStoreOn((prev) => ({ ...prev, [s.storeId]: e.target.checked }))}
                />
                {s.name}
              </label>
            ))}
            <label className="flex min-h-9 cursor-pointer items-center gap-1.5">
              <input type="checkbox" className="h-[18px] w-[18px] accent-primary" checked={promoOnly} onChange={(e) => setPromoOnly(e.target.checked)} />
              Только со скидкой
            </label>
            <label className="flex min-h-9 cursor-pointer items-center gap-1.5">
              <input type="checkbox" className="h-[18px] w-[18px] accent-primary" checked={stockOnly} onChange={(e) => setStockOnly(e.target.checked)} />
              В наличии
            </label>
            <label className="flex min-h-9 cursor-pointer items-center gap-1.5">
              Сортировка
              <select value={sort} onChange={(e) => setSort(e.target.value as 'none' | 'asc' | 'desc')} className="min-h-9 rounded-lg border border-line bg-card px-2.5 py-1.5 text-sm text-ink">
                <option value="none">без сортировки</option>
                <option value="asc">сначала дешевле</option>
                <option value="desc">сначала дороже</option>
              </select>
            </label>
          </div>
        )}

        {groups && groups.groups.length > 0 && (
          <section className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3" aria-label="Найденные товары">
            {groups.groups.map((g) => (
              <article key={g.key} className="rounded-2xl border border-line bg-card p-4">
                {g.imageUrl && (
                  <img
                    src={g.imageUrl}
                    alt=""
                    loading="lazy"
                    className="h-48 w-full rounded-xl bg-cream object-contain"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                )}
                <h2 className="mb-2 mt-1 text-base font-semibold leading-snug">{g.name}</h2>
                <button
                  className="mb-2 min-h-8 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-ink"
                  onClick={() => openDetail(g.key)}
                >
                  Подробнее
                </button>
                {g.offers.map((o) => {
                  const effective = o.product.promoPrice ?? o.product.price;
                  const struck = o.product.oldPrice ?? (o.product.promoPrice != null ? o.product.price : null);
                  const hkey = `${o.storeId}:${o.product.canonicalId}:${city}`;
                  return (
                    <div key={`${o.storeId}:${o.product.canonicalId}`}>
                      <div className="flex items-baseline justify-between gap-2 border-t border-line py-1.5 text-sm first:border-t-0">
                        <span className="text-muted">{storeName(o.storeId)}</span>
                        <span className="tabular-nums">
                          {struck !== null && struck !== undefined && (
                            <span className="mr-1.5 text-[13px] text-muted line-through">{formatPrice(struck)}</span>
                          )}
                          <span className="whitespace-nowrap text-lg font-bold">{formatPrice(effective)}</span>{' '}
                          <button
                            className="min-h-8 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-ink"
                            onClick={() =>
                              toggleHist(hkey, {
                                canonicalId: o.product.canonicalId,
                                storeId: o.storeId,
                                city,
                              })
                            }
                          >
                            {openHist === hkey ? 'скрыть' : 'история'}
                          </button>
                        </span>
                      </div>
                      {openHist === hkey &&
                        (histLoading[hkey] === true ? (
                          <p className="mt-1 text-xs text-muted" role="status">
                            Загружаю историю…
                          </p>
                        ) : hist[hkey] === 'error' ? (
                          <p className="mt-1 text-xs text-muted" role="alert">
                            Не удалось загрузить историю.{' '}
                            <button
                              className="min-h-8 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-ink"
                              onClick={() =>
                                fetchHist(hkey, {
                                  canonicalId: o.product.canonicalId,
                                  storeId: o.storeId,
                                  city,
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

        <footer className="mt-7 flex flex-wrap justify-between gap-2 text-xs text-muted">
          <span>Локально · SQLite · IPC: {status} · запись в историю только при изменении цены</span>
          <span>
            {sched && sched.lastRun
              ? `опрос каждые ${sched.intervalHours}ч · последний: ${sched.lastRun.slice(0, 16).replace('T', ' ')} (+${sched.counts.inserted}/=${sched.counts.skipped}/!${sched.counts.failed})`
              : `опрос каждые ${sched?.intervalHours ?? 6}ч · ещё не было`}
            <button
              className="ml-2 min-h-8 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-ink disabled:cursor-not-allowed disabled:opacity-55"
              onClick={runPoll}
              disabled={sched?.running === true}
            >
              {sched?.running === true ? 'Опрашиваю…' : 'Опросить сейчас'}
            </button>
          </span>
          <span>v{version}</span>
        </footer>

        {detailKey !== null &&
          (() => {
            const g = groups?.groups.find((x) => x.key === detailKey);
            if (!g) return null;
            const first = g.offers[0]?.product;
            return (
              <div
                className="fixed inset-0 z-30 overflow-y-auto bg-ink/60 p-4"
                role="dialog"
                aria-modal="true"
                aria-label={g.name}
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) setDetailKey(null);
                }}
              >
                <div className="mx-auto my-8 max-w-2xl rounded-2xl bg-card p-6">
                  <div className="mb-4 flex items-start justify-between gap-4">
                    <h2 className="m-0 text-xl font-bold">{g.name}</h2>
                    <button
                      ref={closeBtnRef}
                      className="min-h-9 flex-none cursor-pointer rounded-full border border-line bg-card px-3.5 py-1.5 text-sm"
                      onClick={() => setDetailKey(null)}
                      aria-label="Закрыть"
                    >
                      ✕
                    </button>
                  </div>
                  {g.imageUrl && (
                    <img
                      src={g.imageUrl}
                      alt=""
                      className="mb-4 max-h-64 w-full rounded-xl bg-cream object-contain"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  )}
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
                    const hkey = `${o.storeId}:${o.product.canonicalId}:${city}`;
                    const effective = o.product.promoPrice ?? o.product.price;
                    return (
                      <section key={hkey} className="mb-4 rounded-xl border border-line p-3">
                        <div className="flex items-baseline justify-between">
                          <strong>{storeName(o.storeId)}</strong>
                          <span className="tabular-nums text-lg font-bold">{formatPrice(effective)}</span>
                        </div>
                        <p className="m-0 text-xs text-muted">
                          {o.product.inStock === false ? 'нет в наличии · ' : ''}
                          {o.product.url ? (
                            <button
                              className="min-h-9 cursor-pointer rounded px-2 text-xs text-primary underline"
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
                      </section>
                    );
                  })}
                </div>
              </div>
            );
          })()}
      </div>
    </div>
  );
}
