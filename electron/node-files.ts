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
      // Через временный файл с переименованием: обычная запись обрывается на
      // середине, и на диске остаётся битая база — а цены и история в ней
      // единственные, восстановить их неоткуда.
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, file);
    },
    backupDb(bytes: Uint8Array): void {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Так же через временный файл: оборванная на середине копия бесполезна
      // хуже отсутствующей — она выглядит как запасной вариант, который можно
      // развернуть, и при этом не разворачивается.
      const tmp = `${file}.pre-phase6.bak.tmp`;
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, `${file}.pre-phase6.bak`);
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
