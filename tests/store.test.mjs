import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore } from '../electron/store.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-red-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new LocalStore(join(dir, 'nested/state.json'));
}
test('new store is empty and metadata survives reopening', async t => {
  const store = await setup(t); const state = await store.read();
  state.folders.push({ id: 'work', name: 'Работа' });
  state.chats['chat-1'] = { pinned: true, folderId: 'work', name: 'Проект' };
  await store.save(state);
  assert.deepEqual(await new LocalStore(store.path).read(), state);
});
test('serializes overlapping writes and keeps the latest state', async t => {
  const store = await setup(t); const state = await store.read();
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.save({ ...state, model: String(i) })));
  assert.equal((await store.read()).model, '19');
});
test('preserves corrupt data instead of overwriting it', async t => {
  const store = await setup(t); await store.save(await store.read());
  await writeFile(store.path, '{broken');
  await assert.rejects(store.read(), /сохранён без изменений/);
  assert.equal(await readFile(store.path, 'utf8'), '{broken');
});
test('rejects invalid folder state before writing', async t => {
  const store = await setup(t); const state = await store.read();
  assert.throws(() => store.save({ ...state, folders: [{ id: 'x', name: '' }] }), /название/);
});
