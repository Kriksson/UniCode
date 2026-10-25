import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CodexRpc } from './rpc.mjs';
import { LocalStore } from './store.mjs';
import { openMessageLink } from './links.mjs';
import { AttentionNotifications } from './attention.mjs';
import { HistoryReader, threadMetadata } from './history.mjs';
import { EventStream } from './event-stream.mjs';
import { PhoneServer } from './phone.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const isTest = process.env.CODEX_RED_TEST === '1' && !app.isPackaged;
if (isTest && process.env.CODEX_RED_DATA) app.setPath('userData', process.env.CODEX_RED_DATA);
app.setName('UniCode v1');
if (process.platform === 'linux') app.setDesktopName('unicode-v1.desktop');
if (!isTest) app.setPath('userData', join(app.getPath('appData'), 'UniCode v1'));
const ownsLock = isTest || app.requestSingleInstanceLock();
if (!ownsLock) app.quit();
let window;
let rpc;
let store;
let attention;
let history;
let stream;
let limitsRead;
let phone;
let desktopShared;
const sharedFields = value => ({ folders: value.folders, chats: value.chats, hidden: value.hidden });
function mergeEntries(current, previous, incoming) {
  const result = { ...current };
  for (const key of new Set([...Object.keys(previous), ...Object.keys(incoming)])) {
    if (JSON.stringify(previous[key]) === JSON.stringify(incoming[key])) continue;
    if (!(key in incoming)) { delete result[key]; continue; }
    const before = previous[key] || {}; const after = incoming[key];
    const merged = { ...result[key] };
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
      if (field in after) merged[field] = after[field]; else delete merged[field];
    }
    result[key] = merged;
  }
  return result;
}
let sharedState = '';
const handlers = new Map();
const liveTurns = new Map();
const activeTurns = new Set();
let quitting = false;
const emit = (type, payload) => {
  if (window && !window.isDestroyed()) window.webContents.send('codex:event', { type, ...payload });
  phone?.broadcast({ type, ...payload });
};
const threadId = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('Неверный идентификатор чата');
  return value;
};
const validCwd = async value => {
  if (typeof value !== 'string' || !isAbsolute(value) || !(await stat(value)).isDirectory()) throw new Error('Папка проекта недоступна');
  return value;
};
const accessModes = {
  'read-only': { sandbox: 'read-only', approvalPolicy: 'on-request' },
  'workspace-write': { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  'danger-full-access': { sandbox: 'danger-full-access', approvalPolicy: 'never' },
};
const options = async value => ({
  ...(value?.cwd ? { cwd: await validCwd(value.cwd) } : {}),
  ...(typeof value?.model === 'string' && value.model.length < 150 && value.model ? { model: value.model } : {}),
  ...(Object.hasOwn(accessModes, value?.access) ? accessModes[value.access] : accessModes['workspace-write']), approvalsReviewer: 'user',
});

function handle(name, fn) {
  handlers.set(name, fn);
  ipcMain.handle(`codex:${name}`, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Нет доступа');
    const result = await fn(...args);
    if (name === 'bootstrap') desktopShared = sharedFields(result.state);
    return result;
  });
}

async function openExternal(url) {
  if (typeof url !== 'string') return;
  let parsed;
  try { parsed = new URL(url); } catch { return; }
  if (['https:', 'http:', 'mailto:'].includes(parsed.protocol)) await shell.openExternal(parsed.href);
}

