import { uiItem } from './history.mjs';

const deltas = new Set(['item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/reasoning/summaryTextDelta']);
const events = new Set([...deltas, 'turn/started', 'turn/completed', 'item/started', 'item/completed',
  'item/mcpToolCall/progress', 'thread/deleted', 'thread/name/updated', 'account/login/completed', 'account/updated', 'account/rateLimits/updated', 'serverRequest/resolved', 'error']);

/** Coalesce token bursts, preserving protocol order at item/turn boundaries. */
export class EventStream {
  constructor(emit) { this.emit = emit; this.pending = new Map(); }

  publish(message) {
    if (!events.has(message.method)) return;
    const params = message.params;
    // The UI already receives items incrementally; turn-completed snapshots can be huge.
    if (params.item) message = { ...message, params: { ...params, item: uiItem(params.item) } };
    if (params.turn) message = { ...message, params: { ...params, turn: { id: params.turn.id, status: params.turn.status, error: params.turn.error } } };
    if (message.method === 'item/reasoning/summaryTextDelta') message = { ...message, params: { ...params, delta: '' } };
    if (!deltas.has(message.method)) {
      this.flush(); this.emit('notification', { message }); return;
    }
    const p = message.params;
    const key = JSON.stringify([message.method, p.threadId, p.itemId, p.summaryIndex]);
    const previous = this.pending.get(key);
    this.pending.set(key, previous ? { ...message, params: { ...p, delta: previous.params.delta + p.delta } } : message);
    this.timer ||= setTimeout(() => this.flush(), 40);
  }

  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.pending.size) return;
    const messages = [...this.pending.values()]; this.pending.clear();
    this.emit('notifications', { messages });
  }

  close() { clearTimeout(this.timer); this.pending.clear(); }
}
