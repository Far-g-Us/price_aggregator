// Файловые порты без Electron: только node:fs. Держим отдельно от
// node-platform.ts, чтобы тесты (под tsx, где `import { app } from 'electron'`
// падает) могли пользоваться файловым хранилищем и не тащить Electron.
import fs from 'node:fs';
import path from 'node:path';
import type { AppStorage, JsonStore } from '../src/core/platform.js';

export function fileStorageAt(file: string): AppStorage {
  return {
    readDb(): Uint8Array | null {
      return fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : null;
    },
    writeDb(bytes: Uint8Array): void {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    },
  };
}

export function jsonStoreAt(dir: string): JsonStore {
  return {
    read(name: string): string | null {
      const file = path.join(dir, name);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
    },
    write(name: string, text: string): void {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    },
  };
}
