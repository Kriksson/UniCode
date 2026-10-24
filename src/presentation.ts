import type { Item } from './types';

export type QuestionReply = { question: string; answer: string; questionItemId?: string };

/** Decode only complete transport envelopes, leaving quoted examples untouched. */
export function questionReplies(text: string): QuestionReply[] | null {
  const match = text.trim().match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    if (!Array.isArray(value) || !value.length || value.some(reply => !reply || typeof reply.question !== 'string' || typeof reply.answer !== 'string')) return null;
    return value.map(reply => ({ question: reply.question, answer: reply.answer, questionItemId: typeof reply.questionItemId === 'string' ? reply.questionItemId : undefined }));
  } catch { return null; }
}

/** Preserve local file destinations without allowing executable URL schemes. */
export function messageLinkUrl(value: string): string {
  const url = value.trim();
  if (!url || /[\u0000-\u001f\u007f]/.test(url) || url.startsWith('//')) return '';
  const scheme = url.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase();
  return !scheme || ['http', 'https', 'mailto', 'file'].includes(scheme) ? url : '';
}

export const effortLabel = (effort: string) => ({
  none: 'Без рассуждений', minimal: 'Минимальная', low: 'Низкая', medium: 'Средняя', high: 'Высокая', xhigh: 'Очень высокая', max: 'Максимальная', ultra: 'Предельная',
} as Record<string, string>)[effort] || effort;
const compact = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 140);

export function itemActivity(item?: Item): string {
  if (!item) return 'Готовит ответ';
  if (item.type === 'commandExecution') {
    const action = item.commandActions?.find(action => action.type !== 'unknown');
    if (action?.type === 'read') return `Читает ${compact(action.name || action.path || 'файл')}`;
    if (action?.type === 'listFiles') return `Просматривает файлы${action.path ? ' · ' + compact(action.path) : ''}`;
    if (action?.type === 'search') return `Ищет${action.query ? ' «' + compact(action.query) + '»' : ' в файлах'}${action.path ? ' · ' + compact(action.path) : ''}`;
    return item.command ? `Выполняет · ${compact(item.command)}` : 'Выполняет команду';
  }
  if (item.type === 'fileChange') return item.changes?.length === 1 ? `Изменяет ${compact(item.changes[0].path)}` : `Изменяет файлы${item.changes?.length ? ' · ' + item.changes.length : ''}`;
  if (item.type === 'mcpToolCall') return `Вызывает ${compact([item.server, item.tool].filter(Boolean).join(' / '))}`;
  if (item.type === 'dynamicToolCall') return `Выполняет ${compact(item.tool || 'инструмент')}`;
  if (item.type === 'reasoning') return 'Продумывает решение';
  if (item.type === 'agentMessage') return item.phase === 'commentary' ? 'Сообщает о ходе работы' : 'Пишет ответ';
  if (item.type === 'plan') return 'Составляет план';
  if (item.type === 'webSearch') return 'Ищет информацию в интернете';
  if (item.type === 'contextCompaction') return 'Сжимает историю разговора';
  if (item.type === 'imageView') return 'Рассматривает изображение';
  if (item.type === 'imageGeneration') return 'Создаёт изображение';
  if (item.type === 'collabAgentToolCall') return 'Работает с помощником';
  return 'Готовит ответ';
}

export function liveActivity(items: Item[]): string {
  return itemActivity([...items].reverse().find(item => item.inProgress && item.type !== 'userMessage'));
}
