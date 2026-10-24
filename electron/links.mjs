import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export async function openMessageLink({ href, cwd }, shell) {
  if (typeof href !== 'string' || !href.trim() || href.length > 16384 || /[\u0000-\u001f\u007f]/.test(href)) throw new Error('Некорректная ссылка');
  if (/^(https?:|mailto:)/i.test(href)) {
    await shell.openExternal(new URL(href).href);
    return;
  }
  if (href.startsWith('//') || (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^file:/i.test(href))) throw new Error('Этот тип ссылки не поддерживается');
  let path;
  try { path = /^file:/i.test(href) ? fileURLToPath(href) : decodeURIComponent(href); }
  catch { throw new Error('Некорректный путь к файлу'); }
  if (path.startsWith('~/')) path = resolve(homedir(), path.slice(2));
  if (!isAbsolute(path)) path = resolve(typeof cwd === 'string' && isAbsolute(cwd) ? cwd : homedir(), path);
  let info;
  try { info = await stat(path); }
  catch (error) {
    // Source links may end in :line[:column] or #Lline[Ccolumn].
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw new Error(`Файл недоступен: ${path}`);
    const withoutLocation = path.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/, '');
    if (withoutLocation === path) throw new Error(`Файл не найден: ${path}`);
    path = withoutLocation;
    try { info = await stat(path); } catch { throw new Error(`Файл не найден: ${path}`); }
  }
  if (info.isFile() && ((info.mode & 0o111) !== 0 || /\.(desktop|appimage|exe|msi|bat|cmd|com|lnk|url)$/i.test(path))) {
    shell.showItemInFolder(path);
    return;
  }
  const error = await shell.openPath(path);
  if (error) throw new Error(`Не удалось открыть файл: ${error}`);
}
