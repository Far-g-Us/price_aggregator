import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Favorite, HistoryPoint, OurCategoryInfo, ProductShelves, RendererApi, SchedulerStatus, StoreCatalog, StorePrices } from '../shared/api';
import type { PriceGroup } from '../shared/matching';
import { CITIES, CITY_STORES } from '../shared/catalog';
import { groupByProduct, parseSplitKey } from '../shared/matching';
import { formatPrice } from '../shared/format';
import { rootShelves } from '../shared/taxonomy';
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
  return !summary.startsWith('Опрос завершён');
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
    setStoreOn({});
    setLastAction(null);
    setDetailKey(null);
    setOurCategories(null);
    reloadLists();
  }, [reloadLists]);

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
      // Гарды независимые: история могла уже грузиться из карточки («история»),
      // и общий continue глушил бы загрузку полок — фича просто не появлялась.
      if (hist[hkey] === undefined || hist[hkey] === 'error') {
        fetchHist(hkey, {
          canonicalId: o.product.canonicalId,
          storeId: o.storeId,
          city,
        });
      }
      if (shelves[hkey] === undefined || shelves[hkey] === 'error') {
        fetchShelves(hkey, {
          canonicalId: o.product.canonicalId,
          storeId: o.storeId,
          city,
        });
      }
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
    const action = lastAction;
    // Город передаём явно: кнопка «Опросить сейчас» в подвале не привязана к
    // последнему открытому списку, и без city ядро опрашивало бы все города.
    window.api
      .runScheduler({ city })
      .then((d) => {
        setSched(d.status);
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
            // Причина обязательна: «Опрос не удался» без текста — это ровно тот
        // молчаливый отказ, который чинили в категориях.
        setPollMsg({ text: `Опрос не удался: ${errText(e)}`, tone: 'warn' });
      });
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
    // через 45 с сорвёт загрузку той полки, которую открыли вместо неё:
    // скелет исчезнет на середине, а над результатами появится ложная ошибка
    // про магазин, который пользователь уже закрыл.
    const stalled = setTimeout(() => {
      if (token !== shelfTokenRef.current) return;
      setCatLoading(false);
      setCatError({ kind: 'error', text: `Магазин не ответил за ${SHELF_TIMEOUT_MS / 1000} секунд — попробуй открыть полку ещё раз.` });
    }, SHELF_TIMEOUT_MS);
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
    // через 45 с сорвёт загрузку той полки, которую открыли вместо неё:
    // скелет исчезнет на середине, а над результатами появится ложная ошибка
    // про магазин, который пользователь уже закрыл.
    const stalled = setTimeout(() => {
      if (token !== shelfTokenRef.current) return;
      setCatLoading(false);
      setCatError({ kind: 'error', text: `Магазин не ответил за ${SHELF_TIMEOUT_MS / 1000} секунд — попробуй открыть полку ещё раз.` });
    }, SHELF_TIMEOUT_MS);
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
  // иначе они были бы в списке дважды.
  const virtualShelf = (ourCategories ?? []).find((c) => c.virtual === true) ?? null;
  const realShelves = rootShelves(ourCategories ?? []);

const groups = useMemo(() => {
    if (!results) return null;
    const rawCount = results.reduce((n, s) => n + s.items.length, 0);
    // Разрыв склейки в пределах одного магазина невозможен по смыслу: два
    // товара одной сети с одинаковым названием — это почти всегда один товар,
    // а если нет — они и так в одной карточке, и разделить их нечем.
    const items = results.flatMap((s) =>
      storeOn[s.storeId] === false
        ? []
        : s.items.filter((p) => {
            if (promoOnly && p.oldPrice == null && p.promoPrice == null) return false;
            if (stockOnly && p.inStock === false) return false;
            return true;
          }),
    );
const list = groupByProduct(items, splits);
    const minOf = (g: (typeof list)[number]) =>
      Math.min(...g.offers.map((o) => o.product.promoPrice ?? o.product.price));
    if (sort !== 'none') list.sort((a, b) => (sort === 'asc' ? minOf(a) - minOf(b) : minOf(b) - minOf(a)));
    return { groups: list, stores: results, rawCount };
    // splits в зависимостях обязателен: без него React держит мемоизацию при
    // неизменных аргументах, и после отметки «это разные товары» карточка
    // осталась бы склеенной до смены фильтра — пользователь счёл бы кнопку
    // сломанной.
  }, [results, storeOn, promoOnly, stockOnly, sort, splits]);

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
  const goPage = (n: number) => {
    setPage(Math.min(Math.max(1, n), pageCount));
    resultsRef.current?.focus();
  };

