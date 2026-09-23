import React, { useEffect, useMemo, useState } from 'react';
import type { HistoryPoint, RendererApi, SchedulerStatus, StorePrices } from '../shared/api';
import { CITIES, CITY_STORES } from '../shared/catalog';
import { groupByProduct } from '../shared/matching';

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

const css = `
  :root {
    --primary: #059669; --primary-dark: #047857; --accent: #d97706;
    --bg: #ecfdf5; --card: #ffffff; --ink: #0f172a; --muted: #475569;
    --border: #d8efe8; --danger: #dc2626; --warn-bg: #fff3cd; --ok-bg: #d4edda;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font-family: system-ui, 'Segoe UI', Roboto, sans-serif; font-size: 16px; line-height: 1.5; }
  .shell { max-width: 1080px; margin: 0 auto; padding: 20px 24px 40px; }
  header.top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .logo { width: 40px; height: 40px; border-radius: 12px; background: var(--primary);
    display: flex; align-items: center; justify-content: center; flex: none; }
  h1 { font-size: 22px; margin: 0; }
  .ver { font-size: 12px; color: var(--muted); border: 1px solid var(--border);
    border-radius: 999px; padding: 2px 10px; background: var(--card); }
  .cities { display: flex; gap: 8px; margin-left: auto; flex-wrap: wrap; }
  .city { border: 1px solid var(--border); background: var(--card); color: var(--ink);
    border-radius: 999px; padding: 6px 14px; font-size: 14px; cursor: pointer;
    transition: background 150ms ease, color 150ms ease; min-height: 36px; }
  .city.active { background: var(--primary); border-color: var(--primary); color: #fff; }
  .city:disabled { opacity: 0.55; cursor: not-allowed; }
  button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .search { display: flex; gap: 8px; margin: 20px 0 8px; }
  .search input { flex: 1; font-size: 16px; padding: 10px 14px; border-radius: 12px;
    border: 1px solid var(--border); background: var(--card); color: var(--ink); min-height: 44px; }
  .search button { font-size: 16px; padding: 10px 22px; border-radius: 12px; border: none;
    background: var(--primary); color: #fff; cursor: pointer; min-height: 44px;
    transition: background 150ms ease; }
  .search button:hover { background: var(--primary-dark); }
  .hint { font-size: 13px; color: var(--muted); margin: 0 0 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 16px; }
  .card h2 { font-size: 16px; margin: 0 0 8px; }
  .card img { width: 100%; height: 140px; object-fit: contain; border-radius: 8px; background: var(--bg); }
  .offer { display: flex; justify-content: space-between; align-items: baseline;
    gap: 8px; padding: 6px 0; border-top: 1px solid var(--border); font-size: 14px; }
  .offer:first-of-type { border-top: none; }
  .price { font-size: 18px; font-weight: 700; white-space: nowrap; }
  .old { color: var(--muted); text-decoration: line-through; font-size: 13px; margin-right: 6px; }
  .store { color: var(--muted); }
  .mini-btn { font-size: 12px; border: 1px solid var(--border); background: var(--card);
    border-radius: 8px; padding: 4px 10px; cursor: pointer; min-height: 32px; color: var(--ink); }
  .chart { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px; }
  .chart svg { width: 100%; height: 90px; display: block; }
  .chart .meta { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .banner { border-radius: 12px; padding: 10px 14px; margin: 12px 0; font-size: 14px; }
  .banner.warn { background: var(--warn-bg); }
  .banner.ok { background: var(--ok-bg); }
  .banner button { margin-left: 8px; cursor: pointer; min-height: 36px; }
  .empty { background: var(--card); border: 1px dashed var(--border); border-radius: 14px;
    padding: 28px; text-align: center; color: var(--muted); margin-top: 12px; }
  footer { margin-top: 28px; font-size: 12px; color: var(--muted);
    display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

function HistoryChart({ points }: { points: HistoryPoint[] }) {
  if (points.length === 0) return <p className="meta">Пока нет замеров — появятся после опросов.</p>;
  const eff = points.map((p) => p.promo_price ?? p.price);
  if (points.length === 1) {
    const only = points[0];
    return (
      <p className="meta">
        Один замер: {only?.price} ₽ ({only?.collected_at.slice(0, 10)}). График появится со второго.
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
    <div className="chart">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`История цены: мин ${min}, макс ${max}`}>
        <polyline points={dots} fill="none" stroke="#059669" strokeWidth="2" />
        {points.map((p, i) => {
          const v = p.promo_price ?? p.price;
          const x = (i / (points.length - 1)) * w;
          const y = h - 6 - ((v - min) / span) * (h - 16);
          return <circle key={i} cx={x} cy={y} r="2.5" fill={v === min ? '#d97706' : '#059669'} />;
        })}
      </svg>
      <p className="meta">
        мин {min} ₽ · макс {max} ₽ · замеров {points.length}
        {promoMarks > 0 ? ` · из них по акции ${promoMarks}` : ''} · {first} → {last}
      </p>
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
  const [openHist, setOpenHist] = useState<string | null>(null);
  const [hist, setHist] = useState<Record<string, HistoryPoint[] | 'error'>>({});
  const [sched, setSched] = useState<SchedulerStatus | null>(null);

  useEffect(() => {
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
    return off;
  }, []);

  const fetchHist = (key: string, args: { canonicalId: string; storeId: string; city: string }) => {
    window.api
      .getHistory(args)
      .then((h) => setHist((prev) => ({ ...prev, [key]: h })))
      .catch(() => setHist((prev) => ({ ...prev, [key]: 'error' })));
  };

  const toggleHist = (key: string, args: { canonicalId: string; storeId: string; city: string }) => {
    if (openHist === key) {
      setOpenHist(null);
      return;
    }
    setOpenHist(key);
    if (hist[key] !== undefined && hist[key] !== 'error') return;
    fetchHist(key, args);
  };

  const runPoll = () => {
    window.api
      .runScheduler()
      .then((s) => setSched(s))
      .catch(() => {});
  };

  const doSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setResults(null);
    window.api
      .getPrices({ city, query: query.trim() })
      .then((r) => setResults(r))
      .catch(() => setResults([]));
  };

  const groups = useMemo(() => {
    if (!results) return null;
    const items = results.flatMap((s) => s.items);
    return { groups: groupByProduct(items), stores: results };
  }, [results]);

  const storeName = (id: string) =>
    CITY_STORES[city]?.find((s) => s.storeId === id)?.name ?? id;

  return (
    <div className="shell">
      <style>{css}</style>
      <header className="top">
        <span className="logo" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
            <path d="M6 7h15l-1.5 9h-12z" />
            <path d="M6 7l-1-4H2" />
            <circle cx="9" cy="20" r="1.5" />
            <circle cx="17" cy="20" r="1.5" />
          </svg>
        </span>
        <h1>PriceAggregator</h1>
        <span className="ver" title="Версия приложения">v{version}</span>
        <nav className="cities" aria-label="Выбор города">
          {CITIES.map((c) => (
            <button
              key={c.id}
              className={city === c.id ? 'city active' : 'city'}
              disabled={!c.ready}
              title={c.ready ? c.name : `${c.name} — скоро`}
              onClick={() => {
                setCity(c.id);
                setResults(null);
              }}
            >
              {c.name}
            </button>
          ))}
        </nav>
      </header>

      {update.kind === 'available' && (
        <p className="banner warn" role="status">
          Доступна версия {update.latest}, скачиваю из GitHub Releases…
        </p>
      )}
      {update.kind === 'downloaded' && (
        <p className="banner ok" role="status">
          Версия {update.latest} скачана.
          <button
            onClick={() =>
              window.api.installUpdate().catch(() => setUpdate({ kind: 'error', message: 'не удалось запустить установку' }))
            }
          >
            Установить и перезапустить
          </button>
        </p>
      )}
      {update.kind === 'error' && (
        <p className="banner warn" role="alert">
          Ошибка обновлений: {update.message}
        </p>
      )}

      <form className="search" onSubmit={doSearch}>
        <label htmlFor="q" style={{ position: 'absolute', left: -9999 }}>
          Поиск товара
        </label>
        <input
          id="q"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Молоко, яйца, хлеб…"
          autoComplete="off"
        />
        <button type="submit">Найти</button>
      </form>
      <p className="hint">
        Цены — по конкретному магазину, не «в среднем по городу»: даже соседние
        магазины одной сети могут стоить по-разному. Один и тот же товар
        в разных сетях склеивается по штрих-коду, иначе — по названию, бренду и фасовке.
      </p>

      {groups && (
        <p className="hint" aria-live="polite">
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

      {groups && groups.groups.length === 0 && (
        <div className="empty" role="status">
          По запросу «{query.trim()}» ничего не нашлось. Проверь название
          или попробуй позже — сети иногда отвечают с задержкой.
        </div>
      )}

      {groups && groups.groups.length > 0 && (
        <section className="grid" aria-label="Найденные товары">
          {groups.groups.map((g) => (
            <article className="card" key={g.key}>
              {g.imageUrl && (
                <img
                  src={g.imageUrl}
                  alt=""
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              )}
              <h2>{g.name}</h2>
              {g.offers.map((o) => {
                const effective = o.product.promoPrice ?? o.product.price;
                const struck = o.product.oldPrice ?? (o.product.promoPrice != null ? o.product.price : null);
                const hkey = `${o.storeId}:${o.product.canonicalId}:${city}`;
                return (
                  <div key={`${o.storeId}:${o.product.canonicalId}`}>
                    <div className="offer">
                      <span className="store">{storeName(o.storeId)}</span>
                      <span>
                        {struck !== null && struck !== undefined && (
                          <span className="old">{struck} ₽</span>
                        )}
                        <span className="price">{effective} ₽</span>{' '}
                        <button
                          className="mini-btn"
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
                      (hist[hkey] === 'error' ? (
                        <p className="meta" role="alert">
                          Не удалось загрузить историю.{' '}
                          <button
                            className="mini-btn"
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

      <footer>
        <span>Локально · SQLite · IPC: {status} · запись в историю только при изменении цены</span>
        <span>
          {sched
            ? `опрос каждые ${sched.intervalHours}ч · последний: ${sched.lastRun ? sched.lastRun.slice(0, 16).replace('T', ' ') : 'ещё не было'} (+${sched.counts.inserted}/=${sched.counts.skipped}/!${sched.counts.failed})`
            : 'планировщик…'}
          <button className="mini-btn" onClick={runPoll} style={{ marginLeft: 8 }} disabled={sched?.running === true}>
            {sched?.running === true ? 'Опрашиваю…' : 'Опросить сейчас'}
          </button>
        </span>
        <span>v{version}</span>
      </footer>
    </div>
  );
}
