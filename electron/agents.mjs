import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const terminal = status => ['completed', 'errored', 'shutdown', 'notFound', 'interrupted'].includes(status);
const valid = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const compact = text => typeof text === 'string' ? text.slice(0, 16000) : '';
const collab = item => ['collabAgentToolCall', 'collabToolCall'].includes(item?.type);

/** Track actual child threads; completion of spawn itself is not task completion. */
export class AgentTracker {
  constructor({ rpc, path, changed }) {
    Object.assign(this, { rpc, path, changed }); this.agents = new Map(); this.revisions = new Map(); this.queue = Promise.resolve();
    this.attached = new Set(); this.attaching = new Set(); this.roots = new Set(); this.assignments = new Map(); this.autoRuns = new Map(); this.recoveryAt = new Map(); this.recoveryAttempts = new Map();
    this.timer = setInterval(() => void this.poll(), 5000); this.timer.unref();
  }
  async load() {
    if (!this.loading) this.loading = (async () => {
      try {
        const saved = JSON.parse(await readFile(this.path, 'utf8'));
        this.assignments = new Map(saved.assignments || []); this.autoRuns = new Map(saved.autoRuns || []);
        for (const agent of Array.isArray(saved.agents) ? saved.agents.slice(-1000) : []) {
          if (valid(agent.id) && valid(agent.parentId) && !this.agents.has(agent.id)) this.agents.set(agent.id, {
            ...agent, task: compact(agent.task), result: compact(agent.result),
            status: terminal(agent.status) ? agent.status : 'unknown', activity: terminal(agent.status) ? agent.activity : 'Уточняет состояние',
          });
        }
        // Old releases could record /root as a child of a worker. Repair that known bad edge.
        for (const agent of this.agents.values()) if (agent.name === 'root' || agent.agentPath === '/root') { this.agents.delete(agent.id); this.roots.add(agent.id); }
      } catch (error) { if (error.code !== 'ENOENT') console.warn('UniCode: не удалось загрузить историю субагентов'); }
    })();
    await this.loading;
    return this.snapshot();
  }
  snapshot() { return [...this.agents.values()]; }
  configureAuto(id, enabled) {
    if (enabled) this.autoRuns.set(id, { id: `${id}:${Date.now()}`, completed: false });
    else this.autoRuns.delete(id);
    this.publish();
  }
  cancelAuto(id) { const run = this.autoRuns.get(id); if (run) { run.completed = false; this.publish(); } }
  wouldCycle(id, parentId) {
    const seen = new Set([id]); let current = parentId;
    while (current) { if (seen.has(current)) return true; seen.add(current); current = this.agents.get(current)?.parentId; }
    return false;
  }
  assignment(parentId, name) { return this.assignments.get(`${parentId}:${name}`); }
  manifest(text, parentId) {
    if (typeof text !== 'string' || !valid(parentId)) return;
    for (const match of text.matchAll(/<!--\s*unicode:tasks\s+(\[[\s\S]*?\])\s*-->/g)) {
      try {
        const tasks = JSON.parse(match[1]);
        for (const task of tasks.slice(0, 20)) if (typeof task.name === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(task.name) && typeof task.task === 'string' && task.task.trim()) {
          this.assignments.set(`${parentId}:${task.name}`, compact(task.task));
          for (const agent of this.agents.values()) if (agent.parentId === parentId && agent.agentPath?.split('/').pop() === task.name) this.patch(agent.id, { task: compact(task.task) });
        }
      } catch { /* A partial or invalid manifest never changes tasks. */ }
    }
    while (this.assignments.size > 1000) this.assignments.delete(this.assignments.keys().next().value);
  }
  async recoverTask(agent) {
    if (agent.task || agent.deleted || (this.recoveryAttempts.get(agent.id) || 0) >= 2 || Date.now() - (this.recoveryAt.get(agent.id) || 0) < 30000) return;
    this.recoveryAt.set(agent.id, Date.now()); this.recoveryAttempts.set(agent.id, (this.recoveryAttempts.get(agent.id) || 0) + 1);
    try {
      const page = await this.rpc.request('thread/items/list', { threadId: agent.id, limit: 16, sortDirection: 'asc' }, { timeoutMs: 10000 });
      if (this.closed || !this.agents.has(agent.id)) return;
      const items = (page.data || []).map(entry => entry.item);
      const firstUser = items.find(item => item.type === 'userMessage');
      const task = firstUser?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n');
      const intro = items.find(item => item.type === 'agentMessage' && item.phase === 'commentary' && item.text)?.text?.replace(/<!--\s*unicode:tasks[\s\S]*?(?:-->|$)/g, '').trim();
      if (!this.agents.get(agent.id)?.task && task) this.patch(agent.id, { task: compact(task) });
      else if (intro) this.patch(agent.id, { introduction: compact(intro) });
      // Some clients omit worker input entirely, but the coordinator can provide a manifest.
      if (!this.agents.get(agent.id)?.task && Date.now() - (this.recoveryAt.get(agent.parentId) || 0) >= 30000) {
        this.recoveryAt.set(agent.parentId, Date.now());
        const parent = await this.rpc.request('thread/items/list', { threadId: agent.parentId, limit: 60, sortDirection: 'desc' }, { timeoutMs: 10000 });
        for (const entry of [...(parent.data || [])].reverse()) if (entry.item.type === 'agentMessage') this.manifest(entry.item.text, agent.parentId);
      }
    } catch { /* Old servers and private worker inputs may not expose a task. */ }
  }
  async cleanupAuto() {
    for (const [parentId, run] of this.autoRuns) {
      if (!run.completed) continue;
      const children = this.snapshot().filter(agent => agent.autoRun === run.id && !agent.deleted);
      if (!children.length || children.some(agent => !terminal(agent.status))) continue;
      try {
        const { thread } = await this.rpc.request('thread/read', { threadId: parentId, includeTurns: false }, { timeoutMs: 10000 });
        if (this.autoRuns.get(parentId) !== run || !run.completed || thread.status?.type === 'active') continue;
        for (const agent of children.reverse()) {
          if (!run.completed || this.autoRuns.get(parentId) !== run) break;
          const { thread: child } = await this.rpc.request('thread/read', { threadId: agent.id, includeTurns: false }, { timeoutMs: 10000 });
          if (child.status?.type === 'active') continue;
          if (!this.agents.get(agent.id)?.result) {
            const page = await this.rpc.request('thread/items/list', { threadId: agent.id, limit: 12, sortDirection: 'desc' }, { timeoutMs: 10000 });
            const reply = page.data?.map(entry => entry.item).find(item => item.type === 'agentMessage' && item.text);
            if (reply) this.patch(agent.id, { result: compact(reply.text) });
          }
          // Save the summary before permanently deleting the worker thread.
          this.publish(); await this.queue;
          if (!run.completed || this.autoRuns.get(parentId) !== run || this.closed) break;
          await this.rpc.request('thread/delete', { threadId: agent.id }, { timeoutMs: 10000 });
          this.patch(agent.id, { deleted: true, status: agent.status, activity: '' });
        }
      } catch { /* Keep summaries and retry later if the server still owns a worker. */ }
    }
  }
  async attach(id) {
    if (this.closed || this.attached.has(id) || this.attaching.has(id) || !this.rpc.connected) return;
    this.attaching.add(id);
    const revision = this.revisions.get(id);
    try {
      const { thread } = await this.rpc.request('thread/resume', { threadId: id, excludeTurns: true }, { timeoutMs: 10000 });
      this.attached.add(id); this.thread(revision === this.revisions.get(id) ? thread : { ...thread, status: undefined });
    } catch { /* Poll the status if this server cannot subscribe to the child. */ }
    finally { this.attaching.delete(id); }
  }
  patch(id, patch) {
    if (this.closed) return;
    const old = this.agents.get(id);
    if (this.roots.has(id) || (patch.parentId && this.wouldCycle(id, patch.parentId))) return;
    if (!old && (!valid(id) || !valid(patch.parentId) || id === patch.parentId)) return;
    const next = { id, name: 'Агент', task: '', status: 'pendingInit', activity: '', ...old, ...patch, updatedAt: Date.now() };
    if (old && Object.keys(patch).every(key => old[key] === patch[key])) return;
    if (!old) {
      let ancestor = next.parentId; const seen = new Set();
      while (ancestor && !seen.has(ancestor)) { seen.add(ancestor); const run = this.autoRuns.get(ancestor); if (run && !run.completed) { next.autoRun = run.id; break; } ancestor = this.agents.get(ancestor)?.parentId; }
    }
    this.agents.set(id, next); this.revisions.set(id, (this.revisions.get(id) || 0) + 1);
    if (!terminal(next.status)) void this.attach(id);
    if (!this.publishTimer) this.publishTimer = setTimeout(() => { this.publishTimer = null; this.publish(); }, 150);
  }
  publish() {
    // Bound saved summaries; active agents and their ancestry always stay present.
    if (this.agents.size > 1000) {
      const protectedIds = new Set([...this.agents.values()].filter(agent => !terminal(agent.status)).map(agent => agent.id));
      for (const id of [...protectedIds]) {
        let parent = this.agents.get(id)?.parentId; const seen = new Set();
        while (parent && !seen.has(parent)) { seen.add(parent); protectedIds.add(parent); parent = this.agents.get(parent)?.parentId; }
      }
      for (const agent of this.agents.values()) if (this.agents.size > 1000 && !protectedIds.has(agent.id)) this.agents.delete(agent.id);
    }
    const agents = this.snapshot(); this.changed(agents);
    const data = JSON.stringify({ version: 2, agents, assignments: [...this.assignments], autoRuns: [...this.autoRuns] });
    this.queue = this.queue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(this.path + '.tmp', data, { mode: 0o600 }); await rename(this.path + '.tmp', this.path);
    });
    void this.queue.catch(() => console.warn('UniCode: не удалось сохранить историю субагентов'));
  }
  thread(thread) {
    if (!thread) return;
    const source = (thread.source?.subAgent || thread.source?.subagent)?.thread_spawn;
    const parentId = thread.parentThreadId || source?.parent_thread_id;
    if (!valid(parentId)) {
      if (Object.hasOwn(thread, 'parentThreadId') && thread.parentThreadId === null && !source) {
        this.roots.add(thread.id); if (this.agents.delete(thread.id)) this.publish();
      }
      return;
    }
    this.patch(thread.id, { parentId, ...(source?.agent_path ? { agentPath: source.agent_path } : {}),
      ...(this.assignment(parentId, source?.agent_path?.split('/').pop()) ? { task: this.assignment(parentId, source.agent_path.split('/').pop()) } : {}), name: thread.agentNickname || source?.agent_nickname || thread.name || 'Агент',
      ...(thread.model ? { model: thread.model } : {}), ...(thread.cwd ? { cwd: thread.cwd } : {}),
      ...(!this.agents.get(thread.id)?.task && thread.preview && !this.assignment(parentId, source?.agent_path?.split('/').pop()) ? { task: compact(thread.preview) } : {}),
      ...(thread.status?.type === 'active' ? { status: 'running' } : {}),
    });
  }
  item(item, parentId, historical = false) {
    if (item?.type === 'agentMessage') this.manifest(item.text, parentId);
    if (item?.type === 'subAgentActivity') {
      const id = item.agentThreadId;
      if (!valid(id) || !valid(parentId) || id === parentId || item.agentPath === '/root') return;
      if (historical && this.agents.has(id)) return;
      const ownerPath = this.agents.get(parentId)?.agentPath;
      if (!this.agents.has(id) && ownerPath && !item.agentPath?.startsWith(ownerPath + '/')) return;
      const task = this.assignment(parentId, item.agentPath?.split('/').pop());
      this.patch(id, { ...(item.agentPath ? { agentPath: item.agentPath } : {}), ...(task ? { task } : {}), ...(this.agents.has(id) ? {} : { parentId }), name: item.agentPath?.split('/').filter(Boolean).pop() || this.agents.get(id)?.name || 'Агент',
        ...(item.model ? { model: item.model } : {}), status: item.kind === 'completed' ? 'completed' : item.kind === 'interrupted' ? 'interrupted' : historical ? 'unknown' : 'running' });
      return;
    }
    if (!collab(item)) return;
    const owner = item.senderThreadId || parentId;
    const ids = item.receiverThreadIds || [item.newThreadId || item.receiverThreadId].filter(Boolean);
    for (const id of ids) {
      if (!valid(id) || !valid(owner) || id === owner) continue;
      const previous = this.agents.get(id);
      if (historical && previous) continue;
      // Wait/list/message events must not turn peers or parents into children.
      if (!previous && !['spawnAgent', 'spawn_agent'].includes(item.tool)) continue;
      const state = item.agentsStates?.[id] || item.agentStatus;
      const status = typeof state === 'string' ? state : state?.status;
      const isWork = ['spawnAgent', 'spawn_agent', 'followupTask', 'sendInput', 'resumeAgent'].includes(item.tool);
      const patch = { ...(previous ? {} : { parentId: owner }),
        ...(item.model && ['spawnAgent', 'spawn_agent'].includes(item.tool) ? { model: item.model } : {}),
        ...(isWork && item.prompt ? { task: compact(item.prompt) } : {}),
        ...(isWork && item.prompt && item.prompt !== previous?.task ? { result: '' } : {}),
        ...(status ? { status, activity: status === 'running' ? 'Работает над задачей' : '' } : isWork ? { status: historical ? 'unknown' : 'pendingInit' } : {}),
        ...(state?.message ? { result: compact(state.message) } : {}),
      };
      if (item.tool === 'closeAgent' && item.status === 'completed') patch.status = previous?.status === 'completed' ? 'completed' : 'shutdown';
      if (previous?.status === 'completed' && patch.status === 'shutdown') patch.status = 'completed';
      this.patch(id, patch);
    }
  }
  observe({ method, params: p }) {
    if (!p) return;
    if (method === 'thread/started') this.thread(p.thread);
    if (['item/started', 'item/completed'].includes(method)) this.item(p.item, p.threadId);
    const run = this.autoRuns.get(p.threadId);
    if (run && method === 'turn/started') { run.completed = false; this.publish(); }
    if (run && method === 'turn/completed') { run.completed = p.turn.status === 'completed'; this.publish(); }
    const agent = this.agents.get(p.threadId);
    if (!agent) return;
    if (method === 'turn/started') this.patch(agent.id, { status: 'running', activity: 'Готовит ответ', result: '' });
    if (method === 'turn/completed') this.patch(agent.id, { status: p.turn.status === 'failed' ? 'errored' : p.turn.status === 'interrupted' ? 'interrupted' : 'completed', activity: '', ...(p.turn.error?.message ? { result: compact(p.turn.error.message) } : {}) });
    if (method === 'thread/status/changed' && p.status?.type === 'active') this.patch(agent.id, { status: 'running', activity: p.status.activeFlags?.length ? 'Ожидает действия' : 'Работает над задачей' });
    if (method === 'thread/deleted') this.patch(agent.id, { deleted: true, status: terminal(agent.status) ? agent.status : 'notFound', activity: '' });
    if (['item/started', 'item/completed'].includes(method)) {
      const item = p.item;
      const activity = item.type === 'commandExecution' ? `Выполняет ${compact(item.command).slice(0, 120)}` : item.type === 'fileChange' ? 'Изменяет файлы' : item.type === 'agentMessage' ? 'Пишет ответ' : item.type === 'reasoning' ? 'Продумывает решение' : 'Работает над задачей';
      this.patch(agent.id, { ...(method === 'item/started' ? { status: 'running', activity } : {}),
        ...(method === 'item/completed' && item.type === 'agentMessage' && item.text ? { result: compact(item.text), ...(!agent.task && !agent.introduction && item.phase === 'commentary' ? { introduction: compact(item.text.replace(/<!--\s*unicode:tasks[\s\S]*?(?:-->|$)/g, '').trim()) } : {}) } : {}),
      });
    }
  }
  disconnected() {
    this.attached.clear(); this.attaching.clear();
    for (const agent of this.agents.values()) if (!terminal(agent.status)) this.patch(agent.id, { status: 'unknown', activity: 'Нет соединения с Codex' });
  }
  request(request) {
    if (this.agents.has(request.params.threadId)) this.patch(request.params.threadId, { status: 'running', activity: 'Ожидает вашего ответа' });
  }
  history(id, page) { this.thread(page.thread); for (const item of page.items) this.item(item, id, true); }
  async poll() {
    if (this.closed || this.polling || !this.rpc.connected) return;
    this.polling = true;
    try {
      await this.load();
      const candidates = this.snapshot().filter(agent => !agent.deleted && agent.status !== 'notFound');
      const active = [...candidates.filter(agent => !terminal(agent.status)), ...candidates.filter(agent => terminal(agent.status) && !agent.task && (this.recoveryAttempts.get(agent.id) || 0) < 2 && Date.now() - (this.recoveryAt.get(agent.id) || 0) >= 30000).slice(-3)];
      for (let index = 0; index < active.length; index += 3) await Promise.all(active.slice(index, index + 3).map(async agent => {
        const revision = this.revisions.get(agent.id);
        try {
          const { thread } = await this.rpc.request('thread/read', { threadId: agent.id, includeTurns: false }, { timeoutMs: 10000 });
          if (revision !== this.revisions.get(agent.id)) return;
          this.thread(thread);
          await this.recoverTask(this.agents.get(agent.id) || agent);
          const afterRead = this.revisions.get(agent.id);
          if (thread.status?.type === 'active') return;
          if (terminal(this.agents.get(agent.id)?.status)) return;
          const latest = await this.rpc.request('thread/turns/list', { threadId: agent.id, limit: 1, sortDirection: 'desc', itemsView: 'summary' }, { timeoutMs: 10000 });
          if (this.revisions.get(agent.id) !== afterRead) return;
          const turn = latest.data?.[0];
          if (turn?.status === 'completed') {
            const reply = [...(turn.items || [])].reverse().find(item => item.type === 'agentMessage' && item.text);
            this.patch(agent.id, { status: 'completed', activity: '', ...(reply ? { result: compact(reply.text) } : {}) });
          }
          else if (turn?.status === 'failed' || thread.status?.type === 'systemError') this.patch(agent.id, { status: 'errored', activity: '' });
          else if (turn?.status === 'interrupted') this.patch(agent.id, { status: 'interrupted', activity: '' });
        } catch (error) {
          this.patch(agent.id, /thread.*(not found|does not exist)|no.*thread.*found/i.test(error.message)
            ? { status: 'notFound', activity: '' } : { status: 'unknown', activity: 'Состояние временно недоступно' });
        }
      }));
      await this.cleanupAuto();
    } finally { this.polling = false; }
  }
  async close() { this.closed = true; clearInterval(this.timer); clearTimeout(this.publishTimer); this.publish(); await this.queue.catch(() => {}); }
}
