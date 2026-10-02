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

export function PollProgress(): React.ReactElement | null {
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);

  React.useEffect(() => {
    if (!window.api) return;
    const offProgress = window.api.onSchedulerProgress((done, total) => setProgress({ done, total }));
    // Сводка приходит и по событию, и по возврату runScheduler: дубль нужен
    // для случая, когда проход завершился, пока лист ещё не смонтирован.
    const offDone = window.api.onSchedulerDone(() => setProgress(null));
    return () => {
      offProgress();
      offDone();
    };
  }, []);

  if (!progress) return null;
  return (
    <p className="m-0 mb-4 text-[13px] text-muted" role="status">
      Опрашиваю… {progress.done}/{progress.total}
    </p>
  );
}