// Фильтры меняют groups, но не results, поэтому сброса на [results] для них
  // не хватает: сняли галочку магазина на 5-й странице ( стало 2 страницы —
  // вид ужат), вернули галочку — и выдача молча прыгнула на товары 97–120.
  // Приводим state к фактической странице; для обычного клика «вперёд» это
  // no-op, потому что pageNo там и так равен page.
  // Массив зависимостей здесь НЕ exhaustive и это намеренно: pageNo — сводное
  // значение (page и pageCount), а читать из эффекта надо только pageNo.
  // Если добавить page в зависимости ради «правильности», синхронизация с
  // фильтрами перестанет работать. ESLint в проекте нет, поэтому предупредить
  // об этом некому — предупреждение здесь.
  useEffect(() => {
    setPage(pageNo);
  }, [pageNo]);

  const storeName = (id: string) =>
    CITY_STORES[city]?.find((s) => s.storeId === id)?.name ?? id;

  return (
    <div className="mx-auto max-w-6xl bg-cream px-6 pb-3 text-ink">
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
          <button
              type="button"
              className="flex min-h-9 w-9 flex-none cursor-pointer items-center justify-center rounded-full border border-line bg-card text-ink transition-colors hover:border-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
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
                  const stores = CITY_STORES[c.id] ?? [];
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

        {/* Поиск живёт под иконкой в шапке: на главной он занимал целую полосу ради
            одного поля, а при открытой полке отнимал место у результатов. */}
        {searchOpen && (
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
              className="min-h-11 flex-1 rounded-l-xl rounded-r-none border border-r-0 border-line bg-card px-3.5 text-base text-ink focus:outline-2 focus:outline-primary"
            />
            <button
              type="submit"
              className="flex min-h-11 min-w-[7.5rem] cursor-pointer items-center justify-center gap-2 rounded-l-none rounded-r-xl border-none bg-primary px-6 text-base text-white transition-colors hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-70"
              disabled={searching}
            >
              {searching && <Spinner />}
              {searching ? 'Ищу…' : 'Найти'}
            </button>
          </form>
        )}
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
        <PollProgress />
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
        <p className="m-0 mb-4 text-[13px] text-muted">
          Цены — по конкретному магазину, не «в среднем по городу»: даже соседние
          магазины одной сети могут стоить по-разному. Один и тот же товар
          в разных сетях склеивается по штрих-коду, иначе — по названию, бренду и фасовке.
        </p>

        {/* Списки категорий живут, пока пользователь на главной. Как только начат
            поиск или открыта полка — они уходят, иначе под результатами
            торчит дубль того же списка. Возвращает их «← к категориям». */}
        {results === null && !searching && !catLoading && (
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
              <button
                className={
                  source === 'favorites'
                    ? 'min-h-9 cursor-pointer rounded-full border border-primary bg-primary px-3.5 py-1.5 text-sm text-white'
                    : 'min-h-9 cursor-pointer rounded-full border border-line bg-card px-3.5 py-1.5 text-sm text-ink hover:border-primary'
                }
                onClick={() => setSource('favorites')}
                aria-pressed={source === 'favorites'}
              >
                Избранное{favorites.length > 0 ? ` (${favorites.length})` : ''}
              </button>
              <span className="text-[13px] text-muted">
                {source === 'favorites'
                  ? 'Отмеченные товары и целевые цены: уведомим, когда сеть отдаст цену ниже.'
                  : source === 'ours'
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
                    {/* Число сетей одинаково для всех полок города — десять раз
                        повторять его в строках незачем, поэтому оно вынесено
                        одной строкой над панелью. */}
                    <p className="mb-1.5 mt-3 text-[13px] text-muted">
                      Опрашиваем {storesPhrase(realShelves[0]?.storeCount ?? 0)} — столько сетей сейчас готово.
                    </p>
                    {/* Плоский список плиток — тем же видом, что витрина сети
                        (акцент слева, скруглённая карточка, сетка). Раньше здесь
                        был <ul> с раскрываемыми детьми; вложенность снята, и
                        список из 16 полок читается так же, как каталог магазина. */}
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2.5">
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
                              размерах только чище (детали не сливаются). */}
                          <CategoryIcon id={c.id} className="h-11 w-11 flex-none" />
                          <span>{c.name}</span>
                          {/* Число запросов остаётся: после снятия вложенности
                              это единственный сигнал, что полка широкая и клик
                              по ней дорогой (8 сетевых запросов). */}
                          <span className="text-xs font-normal text-muted">{queriesPhrase(c.queryCount)}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {virtualShelf && (
                  <div className="mt-2 flex items-center gap-3 rounded-2xl border border-warnline bg-warnbox px-3 py-2">
                    <CategoryIcon id={virtualShelf.id} className="h-8 w-8 flex-none" accent />
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
                        aria-expanded={storeOpen[s.storeId] !== false}
                        aria-controls={`cat-panel-${s.storeId}`}
                        onClick={() =>
                          setStoreOpen((prev) => ({ ...prev, [s.storeId]: prev[s.storeId] === false }))
                        }
                      >
                        <Chevron open={storeOpen[s.storeId] !== false} />
                        <span className="flex-1 text-base font-semibold">{s.name}</span>
                        <span className="text-xs font-normal text-muted tabular-nums">
                          {sectionsPhrase(s.categories.length)}
                        </span>
                      </button>
                    </h2>
                    {storeOpen[s.storeId] !== false && (
                      <div
                        id={`cat-panel-${s.storeId}`}
                        className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2.5"
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
                                // Картинки категорий у Магнита вертикальные (318×384),
                                // поэтому режем по центру: object-cover с полной
                                // шириной и фиксированной высотой даёт ровные плитки.
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
                    <p className="mb-3 text-[13px] text-muted">
                      {favorites.length} {favorites.length === 1 ? 'товар' : 'товаров'}. Цена — последняя,
                      которую записал опрос; целевая сработает, когда сеть отдаст ниже.
                    </p>
                    <section className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3" aria-label="Избранные товары">
                      {favorites.map((f) => {
                        const fkey = favKey(f.canonicalId, f.storeId, f.city);
                        const hit = f.targetPrice !== null && f.price !== null && f.price < f.targetPrice;
                        return (
                          <article key={fkey} className="rounded-2xl border border-line bg-card p-4">
                            <h2 className="mb-1 mt-0 text-base font-semibold leading-snug">{f.name}</h2>
                            <div className="flex items-baseline justify-between gap-2 text-sm">
                              <span className="text-muted">{storeName(f.storeId)}</span>
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
                                  void setTargetPrice(f.canonicalId, f.storeId, f.city, parsed);
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
                              onClick={() => void toggleFavorite(f.canonicalId, f.storeId, f.city)}
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
              className="min-h-8 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-ink"
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
              className="min-h-8 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-ink"
              onClick={() => setFavError(null)}
            >
              скрыть
            </button>
          </div>
        )}
{groups && (
          <p className="m-0 mb-4 text-[13px] text-muted" aria-live="polite">
            {/* Число найденного объявляется здесь же: строка сетей ниже
                сообщает только о состоянии запросов, и по ней нельзя понять,
                пришли товары или нет. Считаем groups.length, а не rawCount:
                rawCount — это позиции по сетям до склейки, и один товар в трёх
                магазинах дал бы «120 товаров» при 40 карточках на экране. */}
            {groups.rawCount > 0 && `Найдено ${plural(groups.groups.length, 'товар', 'товара', 'товаров')} · `}
            {groups.stores
              .map((s) =>
                s.ready && !s.error
                  ? `${s.name}: ${s.cached ? 'из локальной базы' : 'опрошен'}`
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
        {groups && groups.groups.length === 0 && groups.rawCount === 0 && !catLoading && !searchError && !catError && (
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
          <section
            ref={resultsRef}
            tabIndex={-1}
            aria-busy={searching || catLoading}
            aria-label={`Найденные товары, страница ${pageNo} из ${pageCount}`}
            className="grid scroll-mt-20 grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3 focus-visible:outline-2 focus-visible:outline-primary"
          >
            {pagedGroups.map((g) => (
              <article key={g.key} className="rounded-2xl border border-line bg-card p-4">
                <ProductImage src={g.imageUrl} name={g.name} />
<h2 className="mb-2 mt-1 text-base font-semibold leading-snug">{g.name}</h2>
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <button
                    className="min-h-8 cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-ink"
                    onClick={() => openDetail(g.key)}
                  >
                    Подробнее
                  </button>
                  {/* Кнопка только когда в карточке есть что разделять: одна
                      сеть в группе не бывает склеена по названию, значит и
                      спорить не о чем. */}
                  {new Set(g.offers.map((o) => o.storeId)).size > 1 && (
                    <button
                      className="min-h-8 cursor-pointer rounded-lg border border-warnline bg-warnbox px-2.5 py-1 text-xs text-ink disabled:cursor-not-allowed disabled:opacity-60"
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
                  const hkey = `${o.storeId}:${o.product.canonicalId}:${city}`;
                  const fkey = favKey(o.product.canonicalId, o.storeId, city);
                  const faved = isFav(o.product.canonicalId, o.storeId, city);
                  const target = favTarget(o.product.canonicalId, o.storeId, city);
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
                          <button
                            className={`ml-1 min-h-8 cursor-pointer rounded-lg border px-2 py-1 text-xs ${
                              faved ? 'border-primary bg-primary text-white' : 'border-line bg-card text-ink'
                            } disabled:cursor-not-allowed disabled:opacity-60`}
                            aria-pressed={faved}
                            aria-label={
                              faved
                                ? `Убрать «${o.product.name}» из избранного`
                                : `Добавить «${o.product.name}» в избранное`
                            }
                            disabled={favBusy === fkey}
                            onClick={() => void toggleFavorite(o.product.canonicalId, o.storeId, city)}
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
                              void setTargetPrice(o.product.canonicalId, o.storeId, city, parsed);
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
              className="min-h-9 cursor-pointer rounded-lg border border-line bg-card px-3 py-1.5 text-xs text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => goPage(1)}
              disabled={pageNo === 1}
            >
              в начало
            </button>
            <button
              className="min-h-9 cursor-pointer rounded-lg border border-line bg-card px-3 py-1.5 text-xs text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => goPage(pageNo - 1)}
              disabled={pageNo === 1}
            >
              ← назад
            </button>
            <span className="px-1 tabular-nums text-muted" aria-live="polite">
              Страница {pageNo} из {pageCount}
            </span>
            <button
              className="min-h-9 cursor-pointer rounded-lg border border-line bg-card px-3 py-1.5 text-xs text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => goPage(pageNo + 1)}
              disabled={pageNo === pageCount}
            >
              вперёд →
            </button>
            <button
              className="min-h-9 cursor-pointer rounded-lg border border-line bg-card px-3 py-1.5 text-xs text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
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

        {/* Три колонки, а не flex с justify-between: текст опроса меняет длину
            («(добавлено 1, без изменений 22)»), и при flex кнопка «Опросить
            сейчас» уезжала вбок на 40+ пикселей — футер «танцевал». Первая
колонка забирает всю свободную ширину, последние две стоят на месте. */}
        <footer className="mt-7 grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span>Локально · SQLite · IPC: {status} · запись в историю только при изменении цены</span>
          <span className="whitespace-nowrap tabular-nums">
            {sched && sched.lastRun
              ? `опрос каждые ${sched.intervalHours}ч · последний: ${sched.lastRun.slice(0, 16).replace('T', ' ')}${pollCountsText(sched.counts)}`
              : `опрос каждые ${sched?.intervalHours ?? 6}ч · ещё не было`}
          </span>
          {/* Кнопка опроса намеренно мелкая и без min-w: в подвале это служебное
              действие, а не главный призыв, и 184 пикселя ширины рядом с
              версией выглядели как баннер. min-w держали только ради того, чтобы
              футер не «танцевал» — но левая колонка и так забирает всю
              свободную ширину, поэтому фиксировать ширину нечего. Размер
              совпадает с соседними мелкими кнопками файла (min-h-8/text-xs). */}
          <button
            className="flex min-h-8 cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-line bg-card px-2.5 text-xs text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
            onClick={runPoll}
            disabled={sched?.running === true}
          >
            {sched?.running === true && <Spinner className="h-3 w-3" />}
            {sched?.running === true ? 'Опрашиваю…' : 'Опросить сейчас'}
          </button>
          <span className="tabular-nums">v{version}</span>
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
                    const hkey = `${o.storeId}:${o.product.canonicalId}:${city}`;
                    const effective = o.product.promoPrice ?? o.product.price;
                    return (
                      <section key={hkey} className="mb-4 rounded-xl border border-line p-3">
                        <div className="flex items-baseline justify-between">
                          <strong>{storeName(o.storeId)}</strong>
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
                        {(() => {
                          const scope = { canonicalId: o.product.canonicalId, storeId: o.storeId, city };
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
                                  className="mt-2 min-h-9 cursor-pointer rounded px-1 text-xs text-primary underline disabled:opacity-50"
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
      </div>
    </div>
  );
}





