import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// Рендерер без границы ошибок падал в пустое окно: одно недоступное
// window.api-метод или исключение в эффекте — и пользователь видел белый
// экран без единого слова. Проверено: отсутствие window.api.ping даёт
// «pageerror» и пустой документ. Показываем, что случилось и куда смотреть.
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  buttonRef = React.createRef<HTMLButtonElement>();

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('renderer crashed', error, info.componentStack);
    // Фокус на кнопке: иначе после падения он остаётся на body и
    // клавиатурный пользователь не попадёт в единственное действие.
    this.buttonRef.current?.focus();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" style={{ maxWidth: 640, margin: '48px auto', padding: '0 24px' }}>
        <h1 style={{ fontSize: 20, marginBottom: 12 }}>Интерфейс не смог запуститься</h1>
        <p style={{ lineHeight: 1.5, marginBottom: 12 }}>
          Это ошибка в самом окне приложения, а не в сети: цены и история в базе не пострадали. Подробности — в консоли
          разработчика (F12).
        </p>
        <pre
          style={{
            padding: 12,
            background: 'var(--color-warnbox)',
            borderRadius: 8,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {error.message}
        </pre>
        <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
          <button
            type="button"
            ref={this.buttonRef}
            onClick={() => window.location.reload()}
            style={{
              minHeight: 44,
              padding: '0 16px',
              borderRadius: 8,
              // Не --color-primary: белый на нём даёт 3.75:1, ниже AA.
              border: '1px solid var(--color-primary-dark)',
              background: 'var(--color-primary-dark)',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            Перезагрузить окно
          </button>
          <span className="text-[13px] text-muted" style={{ alignSelf: 'center' }}>
            Не помогло — перезапустите приложение. Вероятнее всего, сборка интерфейса не совпадает с main-процессом.
          </span>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);