function registerHandlers() {
  handle('bootstrap', async () => {
    const state = await store.read();
    await rpc.connect();
    const [threads, models, account, config] = await Promise.allSettled([
      rpc.request('thread/list', { limit: 100, sortKey: 'updated_at', modelProviders: [], sourceKinds: ['cli', 'vscode', 'appServer'] }),
      rpc.request('model/list', {}),
      rpc.request('account/read', {}),
      rpc.request('config/read', {}),
    ]);
    if (threads.status === 'rejected') throw threads.reason;
    return { state, home: homedir(), threads: threads.value,
      models: models.status === 'fulfilled' ? models.value.data.filter(m => !m.hidden) : [],
      authenticated: account.status === 'fulfilled' && !!account.value.account,
      activeTurns: [...liveTurns].map(([threadId, turnId]) => ({ threadId, turnId })),
      requests: [...rpc.requests.values()],
      defaults: config.status === 'fulfilled' ? {
        model: config.value.config?.model || '', effort: config.value.config?.model_reasoning_effort || '',
      } : { model: '', effort: '' },
    };
  });
  handle('save', async value => {
    const previous = desktopShared;
    desktopShared = sharedFields(value);
    const saved = await store.update(current => {
      if (!previous) return value;
      const index = folders => Object.fromEntries(folders.map(folder => [folder.id, folder]));
      const folders = Object.values(mergeEntries(index(current.folders), index(previous.folders), index(value.folders)));
      const chats = mergeEntries(current.chats, previous.chats, value.chats);
      const removed = new Set(previous.hidden.filter(id => !value.hidden.includes(id)));
      const added = value.hidden.filter(id => !previous.hidden.includes(id));
      return { ...value, folders, chats, hidden: [...new Set([...current.hidden.filter(id => !removed.has(id)), ...added])] };
    });
    const message = sharedFields(saved);
    const serialized = JSON.stringify(message);
    if (sharedState !== serialized) { sharedState = serialized; phone?.broadcast({ type: 'state-updated', message }); }
  });
  handle('phone-status', async () => { await phone.loadDevices(); return phone.status(); });
  handle('manage-chat', async action => {
    if (!action || typeof action !== 'object') throw new Error('Неверное действие');
    const { kind, id, name, folderId, pinned } = action;
    if (!['rename', 'pin', 'move', 'hide', 'folder-create', 'folder-rename', 'folder-delete'].includes(kind)) throw new Error('Неизвестное действие');
    if (kind !== 'folder-create' && (typeof id !== 'string' || !id || id.length > 200)) throw new Error('Неверный идентификатор');
    if (['rename', 'folder-create', 'folder-rename'].includes(kind)
      && (typeof name !== 'string' || !name.trim() || name.length > (kind === 'rename' ? 120 : 80))) throw new Error('Неверное название');
    if (kind === 'pin' && typeof pinned !== 'boolean') throw new Error('Неверное закрепление');
    const value = await store.update(state => {
      if (['folder-rename', 'folder-delete'].includes(kind) && !state.folders.some(folder => folder.id === id)) throw new Error('Папка уже удалена');
      if (kind === 'move' && folderId !== null && !state.folders.some(folder => folder.id === folderId)) throw new Error('Папка уже удалена');
      if (kind === 'folder-create') state.folders.push({ id: randomUUID(), name: name.trim() });
      else if (kind === 'folder-rename') state.folders = state.folders.map(folder => folder.id === id ? { ...folder, name: name.trim() } : folder);
      else if (kind === 'folder-delete') {
        state.folders = state.folders.filter(folder => folder.id !== id);
        state.chats = Object.fromEntries(Object.entries(state.chats).map(([key, meta]) => [key, meta.folderId === id ? { ...meta, folderId: null } : meta]));
      } else if (kind === 'hide') state.hidden = [...new Set([...state.hidden, id])];
      else state.chats[id] = { ...state.chats[id], ...(kind === 'rename' ? { name: name.trim() } : kind === 'pin' ? { pinned } : { folderId }) };
      return state;
    });
    const message = { folders: value.folders, chats: value.chats, hidden: value.hidden };
    sharedState = JSON.stringify(message); emit('state-updated', { message });
    return { ...message, chats: Object.fromEntries(Object.entries(message.chats).filter(([, meta]) => !meta.draft)) };
  });
  handle('phone-start', host => phone.start(host));
  handle('phone-stop', () => phone.stop());
  handle('phone-code', () => phone.newCode());
  handle('phone-revoke', id => phone.revoke(id));
  handle('rate-limits', () => {
    if (!rpc.connected) return null;
    if (!limitsRead) limitsRead = rpc.request('account/rateLimits/read', {}).then(result => ({
      rateLimits: result.rateLimits || null, rateLimitsByLimitId: result.rateLimitsByLimitId || null,
    })).finally(() => { limitsRead = null; });
    return limitsRead;
  });
  handle('list', (cursor = null, searchTerm = null) => rpc.request('thread/list', {
    limit: 100, cursor, sortKey: 'updated_at', modelProviders: [], sourceKinds: ['cli', 'vscode', 'appServer'], searchTerm,
  }));
  handle('history', (id, cursor = null) => history.read(threadId(id), cursor));
  handle('delete-chat', async id => {
    id = threadId(id);
    if (activeTurns.has(id)) throw new Error('Сначала остановите текущий ответ');
    await rpc.connect();
    await rpc.request('thread/delete', { threadId: id });
  });
  handle('delete-from', async ({ id, turnId }) => {
    id = threadId(id); turnId = threadId(turnId);
    if (activeTurns.has(id)) throw new Error('Сначала остановите текущий ответ');
    await rpc.connect();
    const { thread: before } = await rpc.request('thread/read', { threadId: id });
    if (before.status?.type === 'active') throw new Error('Сначала остановите текущий ответ');
    await rpc.request('thread/resume', { threadId: id, excludeTurns: true });
    await rpc.request('thread/revert', { threadId: id, beforeTurnId: turnId });
    emit('history-invalidated', { threadId: id });
    return history.read(id);
  });
  handle('send', async value => {
    if (typeof value?.text !== 'string' || !value.text.trim() || value.text.length > 250_000) throw new Error('Сообщение пустое или слишком длинное');
    await rpc.connect();
    const params = await options(value);
    const response = value.id
      ? await rpc.request('thread/resume', { threadId: threadId(value.id), ...params, excludeTurns: true })
      : await rpc.request('thread/start', params);
    const id = response.thread.id;
    const visibleThread = threadMetadata({ ...response.thread, preview: response.thread.preview || value.text.replace(/\s+/g, ' ').slice(0, 80) });
    // Tell the renderer the canonical id before turn notifications can arrive.
    emit('thread-ready', { localId: value.localId, thread: visibleThread });
    try {
      const { turn } = await rpc.request('turn/start', {
        threadId: id, input: [{ type: 'text', text: value.text, text_elements: [] }],
        ...(value.model ? { model: value.model } : {}),
        ...(typeof value.effort === 'string' && value.effort && value.effort.length < 100 ? { effort: value.effort } : {}),
      });
      attention.answerText(id, value.text);
      return { thread: visibleThread, turn };
    } catch (error) {
      emit('send-failed', { threadId: id, message: error.message });
      throw error;
    }
  });
  handle('interrupt', value => rpc.request('turn/interrupt', { threadId: threadId(value.id), turnId: threadId(value.turnId) }));
  handle('steer', async value => {
    if (typeof value?.text !== 'string' || !value.text.trim() || value.text.length > 250_000) throw new Error('Ответ пустой или слишком длинный');
    const result = await rpc.request('turn/steer', { threadId: threadId(value.id), expectedTurnId: threadId(value.turnId), input: [{ type: 'text', text: value.text, text_elements: [] }] });
    attention.answerText(value.id, value.text);
    return result;
  });
  handle('choose-folder', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Папка проекта', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('answer', ({ id, decision, answers }) => {
    const request = rpc.requests.get(id);
    if (!request) throw new Error('Запрос уже закрыт');
    const allow = decision === 'accept';
    if (request.method === 'item/tool/requestUserInput') {
      const validated = {};
      for (const question of request.params.questions) {
        const answer = answers?.[question.id];
        if (!Array.isArray(answer) || answer.some(a => typeof a !== 'string') || !answer.length) throw new Error('Ответьте на каждый вопрос');
        validated[question.id] = { answers: answer };
      }
      rpc.respond(id, { answers: validated });
    } else if (request.method === 'item/permissions/requestApproval') {
      rpc.respond(id, { permissions: allow ? request.params.permissions : {}, scope: 'turn' });
    } else if (request.method === 'mcpServer/elicitation/request') {
      rpc.respond(id, { action: 'decline', content: null, _meta: null });
    } else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) {
      rpc.respond(id, { decision: allow ? 'accept' : 'decline' });
    } else throw new Error('Неподдерживаемый запрос');
    attention.resolveRequest(id);
    emit('request-resolved', { id });
  });
  handle('login', async () => {
    const result = await rpc.request('account/login/start', { type: 'chatgpt' });
    if (result.authUrl) await openExternal(result.authUrl);
    return { loginId: result.loginId };
  });
  handle('external', openExternal);
  handle('open-link', value => openMessageLink(value, shell));
  handle('window', action => {
    if (action === 'minimize') window.minimize();
    else if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
    else if (action === 'close') window.close();
  });
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1220, height: 820, minWidth: 780, minHeight: 560,
    title: 'UniCode v1', backgroundColor: '#ffffff', frame: false, show: false,
    icon: nativeImage.createFromPath(join(root, 'assets/icon.png')),
    webPreferences: {
      preload: join(root, 'electron/preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('focus', () => window.flashFrame(false));
  window.on('close', event => {
    if (!window || window.isDestroyed()) return;
    if ((rpc.requests.size || activeTurns.size) && !isTest) {
      const choice = dialog.showMessageBoxSync(window, {
        type: 'question', message: 'Codex ещё работает. Закрыть приложение?', detail: 'Текущая работа будет остановлена. История переписки сохранится.',
        buttons: ['Остаться', 'Закрыть'], defaultId: 0, cancelId: 0,
      });
      if (choice === 0) event.preventDefault();
    }
  });
  if (process.env.CODEX_RED_DEV === '1' && !app.isPackaged) await window.loadURL('http://127.0.0.1:5178');
  else await window.loadFile(join(root, 'dist/index.html'));
}

if (ownsLock) {
  app.whenReady().then(async () => {
    store = new LocalStore(join(app.getPath('userData'), 'state.json'));
    rpc = new CodexRpc({ cwd: homedir() });
    history = new HistoryReader(rpc);
    stream = new EventStream(emit);
    phone = new PhoneServer({
      root, dataPath: app.getPath('userData'),
      invoke: async (name, args) => {
        const fn = handlers.get(name);
        if (!fn) throw new Error('Действие недоступно');
        const result = await fn(...args);
        if (name === 'bootstrap') return { ...result, state: { ...result.state, selectedId: null, drafts: {},
          chats: Object.fromEntries(Object.entries(result.state.chats).filter(([, meta]) => !meta.draft)),
        } };
        return result;
      },
      changed: message => emit('phone-status', { message }),
      approve: async name => {
        if (!window || window.isDestroyed()) return false;
        if (window.isMinimized()) window.restore();
        window.show(); window.focus();
        const { response } = await dialog.showMessageBox(window, {
          type: 'question', title: 'UniCode v1', message: `Подключить ${name}?`,
          detail: 'Устройство получит доступ к переписке, отправке сообщений и подтверждению действий агента.',
          buttons: ['Подключить', 'Отмена'], defaultId: 1, cancelId: 1,
        });
        return response === 0;
      },
    });
    attention = new AttentionNotifications({
      icon: join(root, 'assets/icon.png'),
      sound: app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked/assets/attention.wav') : join(root, 'assets/attention.wav'),
      enabled: !isTest,
      indicate: () => { if (window && !window.isDestroyed() && !window.isFocused()) window.flashFrame(true); },
      activate: id => {
        if (!window || window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show(); window.focus(); window.flashFrame(false);
        if (id) emit('focus-thread', { threadId: id });
      },
    });
    rpc.on('notification', message => {
      if (message.method === 'turn/started') { activeTurns.add(message.params.threadId); liveTurns.set(message.params.threadId, message.params.turn.id); }
      if (message.method === 'turn/completed') { activeTurns.delete(message.params.threadId); liveTurns.delete(message.params.threadId); }
      attention.observe(message);
      stream.publish(message);
    });
    rpc.on('disconnected', message => { stream.flush(); activeTurns.clear(); liveTurns.clear(); attention.clear(); emit('disconnected', { message }); });
    rpc.on('request', message => {
      stream.flush();
      const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request'];
      if (supported.includes(message.method)) { emit('request', { message }); attention.request(message); }
      else rpc.rejectRequest(message.id);
    });
    registerHandlers();
    await createWindow();
  });
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    attention?.dispose();
    stream?.close();
    rpc?.close();
    Promise.allSettled([store?.queue, phone?.stop()]).finally(() => app.quit());
  });
}
