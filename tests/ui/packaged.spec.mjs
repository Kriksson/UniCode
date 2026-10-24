import { test, expect, _electron as electron } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('packaged Fedora app connects to the installed Codex CLI', async () => {
  const binary = join(process.cwd(), 'release/linux-unpacked/unicode-v1');
  test.skip(!existsSync(binary), 'Сначала выполните npm run dist');
  const env = { ...process.env, XDG_CONFIG_HOME: await mkdtemp(join(tmpdir(), 'unicode-packaged-config-')) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CODEX_RED_TEST;
  delete env.CODEX_RED_DATA;
  delete env.CODEX_RED_CLI;
  delete env.UNICODE_CLI;
  const app = await electron.launch({ executablePath: binary, args: [], env });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByText('Codex CLI подключён')).toBeVisible({ timeout: 20000 });
    await expect(page).toHaveTitle('UniCode v1');
    await expect(page.locator('.sidebar-brand').getByText('by krkss', { exact: true })).toBeVisible();
    await expect(page.locator('.composer-footnote').getByText('by krkss', { exact: true })).toHaveCount(0);
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    expect(await app.evaluate(({ app, nativeImage }) => nativeImage.createFromPath(app.getAppPath() + '/assets/icon.png').isEmpty())).toBe(false);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
