const PAGE_SIZE = 60;
export const threadMetadata = thread => ({ ...thread, turns: [] });
const itemFields = ['id', 'type', 'text', 'command', 'aggregatedOutput', 'status', 'exitCode', 'server', 'tool', 'changes', 'error', 'phase', 'commandActions', 'questions'];
export function uiItem(item) {
  const result = Object.fromEntries(itemFields.filter(key => item[key] !== undefined).map(key => [key, item[key]]));
  if (item.type === 'userMessage') result.content = (item.content || []).filter(part => part.type === 'text').map(part => ({ type: 'text', text: part.text }));
  return result;
}

/** Keep pagination at the CLI boundary: never hydrate a whole thread for the UI. */
export class HistoryReader {
  constructor(rpc) { this.rpc = rpc; }

  async read(id, cursor = null) {
    if (cursor !== null && (!cursor || !['items', 'turns'].includes(cursor.kind)
      || typeof cursor.token !== 'string' || !cursor.token || cursor.token.length > 16384)) {
      throw new Error('Неверный указатель истории');
    }
    await this.rpc.connect();
    let thread;
    if (!cursor) {
      const response = await this.rpc.request('thread/read', { threadId: id, includeTurns: false });
      if (!response.thread) throw new Error('Чат не найден в Codex CLI');
      thread = threadMetadata(response.thread);
    }
    let kind = cursor?.kind || (thread?.historyMode === 'legacy' ? 'turns' : 'items');
    let page;
    if (kind === 'items') {
      try {
        page = await this.rpc.request('thread/items/list', { threadId: id, cursor: cursor?.token || null, limit: PAGE_SIZE, sortDirection: 'desc' });
      } catch (error) {
        if (cursor || !(error.code === -32601 || /not support|unsupported|does not implement|requires.*paginated/i.test(error.message))) throw error;
        kind = 'turns';
      }
    }
    if (kind === 'turns') {
      // Old stores can page turns only. A single turn avoids loading the whole chat.
      page = await this.rpc.request('thread/turns/list', { threadId: id, cursor: cursor?.token || null, limit: 1, sortDirection: 'desc', itemsView: 'full' });
    }
    const items = kind === 'items'
      ? [...page.data].reverse().map(entry => ({ ...uiItem(entry.item), turnId: entry.turnId }))
      : [...page.data].reverse().flatMap(turn => turn.items.map(item => ({ ...uiItem(item), turnId: turn.id })));
    return { ...(thread ? { thread } : {}), items, cursor: page.nextCursor ? { kind, token: page.nextCursor } : null };
  }
}
