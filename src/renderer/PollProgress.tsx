// Прогресс опроса живёт здесь, а не в App, и подписан на канал сам.
//
// Пока состояние прогресса лежало в App, каждое сообщение scheduler:progress
// перерисовывало всё дерево целиком: App — файл на 2200+ строк, 24 карточки
// товара на страницу, ни одного React.memo. Electron писал в консоль
// [Violation] 'message' handler took 521ms — это и есть эта перерисовка.
//
// Отдельный лист с собственной подпиской решает проблему структурно: App на
// прогрессе не рендерится вообще. Подписки preload возвращают функцию
// отписки, а канал позволяет нескольким слушателям, так что вторая подписка
// на тот же ивент законна.
import React from 'react';
import { CITY_STORES } from '../shared/catalog';

// Имя сети для плашки прогресса. Список собран из каталога, а не зашит рядом с
// подпиской: новая сеть в CITY_STORES подхватится сама, иначе в прогрессе
// появился бы внутренний код вместо названия.
const STORE_LABEL: Record<string, string> = {};
for (const city of Object.values(CITY_STORES)) {
  for (const s of city) if (STORE_LABEL[s.storeId] === undefined) STORE_LABEL[s.storeId] = s.name;
}

export function PollProgress(props: { onRunningChange?: (running: boolean) => void }): React.ReactElement | null {
  const { onRunningChange } = props;
  const [progress, setProgress] = React.useState<{ done: number; total: number; storeId?: string } | null>(null);
  // Флаг «идёт» держится в ref, а не в состоянии: сообщения прогресса идут
  // пачками по 4 в секунду, и обновление состояния на каждом уронило бы весь App
  // заново — ровно та перерисовка, ради которой этот лист и вынесен отдельно.
  // Вверх уходит только СМЕНА флага (два раза за прогон), а не каждый тик.
  const running = React.useRef(false);
  const notify = React.useRef(onRunningChange);
  React.useEffect(() => {
    notify.current = onRunningChange;
  }, [onRunningChange]);

  React.useEffect(() => {
    if (!window.api) return;
    const offProgress = window.api.onSchedulerProgress((done, total, storeId) => {
      if (!running.current) {
        running.current = true;
        notify.current?.(true);
      }
      // ТочныйOptionalPropertyTypes: ключ без значения туда не кладём — иначе
      // `storeId: undefined` не равен отсутствующему ключу по типу.
      setProgress(storeId === undefined ? { done, total } : { done, total, storeId });
    });
    // Сводка приходит и по событию, и по возврату runScheduler: дубль нужен
    // для случая, когда проход завершился, пока лист ещё не смонтирован.
    const offDone = window.api.onSchedulerDone(() => {
      running.current = false;
      notify.current?.(false);
      setProgress(null);
    });
    return () => {
      offProgress();
      offDone();
    };
  }, []);

  if (!progress) return null;
  // Кто именно сейчас опрашивается: без этого прогресс выглядит как «что-то
  // делается в тишине», а по одному счётчику непонятно, где именно застряло.
  // Оформление — как у остальных плашек приложения (`rounded-full border
  // border-line bg-card`): зелёного текста на светлом фоне 12px не хватает до
  // контраста AA, а `bg-accent/15` в проекте вообще не определён (нет --color-accent).
  const name = progress.storeId === undefined ? null : STORE_LABEL[progress.storeId] ?? progress.storeId;
  return (
    <p className="m-0 mb-4 flex flex-wrap items-center gap-2 text-[13px] text-muted" role="status">
      <span>Опрашиваю… {progress.done}/{progress.total}</span>
      {name !== null && (
        <span className="rounded-full border border-line bg-card px-2 py-0.5 text-[12px] font-medium text-primary-dark">
          Сейчас: {name}
        </span>
      )}
    </p>
  );
}