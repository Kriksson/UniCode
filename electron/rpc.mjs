import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

/** A single persistent stdio connection; never invokes a shell. */
export class CodexRpc extends EventEmitter {
  constructor({ command = process.env.UNICODE_CLI || process.env.CODEX_RED_CLI || 'codex', args = ['app-server'], cwd, timeout = 45000 } = {}) {
    super();
    Object.assign(this, { command, args, cwd, timeout });
    this.pending = new Map();
    this.requests = new Map();
    this.sequence = 0;
    this.connected = false;
    this.generation = 0;
  }

  async connect() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.initialize().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async initialize() {
    const generation = ++this.generation;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CODEX_THREAD_ID;
    const child = spawn(this.command, this.args, {
      cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child = child;
    let diagnostic = '';
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-3000); });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      if (generation !== this.generation) return;
      try { this.receive(JSON.parse(line)); } catch { /* Ignore non-protocol stdout. */ }
    });
    const disconnected = error => {
      if (generation !== this.generation) return;
      this.connected = false;
      this.child = null;
      this.requests.clear();
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
      this.emit('disconnected', error.message);
    };
    child.once('error', error => disconnected(new Error(
      error.code === 'ENOENT' ? 'Codex CLI не найден. Установите его и перезапустите приложение.' : error.message,
    )));
    child.once('exit', (code, signal) => disconnected(new Error(
      `Соединение с Codex закрыто (${signal || code}).${diagnostic ? ` ${diagnostic}` : ''}`,
    )));
    child.stdin.on('error', () => {});
    try {
      const result = await this.request('initialize', {
        clientInfo: { name: 'unicode_v1', title: 'UniCode v1', version: '1.3.0' },
      });
      this.notify('initialized', {});
      this.connected = true;
      this.emit('connected', result);
      return result;
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  receive(message) {
    if (message.method) {
      if (message.id !== undefined) {
        this.requests.set(message.id, message);
        this.emit('request', message);
      } else {
        if (message.method === 'serverRequest/resolved') this.requests.delete(message.params.requestId);
        this.emit('notification', message);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'Ошибка Codex'), { code: message.error.code }));
    else pending.resolve(message.result);
  }

  write(value) {
    if (!this.child?.stdin.writable || this.child.killed) throw new Error('Нет соединения с Codex');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex не ответил на ${method}. Проверьте соединение.`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params) { this.write({ method, params }); }

  respond(id, result) {
    if (!this.requests.has(id)) throw new Error('Запрос уже закрыт');
    this.write({ id, result });
    this.requests.delete(id);
  }

  rejectRequest(id, message = 'Этот тип запроса пока не поддерживается клиентом') {
    this.write({ id, error: { code: -32601, message } });
    this.requests.delete(id);
  }

  close() {
    this.child?.kill();
  }
}
