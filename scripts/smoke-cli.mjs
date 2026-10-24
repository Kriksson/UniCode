import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRpc } from '../electron/rpc.mjs';

const cwd = await mkdtemp(join(tmpdir(), 'unicode-live-'));
const rpc = new CodexRpc({ cwd, timeout: 45000 });
let id;
let turnId;
let timer;
let text = '';
let streamed = false;
rpc.on('request', request => {
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) rpc.respond(request.id, { decision: 'decline' });
  else rpc.rejectRequest(request.id);
});
try {
  await rpc.connect();
  const { thread } = await rpc.request('thread/start', {
    cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user',
  });
  id = thread.id;
  const finished = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Превышено время ожидания ответа')), 120000);
    rpc.on('notification', ({ method, params: p }) => {
      if (p.threadId !== id) return;
      if (method === 'item/agentMessage/delta') { text += p.delta; streamed = true; }
      if (method === 'turn/completed') p.turn.status === 'completed' ? resolve(p.turn) : reject(new Error(p.turn.error?.message || p.turn.status));
    });
  });
  const { turn } = await rpc.request('turn/start', {
    threadId: id, input: [{ type: 'text', text: 'Ответь ровно UNICODE_OK. Не используй инструменты. Не читай и не изменяй файлы.', text_elements: [] }],
  });
  turnId = turn.id;
  await finished;
  if (!text.includes('UNICODE_OK') || !streamed) throw new Error('Ожидаемый потоковый ответ не получен');
  const history = await rpc.request('thread/read', { threadId: id, includeTurns: true });
  console.log(JSON.stringify({ liveCli: true, streamed, completed: true, historySaved: history.thread.turns.length > 0, response: text.trim() }));
} catch (error) {
  console.error(error.message); process.exitCode = 1;
  if (id && turnId) await rpc.request('turn/interrupt', { threadId: id, turnId }).catch(() => {});
} finally {
  clearTimeout(timer);
  if (id) await rpc.request('thread/archive', { threadId: id }).catch(() => {});
  rpc.close();
  await rm(cwd, { recursive: true, force: true });
}
