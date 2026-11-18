const terminal = status => ['completed', 'errored', 'shutdown', 'notFound', 'interrupted'].includes(status);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Cancel the current turn tree and confirm it stopped before accepting new input. */
export async function interruptForMessage({ rpc, agents, liveTurns, threadId }) {
  const deadline = Date.now() + 20000;
  const interrupted = new Set();
  agents.cancelAuto(threadId);
  const request = (method, params) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('Агент ещё останавливается. Попробуйте отправить сообщение снова.');
    return rpc.request(method, params, { timeoutMs: Math.min(8000, left) });
  };
  // Rebuild the subtree each pass: a spawn already in flight may finish during cancellation.
  for (;;) {
    const ids = new Set([threadId]);
    const children = agents.snapshot().filter(agent => !agent.deleted);
    let changed = true;
    while (changed) {
      changed = false;
      for (const agent of children) if (ids.has(agent.parentId) && !ids.has(agent.id)) {
        ids.add(agent.id); changed = true;
      }
    }
    const targets = [...ids].filter(id => id === threadId || liveTurns.has(id) || !terminal(children.find(agent => agent.id === id)?.status));
    const states = await Promise.all(targets.map(async id => {
      const { thread } = await request('thread/read', { threadId: id, includeTurns: false });
      if (thread.status?.type !== 'active') return false;
      const page = await request('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
      const turn = page.data?.find(turn => turn.status === 'inProgress');
      const turnId = turn?.id || liveTurns.get(id);
      if (!turnId) return true; // Await initialization; never start a competing turn.
      const key = `${id}:${turnId}`;
      if (!interrupted.has(key)) {
        try {
          await request('turn/interrupt', { threadId: id, turnId });
          interrupted.add(key);
        } catch (error) {
          // Completion can win the race with cancellation. Only ignore a confirmed idle thread.
          const latest = await request('thread/read', { threadId: id, includeTurns: false });
          if (latest.thread.status?.type === 'active') throw error;
        }
      }
      return true;
    }));
    if (!states.some(Boolean)) return;
    if (Date.now() >= deadline) throw new Error('Агент ещё останавливается. Попробуйте отправить сообщение снова.');
    await delay(200);
  }
}
