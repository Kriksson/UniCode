import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_FILE = 25 * 1024 * 1024;
const MAX_MESSAGE = 100 * 1024 * 1024;
const imageKind = data => data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
  : data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'jpg'
  : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? 'webp'
  : /^GIF8[79]a$/.test(data.toString('ascii', 0, 6)) ? 'gif' : null;

/** Immutable local copies keep attachments available in persistent Codex history. */
export class AttachmentStore {
  constructor(root) { this.root = root; this.queue = Promise.resolve(); }

  upload(value) {
    const operation = this.queue.catch(() => {}).then(() => this.write(value));
    this.queue = operation;
    return operation;
  }

  async write({ name, data } = {}) {
    if (typeof name !== 'string' || !name.trim() || name.length > 255
      || typeof data !== 'string' || data.length > Math.ceil(MAX_FILE / 3) * 4
      || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Неверный файл. Максимальный размер — 25 МБ.');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_FILE) throw new Error('Максимальный размер файла — 25 МБ.');
    let safeName = name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 180) || 'file';
    while (Buffer.byteLength(safeName) > 160) safeName = safeName.slice(0, -1);
    const id = randomUUID(); const kind = imageKind(bytes);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root);
    let total = 0;
    for (const entry of entries) total += (await stat(join(this.root, entry))).size;
    if (total + bytes.length > 2 * 1024 ** 3) throw new Error('Хранилище вложений UniCode заполнено (2 ГБ).');
    const filename = `${id}-${safeName}${kind && !safeName.toLowerCase().endsWith('.' + kind) ? '.' + kind : ''}`;
    const attachment = { id, name: safeName, size: bytes.length, image: !!kind };
    const path = join(this.root, filename);
    try {
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
      await writeFile(join(this.root, id + '.json'), JSON.stringify({ ...attachment, filename }), { mode: 0o600, flag: 'wx' });
    } catch (error) { await unlink(path).catch(() => {}); throw error; }
    return attachment;
  }

  async input(text, ids = []) {
    if (!Array.isArray(ids) || ids.length > 8 || new Set(ids).size !== ids.length) throw new Error('Можно прикрепить до 8 файлов.');
    const files = [];
    let total = 0;
    for (const id of ids) {
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Неверное вложение.');
      let file;
      try { file = JSON.parse(await readFile(join(this.root, id + '.json'), 'utf8')); }
      catch { throw new Error('Вложение не найдено. Прикрепите файл заново.'); }
      if (file.id !== id || typeof file.filename !== 'string' || /[\\/]/.test(file.filename)) throw new Error('Неверное вложение.');
      const path = join(this.root, file.filename);
      const info = await stat(path);
      total += info.size;
      if (!info.isFile() || info.size > MAX_FILE || total > MAX_MESSAGE) throw new Error('Общий размер вложений не должен превышать 100 МБ.');
      files.push({ name: file.name, path, image: file.image === true });
    }
    if (!text.trim() && !files.length) throw new Error('Добавьте сообщение или файл.');
    const combined = files.length ? `${text.trim()}\n\n<unicode_attachments>\n${JSON.stringify(files)}\n</unicode_attachments>` : text;
    return [{ type: 'text', text: combined.trim(), text_elements: [] }, ...files.filter(file => file.image).map(file => ({ type: 'localImage', path: file.path }))];
  }
}
