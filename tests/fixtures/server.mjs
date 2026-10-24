#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
let active;
let counter = Date.now();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params });
const seeded = [{ id: 'seed-chat', name: 'Работа с проектом', preview: 'Проверь структуру проекта', cwd: '/tmp', createdAt: 1000, updatedAt: 2000, turns: [] }];
const persistence = process.env.CODEX_RED_DATA ? join(process.env.CODEX_RED_DATA, 'fixture-threads.json') : null;
const threads = new Map((persistence && existsSync(persistence) ? JSON.parse(readFileSync(persistence, 'utf8')) : seeded).map(t => [t.id, t]));
const persist = () => { if (persistence) writeFileSync(persistence, JSON.stringify([...threads.values()])); };
function complete(threadId, turnId) {
  const text = 'Готово. Давайте начнём с вашего проекта.\n\n```js\nconsole.log("hello");\n```';
  const item = { type: 'agentMessage', id: turnId + '-answer', text };
  notify('item/started', { threadId, turnId, item: { ...item, text: '' } });
  notify('item/agentMessage/delta', { threadId, turnId, itemId: item.id, delta: 'Готово. ' });
  setTimeout(() => {
    notify('item/agentMessage/delta', { threadId, turnId, itemId: item.id, delta: text.slice(8) });
    notify('item/completed', { threadId, turnId, item });
    const turn = threads.get(threadId).turns.find(t => t.id === turnId);
    turn.status = 'completed'; turn.items.push(item);
    persist();
    notify('turn/completed', { threadId, turn });
    active = null;
  }, 60);
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!message.method) {
    if (message.id === 900 && active) complete(active.threadId, active.turnId);
    return;
  }
  const { id, method, params: p = {} } = message;
  if (id === undefined) return;
  const reply = result => send({ id, result });
  if (method === 'initialize') return reply({ userAgent: 'test' });
  if (method === 'echo') return reply(p);
  if (method === 'disconnect') return process.exit(2);
  if (method === 'hang') return;
  if (method === 'fail') return send({ id, error: { code: -1, message: 'test failure' } });
  if (method === 'ask') { reply({}); return send({ id: 700, method: 'item/commandExecution/requestApproval', params: { threadId: 'seed-chat', command: 'echo hello' } }); }
  if (method === 'thread/list') return reply({ data: [...threads.values()].filter(t => !p.searchTerm || t.name?.includes(p.searchTerm)), nextCursor: null });
  if (method === 'model/list') return reply({ data: [{ id: 'test-model', model: 'test-model', displayName: 'Тестовая модель', hidden: false }], nextCursor: null });
  if (method === 'account/read') return reply({ account: { type: 'chatgpt' } });
  if (method === 'thread/read') return threads.has(p.threadId) ? reply({ thread: threads.get(p.threadId) }) : send({ id, error: { code: -1, message: 'thread not found' } });
  if (method === 'thread/start') {
    const thread = { id: 'test-' + (++counter), preview: '', cwd: p.cwd, createdAt: 3000, updatedAt: 3000, turns: [] };
    threads.set(thread.id, thread); persist(); return reply({ thread });
  }
  if (method === 'thread/resume') return reply({ thread: threads.get(p.threadId) });
  if (method === 'turn/start') {
    const turn = { id: 'turn-' + (++counter), status: 'inProgress', items: [] };
    const thread = threads.get(p.threadId);
    const userItem = { type: 'userMessage', id: turn.id + '-user', content: p.input };
    thread.turns.push(turn); turn.items.push(userItem);
    reply({ turn });
    notify('turn/started', { threadId: thread.id, turn });
    notify('item/started', { threadId: thread.id, turnId: turn.id, item: userItem });
    if (p.input[0].text === 'permission') {
      active = { threadId: thread.id, turnId: turn.id };
      send({ id: 900, method: 'item/commandExecution/requestApproval', params: { ...active, command: 'echo hello', reason: 'Тест разрешения' } });
    } else if (p.input[0].text === 'slow') active = { threadId: thread.id, turnId: turn.id };
    else setTimeout(() => complete(thread.id, turn.id), 40);
    return;
  }
  if (method === 'turn/interrupt') {
    const turn = threads.get(p.threadId).turns.find(t => t.id === p.turnId);
    turn.status = 'interrupted'; reply({}); notify('turn/completed', { threadId: p.threadId, turn }); active = null; return;
  }
  send({ id, error: { code: -32601, message: `unknown method ${method}` } });
});
