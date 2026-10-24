import type { Item, Runtime } from './types';
import { questionReplies } from './presentation';

export const HISTORY_START = 1_000_000_000;
const visibleTypes = new Set(['userMessage', 'agentMessage', 'commandExecution', 'fileChange', 'mcpToolCall', 'plan']);
export const isVisibleItem = (item: Item) => visibleTypes.has(item.type)
  && (!['agentMessage', 'plan'].includes(item.type) || !!item.text || !!item.questions?.length);

/** Keep the answer index when an earlier question is fetched in a later page. */
export function collectAnswers(previous: string[] | undefined, items: Item[]): string[] | undefined {
  let result: Set<string> | undefined;
  for (const item of items) {
    if (item.type !== 'userMessage') continue;
    const text = (item.content || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n');
    for (const reply of questionReplies(text) || []) {
      if (!reply.questionItemId) continue;
      result ||= new Set(previous);
      result.add(reply.questionItemId);
    }
  }
  return result ? [...result] : previous;
}

/** Prepend older items without replacing newer streaming objects at the overlap. */
export function prependHistory(value: Runtime, older: Item[]): Pick<Runtime, 'items' | 'historyOffset' | 'answeredQuestionIds'> {
  const known = new Set(value.items.map(item => item.id));
  const added = older.filter(item => {
    if (known.has(item.id)) return false;
    known.add(item.id); return true;
  });
  return {
    items: [...added, ...value.items],
    historyOffset: (value.historyOffset ?? HISTORY_START) - added.filter(isVisibleItem).length,
    answeredQuestionIds: collectAnswers(value.answeredQuestionIds, older),
  };
}
