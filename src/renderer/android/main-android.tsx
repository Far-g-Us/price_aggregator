/**
 * Вход Android-сборки. Отдельный от `main.tsx` (Electron) по двум причинам:
 *
 * 1. Здесь `window.api` ставит сам мост, и он обязан быть готов ДО первого рендера:
 *    `App.tsx` читает `window.api` в эффекте с пустым списком зависимостей, то
 *    есть поздняя установка навсегда оставила бы вечный баннер «нет preload».
 * 2. Electron-сборка не должна видеть ни ядра, ни sql.js, ни `@capacitor/core` —
 *    иначе всё это уедет в portable-exe. Раздельные точки входа и есть
 *    раздельные бандлы.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../App';
import '../index.css';
import { installAndroidApi } from './bootstrap';
import { APP_VERSION } from './version';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('renderer crashed', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" style={{ maxWidth: 640, margin: '48px auto', padding: '0 24px' }}>
        <h1 style={{ fontSize: 20, marginBottom: 12 }}>Интерфейс не смог запуститься</h1>
        <p style={{ lineHeight: 1.5, marginBottom: 12 }}>
          Это ошибка в самом окне приложения, а не в сети: цены и история в базе не пострадали.
          Подробности — в logs приложения (adb logcat).
        </p>
        <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{error.message}</pre>
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              minHeight: 44,
              padding: '0 16px',
              borderRadius: 8,
              border: '1px solid var(--color-primary-dark)',
              background: 'var(--color-primary-dark)',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            Перезагрузить приложение
          </button>
        </div>
      </div>
    );
  }
}

const mount = (): void => {
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
};

// Мост ставится ДО рендера: см. пункт 1 в шапке файла. Ошибка установки не
// скрывается — тогда App сам покажет баннер с честным объяснением, что
// получилось и что нет.
//
// Путь к wasm — фиксированное имя рядом с документом: копию кладёт плагин
// `pa-sql-wasm` из vite.android.config.ts. В Capacitor документ живёт на
// https://localhost/, и wasm лежит в его корне.
const wasmUrl = new URL('sql-wasm.wasm', window.location.href).href;
installAndroidApi(wasmUrl, APP_VERSION)
  .then(mount)
  .catch((err) => {
    console.error('мост к ядру не поднялся', err);
    mount();
  });
