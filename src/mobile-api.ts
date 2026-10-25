import type { Event as CodexEvent } from './types';

type Api = Window['codex'];
const listeners = new Set<(event: CodexEvent) => void>();
let source: EventSource | null = null;
let opened: Promise<void> | null = null;
let openedOnce = false;
let checkAt = 0;
let pending: CodexEvent[] = [];

function emit(event: CodexEvent) {
  if (!listeners.size) { pending.push(event); if (pending.length > 200) pending.shift(); }
  else for (const listener of listeners) listener(event);
}

function events() {
  if (source) return source.readyState === EventSource.OPEN ? Promise.resolve() : opened!;
  source = new EventSource('/events');
  opened = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Не удалось подключиться к компьютеру.')), 12000);
    source!.onopen = () => {
      window.clearTimeout(timeout); resolve();
      emit({ type: openedOnce ? 'remote-resync' : 'remote-online' }); openedOnce = true;
    };
    source!.onmessage = event => {
      try {
        const message = JSON.parse(event.data) as CodexEvent;
        if (message.type === 'remote-revoked') { closeMobileApi(); window.dispatchEvent(new Event('unicode-unpaired')); }
        else emit(message);
      } catch { /* Ignore an incomplete frame. */ }
    };
    source!.onerror = () => {
      emit({ type: 'remote-offline' });
      if (Date.now() - checkAt < 5000) return;
      checkAt = Date.now();
      void fetch('/session', { cache: 'no-store' }).then(response => {
        if (response.status === 401) {
          closeMobileApi(); window.dispatchEvent(new Event('unicode-unpaired'));
        }
      }).catch(() => {});
    };
  });
  return opened;
}

async function request<T>(method: string, args: unknown[] = []): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 55000);
  try {
    const response = await fetch('/rpc', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }), signal: controller.signal });
    const payload = await response.json();
    if (response.status === 401) { closeMobileApi(); window.dispatchEvent(new Event('unicode-unpaired')); }
    if (!response.ok || payload.error) throw new Error(payload.error || 'Не удалось выполнить действие.');
    return payload.result as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Компьютер не ответил вовремя.');
    throw error;
  } finally { window.clearTimeout(timeout); }
}

export function closeMobileApi() {
  source?.close(); source = null; opened = null; openedOnce = false; listeners.clear(); pending = [];
}

export function installMobileApi() {
  closeMobileApi();
  const unsupported = async (): Promise<never> => { throw new Error('Это действие доступно на компьютере.'); };
  const api: Api = {
    bootstrap: async () => { await events(); return request<Awaited<ReturnType<Api['bootstrap']>>>('bootstrap'); },
    list: (...args) => request('list', args), history: (...args) => request('history', args),
    send: (...args) => request('send', args), steer: (...args) => request('steer', args),
    interrupt: (...args) => request('interrupt', args), answer: (...args) => request('answer', args),
    manageChat: (...args) => request('manage-chat', args),
    rateLimits: () => request('rate-limits'), save: unsupported, chooseFolder: unsupported,
    login: unsupported, deleteChat: (...args) => request('delete-chat', args), deleteFrom: (...args) => request('delete-from', args), window: unsupported,
    phoneStatus: unsupported, phoneStart: unsupported, phoneStop: unsupported, phoneCode: unsupported, phoneRevoke: unsupported,
    external: async href => { if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener,noreferrer'); },
    openLink: async ({ href }) => {
      if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
      else throw new Error('Локальные файлы доступны на компьютере.');
    },
    onEvent: callback => {
      listeners.add(callback);
      if (pending.length) { const queued = pending; pending = []; queueMicrotask(() => { for (const event of queued) if (listeners.has(callback)) callback(event); }); }
      void events().catch(() => emit({ type: 'remote-offline' }));
      return () => { listeners.delete(callback); };
    },
  };
  window.codex = api;
}
