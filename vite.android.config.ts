import { copyFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Копирует `sql-wasm.wasm` рядом с `index.html` сборки.
 *
 * Почему не `import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'`: директива
 * отдаёт ассет С ХЕШЕМ в имени, то есть путь известен только после сборки, а
 * `initSqlJs({ locateFile })` зовётся в рантайме и должен знать его заранее.
 * Фиксированное имя снимает проблему: `locateFile` возвращает
 * `sql-wasm.wasm` относительно текущего документа (в Capacitor это
 * `https://localhost/`), и wasm лежит ровно рядом.
 */
const sqlWasm = (): Plugin => ({
  name: 'pa-sql-wasm',
  apply: 'build',
  closeBundle() {
    // Путь к пакету НЕ через require.resolve: в `exports` sql.js нет подпути
    // './package.json', и такая попытка роняет всю сборку. node_modules лежит
    // рядом с конфигом, поэтому путь строится от него.
    const src = resolve(import.meta.dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    if (!existsSync(src)) {
      this.error(`sql-wasm.wasm не найден: ${src}`);
    }
    const outDir = resolve(import.meta.dirname, 'build-android');
    copyFileSync(src, join(outDir, 'sql-wasm.wasm'));
    // Capacitor требует, чтобы документ назывался `index.html`, а vite build
    // называет его по имени входа (`android.html`). Поэтому переименовываем
    // ЗДЕСЬ: иначе `cap sync` отказывается работать («must contain an
    // index.html file»), а руками переименовывать в двух местах — значит
    // забыть при следующей правке.
    renameSync(join(outDir, 'android.html'), join(outDir, 'index.html'));
  },
});

/**
 * Сборка интерфейса ДЛЯ ANDROID. Отдельный конфиг, а не режим основного:
 * каталог build-renderer едет и в Capacitor, и в electron-builder, поэтому общий
 * бандл либо утащил бы в Windows-exe ядро с sql.js и динамическим импортом
 * playwright, либо — наоборот — не дал бы Android то, что ему нужно.
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), sqlWasm()],
  base: './',
  build: {
    outDir: 'build-android',
    assetsInlineLimit: 0,
    rollupOptions: {
      // Вход указываем ЯВНО: иначе vite build берёт корневой index.html — то
      // есть Electron-вход, и Android получает интерфейс без моста, который
      // вечно показывает баннер «нет preload».
      input: resolve(import.meta.dirname, 'android.html'),
    },
  },
  server: { port: 5174 },
});
