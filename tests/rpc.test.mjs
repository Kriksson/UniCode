import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { CodexRpc } from '../electron/rpc.mjs';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url));
const client = (options = {}) => new CodexRpc({ command: process.execPath, args: [fixture], timeout: 3000, ...options });

test('initializes once and routes concurrent responses by id', async t => {
  const rpc = client(); t.after(() => rpc.close());
  await Promise.all([rpc.connect(), rpc.connect()]);
  assert.equal(rpc.connected, true);
  const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => rpc.request('echo', { i })));
  assert.deepEqual(replies.map(r => r.i), [0, 1, 2, 3, 4, 5, 6, 7]);
});
test('propagates protocol errors and clears pending requests', async t => {
  const rpc = client(); t.after(() => rpc.close()); await rpc.connect();
  await assert.rejects(rpc.request('fail'), /test failure/);
  assert.equal(rpc.pending.size, 0);
});
test('expires a request without leaking timers', async t => {
  const rpc = client(); t.after(() => rpc.close()); await rpc.connect(); rpc.timeout = 80;
  await assert.rejects(rpc.request('hang'), /не ответил/);
  assert.equal(rpc.pending.size, 0);
});
test('rejects in-flight requests on process exit and supports reconnect', async t => {
  const rpc = client(); t.after(() => rpc.close()); await rpc.connect();
  await assert.rejects(rpc.request('disconnect'), /Соединение/);
  assert.equal(rpc.connected, false); assert.equal(rpc.pending.size, 0);
  await rpc.connect(); assert.deepEqual(await rpc.request('echo', { reconnected: true }), { reconnected: true });
});
test('routes server requests and rejects duplicate approvals', async t => {
  const rpc = client(); t.after(() => rpc.close()); await rpc.connect();
  const incoming = once(rpc, 'request'); await rpc.request('ask');
  const [request] = await incoming;
  assert.equal(request.id, 700); assert.equal(rpc.requests.size, 1);
  rpc.respond(request.id, { decision: 'decline' });
  assert.equal(rpc.requests.size, 0);
  assert.throws(() => rpc.respond(request.id, { decision: 'accept' }), /закрыт/);
});
test('missing CLI produces a useful error', async () => {
  const rpc = new CodexRpc({ command: '/tmp/no-such-codex-red-executable' });
  await assert.rejects(rpc.connect(), /CLI не найден/);
});
