import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let app, page, data;
const errors = [];
const cli = join(process.cwd(), 'tests/fixtures/server.mjs');
test.beforeAll(async () => { await chmod(cli, 0o755); });
async function launch() {
  const env = { ...process.env, CODEX_RED_TEST: '1', CODEX_RED_DATA: data, CODEX_RED_CLI: cli };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], env });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByText('Codex CLI подключён')).toBeVisible();
}
test.beforeEach(async ({}, testInfo) => {
  data = await mkdtemp(join(tmpdir(), 'codex-red-ui-'));
  if (!testInfo.title.startsWith('creates')) await writeFile(join(data, 'state.json'), JSON.stringify({
    version: 1, folders: [{ id: 'work', name: 'Разработка' }],
    chats: { 'seed-chat': { pinned: true, folderId: 'work', name: 'Мой проект' } },
    hidden: [], selectedId: null, cwd: '/tmp', model: '',
  }));
  await launch();
});
test.afterEach(async () => { await app.close(); });

test('creates a folder, streams a chat, pins, renames and persists it', async () => {
  await page.getByRole('button', { name: 'Создать папку', exact: true }).first().click();
  await page.getByLabel('Название папки').fill('Разработка');
  await page.getByRole('button', { name: 'Создать папку', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Разработка 0' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Сообщение Codex' }).fill('Привет, Codex');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(page.getByText('Готово. Давайте начнём с вашего проекта.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Остановить ответ' })).toHaveCount(0);
  await expect(page.locator('.user-bubble')).toHaveCount(1);
  await page.getByRole('button', { name: 'Закрепить чат', exact: true }).click();
  await expect(page.getByText('Закреплённые', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Действия чата', exact: true }).click();
  await page.getByRole('button', { name: 'Переименовать', exact: true }).click();
  await page.getByLabel('Название чата').fill('Мой проект');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.locator('.chat-heading')).toHaveText('Мой проект');
  await page.screenshot({ path: 'test-results/chat.png' });
  await expect.poll(async () => {
    const state = JSON.parse(await readFile(join(data, 'state.json'), 'utf8'));
    return state.chats[state.selectedId]?.name;
  }).toBe('Мой проект');
  const stored = JSON.parse(await readFile(join(data, 'state.json'), 'utf8'));
  expect(stored.folders[0].name).toBe('Разработка');
  expect(stored.chats[stored.selectedId].pinned).toBe(true);
  expect(stored.chats[stored.selectedId].folderId).toBe(stored.folders[0].id);
  expect(stored.chats[stored.selectedId].name).toBe('Мой проект');
  await app.close();
  await launch();
  await expect(page.getByText('Закреплённые', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-heading')).toHaveText('Мой проект');
});

test('restores folders and pins, supports search and shortcut', async () => {
  await expect(page.getByText('Закреплённые', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Найти чат' }).fill('не существует');
  await expect(page.getByText('Чаты не найдены', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Найти чат' }).fill('');
  await page.keyboard.press('Control+n');
  await expect(page.locator('.chat-heading')).toHaveText('Новый чат');
  await page.screenshot({ path: 'test-results/empty.png' });
});

test('requires an explicit approval and supports interrupt', async () => {
  await page.getByRole('button', { name: 'Новый чат', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Сообщение Codex' });
  await input.fill('permission'); await input.press('Enter');
  await expect(page.getByRole('region', { name: 'Запрос разрешения' })).toBeVisible();
  await expect(page.getByText('echo hello', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Разрешить один раз' }).click();
  await expect(page.getByText('Готово. Давайте начнём с вашего проекта.')).toBeVisible();
  await input.fill('slow'); await input.press('Enter');
  await page.getByRole('button', { name: 'Остановить ответ' }).click();
  await expect(page.getByRole('button', { name: 'Остановить ответ' })).toHaveCount(0);
});

test('deleting a folder keeps its chats and narrow layout has no overflow', async () => {
  await page.locator('.folder-row').filter({ hasText: 'Разработка' }).hover();
  await page.getByRole('button', { name: 'Действия папки Разработка' }).click();
  await page.getByRole('button', { name: 'Удалить папку', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить папку' }).click();
  await expect(page.getByRole('button', { name: 'Действия папки Разработка' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Мой проект', exact: true }).first()).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 600));
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: 'test-results/compact.png' });
  expect(errors).toEqual([]);
});
