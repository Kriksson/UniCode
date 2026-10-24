import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const empty = () => ({ version: 1, folders: [], chats: {}, hidden: [], selectedId: null, cwd: null, model: '' });

export function validateState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.folders) || !value.chats || Array.isArray(value.chats)
    || !Array.isArray(value.hidden)) throw new Error('Неверный формат локальных данных');
  if (JSON.stringify(value).length > 8_000_000) throw new Error('Слишком большой объём локальных данных');
  for (const folder of value.folders) {
    if (typeof folder.id !== 'string' || typeof folder.name !== 'string' || !folder.name.trim() || folder.name.length > 80)
      throw new Error('Неверное название папки');
  }
  return value;
}

export class LocalStore {
  constructor(path) { this.path = path; this.queue = Promise.resolve(); }

  async read() {
    try { return validateState(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') return empty();
      throw new Error(`Не удалось прочитать ${this.path}. Файл сохранён без изменений. ${error.message}`);
    }
  }

  save(value) {
    validateState(value);
    const serialized = JSON.stringify(value, null, 2);
    const operation = this.queue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(this.path + '.tmp', serialized, { mode: 0o600 });
      await rename(this.path + '.tmp', this.path);
    });
    this.queue = operation;
    return operation;
  }
}
