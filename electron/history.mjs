const PAGE_SIZE = 60;
export const threadMetadata = thread => {
  const preview = typeof thread.preview === 'string' ? thread.preview.replace(/\s*<unicode_auto>[\s\S]*?(?:<\/unicode_auto>|$)/g, '').split('<unicode_attachments>')[0].trim() : thread.preview;
  return { ...thread, turns: [], ...(preview !== thread.preview ? { preview: preview || 'Прикреплённые файлы' } : {}) };
};
const itemFields = ['id', 'type', 'text', 'command', 'aggregatedOutput', 'status', 'exitCode', 'server', 'tool', 'changes', 'error', 'phase', 'commandActions', 'questions', 'senderThreadId', 'receiverThreadIds', 'receiverThreadId', 'newThreadId', 'prompt', 'model', 'reasoningEffort', 'agentsStates', 'agentStatus', 'kind', 'agentThreadId', 'agentPath'];
export function uiItem(item) {
  const result = Object.fromEntries(itemFields.filter(key => item[key] !== undefined).map(key => [key, item[key]]));
  if (item.type === 'userMessage') result.content = (item.content || []).filter(part => part.type === 'text' || part.type === 'localImage' || part.type === 'image').map(part => part.type === 'text' ? { type: 'text', text: part.text } : part.type === 'localImage' ? { type: 'localImage', path: part.path } : { type: 'image' });
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
