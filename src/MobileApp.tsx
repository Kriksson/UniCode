import { Presence } from './Presence';
import { useAgents, AgentBranches, AgentProgress, AgentParent, agentFinished } from './Agents';
import { Connections } from './Connections';
import { useAttachments, AttachmentButton, AttachmentStrip, attachmentMessage, MessageFiles } from './Attachments';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Check, Folder, LoaderCircle, MessageSquare, Pin, Search, Square, SquarePen, WifiOff, X, MoreHorizontal, Plus, Pencil, Trash2, EyeOff } from 'lucide-react';
import { Message, Approval } from './App';
import { ChatHistory } from './ChatHistory';
import { PlanUsage } from './PlanUsage';
import { RunOptions } from './RunOptions';
import { autoEffort, resolveAutoModels } from './auto-models';
import { collectAnswers, HISTORY_START, prependHistory } from './history';
import { liveActivity } from './presentation';
import type { ChatAction, Event, Item, Model, Runtime, ServerRequest, State, Thread } from './types';
import appIcon from '../assets/icon-v2.svg';

const api = window.codex;
const blank = (): Runtime => ({ items: [], busy: false });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const uniqueId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
function saved<T>(key: string, fallback: T): T { try { return JSON.parse(sessionStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } }
function useLive<A extends unknown[], R>(callback: (...args: A) => R) {
  const ref = useRef(callback); ref.current = callback;
  return useCallback((...args: A) => ref.current(...args), []);
}

export default function MobileApp() {
  const { agents, seed: seedAgents } = useAgents();
  const agentIds = useRef(new Set<string>()); agentIds.current = new Set(agents.map(agent => agent.id));
  const [state, setState] = useState<State | null>(null);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [models, setModels] = useState<Model[]>([]);
  const [defaults, setDefaults] = useState({ model: '', effort: '' });
  const [home, setHome] = useState('');
  const [runtime, setRuntime] = useState<Record<string, Runtime>>({});
  const runtimeRef = useRef(runtime); runtimeRef.current = runtime;
  const [selectedId, setSelectedId] = useState<string | null>(() => saved('unicode-mobile-chat', null));
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  const [showChats, setShowChats] = useState(!selectedId);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => saved('unicode-mobile-drafts', {}));
  const [preferences, setPreferences] = useState<Record<string, Partial<State>>>({});
  const [requests, setRequests] = useState<ServerRequest[]>([]);
  const [online, setOnline] = useState(true);
  const [authenticated, setAuthenticated] = useState(true);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState('all');
  const [cursor, setCursor] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [scrollSignal, setScrollSignal] = useState(0);
  const [copied, setCopied] = useState('');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [dialog, setDialog] = useState<{ kind: 'rename' | 'folder-create' | 'folder-rename' | 'folder-delete' | 'hide' | 'delete' | 'messages'; id: string; value: string; turnId?: string } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const loading = useRef(new Map<string, string>());
  const older = useRef(new Map<string, string>());
  const aliases = useRef(new Map<string, string>());
  const liveState = useRef(new Map<string, { busy: boolean; turnId?: string }>());
  const sending = useRef(false);
  const settingsQueue = useRef(Promise.resolve());
  const generation = useRef(0);
  const historyEpochs = useRef(new Map<string, number>());
  const historyKey = (id: string) => `${generation.current}:${historyEpochs.current.get(id) || 0}`;
  const questionDrafts = useRef(new Map<string, Record<number, string>>());
  const composer = useRef<HTMLTextAreaElement>(null);

  const update = useCallback((id: string, fn: (value: Runtime) => Runtime) => setRuntime(all => ({ ...all, [id]: fn(all[id] || blank()) })), []);
  const bootstrap = useCallback(async () => {
    setBooting(true);
    try {
      const result = await api.bootstrap();
      seedAgents(result.agents);
      setState(result.state); setHome(result.home); setModels(result.models); setDefaults(result.defaults || { model: '', effort: '' });
      setThreads(Object.fromEntries(result.threads.data.map(thread => [thread.id, thread])));
      setCursor(result.threads.nextCursor); setRequests(result.requests); setAuthenticated(result.authenticated); setOnline(true); setError('');
      setRuntime(all => {
        const next = { ...all };
        for (const turn of result.activeTurns || []) {
          const latest = liveState.current.get(turn.threadId);
          if (!latest || latest.busy) next[turn.threadId] = { ...(next[turn.threadId] || blank()), busy: true, turnId: latest?.turnId || turn.turnId, activity: next[turn.threadId]?.activity || 'Агент работает' };
        }
        return next;
      });
    } catch (error) { setError(errorText(error)); setOnline(false); }
    finally { setBooting(false); }
  }, []);
  useEffect(() => { void bootstrap(); }, [bootstrap]);

  useEffect(() => api.onEvent(event => {
    function receive(event: Event) {
      if (event.type === 'remote-offline') { setOnline(false); return; }
      if (event.type === 'remote-online') { setOnline(true); return; }
      if (event.type === 'remote-resync') {
        generation.current++; loading.current.clear(); older.current.clear(); liveState.current.clear(); setRuntime({}); setRequests([]); void bootstrap(); return;
      }
      if (event.type === 'disconnected') {
        setOnline(false); setError('Агент на компьютере отключился.'); setRequests([]); liveState.current.clear();
        setRuntime(all => Object.fromEntries(Object.entries(all).map(([id, value]) => [id, { ...value, busy: false, turnId: undefined, loaded: false, items: value.items.map(item => item.inProgress ? { ...item, inProgress: false } : item) }])));
        return;
      }
      if (event.type === 'history-invalidated' && event.threadId) {
        historyEpochs.current.set(event.threadId, (historyEpochs.current.get(event.threadId) || 0) + 1);
        loading.current.delete(event.threadId); older.current.delete(event.threadId);
        update(event.threadId, value => ({ ...blank(), historyVersion: (value.historyVersion || 0) + 1 })); return;
      }
      if (event.type === 'state-updated') {
        const shared = event.message as Pick<State, 'chats' | 'folders' | 'hidden'>;
        setPreferences(all => Object.fromEntries(Object.entries(all).map(([id, preference]) => {
          const next = { ...preference };
          for (const key of ['serviceTier', 'autoCoordinator', 'autoWorker'] as const) {
            if (next[key] !== undefined && next[key] === shared.chats[id]?.[key]) delete next[key];
          }
          return [id, next];
        })));
        setState(value => value ? { ...value, ...shared, chats: { ...Object.fromEntries(Object.entries(value.chats).filter(([, meta]) => meta.draft)), ...Object.fromEntries(Object.entries(shared.chats).filter(([, meta]) => !meta.draft)) } } : value);
        return;
      }
      if (event.type === 'request') { setRequests(all => [...all.filter(request => request.id !== event.message.id), event.message]); return; }
      if (event.type === 'request-resolved') { setRequests(all => all.filter(request => request.id !== event.id)); return; }
      if (event.type === 'thread-ready' && event.thread) {
        const thread = event.thread; const previous = event.localId || thread.id;
        aliases.current.set(previous, thread.id);
        setThreads(all => ({ ...all, [thread.id]: thread }));
        setSelectedId(value => value === previous ? thread.id : value);
        setState(value => {
          if (!value) return value;
          const chats = { ...value.chats }; const meta = chats[previous] || {};
          if (previous !== thread.id) delete chats[previous];
          chats[thread.id] = { ...meta, draft: false, cwd: thread.cwd };
          return { ...value, chats };
        });
        setPreferences(all => previous === thread.id || !all[previous] ? all : { ...all, [thread.id]: all[previous] });
        setRuntime(all => {
          const next = { ...all, [thread.id]: all[previous] || all[thread.id] || blank() };
          if (previous !== thread.id) delete next[previous];
          return next;
        }); return;
      }
      if (event.type !== 'notification') return;
      const { method, params: p } = event.message;
      if (method === 'serverRequest/resolved') setRequests(all => all.filter(request => request.id !== p.requestId));
      if (method === 'account/updated') setAuthenticated(!!p.authMode);
      const id = p.threadId;
      if (!id) return;
      if (agentIds.current.has(id) && id !== selectedRef.current && method.startsWith('item/')) return;
      if (method === 'thread/deleted') {
        historyEpochs.current.set(id, (historyEpochs.current.get(id) || 0) + 1);
        loading.current.delete(id); older.current.delete(id);
        setMenuId(value => value === id ? null : value);
        setDialog(value => value?.id === id ? null : value);
        setDrafts(all => { const next = { ...all }; delete next[id]; return next; });
        setThreads(all => { const next = { ...all }; delete next[id]; return next; });
        setState(value => { if (!value) return value; const chats = { ...value.chats }; delete chats[id]; return { ...value, chats }; });
        if (selectedRef.current === id) { setSelectedId(null); setShowChats(true); }
        setRuntime(all => { const next = { ...all }; delete next[id]; return next; }); return;
      }
      if (method === 'turn/started') { liveState.current.set(id, { busy: true, turnId: p.turn.id }); update(id, value => ({ ...value, busy: true, turnId: p.turn.id, activity: 'Готовит ответ', error: undefined })); }
      if (method === 'turn/completed') {
        liveState.current.set(id, { busy: false });
        update(id, value => ({ ...value, busy: false, turnId: undefined, items: value.items.map(item => item.inProgress ? { ...item, inProgress: false } : item), error: p.turn.status === 'failed' ? p.turn.error?.message || 'Не удалось завершить ответ' : undefined }));
        setRequests(all => all.filter(request => request.params.threadId !== id));
      }
      if (method === 'item/started' || method === 'item/completed') update(id, value => {
        const incoming = { ...p.item, turnId: p.turnId, inProgress: method === 'item/started' } as Item;
        const items = value.items.filter(item => !(incoming.type === 'userMessage' && item.id.startsWith('pending-')));
        const index = items.findIndex(item => item.id === incoming.id);
        if (index < 0) items.push(incoming); else items[index] = { ...items[index], ...incoming };
        return { ...value, items, activity: liveActivity(items), answeredQuestionIds: incoming.type === 'userMessage' ? collectAnswers(value.answeredQuestionIds, [incoming]) : value.answeredQuestionIds };
      });
      if (method === 'item/agentMessage/delta') update(id, value => {
        const items = [...value.items]; const index = items.findIndex(item => item.id === p.itemId);
        if (index < 0) items.push({ id: p.itemId, type: 'agentMessage', text: p.delta, turnId: p.turnId, inProgress: true });
        else items[index] = { ...items[index], text: (items[index].text || '') + p.delta };
        return { ...value, items, activity: 'Пишет ответ' };
      });
      if (method === 'item/commandExecution/outputDelta') update(id, value => ({ ...value, items: value.items.map(item => item.id === p.itemId ? { ...item, aggregatedOutput: ((item.aggregatedOutput || '') + p.delta).slice(-100000) } : item) }));
      if (method === 'item/reasoning/summaryTextDelta') update(id, value => ({ ...value, activity: 'Продумывает решение' }));
      if (method === 'item/mcpToolCall/progress') update(id, value => ({ ...value, activity: p.message?.slice(0, 160) || value.activity }));
      if (method === 'thread/name/updated') setThreads(all => all[id] ? { ...all, [id]: { ...all[id], name: p.threadName } } : all);
      if (method === 'error' && !p.willRetry) update(id, value => ({ ...value, error: p.error?.message || 'Ошибка агента' }));
    }
    if (event.type === 'notifications') for (const message of event.messages || []) receive({ type: 'notification', message });
    else receive(event);
  }), [bootstrap, update]);

  const loadHistory = useCallback(async (id: string) => {
    const epoch = historyKey(id || '');
    if (loading.current.get(id) === epoch) return;
    loading.current.set(id, epoch);
    update(id, value => ({ ...value, error: undefined }));
    try {
      const page = await api.history(id);
      if (epoch !== historyKey(id)) return;
      if (page.thread) setThreads(all => ({ ...all, [id]: page.thread! }));
      update(id, value => ({ ...value, ...prependHistory(value, page.items), loaded: true, historyCursor: page.cursor, historyVersion: (value.historyVersion || 0) + 1 }));
    } catch (error) { if (epoch === historyKey(id)) update(id, value => ({ ...value, error: errorText(error) })); }
    finally { if (loading.current.get(id) === epoch) loading.current.delete(id); }
  }, [update]);
  const selectedAgent = agents.find(agent => agent.id === selectedId);
  const storedActive = runtime[selectedId || ''] || blank();
  const active = selectedAgent && !agentFinished(selectedAgent) ? { ...storedActive, busy: true, activity: selectedAgent.activity } : storedActive;
  const meta = state?.chats[selectedId || ''];
  useEffect(() => { if (selectedId && state && online && !meta?.draft && !active.loaded && !active.error) void loadHistory(selectedId); }, [selectedId, !!state, online, meta?.draft, active.loaded, active.error, loadHistory]);
  useEffect(() => {
    setRuntime(all => {
      const idle = Object.keys(all).filter(id => id !== selectedId && !all[id].busy);
      if (idle.length <= 2) return all;
      const keep = new Set(idle.slice(-2));
      return Object.fromEntries(Object.entries(all).filter(([id, value]) => id === selectedId || value.busy || keep.has(id)));
    });
    try { sessionStorage.setItem('unicode-mobile-chat', JSON.stringify(selectedId)); } catch { /* Storage may be disabled. */ }
  }, [selectedId, Object.values(runtime).filter(value => value.busy).length]);
  useEffect(() => {
    const timer = window.setTimeout(() => { try { sessionStorage.setItem('unicode-mobile-drafts', JSON.stringify(drafts)); } catch { /* Keep the in-memory draft. */ } }, 200);
    return () => window.clearTimeout(timer);
  }, [drafts]);
  useEffect(() => {
    const viewport = () => document.documentElement.style.setProperty('--mobile-height', `${window.visualViewport?.height || window.innerHeight}px`);
    viewport(); window.visualViewport?.addEventListener('resize', viewport);
    return () => window.visualViewport?.removeEventListener('resize', viewport);
  }, []);
  useEffect(() => {
    if (!query.trim() || !online) return;
    let alive = true;
    const timer = window.setTimeout(() => { void api.list(null, query.trim()).then(result => { if (alive) setThreads(all => ({ ...all, ...Object.fromEntries(result.data.map(thread => [thread.id, thread])) })); }).catch(() => {}); }, 350);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [query, online]);

  useEffect(() => { if (state && folder !== 'all' && folder !== 'pinned' && !state.folders.some(item => item.id === folder)) setFolder('all'); }, [state?.folders, folder]);
  const previousAgent = useRef<{ id: string; active: boolean } | null>(null);
  useEffect(() => {
    const before = previousAgent.current;
    if (selectedAgent && agentFinished(selectedAgent) && before?.id === selectedAgent.id && before.active) setSelectedId(selectedAgent.parentId);
    previousAgent.current = selectedAgent ? { id: selectedAgent.id, active: !agentFinished(selectedAgent) } : null;
  }, [selectedId, selectedAgent?.status]);
  const openAgent = (id: string) => { setSelectedId(id); setShowChats(false); setScrollSignal(value => value + 1); setError(''); };
  const selected = threads[selectedId || ''];
  const preference = preferences[selectedId || ''] || {};
  const cwd = preference.cwd || meta?.cwd || selected?.cwd || selectedAgent?.cwd || state?.cwd || home;
  const model = preference.model ?? meta?.model ?? selected?.model ?? selectedAgent?.model ?? state?.model ?? '';
  const effort = preference.effort ?? meta?.effort ?? '';
  const autoCoordinator = preference.autoCoordinator ?? meta?.autoCoordinator ?? '';
  const autoWorker = preference.autoWorker ?? meta?.autoWorker ?? '';
  const autoModels = resolveAutoModels(models, autoCoordinator, autoWorker);
  const serviceTier = preference.serviceTier ?? meta?.serviceTier ?? 'default';
  const access = preference.access ?? meta?.access ?? 'workspace-write';
  const draft = drafts[selectedId || ''] || '';
  const attachment = useAttachments(selectedId || 'empty', !selectedId || !state || !online || !authenticated, setError);
  useEffect(() => { if (composer.current) { composer.current.style.height = 'auto'; composer.current.style.height = `${Math.min(composer.current.scrollHeight, 130)}px`; } }, [draft]);
  const answered = useMemo(() => new Set(active.answeredQuestionIds || []), [active.answeredQuestionIds]);
  const activeRequests = requests.filter(request => request.params.threadId === selectedId);
  const title = meta?.name || selected?.name || selectedAgent?.name || selected?.preview?.replace(/\s+/g, ' ').slice(0, 80) || 'Новый чат';

  const loadEarlier = useLive(async () => {
    const id = selectedRef.current; const cursor = id && runtimeRef.current[id]?.historyCursor;
    const epoch = historyKey(id || '');
    if (!id || !cursor || older.current.get(id) === epoch) return;
    older.current.set(id, epoch); update(id, value => ({ ...value, loadingOlder: true, historyError: undefined }));
    try {
      const page = await api.history(id, cursor);
      if (epoch === historyKey(id) && runtimeRef.current[id]) update(id, value => ({ ...value, ...prependHistory(value, page.items), historyCursor: page.cursor, loadingOlder: false }));
    } catch (error) { if (epoch === historyKey(id)) update(id, value => ({ ...value, loadingOlder: false, historyError: errorText(error) })); }
    finally { if (older.current.get(id) === epoch) older.current.delete(id); }
  });
  const send = useLive(async (override?: string, steer = false): Promise<boolean> => {
    const id = selectedId; const text = (override ?? draft).trim();
    const attached = override === undefined ? attachment.items : [];
    const attachmentIds = attached.map(file => file.id);
    if (!id || (!text && !attached.length) || attachment.uploading || !online || !authenticated || sending.current || (!meta?.draft && !active.loaded)) return false;
    if (active.busy && steer && !active.turnId) return false;
    const pendingId = `pending-${uniqueId()}`;
    sending.current = true; setError('');
    if (override === undefined) setDrafts(value => ({ ...value, [id]: '' }));
    update(id, value => ({ ...value, busy: true, loaded: true, error: undefined, items: [...value.items, { id: pendingId, type: 'userMessage', content: [{ type: 'text', text }], attachments: attached }] }));
    setScrollSignal(value => value + 1);
    try {
      let canonical = id;
      if (steer && active.busy && active.turnId) await api.steer({ id, turnId: active.turnId, text });
      else {
        const info = model === 'auto' ? autoModels.coordinator : models.find(item => item.model === (model || defaults.model)) || models.find(item => item.isDefault);
        const result = await api.send({ id: meta?.draft ? undefined : id, localId: id, text, attachments: attachmentIds, interruptActive: true, serviceTier, autoCoordinator, autoWorker, cwd, model: model || defaults.model || info?.model || '', effort: effort || (model === 'auto' ? autoEffort(info) : !model ? defaults.effort : '') || info?.defaultReasoningEffort, access });
        canonical = result.thread.id;
        if (meta?.draft) {
          const actions: ChatAction[] = [];
          if (meta.name) actions.push({ kind: 'rename', id: canonical, name: meta.name });
          actions.push({ kind: 'speed', id: canonical, serviceTier });
          if (meta.pinned) actions.push({ kind: 'pin', id: canonical, pinned: true });
          if (meta.folderId) actions.push({ kind: 'move', id: canonical, folderId: meta.folderId });
          for (const action of actions) {
            try { mergeShared(await api.manageChat(action)); } catch (error) { setError(errorText(error)); }
          }
        }
        update(canonical, value => ({ ...value, turnId: value.busy ? value.turnId || result.turn.id : undefined }));
      }
      attachment.sent(attachmentIds);
      update(canonical, value => ({ ...value, answeredQuestionIds: collectAnswers(value.answeredQuestionIds, [{ id: pendingId, type: 'userMessage', content: [{ type: 'text', text }], attachments: attached }]) }));
      return true;
    } catch (error) {
      const canonical = aliases.current.get(id) || id;
      update(canonical, value => ({ ...value, busy: steer ? value.busy : liveState.current.has(canonical) ? !!liveState.current.get(canonical)?.busy : active.busy && value.busy, items: value.items.filter(item => item.id !== pendingId), error: errorText(error) }));
      if (override === undefined) setDrafts(value => ({ ...value, [canonical]: value[canonical] ? `${text}\n\n${value[canonical]}` : text }));
      return false;
    } finally { sending.current = false; }
  });
  const copy = useCallback(async (text: string, id: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(id); window.setTimeout(() => setCopied(''), 1800); }
    catch { setError('Не удалось скопировать текст.'); }
  }, []);
  const answerQuestion = useLive((text: string) => send(text, true));
  const onDelete = useLive((item: Item) => {
    if (selectedId && item.turnId) setDialog({ kind: 'messages', id: selectedId, turnId: item.turnId, value: '' });
  });
  const mergeShared = (shared: Pick<State, 'chats' | 'folders' | 'hidden'>) => setState(value => value ? {
    ...value, ...shared, chats: { ...shared.chats, ...Object.fromEntries(Object.entries(value.chats).filter(([, meta]) => meta.draft)) },
  } : value);
  async function manage(action: ChatAction) {
    if (actionBusy || !online) return;
    setActionBusy(true); setError('');
    try {
      if ('id' in action && state?.chats[action.id]?.draft && ['pin', 'rename', 'move', 'hide'].includes(action.kind)) {
        setState(value => {
          if (!value) return value;
          if (action.kind === 'hide') return { ...value, hidden: [...value.hidden, action.id] };
          const patch = action.kind === 'pin' ? { pinned: action.pinned } : action.kind === 'rename' ? { name: action.name } : action.kind === 'move' ? { folderId: action.folderId } : {};
          return { ...value, chats: { ...value.chats, [action.id]: { ...value.chats[action.id], ...patch } } };
        });
      } else mergeShared(await api.manageChat(action));
      if (action.kind === 'hide' && selectedId === action.id) { setSelectedId(null); setShowChats(true); }
      if (action.kind === 'folder-delete' && folder === action.id) setFolder('all');
      setMenuId(null); setDialog(null);
    } catch (error) { setError(errorText(error)); }
    finally { setActionBusy(false); }
  }
  async function submitDialog() {
    if (!dialog || actionBusy || !online) return;
    const { kind, id, turnId } = dialog; const name = dialog.value.trim();
    if (kind === 'rename' || kind === 'folder-rename') { if (name) await manage({ kind, id, name }); return; }
    if (kind === 'folder-create') { if (name) await manage({ kind, name }); return; }
    if (kind === 'folder-delete' || kind === 'hide') { await manage({ kind, id }); return; }
    setActionBusy(true); setError('');
    try {
      if (runtimeRef.current[id]?.busy) throw new Error('Сначала остановите текущий ответ');
      if (kind === 'delete') {
        if (!state?.chats[id]?.draft) await api.deleteChat(id);
        setThreads(all => { const next = { ...all }; delete next[id]; return next; });
        setState(value => { if (!value) return value; const chats = { ...value.chats }; delete chats[id]; return { ...value, chats }; });
        setRuntime(all => { const next = { ...all }; delete next[id]; return next; });
        setDrafts(all => { const next = { ...all }; delete next[id]; return next; });
        if (selectedId === id) { setSelectedId(null); setShowChats(true); }
      } else if (turnId) {
        const page = await api.deleteFrom({ id, turnId });
        if (page.thread) setThreads(all => ({ ...all, [id]: page.thread! }));
        update(id, value => ({ ...blank(), loaded: true, items: page.items, historyCursor: page.cursor, historyOffset: HISTORY_START,
          historyVersion: (value.historyVersion || 0) + 1, answeredQuestionIds: collectAnswers(undefined, page.items) }));
      }
      setDialog(null); setMenuId(null);
    } catch (error) { setError(errorText(error)); }
    finally { setActionBusy(false); }
  }
  function newChat() {
    if (!state) return;
    const id = `draft-${uniqueId()}`;
    setState(value => value ? { ...value, chats: { ...value.chats, [id]: { draft: true, folderId: state.folders.some(item => item.id === folder) ? folder : null, cwd: state.cwd || home, autoCoordinator: state.autoCoordinator, autoWorker: state.autoWorker, createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000 } } } : value);
    setSelectedId(id); setShowChats(false); setError('');
    setFolder('all');
  }

  const rows = [...new Set([...Object.keys(threads), ...Object.keys(state?.chats || {}), ...agents.filter(agent => !agent.deleted).map(agent => agent.parentId)])]
    .filter(id => !state?.hidden.includes(id) && !agents.some(agent => agent.id === id)).map(id => {
      const meta = state?.chats[id]; const thread = threads[id];
      return { id, meta, thread, title: meta?.name || thread?.name || thread?.preview?.replace(/\s+/g, ' ').slice(0, 80) || 'Новый чат' };
    }).filter(row => (folder === 'all' || (folder === 'pinned' ? row.meta?.pinned : row.meta?.folderId === folder)) && (!query || row.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
    .sort((a, b) => Number(!!b.meta?.pinned) - Number(!!a.meta?.pinned) || (b.meta?.updatedAt || b.thread?.updatedAt || 0) - (a.meta?.updatedAt || a.thread?.updatedAt || 0));
  const menuRow = rows.find(row => row.id === menuId) || (menuId ? { id: menuId, meta: state?.chats[menuId], title: state?.chats[menuId]?.name || threads[menuId]?.name || threads[menuId]?.preview || 'Новый чат' } : null);
  const chatError = active.error && <div className="chat-error" role="alert">{active.error}<button type="button" onClick={() => selectedId && void loadHistory(selectedId)}>Обновить переписку</button></div>;

  return <div className="mobile-shell attachment-drop-zone" {...attachment.dropProps}>
    {attachment.dragging && <div className="attachment-drop-overlay">Отпусти файлы, чтобы прикрепить</div>}
    <header className="mobile-header">{showChats ? <><img src={appIcon} width="31" height="31" alt="" /><div className="mobile-brand">UniCode <span>v2</span><small>by krkss</small></div><Connections disabled={!online || !authenticated} onNewChat={newChat} /><button type="button" className="mobile-icon-button" aria-label="Новый чат" disabled={!state || !online} onClick={newChat}><SquarePen size={21} /></button></> : <>
      <button type="button" className="mobile-icon-button" aria-label="К списку чатов" onClick={() => setShowChats(true)}><ArrowLeft size={21} /></button>
      <div className="mobile-chat-title"><strong>{title}</strong></div>
      <button type="button" className="mobile-icon-button" aria-label="Действия чата" disabled={!selectedId || !online} onClick={() => setMenuId(selectedId)}><MoreHorizontal size={21} /></button>
    </>}</header>
    <div className="mobile-agent-status"><PlanUsage connected={online && !booting} authenticated={authenticated} /></div>
    {!showChats && <><AgentParent agent={selectedAgent} onSelect={openAgent} /><AgentProgress key={selectedId} agents={agents} parentId={selectedId || ''} onSelect={openAgent} /></>}
    {!online && <div className="mobile-offline"><WifiOff size={13} /><span>Нет соединения с компьютером</span><button type="button" onClick={() => void bootstrap()}>Повторить</button></div>}
    {error && <div className="mobile-error" role="alert"><span>{error}</span><button type="button" aria-label="Закрыть ошибку" onClick={() => setError('')}><X size={16} /></button></div>}
    {showChats ? <>
      <label className="mobile-search"><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти чат" /></label>
      <nav className="mobile-folders" aria-label="Папки"><button className={folder === 'all' ? 'selected' : ''} onClick={() => setFolder('all')}>Чаты</button><button className={folder === 'pinned' ? 'selected' : ''} onClick={() => setFolder('pinned')}><Pin size={12} />Закреплённые</button>{state?.folders.map(item => <button className={folder === item.id ? 'selected' : ''} key={item.id} onClick={() => setFolder(item.id)}><Folder size={12} />{item.name}</button>)}<button aria-label="Управление папками" onClick={() => setFoldersOpen(true)}><MoreHorizontal size={17} /></button></nav>
      <div className="mobile-chat-list">{booting && !state ? <div className="mobile-loading"><LoaderCircle className="spinning" size={23} /></div> : rows.map(row => <div className="mobile-chat-tree" key={row.id}><div className="mobile-chat-entry"><button type="button" className={`mobile-chat-row ${row.id === selectedId ? 'selected' : ''}`} onClick={() => { setSelectedId(row.id); setShowChats(false); setScrollSignal(value => value + 1); setError(''); }}>
        <span className="mobile-row-symbol">{requests.some(request => request.params.threadId === row.id) ? <span className="attention-dot" /> : runtime[row.id]?.busy ? <LoaderCircle className="spinning" size={16} /> : <MessageSquare size={17} />}</span><span>{row.title}</span>{row.meta?.pinned && <Pin size={12} />}
      </button><button type="button" className="mobile-icon-button mobile-row-actions" aria-label={`Действия чата ${row.title}`} disabled={!online || actionBusy} onClick={() => setMenuId(row.id)}><MoreHorizontal size={19} /></button></div><AgentBranches agents={agents} parentId={row.id} selectedId={selectedId} onSelect={openAgent} /></div>)}
        {!booting && !rows.length && <div className="mobile-empty-list">{query ? 'Чаты не найдены' : 'Здесь появятся ваши чаты'}</div>}
        {cursor && !query && <button className="load-more" disabled={moreBusy || !online} onClick={async () => {
          setMoreBusy(true); try { const result = await api.list(cursor); setThreads(all => ({ ...all, ...Object.fromEntries(result.data.map(thread => [thread.id, thread])) })); setCursor(result.nextCursor); } catch (error) { setError(errorText(error)); } finally { setMoreBusy(false); }
        }}>{moreBusy ? 'Загружаем…' : 'Более ранние чаты'}</button>}
      </div>
    </> : <>
      <div className="mobile-conversation">{!active.items.length && !active.busy && !active.historyCursor ? <div className="mobile-welcome">{!meta?.draft && !active.loaded && !active.error ? <LoaderCircle className="spinning" size={23} /> : <><img src={appIcon} width="43" height="43" alt="" /><p>{meta?.draft ? 'С чего начнём?' : 'Напиши сообщение'}</p>{chatError}</>}</div> :
        <ChatHistory key={`${selectedId}:${active.historyVersion || 0}`} runtime={active} scrollSignal={scrollSignal} onLoadOlder={() => void loadEarlier()}
          renderItem={item => <Message item={item} copied={copied} copy={copy} cwd={cwd} onError={setError} answeredQuestions={answered} onAnswer={answerQuestion} questionDrafts={questionDrafts.current} canDelete={!active.busy && !!active.loaded && !active.loadingOlder && selected?.historyMode !== 'legacy' && online} onDelete={onDelete} />}
          footer={<>{active.busy && <div className="working-indicator" role="status"><span className="working-dot" /><span>{activeRequests.length ? 'Ожидает ответа' : active.activity || 'Готовит ответ'}</span></div>}{chatError}</>} />}
      </div>
      <div className="mobile-compose-area"><div className="mobile-approvals">{activeRequests.map(request => <Approval key={request.id} request={request} onError={setError} items={active.items} />)}</div>
        <div className="mobile-composer"><AttachmentStrip items={attachment.items} remove={attachment.remove} disabled={attachment.uploading} /><textarea ref={composer} rows={1} maxLength={250000} value={draft} placeholder="Что нужно сделать?" aria-label="Сообщение" disabled={!authenticated || !state} onChange={event => selectedId && setDrafts(value => ({ ...value, [selectedId]: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          <div className="mobile-compose-toolbar"><AttachmentButton add={attachment.add} uploading={attachment.uploading} disabled={!state || !online || !authenticated} /><RunOptions key={selectedId} models={models} model={model} autoCoordinator={autoCoordinator} autoWorker={autoWorker} effort={effort} access={access} serviceTier={serviceTier} defaults={defaults} disabled={!online || !state || !authenticated} onChange={patch => {
              if (!selectedId) return;
              setPreferences(value => ({ ...value, [selectedId]: { ...value[selectedId], ...patch } }));
              if (patch.autoCoordinator !== undefined || patch.autoWorker !== undefined) {
                const id = selectedId;
                const pair = { autoCoordinator: patch.autoCoordinator ?? (autoCoordinator || autoModels.coordinator?.model || ''), autoWorker: patch.autoWorker ?? (autoWorker || autoModels.worker?.model || '') };
                if (meta?.draft) setState(value => value ? { ...value, chats: { ...value.chats, [id]: { ...value.chats[id], ...pair, ...patch } } } : value);
                else settingsQueue.current = settingsQueue.current.catch(() => {}).then(async () => {
                  try { mergeShared(await api.manageChat({ kind: 'auto-models', id, ...pair })); }
                  catch (error) {
                    setPreferences(all => {
                      const next = { ...all[id] };
                      if (next.autoCoordinator === pair.autoCoordinator) delete next.autoCoordinator;
                      if (next.autoWorker === pair.autoWorker) delete next.autoWorker;
                      return { ...all, [id]: next };
                    });
                    setError(errorText(error));
                  }
                });
              }
              if (patch.serviceTier) {
                if (meta?.draft) setState(value => value ? { ...value, chats: { ...value.chats, [selectedId]: { ...value.chats[selectedId], serviceTier: patch.serviceTier } } } : value);
                else {
                  const id = selectedId;
                  void api.manageChat({ kind: 'speed', id, serviceTier: patch.serviceTier }).catch(error => {
                    setPreferences(all => { const { serviceTier: _failed, ...rest } = all[id] || {}; return { ...all, [id]: rest }; });
                    setError(errorText(error));
                  });
                }
              }
            }} />
            {active.busy && !draft.trim() && !attachment.items.length ? <button type="button" className="send-button stop" aria-label="Остановить ответ" disabled={!active.turnId || !online} onClick={() => { if (selectedId && active.turnId) void api.interrupt({ id: selectedId, turnId: active.turnId }).catch(error => setError(errorText(error))); }}><Square size={13} fill="currentColor" /></button> : <button type="button" className="send-button" aria-label="Отправить сообщение" disabled={(!draft.trim() && !attachment.items.length) || attachment.uploading || !online || !authenticated || (!meta?.draft && !active.loaded)} onClick={() => void send()}><ArrowUp size={19} /></button>}
          </div>
        </div>
      </div>
    </>}
    <Presence show={!!menuRow && !dialog}>{menuRow && !dialog && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !actionBusy) setMenuId(null); }}><section className="mobile-sheet" role="dialog" aria-modal="true" aria-label="Действия чата">
      <div className="mobile-sheet-heading"><strong>{menuRow.title}</strong><button className="mobile-icon-button" aria-label="Закрыть меню" disabled={actionBusy} onClick={() => setMenuId(null)}><X size={18} /></button></div>
      {error && <p className="mobile-action-error" role="alert">{error}</p>}
      <button disabled={actionBusy || !online} onClick={() => void manage({ kind: 'pin', id: menuRow.id, pinned: !menuRow.meta?.pinned })}><Pin size={16} />{menuRow.meta?.pinned ? 'Открепить' : 'Закрепить'}</button>
      <button disabled={actionBusy || !online} onClick={() => setDialog({ kind: 'rename', id: menuRow.id, value: menuRow.title })}><Pencil size={16} />Переименовать</button>
      <div className="mobile-sheet-label">Переместить в папку</div>
      {[{ id: '', name: 'Без папки' }, ...(state?.folders || [])].map(item => <button key={item.id} disabled={actionBusy || !online} onClick={() => void manage({ kind: 'move', id: menuRow.id, folderId: item.id || null })}><Folder size={16} /><span>{item.name}</span>{(menuRow.meta?.folderId || '') === item.id && <Check size={16} />}</button>)}
      <div className="mobile-sheet-divider" />
      <button disabled={actionBusy || !online} onClick={() => setDialog({ kind: 'hide', id: menuRow.id, value: menuRow.title })}><EyeOff size={16} />Убрать из списка</button>
      <button className="danger" disabled={actionBusy || !online || runtime[menuRow.id]?.busy} onClick={() => setDialog({ kind: 'delete', id: menuRow.id, value: menuRow.title })}><Trash2 size={16} />Удалить чат навсегда</button>
    </section></div>}</Presence>
    <Presence show={foldersOpen && !dialog}>{foldersOpen && !dialog && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setFoldersOpen(false); }}><section className="mobile-sheet" role="dialog" aria-modal="true" aria-label="Управление папками">
      <div className="mobile-sheet-heading"><strong>Папки</strong><button className="mobile-icon-button" aria-label="Закрыть папки" onClick={() => setFoldersOpen(false)}><X size={18} /></button></div>
      <button disabled={!online} onClick={() => setDialog({ kind: 'folder-create', id: '', value: '' })}><Plus size={17} />Создать папку</button>
      {state?.folders.map(item => <div className="mobile-folder-entry" key={item.id}><Folder size={16} /><span>{item.name}</span><button className="mobile-icon-button" aria-label={`Переименовать ${item.name}`} disabled={!online} onClick={() => setDialog({ kind: 'folder-rename', id: item.id, value: item.name })}><Pencil size={16} /></button><button className="mobile-icon-button danger" aria-label={`Удалить ${item.name}`} disabled={!online} onClick={() => setDialog({ kind: 'folder-delete', id: item.id, value: item.name })}><Trash2 size={16} /></button></div>)}
    </section></div>}</Presence>
    <Presence show={!!dialog}>{dialog && <div className="modal-backdrop"><form className="mobile-sheet mobile-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="mobile-dialog-title" onSubmit={event => { event.preventDefault(); void submitDialog(); }}>
      {error && <p className="mobile-action-error" role="alert">{error}</p>}
      <h2 id="mobile-dialog-title">{dialog.kind === 'folder-create' ? 'Новая папка' : dialog.kind === 'folder-delete' ? 'Удалить папку?' : dialog.kind === 'delete' ? 'Удалить чат навсегда?' : dialog.kind === 'messages' ? 'Удалить переписку отсюда?' : dialog.kind === 'hide' ? 'Убрать чат из списка?' : 'Переименовать'}</h2>
      {['rename', 'folder-create', 'folder-rename'].includes(dialog.kind) ? <input aria-label={dialog.kind === 'rename' ? 'Название чата' : 'Название папки'} autoFocus maxLength={dialog.kind === 'rename' ? 120 : 80} value={dialog.value} onChange={event => setDialog({ ...dialog, value: event.target.value })} /> : <p>{dialog.kind === 'folder-delete' ? 'Чаты останутся в общем списке. Удалится только папка.' : dialog.kind === 'delete' ? `Чат «${dialog.value}» и его дочерние диалоги будут удалены без возможности восстановления. Файлы проекта останутся на месте.` : dialog.kind === 'messages' ? 'Удалятся выбранный ход (ваш вопрос и ответы Codex) и все последующие сообщения. История изменится и для Codex. Изменения файлов не отменяются.' : 'Переписка сохранится в Codex CLI и будет скрыта в UniCode.'}</p>}
      <div className="mobile-dialog-actions"><button type="button" className="secondary-button" disabled={actionBusy} onClick={() => setDialog(null)}>Отмена</button><button type="submit" className="primary-button" disabled={actionBusy || !online || (['rename', 'folder-create', 'folder-rename'].includes(dialog.kind) && !dialog.value.trim())}>{actionBusy ? 'Сохраняем…' : ['delete', 'messages', 'folder-delete'].includes(dialog.kind) ? 'Удалить' : dialog.kind === 'hide' ? 'Убрать' : 'Сохранить'}</button></div>
    </form></div>}</Presence>
  </div>;
}
