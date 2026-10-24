import { mkdir, writeFile, readFile, rename, chmod, copyFile, stat, utimes } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = join(root, 'release/current-build.json');
let buildDirectory = process.argv[2];
if (!buildDirectory) {
  try { buildDirectory = JSON.parse(await readFile(manifest, 'utf8')).directory; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
buildDirectory = resolve(root, buildDirectory || 'release');
const binary = join(buildDirectory, 'linux-unpacked/unicode-v1');
await stat(binary);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const desktopEscape = value => value.replaceAll('\\', '\\\\').replaceAll(' ', '\\s').replaceAll('\n', '\\n');
const userHome = homedir();
const bin = join(userHome, '.local/bin');
const applications = join(userHome, '.local/share/applications');
const icons = join(userHome, '.local/share/icons/hicolor/512x512/apps');
const themeRoot = join(userHome, '.local/share/icons/hicolor');
await Promise.all([bin, applications, icons].map(path => mkdir(path, { recursive: true })));
const launcher = join(bin, 'unicode-v1');
await writeFile(launcher + '.tmp', `#!/bin/sh\nunset ELECTRON_RUN_AS_NODE\nexport PATH="/usr/local/bin:/usr/bin:$HOME/.local/bin:$PATH"\nexec ${quote(binary)} "$@"\n`, { mode: 0o755 });
await chmod(launcher + '.tmp', 0o755);
await rename(launcher + '.tmp', launcher);
await mkdir(dirname(manifest), { recursive: true });
await writeFile(manifest + '.tmp', JSON.stringify({ directory: relative(root, buildDirectory) }, null, 2) + '\n');
await rename(manifest + '.tmp', manifest);
const installedIcon = join(icons, 'unicode-v1.png');
await copyFile(join(root, 'assets/icon.png'), installedIcon);
// An absolute icon path also works when the desktop has a stale icon-theme cache.
const entry = `[Desktop Entry]\nVersion=1.0\nType=Application\nName=UniCode v1\nComment=Минималистичный клиент Codex CLI · by krkss\nExec=${desktopEscape(launcher)}\nIcon=${desktopEscape(installedIcon)}\nTerminal=false\nCategories=Development;\nKeywords=Codex;AI;Chat;UniCode;\nStartupNotify=true\nStartupWMClass=unicode-v1\n`;
const desktopFile = join(applications, 'unicode-v1.desktop');
await writeFile(desktopFile, entry);
let desktop;
try { desktop = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' }).trim(); } catch { /* Menu shortcut is always installed. */ }
if (desktop) {
  await mkdir(desktop, { recursive: true });
  const shortcut = join(desktop, 'UniCode v1.desktop');
  await writeFile(shortcut, entry, { mode: 0o755 });
  await chmod(shortcut, 0o755);
  console.log(`Рабочий стол: ${shortcut}`);
}
execFileSync('desktop-file-validate', [desktopFile], { stdio: 'inherit' });
execFileSync('update-desktop-database', [applications], { stdio: 'inherit' });
const now = new Date();
await utimes(themeRoot, now, now);
execFileSync('gtk-update-icon-cache', ['--force', '--ignore-theme-index', themeRoot], { stdio: 'inherit' });
execFileSync('kbuildsycoca6', ['--noincremental'], { stdio: 'inherit' });
console.log(`Меню приложений: ${desktopFile}`);
console.log(`Команда запуска: ${launcher}`);
