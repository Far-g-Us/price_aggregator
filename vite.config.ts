import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  // Рендерер собираем ОТДЕЛЬНО от каталога упаковщика. Раньше он был в dist/,
  // и vite build при каждой сборке вытирал dist/ целиком — то есть запуск
  // сборки уничтожал уже готовые артефакты, а запущенный portable exe блокировал
  // удаление с EBUSY. Теперь vite чистит только свой каталог, упаковщик —
  // свой.
  build: { outDir: 'build-renderer' },
  server: { port: 5173 },
});
