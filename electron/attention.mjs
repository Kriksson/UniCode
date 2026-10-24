import { Notification, nativeImage, shell } from 'electron';
import { spawn } from 'node:child_process';

const compact = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 220);
const requestKey = id => `request:${JSON.stringify(id)}`;

/** Native notifications are driven by live protocol events, never by history reads. */
export class AttentionNotifications {
  constructor({ icon, sound, activate, indicate, enabled = true }) {
    Object.assign(this, { icon, sound, activate, indicate, enabled });
    this.entries = new Map();
    this.seen = new Set();
    this.lastSound = 0;
  }

  show({ key, threadId, title, body, questionIds }) {
    if (!this.enabled || this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
    this.indicate();
    if (process.platform === 'linux') this.playSound();
    if (!Notification.isSupported()) {
      if (process.platform !== 'linux') shell.beep();
      return;
    }
    try {
      const notification = new Notification({
        title: `UniCode v1 · ${title}`, body: compact(body),
        icon: nativeImage.createFromPath(this.icon), silent: process.platform === 'linux', urgency: 'normal', timeoutType: 'never',
      });
      this.entries.set(key, { notification, threadId, questionIds });
      const release = () => { if (this.entries.get(key)?.notification === notification) this.entries.delete(key); };
      notification.once('click', () => { this.activate(threadId); this.dismiss(key); });
      notification.once('close', release);
      notification.once('failed', () => { release(); this.indicate(); });
      notification.show();
      if (this.entries.size > 32) this.dismiss(this.entries.keys().next().value);
    } catch { this.entries.delete(key); }
  }

  request(message) {
    const p = message.params;
    const labels = {
      'item/commandExecution/requestApproval': ['Нужно разрешение', p.command || p.reason || 'Агент ждёт разрешения на выполнение команды.'],
      'item/fileChange/requestApproval': ['Нужно разрешение', p.reason || 'Агент ждёт разрешения на изменение файлов.'],
      'item/permissions/requestApproval': ['Нужны дополнительные права', p.reason || 'Агент запрашивает дополнительные права для текущей задачи.'],
      'item/tool/requestUserInput': ['Нужен ваш ответ', p.questions?.[0]?.question || 'Агент задал вопрос.'],
      'mcpServer/elicitation/request': ['Требуется действие', p.message || 'Инструмент ожидает вашего ответа.'],
    };
    const label = labels[message.method];
    if (label) this.show({ key: requestKey(message.id), threadId: p.threadId, title: label[0], body: label[1] });
  }

  observe({ method, params: p }) {
    if (!p) return;
    if (method === 'serverRequest/resolved') this.resolveRequest(p.requestId);
    if (method === 'thread/deleted' || method === 'turn/completed') {
      for (const [key, entry] of this.entries) {
        // Async questions can still be answered after the agent finishes its turn.
        if (entry.threadId === p.threadId && (method === 'thread/deleted' || !entry.questionIds)) this.dismiss(key);
      }
    }
    if (!['item/started', 'item/completed'].includes(method) || !p.threadId || !p.item) return;
    const item = p.item;
    if (item.type === 'userMessage') {
      this.answerText(p.threadId, (item.content || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n'));
    }
    if (item.type === 'agentMessage' && item.questions?.length) {
      this.show({ key: `question:${p.threadId}:${item.id}`, threadId: p.threadId,
        title: 'Нужен ваш ответ', body: item.questions[0].title || 'Агент задал вопрос.',
        questionIds: new Set(item.questions.map((_, index) => JSON.stringify(['request_user_input_async', item.id, index]))),
      });
    }
  }

  answerText(threadId, text) {
    const match = text.trim().match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
    if (!match) return;
    let replies;
    try { replies = JSON.parse(match[1]); } catch { return; }
    if (!Array.isArray(replies)) return;
    const ids = new Set(replies.filter(reply => typeof reply?.answer === 'string' && reply.answer.trim()).map(reply => reply.questionItemId));
    for (const [key, entry] of this.entries) {
      if (entry.threadId !== threadId || !entry.questionIds) continue;
      for (const id of ids) entry.questionIds.delete(id);
      if (!entry.questionIds.size) this.dismiss(key);
    }
  }

  resolveRequest(id) { this.dismiss(requestKey(id)); }

  dismiss(key) {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    entry?.notification.close();
  }

  clear() {
    for (const key of this.entries.keys()) this.dismiss(key);
    this.seen.clear();
  }

  playSound() {
    if (Date.now() - this.lastSound < 1200) return;
    this.lastSound = Date.now();
    this.cancelSound?.();
    const players = [
      ['paplay', [this.sound]], ['pw-play', [this.sound]],
      ['canberra-gtk-play', ['--file', this.sound, '--description', 'UniCode v1']],
    ];
    const attempt = index => {
      if (!this.enabled) return;
      if (index >= players.length) { shell.beep(); return; }
      const [command, args] = players[index];
      const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
      let settled = false;
      const finish = failed => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.cancelSound = null;
        if (failed) attempt(index + 1);
      };
      const timer = setTimeout(() => { child.kill(); finish(true); }, 3000);
      timer.unref();
      child.once('error', () => finish(true));
      child.once('exit', code => finish(code !== 0));
      this.cancelSound = () => { settled = true; clearTimeout(timer); child.kill(); };
    };
    attempt(0);
  }

  dispose() {
    this.enabled = false;
    this.cancelSound?.();
    this.clear();
  }
}
