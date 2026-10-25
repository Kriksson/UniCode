import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUp, Check, ChevronDown, ChevronRight, Code2, Copy, Folder, FolderOpen, FolderPlus, LoaderCircle, MessageSquare, Minus, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Pin, Plus, Search, ShieldCheck, Square, SquarePen, Trash2, X } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Chat, Event as CodexEvent, Item, Meta, Model, Runtime, ServerRequest, State, Thread } from './types';
import appIcon from '../assets/unicode-generated.png';
import { questionReplies, messageLinkUrl, liveActivity } from './presentation';
import { RunOptions } from './RunOptions';
import { ChatHistory } from './ChatHistory';
import { PlanUsage } from './PlanUsage';
import { PhoneConnect } from './PhoneConnect';
import { collectAnswers, HISTORY_START, prependHistory } from './history';

const api = window.codex;
const initial: State = { version: 1, folders: [], chats: {}, hidden: [], selectedId: null, cwd: null, model: '' };
const blankRuntime = (): Runtime => ({ items: [], busy: false });
const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
const basename = (path?: string | null) => path?.replace(/\/$/, '').split('/').pop() || 'Папка проекта';
const timestamp = () => Math.floor(Date.now() / 1000);

function Brand({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true"><img src={appIcon} alt="" /></span>;
}

function IconButton({ label, children, onClick, className = '', disabled = false }: { label: string; children: ReactNode; onClick?: () => void; className?: string; disabled?: boolean }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

function useLiveCallback<A extends unknown[], R>(callback: (...args: A) => R) {
  const ref = useRef(callback); ref.current = callback;
  return useCallback((...args: A) => ref.current(...args), []);
}

type Dialog = { kind: 'folder' | 'rename' | 'folder-rename'; id?: string; value: string } | { kind: 'hide' | 'folder-delete' | 'chat-delete'; id: string; value: string } | { kind: 'messages-delete'; id: string; turnId: string; value: string };

export function App() {
  const [state, setState] = useState<State>(initial);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [runtime, setRuntime] = useState<Record<string, Runtime>>({});
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const [models, setModels] = useState<Model[]>([]);
  const [requests, setRequests] = useState<ServerRequest[]>([]);
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [authenticated, setAuthenticated] = useState(true);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState('all');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [folderMenu, setFolderMenu] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const composer = useRef<HTMLTextAreaElement>(null);
  const [scrollSignal, setScrollSignal] = useState(0);
  const activeThread = useRef('');
  const recentHistory = useRef<string[]>([]);
  const historyLoading = useRef(new Set<string>());
  const olderLoading = useRef(new Set<string>());
  const historyEpoch = useRef(new Map<string, number>());
  const questionDrafts = useRef(new Map<string, Record<number, string>>());
  const sending = useRef(new Set<string>());
  const aliases = useRef(new Map<string, string>());
  const deletedIds = useRef(new Set<string>());
  const [copied, setCopied] = useState('');
  const [historyBusy, setHistoryBusy] = useState<string | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [defaults, setDefaults] = useState({ model: '', effort: '' });

  const removeChat = useCallback((id: string) => {
    deletedIds.current.add(id);
    historyEpoch.current.set(id, (historyEpoch.current.get(id) || 0) + 1);
    setThreads(value => { const next = { ...value }; delete next[id]; return next; });
    setRuntime(value => { const next = { ...value }; delete next[id]; return next; });
    setDrafts(value => { const next = { ...value }; delete next[id]; return next; });
    setRequests(value => value.filter(request => request.params.threadId !== id));
    setState(value => {
      const chats = { ...value.chats }; delete chats[id];
      return { ...value, chats, hidden: value.hidden.filter(hidden => hidden !== id), selectedId: value.selectedId === id ? null : value.selectedId, access: value.selectedId === id ? 'workspace-write' : value.access };
    });
  }, []);

  const updateRuntime = useCallback((id: string, fn: (value: Runtime) => Runtime) => {
    setRuntime(all => {
      if (deletedIds.current.has(id)) return all;
      const next = fn(all[id] || blankRuntime());
      return next === all[id] ? all : { ...all, [id]: next };
    });
  }, []);

  const bootstrap = useCallback(async () => {
    setBooting(true); setError('');
    try {
      const result = await api.bootstrap();
      setState({ ...result.state, cwd: result.state.cwd || result.home });
      setDrafts(result.state.drafts || {});
      setThreads(Object.fromEntries(result.threads.data.map(thread => [thread.id, thread])));
      setCursor(result.threads.nextCursor); setModels(result.models);
      setDefaults(result.defaults || { model: '', effort: '' });
      setAuthenticated(result.authenticated); setRequests(result.requests);
      setRuntime(all => {
        const next = { ...all };
        for (const turn of result.activeTurns || []) if (!next[turn.threadId]) next[turn.threadId] = { ...blankRuntime(), busy: true, turnId: turn.turnId, activity: 'Агент работает' };
        return next;
      });
      setReady(true); setConnected(true);
    } catch (error) { setError(errorText(error)); }
    finally { setBooting(false); }
  }, []);

  useEffect(() => { void bootstrap(); }, [bootstrap]);
  useEffect(() => {
    if (ready) void api.save({ ...state, drafts }).catch(error => setError(errorText(error)));
  }, [state, drafts, ready]);

  useEffect(() => {
    const receive = (event: CodexEvent) => {
    if (event.type === 'focus-thread' && event.threadId) {
      setScrollSignal(value => value + 1);
      setView('all'); setQuery(''); setMenu(null); setFolderMenu(null);
      setState(value => ({ ...value, selectedId: event.threadId!, hidden: value.hidden.filter(id => id !== event.threadId) }));
      return;
    }
    if (event.type === 'state-updated') {
      const shared = event.message as Pick<State, 'chats' | 'folders' | 'hidden'>;
      setView(view => view === 'all' || view === 'pinned' || shared.folders.some(folder => folder.id === view) ? view : 'all');
      setState(value => JSON.stringify({ chats: value.chats, folders: value.folders, hidden: value.hidden }) === JSON.stringify({ chats: shared.chats, folders: shared.folders, hidden: shared.hidden }) ? value : { ...value, ...shared });
      return;
    }
    if (event.type === 'history-invalidated' && event.threadId) {
      const id = event.threadId;
      historyEpoch.current.set(id, (historyEpoch.current.get(id) || 0) + 1);
      setRuntime(all => ({ ...all, [id]: { ...blankRuntime(), historyVersion: (all[id]?.historyVersion || 0) + 1 } }));
      return;
    }
    if (event.type === 'disconnected') {
      setConnected(false); setError(String(event.message)); setRequests([]);
      setRuntime(all => Object.fromEntries(Object.entries(all).map(([id, value]) => [id, { ...value, busy: false }])));
      return;
    }
    if (event.type === 'request') { setRequests(all => [...all.filter(r => r.id !== event.message.id), event.message]); return; }
    if (event.type === 'request-resolved') { setRequests(all => all.filter(r => r.id !== event.id)); return; }
    if (event.type === 'thread-ready' && event.thread) {
      const thread = event.thread;
      const oldId = event.localId!;
      aliases.current.set(oldId, thread.id);
      setThreads(all => ({ ...all, [thread.id]: thread }));
      setState(value => {
        const chats = { ...value.chats };
        const meta = chats[oldId] || {};
        if (oldId !== thread.id) delete chats[oldId];
        chats[thread.id] = { ...meta, draft: false, cwd: thread.cwd, updatedAt: timestamp() };
        return { ...value, chats, selectedId: value.selectedId === oldId ? thread.id : value.selectedId };
      });
      setRuntime(all => {
        const next = { ...all, [thread.id]: all[oldId] || all[thread.id] || blankRuntime() };
        if (oldId !== thread.id) delete next[oldId];
        return next;
      });
      return;
    }
    if (event.type === 'send-failed' && event.threadId) {
      updateRuntime(event.threadId, value => ({ ...value, busy: false, error: String(event.message) })); return;
    }
    if (event.type !== 'notification') return;
    const { method, params: p } = event.message;
    const id = p.threadId;
    if (method === 'account/login/completed') {
      setAuthenticated(!!p.success);
      if (p.error) setError(p.error);
    }
    if (method === 'account/updated') setAuthenticated(!!p.authMode);
    if (method === 'serverRequest/resolved') setRequests(all => all.filter(r => r.id !== p.requestId));
    if (!id) return;
    if (method === 'thread/deleted') { removeChat(id); return; }
    if (method === 'turn/started') updateRuntime(id, value => ({ ...value, turnId: p.turn.id, busy: true, error: undefined, activity: 'Готовит ответ' }));
    if (method === 'turn/completed') {
      updateRuntime(id, value => ({ ...value, busy: false, turnId: undefined, items: value.items.map(item => item.inProgress ? { ...item, inProgress: false } : item),
        error: p.turn.status === 'failed' ? p.turn.error?.message || 'Codex не смог завершить ответ' : undefined }));
      setState(value => ({ ...value, chats: { ...value.chats, [id]: { ...value.chats[id], updatedAt: timestamp() } } }));
      setRequests(all => all.filter(r => r.params.threadId !== id));
    }
    if (method === 'item/started' || method === 'item/completed') updateRuntime(id, value => {
      const incoming = { ...p.item, turnId: p.turnId, inProgress: method === 'item/started' } as Item;
      const items = value.items.filter(item => !(incoming.type === 'userMessage' && item.id.startsWith('pending-')));
      const index = items.findIndex(item => item.id === incoming.id);
      if (index < 0) items.push(incoming);
      else items[index] = { ...items[index], ...incoming };
      return { ...value, items, activity: liveActivity(items), answeredQuestionIds: incoming.type === 'userMessage' ? collectAnswers(value.answeredQuestionIds, [incoming]) : value.answeredQuestionIds };
    });
    if (method === 'item/agentMessage/delta') updateRuntime(id, value => {
      const items = [...value.items];
      const index = items.findIndex(item => item.id === p.itemId);
      if (index < 0) items.push({ id: p.itemId, type: 'agentMessage', text: p.delta, turnId: p.turnId, inProgress: true });
      else items[index] = { ...items[index], text: (items[index].text || '') + p.delta };
      return { ...value, items, activity: 'Пишет ответ' };
    });
    if (method === 'item/commandExecution/outputDelta') updateRuntime(id, value => ({ ...value,
      items: value.items.map(item => item.id === p.itemId ? { ...item, aggregatedOutput: ((item.aggregatedOutput || '') + p.delta).slice(-100000) } : item),
    }));
    if (method === 'item/reasoning/summaryTextDelta') updateRuntime(id, value => ({ ...value, activity: 'Продумывает решение' }));
    if (method === 'item/mcpToolCall/progress') updateRuntime(id, value => ({ ...value, activity: p.message?.replace(/\s+/g, ' ').trim().slice(0, 160) || value.activity }));
    if (method === 'error' && !p.willRetry) updateRuntime(id, value => ({ ...value, error: p.error?.message || 'Ошибка Codex' }));
    if (method === 'thread/name/updated') setThreads(all => all[id] ? { ...all, [id]: { ...all[id], name: p.threadName } } : all);
    };
    return api.onEvent(event => {
      if (event.type === 'notifications') for (const message of event.messages || []) receive({ type: 'notification', message });
      else receive(event);
    });
  }, [updateRuntime, removeChat]);

  const chats = useMemo<Chat[]>(() => {
    const ids = new Set([...Object.keys(threads), ...Object.keys(state.chats)]);
    return [...ids].filter(id => !state.hidden.includes(id) && !deletedIds.current.has(id)).map(id => {
      const thread = threads[id] as Thread | undefined; const meta = state.chats[id] || {};
      return { ...thread, ...meta, id, cwd: meta.cwd || thread?.cwd || state.cwd || '',
        createdAt: meta.createdAt ?? thread?.createdAt ?? 0, updatedAt: meta.updatedAt ?? thread?.updatedAt ?? 0,
        title: meta.name || thread?.name || thread?.preview?.replace(/\s+/g, ' ').slice(0, 80) || 'Новый чат',
      };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [state.chats, state.hidden, state.cwd, threads]);
  const selected = chats.find(chat => chat.id === state.selectedId);
  const activeId = selected?.id || '';
  activeThread.current = activeId;
  const active = runtime[activeId] || blankRuntime();
  const currentFolder = state.folders.find(folder => folder.id === selected?.folderId);
  const pinned = chats.filter(chat => chat.pinned);
  const filtered = chats.filter(chat => {
    const matchesView = view === 'all' || (view === 'pinned' ? chat.pinned : chat.folderId === view);
    return matchesView && (!query || chat.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  });
  const shownRecent = filtered.filter(chat => query || !chat.pinned);
  const textKey = activeId || `empty:${view}`;
  const draft = drafts[textKey] || '';
  const workingDir = selected?.cwd || state.cwd || '';
  const activeRequests = requests.filter(request => request.params.threadId === activeId);
  const answeredQuestions = useMemo(() => new Set(active.answeredQuestionIds || []), [active.answeredQuestionIds]);
  const selectedModel = selected?.model ?? state.model;
  const selectedEffort = selected ? selected.effort || '' : state.effort || '';
  const selectedAccess = selected ? selected.access || 'workspace-write' : state.access || 'workspace-write';
  const modelInfo = selectedModel ? models.find(model => model.model === selectedModel) : models.find(model => model.model === defaults.model) || models.find(model => model.isDefault);
  const defaultEffort = (!selectedModel ? defaults.effort : '') || modelInfo?.defaultReasoningEffort || '';

  function changeSettings(patch: Pick<Partial<State>, 'model' | 'effort' | 'access'>) {
    setState(value => ({ ...value, ...patch, chats: activeId ? { ...value.chats, [activeId]: {
      ...value.chats[activeId], model: selectedModel, effort: selectedEffort, access: selectedAccess, ...patch,
    } } : value.chats }));
  }

  const newChat = useCallback((folderId?: string | null) => {
    const id = 'draft-' + crypto.randomUUID();
    setState(value => {
      const chats = { ...value.chats };
      // Keep drafts with text; an unused empty draft does not need a sidebar row.
      const previous = chats[value.selectedId || ''];
      if (previous?.draft && !runtimeRef.current[value.selectedId || '']?.items.length && !drafts[value.selectedId || '']) delete chats[value.selectedId!];
      chats[id] = { draft: true, folderId: folderId ?? (view !== 'all' && view !== 'pinned' ? view : null),
        cwd: value.cwd || undefined, createdAt: timestamp(), updatedAt: timestamp(), model: value.model, effort: value.effort || '', access: 'workspace-write' };
      return { ...value, chats, selectedId: id };
    });
    setScrollSignal(value => value + 1);
    requestAnimationFrame(() => composer.current?.focus());
  }, [view, drafts]);

  const selectChat = (id: string) => {
    setScrollSignal(value => value + 1);
    setState(value => ({ ...value, selectedId: id }));
    setMenu(null);
  };

  const loadHistory = useCallback(async (id: string) => {
    if (historyLoading.current.has(id)) return;
    historyLoading.current.add(id); setHistoryBusy(id);
    const epoch = (historyEpoch.current.get(id) || 0) + 1;
    historyEpoch.current.set(id, epoch);
    try {
      const page = await api.history(id);
      if (deletedIds.current.has(id) || historyEpoch.current.get(id) !== epoch
        || (activeThread.current !== id && !recentHistory.current.includes(id) && !runtimeRef.current[id]?.busy)) return;
      if (page.thread) setThreads(all => ({ ...all, [id]: page.thread! }));
      updateRuntime(id, value => {
        const merged = value.busy ? prependHistory(value, page.items) : { items: page.items, historyOffset: HISTORY_START, answeredQuestionIds: collectAnswers(undefined, page.items) };
        return { ...value, ...merged, loaded: true, error: undefined, historyCursor: page.cursor, loadingOlder: false, historyError: undefined, historyVersion: (value.historyVersion || 0) + 1 };
      });
    } catch (error) {
      if (historyEpoch.current.get(id) === epoch && (activeThread.current === id || recentHistory.current.includes(id))) {
        updateRuntime(id, value => ({ ...value, loaded: false, loadingOlder: false, error: errorText(error) }));
      }
    }
    finally { historyLoading.current.delete(id); setHistoryBusy(value => value === id ? null : value); }
  }, [updateRuntime]);

  const loadOlder = useCallback(async (id: string) => {
    const cursor = runtimeRef.current[id]?.historyCursor;
    if (!cursor || olderLoading.current.has(id) || historyLoading.current.has(id)) return;
    olderLoading.current.add(id);
    const epoch = historyEpoch.current.get(id);
    updateRuntime(id, value => ({ ...value, loadingOlder: true, historyError: undefined }));
    try {
      const page = await api.history(id, cursor);
      if (deletedIds.current.has(id) || historyEpoch.current.get(id) !== epoch || !runtimeRef.current[id]) return;
      updateRuntime(id, value => ({ ...value, ...prependHistory(value, page.items), historyCursor: page.cursor, loadingOlder: false }));
    } catch (error) {
      if (historyEpoch.current.get(id) === epoch && runtimeRef.current[id]) updateRuntime(id, value => ({ ...value, loadingOlder: false, historyError: errorText(error) }));
    } finally { olderLoading.current.delete(id); }
  }, [updateRuntime]);

  const runningThreads = Object.entries(runtime).filter(([, value]) => value.busy).map(([id]) => id).sort().join(',');
  useEffect(() => {
    recentHistory.current = [activeId, ...recentHistory.current.filter(id => id !== activeId)].filter(Boolean).slice(0, 3);
    const retained = new Set(recentHistory.current);
    setRuntime(all => {
      const keep = Object.entries(all).filter(([id, value]) => retained.has(id) || value.busy);
      return keep.length === Object.keys(all).length ? all : Object.fromEntries(keep);
    });
  }, [activeId, runningThreads]);

  useEffect(() => {
    if (activeId && !selected?.draft && !runtimeRef.current[activeId]?.loaded && !runtimeRef.current[activeId]?.error)
      void loadHistory(activeId);
  }, [activeId, selected?.draft, active.busy, active.loaded, loadHistory]);

  useEffect(() => {
    if (composer.current) {
      composer.current.style.height = 'auto';
      composer.current.style.height = Math.min(composer.current.scrollHeight, 180) + 'px';
    }
  }, [draft]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); newChat(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setSidebar(true); requestAnimationFrame(() => document.getElementById('chat-search')?.focus());
      }
      if (event.key === 'Escape') { setMenu(null); setFolderMenu(null); if (!dialogBusy) setDialog(null); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [newChat, dialogBusy]);

  useEffect(() => {
    if (!query.trim() || !ready || !connected) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void api.list(null, query.trim()).then(result => {
        if (!cancelled) setThreads(all => ({ ...all, ...Object.fromEntries(result.data.map(thread => [thread.id, thread])) }));
      }).catch(error => { if (!cancelled) setError(errorText(error)); });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, ready, connected]);

  async function send(overrideText?: string, allowSteer = false): Promise<boolean> {
    const text = (overrideText ?? draft).trim();
    if (!text || (active.busy && !allowSteer) || historyBusy === activeId || !connected || !authenticated || sending.current.has(textKey)) return false;
    if (active.busy) {
      if (!active.turnId) { setError('Дождитесь начала ответа Codex'); return false; }
      const pendingId = 'pending-' + crypto.randomUUID();
      sending.current.add(textKey);
      updateRuntime(activeId, value => ({ ...value, items: [...value.items, { id: pendingId, type: 'userMessage', content: [{ type: 'text', text }] }] }));
      try {
        await api.steer({ id: activeId, turnId: active.turnId, text });
        updateRuntime(activeId, value => ({ ...value, answeredQuestionIds: collectAnswers(value.answeredQuestionIds, [{ id: pendingId, type: 'userMessage', content: [{ type: 'text', text }] }]) }));
        return true;
      }
      catch (error) { updateRuntime(activeId, value => ({ ...value, items: value.items.filter(item => item.id !== pendingId) })); setError(errorText(error)); return false; }
      finally { sending.current.delete(textKey); }
    }
    let id = activeId;
    sending.current.add(textKey);
    if (!id) {
      id = 'draft-' + crypto.randomUUID();
      setState(value => ({ ...value, selectedId: id, chats: { ...value.chats, [id]: {
        draft: true, cwd: workingDir, folderId: view !== 'all' && view !== 'pinned' ? view : null,
        createdAt: timestamp(), updatedAt: timestamp(), name: text.replace(/\s+/g, ' ').slice(0, 60),
        model: selectedModel, effort: selectedEffort, access: selectedAccess,
      } } }));
    } else if (selected?.draft && !selected.name) {
      setState(value => ({ ...value, chats: { ...value.chats, [id]: { ...value.chats[id], name: text.replace(/\s+/g, ' ').slice(0, 60) } } }));
    }
    if (activeId) patchMeta(id, { model: selectedModel, effort: selectedEffort, access: selectedAccess });
    if (overrideText === undefined) setDrafts(value => ({ ...value, [textKey]: '' }));
    updateRuntime(id, value => ({ ...value, busy: true, error: undefined, loaded: true,
      items: [...value.items, { id: 'pending-' + crypto.randomUUID(), type: 'userMessage', content: [{ type: 'text', text }] }],
    }));
    setScrollSignal(value => value + 1);
    try {
      const result = await api.send({ id: selected && !selected.draft ? id : undefined, localId: id, text, cwd: workingDir, model: selectedModel || defaults.model || modelInfo?.model || '', effort: selectedEffort || defaultEffort, access: selectedAccess });
      updateRuntime(result.thread.id, value => ({ ...value, turnId: value.busy ? result.turn.id : undefined,
        answeredQuestionIds: collectAnswers(value.answeredQuestionIds, [{ id: '', type: 'userMessage', content: [{ type: 'text', text }] }]),
      }));
      return true;
    } catch (error) {
      const canonicalId = aliases.current.get(id) || id;
      updateRuntime(canonicalId, value => ({ ...value, busy: false, error: errorText(error),
        items: value.items.filter(item => !item.id.startsWith('pending-')),
      }));
      if (overrideText === undefined) setDrafts(value => ({ ...value, [canonicalId]: text }));
      return false;
    } finally { sending.current.delete(textKey); composer.current?.focus(); }
  }

  async function chooseDirectory() {
    try {
      const cwd = await api.chooseFolder();
      if (!cwd) return;
      setState(value => ({ ...value, cwd, chats: activeId ? { ...value.chats, [activeId]: { ...value.chats[activeId], cwd } } : value.chats }));
    } catch (error) { setError(errorText(error)); }
  }

  const patchMeta = (id: string, patch: Partial<Meta>) => setState(value => ({ ...value, chats: { ...value.chats, [id]: { ...value.chats[id], ...patch } } }));

  function chooseView(next: string) {
    setView(next); setQuery('');
    if (next !== 'all' && next !== 'pinned') {
      const first = chats.find(chat => chat.folderId === next);
      if (first) selectChat(first.id);
      else {
        setState(value => ({ ...value, selectedId: null, access: 'workspace-write' }));
        requestAnimationFrame(() => composer.current?.focus());
      }
    }
  }

  async function saveDialog(event: FormEvent) {
    event.preventDefault();
    if (!dialog) return;
    const value = dialog.value.trim();
    if (!value) return;
    if (dialog.kind === 'chat-delete' || dialog.kind === 'messages-delete') {
      if (runtime[dialog.id]?.busy) { setError('Сначала остановите текущий ответ'); return; }
      setDialogBusy(true);
      try {
        if (dialog.kind === 'chat-delete') {
          if (!state.chats[dialog.id]?.draft) await api.deleteChat(dialog.id);
          removeChat(dialog.id);
        } else if (dialog.kind === 'messages-delete') {
          historyEpoch.current.set(dialog.id, (historyEpoch.current.get(dialog.id) || 0) + 1);
          const page = await api.deleteFrom({ id: dialog.id, turnId: dialog.turnId });
          if (page.thread) setThreads(all => ({ ...all, [dialog.id]: page.thread! }));
          setRuntime(all => ({ ...all, [dialog.id]: { ...blankRuntime(), loaded: true, items: page.items, historyCursor: page.cursor,
            historyOffset: HISTORY_START, historyVersion: (all[dialog.id]?.historyVersion || 0) + 1, answeredQuestionIds: collectAnswers(undefined, page.items) } }));
        }
        setDialog(null);
      } catch (error) { setError(errorText(error)); }
      finally { setDialogBusy(false); }
      return;
    }
    if (dialog.kind === 'folder') {
      const id = crypto.randomUUID();
      setState(s => ({ ...s, folders: [...s.folders, { id, name: value }] }));
      setView(id); setState(s => ({ ...s, selectedId: null, access: 'workspace-write' }));
    } else if (dialog.kind === 'folder-rename') {
      setState(s => ({ ...s, folders: s.folders.map(folder => folder.id === dialog.id ? { ...folder, name: value } : folder) }));
    } else if (dialog.kind === 'rename') patchMeta(dialog.id!, { name: value });
    else if (dialog.kind === 'hide') {
      setState(s => ({ ...s, hidden: [...s.hidden, dialog.id], selectedId: s.selectedId === dialog.id ? null : s.selectedId, access: s.selectedId === dialog.id ? 'workspace-write' : s.access }));
    } else if (dialog.kind === 'folder-delete') {
      setState(s => ({ ...s, folders: s.folders.filter(folder => folder.id !== dialog.id),
        chats: Object.fromEntries(Object.entries(s.chats).map(([id, meta]) => [id, meta.folderId === dialog.id ? { ...meta, folderId: null } : meta])),
      }));
      if (view === dialog.id) setView('all');
    }
    setDialog(null);
  }

  const copy = useCallback(async (text: string, id: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(''), 1800); }
    catch { setError('Не удалось скопировать текст'); }
  }, []);

  function chatRow(chat: Chat) {
    const running = runtime[chat.id]?.busy;
    const needsInput = requests.some(request => request.params.threadId === chat.id);
    return <div key={chat.id} className={`chat-row ${activeId === chat.id ? 'active' : ''}`} draggable={!running}
      onDragStart={event => event.dataTransfer.setData('text/codex-chat', chat.id)}>
      <button className="chat-select" onClick={() => selectChat(chat.id)} title={chat.title}>
        {needsInput ? <span className="attention-dot" /> : running ? <LoaderCircle size={14} className="spinning" /> : <MessageSquare size={15} />}
        <span>{chat.title}</span>
      </button>
      <IconButton label={`Действия: ${chat.title}`} className="row-menu" onClick={() => {
        const rect = document.querySelector(`[data-menu-id="${chat.id}"]`)?.getBoundingClientRect();
        setMenu({ id: chat.id, x: rect?.right || 250, y: Math.min(rect?.bottom || 200, window.innerHeight - 330) });
      }}><span data-menu-id={chat.id}><MoreHorizontal size={16} /></span></IconButton>
    </div>;
  }

  const menuChat = chats.find(chat => chat.id === menu?.id);
  const visibleFolder = state.folders.find(folder => folder.id === view);
  const empty = active.items.length === 0 && !active.busy && !active.historyCursor;
  const emptyFolder = view !== 'all' && view !== 'pinned' && !selected;
  const answerQuestion = useLiveCallback((text: string) => send(text, true));
  const deleteMessage = useLiveCallback((item: Item) => {
    if (item.turnId) setDialog({ kind: 'messages-delete', id: activeId, turnId: item.turnId, value: 'Удалить ход' });
  });
  const loadEarlier = useLiveCallback(() => { void loadOlder(activeId); });
  const chatError = active.error && <div className="chat-error" role="alert"><span>{active.error}</span>{!selected?.draft && <button onClick={() => void loadHistory(activeId)}>Обновить переписку</button>}</div>;

  return <div className={`app ${sidebar ? '' : 'sidebar-hidden'}`}>
    <aside className="sidebar" aria-label="Навигация по чатам">
      <div className="sidebar-brand drag-region"><Brand /><div className="brand-lockup"><span className="brand-title">UniCode<span className="brand-version">v1</span></span><span className="brand-credit">by krkss</span></div>
        <IconButton label="Скрыть боковую панель" onClick={() => setSidebar(false)}><PanelLeftClose size={17} /></IconButton>
      </div>
      <div className="sidebar-top">
        <button className="new-chat" aria-label="Новый чат" onClick={() => newChat()} disabled={!ready}><SquarePen size={17} /><span>Новый чат</span><kbd>Ctrl N</kbd></button>
        <label className="search-field"><Search size={16} /><input id="chat-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти чат" aria-label="Найти чат" /><kbd>⌃ K</kbd></label>
        <button className={`nav-row ${view === 'all' ? 'selected' : ''}`} onClick={() => chooseView('all')}><MessageSquare size={17} /><span>Все чаты</span><span className="count">{chats.length}</span></button>
      </div>
      <div className="sidebar-scroll">
        {pinned.length > 0 && !query && <section className="sidebar-section">
          <div className="section-label"><Pin size={12} /><span>Закреплённые</span></div>
          {pinned.map(chatRow)}
        </section>}
        <section className="sidebar-section folders-section">
          <div className="section-label"><span>Папки</span><IconButton label="Создать папку" onClick={() => setDialog({ kind: 'folder', value: '' })}><Plus size={15} /></IconButton></div>
          {!state.folders.length && <button className="empty-folders" onClick={() => setDialog({ kind: 'folder', value: '' })}><FolderPlus size={16} /><span>Создать папку</span></button>}
          {state.folders.map(folder => <div key={folder.id} className={`folder-row ${view === folder.id ? 'selected' : ''}`}
            onDragOver={event => { if (event.dataTransfer.types.includes('text/codex-chat')) { event.preventDefault(); event.currentTarget.classList.add('drop-target'); } }}
            onDragLeave={event => event.currentTarget.classList.remove('drop-target')}
            onDrop={event => { event.preventDefault(); event.currentTarget.classList.remove('drop-target'); const id = event.dataTransfer.getData('text/codex-chat'); if (chats.some(chat => chat.id === id)) patchMeta(id, { folderId: folder.id }); }}>
            <button className="folder-select" onClick={() => chooseView(folder.id)}>{view === folder.id ? <FolderOpen size={17} /> : <Folder size={17} />}<span>{folder.name}</span><span className="count">{chats.filter(chat => chat.folderId === folder.id).length}</span></button>
            <IconButton label={`Действия папки ${folder.name}`} className="row-menu" onClick={() => setFolderMenu(folderMenu === folder.id ? null : folder.id)}><MoreHorizontal size={15} /></IconButton>
            {folderMenu === folder.id && <div className="folder-popup popover" role="menu"><button onClick={() => { setDialog({ kind: 'folder-rename', id: folder.id, value: folder.name }); setFolderMenu(null); }}><Pencil size={14} />Переименовать</button><button className="danger" onClick={() => { setDialog({ kind: 'folder-delete', id: folder.id, value: folder.name }); setFolderMenu(null); }}><Trash2 size={14} />Удалить папку</button></div>}
          </div>)}
        </section>
        {(shownRecent.length > 0 || filtered.length === 0 || (cursor && view === 'all')) && <section className="sidebar-section recent-section">
          <div className="section-label"><span>{query ? 'Результаты поиска' : visibleFolder?.name || 'Недавние'}</span>{visibleFolder && <IconButton label="Новый чат в папке" onClick={() => newChat(view)}><Plus size={15} /></IconButton>}</div>
          {shownRecent.map(chatRow)}
          {!shownRecent.length && <div className="sidebar-empty">{query ? 'Чаты не найдены' : visibleFolder ? 'В этой папке пока пусто' : 'Здесь появятся ваши чаты'}</div>}
          {cursor && !query && view === 'all' && <button className="load-more" disabled={loadingMore} onClick={async () => {
            setLoadingMore(true);
            try { const result = await api.list(cursor); setThreads(all => ({ ...all, ...Object.fromEntries(result.data.map(thread => [thread.id, thread])) })); setCursor(result.nextCursor); }
            catch (error) { setError(errorText(error)); } finally { setLoadingMore(false); }
          }}>{loadingMore ? <LoaderCircle size={13} className="spinning" /> : <ChevronDown size={13} />}Более ранние чаты</button>}
        </section>}
      </div>
      <div className="sidebar-bottom"><span className={`connection-dot ${connected ? 'online' : ''}`} /><span>{booting ? 'Подключение…' : connected ? 'Агент активен' : 'Нет соединения'}</span><PlanUsage connected={connected} authenticated={authenticated} />{!connected && !booting && <button onClick={bootstrap}>Повторить</button>}</div>
    </aside>

    <main className="main">
      <header className="topbar drag-region">
        {!sidebar && <IconButton label="Показать боковую панель" onClick={() => setSidebar(true)}><PanelLeftOpen size={18} /></IconButton>}
        <div className="breadcrumb">{currentFolder || emptyFolder ? <><Folder size={14} /><span>{currentFolder?.name || visibleFolder?.name}</span><span className="breadcrumb-slash">/</span></> : null}<span className="chat-heading">{selected?.title || 'Новый чат'}</span></div>
        <div className="topbar-actions">
          <PhoneConnect />
          {selected && <><IconButton label={selected.pinned ? 'Открепить чат' : 'Закрепить чат'} className={selected.pinned ? 'is-pinned' : ''} onClick={() => patchMeta(selected.id, { pinned: !selected.pinned })}><Pin size={16} /></IconButton><IconButton label="Действия чата" onClick={() => setMenu({ id: activeId, x: window.innerWidth - 135, y: 52 })}><MoreHorizontal size={19} /></IconButton><span className="topbar-divider" /></>}
          <div className="window-controls"><IconButton label="Свернуть" onClick={() => void api.window('minimize')}><Minus size={14} /></IconButton><IconButton label="Развернуть" onClick={() => void api.window('maximize')}><Square size={11} /></IconButton><IconButton label="Закрыть" className="close-window" onClick={() => void api.window('close')}><X size={15} /></IconButton></div>
        </div>
      </header>

      {error && <div className="error-banner" role="alert"><span>{error}</span><div>{!connected && <button onClick={bootstrap} disabled={booting}>Подключиться</button>}<IconButton label="Закрыть уведомление" onClick={() => setError('')}><X size={15} /></IconButton></div></div>}
      {!authenticated && connected && <div className="login-banner"><span>Войдите в аккаунт, чтобы начать переписку.</span><button onClick={() => void api.login().catch(error => setError(errorText(error)))}>Войти через ChatGPT</button></div>}

      <div className={`conversation ${empty ? 'is-empty' : 'with-history'}`}>
        {booting && !ready ? <div className="loading-state"><LoaderCircle className="spinning" size={22} /><span>Подключаем Codex…</span></div> : historyBusy === activeId && !active.items.length ? <div className="loading-state"><LoaderCircle className="spinning" size={22} /><span>Загружаем переписку…</span></div> : empty ?
          <div className="welcome"><div className="welcome-symbol"><Code2 size={34} strokeWidth={1.8} /></div><h1>{emptyFolder ? visibleFolder?.name : 'С чего начнём?'}</h1><p>Выберите проект и напишите, что нужно сделать.</p></div> :
          <ChatHistory key={`${activeId}:${active.historyVersion || 0}`} runtime={active} onLoadOlder={loadEarlier} scrollSignal={scrollSignal}
            renderItem={item => <Message item={item} copied={copied} copy={copy} cwd={workingDir} onError={setError} answeredQuestions={answeredQuestions} onAnswer={answerQuestion}
              questionDrafts={questionDrafts.current} canDelete={!active.busy && historyBusy !== activeId && selected?.historyMode !== 'legacy'} onDelete={deleteMessage} />}
            footer={<>{active.busy && <div className="working-indicator" role="status"><span className="working-dot" /><span title={active.activity}>{activeRequests.length ? 'Ожидает вашего ответа' : active.activity || 'Готовит ответ'}</span></div>}{chatError}</>} />}
        {empty && chatError}
      </div>

      <div className="composer-area">
        {activeRequests.map(request => <Approval key={request.id} request={request} onError={setError} items={active.items} />)}
        <div className={`composer ${active.busy ? 'is-working' : ''}`}>
          <textarea ref={composer} aria-label="Сообщение Codex" placeholder="Напишите Codex…" value={draft} rows={1} maxLength={250000}
            onChange={event => setDrafts(value => ({ ...value, [textKey]: event.target.value }))}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
            disabled={!ready || !authenticated} />
          <div className="composer-toolbar"><div className="composer-options">
            <button className="project-button" title={workingDir || 'Выбрать папку проекта'} onClick={chooseDirectory} disabled={active.busy || !ready}><Folder size={15} /><span>{workingDir ? basename(workingDir) : 'Выбрать проект'}</span><ChevronDown size={12} /></button>
            <span className="composer-divider" />
            <RunOptions key={activeId} models={models} model={selectedModel} effort={selectedEffort} access={selectedAccess} defaults={defaults} disabled={active.busy || !ready} onChange={changeSettings} />
          </div>
            {active.busy ? <button className="send-button stop" aria-label="Остановить ответ" title="Остановить ответ" disabled={!active.turnId} onClick={() => {
              if (active.turnId) void api.interrupt({ id: activeId, turnId: active.turnId }).catch(error => setError(errorText(error)));
            }}><Square size={13} fill="currentColor" /></button> : <button className="send-button" aria-label="Отправить сообщение" title="Отправить сообщение" disabled={!draft.trim() || historyBusy === activeId || !connected || !authenticated || !ready} onClick={() => void send()}><ArrowUp size={19} strokeWidth={2.2} /></button>}
          </div>
        </div>
      </div>
    </main>

    {menu && menuChat && <><div className="menu-scrim" onClick={() => setMenu(null)} /><div className="chat-popover popover" role="menu" style={{ left: Math.max(12, Math.min(menu.x - 15, window.innerWidth - 245)), top: Math.max(55, menu.y) }}>
      <button onClick={() => { patchMeta(menu.id, { pinned: !menuChat.pinned }); setMenu(null); }}><Pin size={15} />{menuChat.pinned ? 'Открепить' : 'Закрепить'}</button>
      <button onClick={() => { setDialog({ kind: 'rename', id: menu.id, value: menuChat.title }); setMenu(null); }}><Pencil size={15} />Переименовать</button>
      <div className="menu-divider" /><div className="menu-caption">Переместить в папку</div>
      <button onClick={() => { patchMeta(menu.id, { folderId: null }); setMenu(null); }}><MessageSquare size={15} /><span>Без папки</span>{!menuChat.folderId && <Check size={14} />}</button>
      {state.folders.map(folder => <button key={folder.id} onClick={() => { patchMeta(menu.id, { folderId: folder.id }); setMenu(null); }}><Folder size={15} /><span>{folder.name}</span>{menuChat.folderId === folder.id && <Check size={14} />}</button>)}
      <div className="menu-divider" /><button className="danger" disabled={runtime[menu.id]?.busy} onClick={() => { setDialog({ kind: 'hide', id: menu.id, value: menuChat.title }); setMenu(null); }}><Trash2 size={15} />Убрать из списка</button>
      <button className="danger" disabled={runtime[menu.id]?.busy} onClick={() => { setDialog({ kind: 'chat-delete', id: menu.id, value: menuChat.title }); setMenu(null); }}><Trash2 size={15} />Удалить чат навсегда</button>
    </div></>}

    {dialog && <div className="modal-backdrop" onMouseDown={event => { if (!dialogBusy && event.target === event.currentTarget) setDialog(null); }}><form className="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onSubmit={saveDialog}>
      <div className="modal-icon">{dialog.kind.includes('folder') ? <Folder size={23} /> : dialog.kind === 'hide' ? <MessageSquare size={23} /> : <Pencil size={23} />}</div>
      <h2 id="dialog-title">{dialog.kind === 'folder' ? 'Новая папка' : dialog.kind === 'folder-delete' ? 'Удалить папку?' : dialog.kind === 'chat-delete' ? 'Удалить чат навсегда?' : dialog.kind === 'messages-delete' ? 'Удалить переписку отсюда?' : dialog.kind === 'hide' ? 'Убрать чат из списка?' : 'Переименовать'}</h2>
      {['hide', 'folder-delete', 'chat-delete', 'messages-delete'].includes(dialog.kind) ? <p>{dialog.kind === 'folder-delete' ? 'Чаты останутся в общем списке. Удалится только папка.' : dialog.kind === 'chat-delete' ? `Чат «${dialog.value}» и его дочерние диалоги будут удалены из Codex CLI. Восстановить переписку не получится. Файлы проекта останутся на месте.` : dialog.kind === 'messages-delete' ? 'Будут удалены весь выбранный ход (ваш вопрос и ответы Codex), а также все последующие сообщения. История изменится и для Codex. Изменения файлов проекта не отменяются.' : 'Переписка сохранится в Codex CLI. Она будет скрыта только в этом приложении.'}</p> : <><label htmlFor="dialog-input">{dialog.kind === 'rename' ? 'Название чата' : 'Название папки'}</label><input id="dialog-input" autoFocus maxLength={dialog.kind === 'rename' ? 120 : 80} placeholder="Например, Работа" value={dialog.value} onChange={event => setDialog({ ...dialog, value: event.target.value })} onFocus={event => event.target.select()} /></>}
      <div className="modal-actions"><button type="button" className="secondary-button" disabled={dialogBusy} onClick={() => setDialog(null)}>Отмена</button><button type="submit" className="primary-button" disabled={dialogBusy || !dialog.value.trim()}>{dialogBusy ? 'Удаляем…' : dialog.kind === 'folder' ? 'Создать папку' : dialog.kind === 'hide' ? 'Убрать из списка' : dialog.kind === 'folder-delete' ? 'Удалить папку' : dialog.kind === 'chat-delete' ? 'Удалить навсегда' : dialog.kind === 'messages-delete' ? 'Удалить переписку' : 'Сохранить'}</button></div>
    </form></div>}
  </div>;
}

export const Message = memo(function Message({ item, copied, copy, cwd, onError, canDelete: allowDelete, onDelete, answeredQuestions, onAnswer, questionDrafts }: { item: Item; copied: string; copy: (text: string, id: string) => Promise<void>; cwd: string; onError: (message: string) => void; canDelete: boolean; onDelete: (item: Item) => void; answeredQuestions: Set<string>; onAnswer: (text: string) => Promise<boolean>; questionDrafts: Map<string, Record<number, string>> }) {
  const canDelete = allowDelete && !!item.turnId;
  if (item.type === 'userMessage') {
    const text = (item.content || []).filter(value => value.type === 'text').map(value => value.text).join('\n');
    const replies = questionReplies(text);
    return <article className="message user-message"><div className="message-author">{replies ? 'Вы ответили' : 'Вы'}</div><div className="user-bubble">{replies ? <dl className="question-replies">{replies.map((reply, index) => <div key={index}><dt>{reply.question}</dt><dd>{reply.answer}</dd></div>)}</dl> : text}</div>{canDelete && <div className="message-actions user-actions"><IconButton label="Удалить с этого сообщения" onClick={() => onDelete(item)}><Trash2 size={14} /></IconButton></div>}</article>;
  }
  if (item.type === 'agentMessage' || item.type === 'plan') {
    if (!item.text && !item.questions?.length) return null;
    return <article className={`message agent-message ${item.phase === 'commentary' ? 'commentary-message' : ''}`}><div className="message-author"><Brand small /><span>Codex</span>{item.type === 'plan' && <span className="message-tag">План</span>}</div>
      <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} urlTransform={messageLinkUrl} components={{
        a: ({ href, children }) => href ? <a href={href} title={href} onClick={event => { event.preventDefault(); void api.openLink({ href, cwd }).catch(error => onError(errorText(error))); }}>{children}</a> : <span>{children}</span>,
        img: ({ alt }) => <span className="image-placeholder">{alt || 'Изображение'}</span>,
        pre: ({ children }) => <div className="code-block"><pre>{children}</pre><button className="copy-code" aria-label="Скопировать код" onClick={event => {
          const text = event.currentTarget.previousElementSibling?.textContent || ''; void copy(text, item.id + '-code');
        }}>{copied === item.id + '-code' ? <Check size={14} /> : <Copy size={14} />}</button></div>,
      }}>{item.text}</Markdown></div>
      {!!item.questions?.length && <AsyncQuestions item={item} answeredQuestions={answeredQuestions} onAnswer={onAnswer} draftCache={questionDrafts} />}
      <div className="message-actions">{!!item.text && <IconButton label="Скопировать ответ" onClick={() => void copy(item.text!, item.id)}>{copied === item.id ? <Check size={14} /> : <Copy size={14} />}</IconButton>}{canDelete && <IconButton label="Удалить с этого сообщения" onClick={() => onDelete(item)}><Trash2 size={14} /></IconButton>}</div>
    </article>;
  }
  return <ToolCall item={item} />;
});

function ToolCall({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  const title = item.type === 'commandExecution' ? item.command : item.type === 'fileChange' ? `Изменения файлов · ${item.changes?.length || 0}` : `${item.server || 'Инструмент'} / ${item.tool || ''}`;
  const running = ['inProgress', 'running'].includes(item.status || '');
  return <details className="tool-call" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{running ? <LoaderCircle size={13} className="spinning" /> : item.status === 'failed' ? <X size={13} /> : <Check size={13} />}<span>{title}</span><ChevronRight size={13} /></summary>{open && <div className="tool-output">{item.type === 'commandExecution' ? <pre>{item.aggregatedOutput || 'Нет вывода'}{item.exitCode != null ? `\nКод выхода: ${item.exitCode}` : ''}</pre> : item.type === 'fileChange' ? item.changes?.map(change => <div key={change.path}><strong>{change.path}</strong><pre>{change.diff}</pre></div>) : <p>{item.error?.message || `Статус: ${item.status || 'завершено'}`}</p>}</div>}</details>;
}

function AsyncQuestions({ item, answeredQuestions, onAnswer, draftCache }: { item: Item; answeredQuestions: Set<string>; onAnswer: (text: string) => Promise<boolean>; draftCache: Map<string, Record<number, string>> }) {
  const [answers, setAnswers] = useState<Record<number, string>>(() => draftCache.get(item.id) || {});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const questions = item.questions || [];
  function setAnswer(index: number, text: string) {
    setAnswers(value => {
      const next = { ...value, [index]: text };
      draftCache.set(item.id, next);
      if (draftCache.size > 300) draftCache.delete(draftCache.keys().next().value!);
      return next;
    });
  }
  const questionId = (index: number) => JSON.stringify(['request_user_input_async', item.id, index]);
  const pending = questions.map((question, index) => ({ ...question, index })).filter(question => !answeredQuestions.has(questionId(question.index)));
  if (!pending.length || sent) return <div className="async-answered"><Check size={13} />Ответ отправлен</div>;
  return <form className="async-questions" aria-label="Вопросы Codex" onSubmit={async event => {
    event.preventDefault();
    if (busy || pending.some(question => !answers[question.index]?.trim())) return;
    const replies = pending.map(question => ({ answer: answers[question.index].trim(), question: question.title, questionItemId: questionId(question.index) }));
    setBusy(true);
    try { if (await onAnswer('<send_user_message_question_reply>\n' + JSON.stringify(replies) + '\n</send_user_message_question_reply>')) { setSent(true); draftCache.delete(item.id); } }
    finally { setBusy(false); }
  }}>
    {pending.map(question => <div className="async-question" key={question.index}><label htmlFor={`question-${item.id}-${question.index}`}>{question.title}</label>
      {!!question.options?.length && <div className="question-options">{question.options.map(option => <button type="button" key={option} disabled={busy} aria-pressed={answers[question.index] === option} className={answers[question.index] === option ? 'chosen' : ''} onClick={() => setAnswer(question.index, option)}>{option}</button>)}</div>}
      <input id={`question-${item.id}-${question.index}`} value={answers[question.index] || ''} disabled={busy} onChange={event => setAnswer(question.index, event.target.value)} placeholder="Выберите вариант или напишите свой ответ" />
    </div>)}
    <div className="approval-actions"><button type="submit" className="primary-button" disabled={busy || pending.some(question => !answers[question.index]?.trim())}>{busy ? 'Отправляем…' : 'Ответить'}</button></div>
  </form>;
}

export function Approval({ request, onError, items }: { request: ServerRequest; onError: (error: string) => void; items: Item[] }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const isQuestion = request.method === 'item/tool/requestUserInput';
  const isElicitation = request.method === 'mcpServer/elicitation/request';
  const isPermission = request.method === 'item/permissions/requestApproval';
  const item = items.find(item => item.id === request.params.itemId);
  const answer = async (decision: string) => {
    setBusy(true);
    try { await api.answer({ id: request.id, decision, answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, [value]])) }); }
    catch (error) { onError(errorText(error)); setBusy(false); }
  };
  return <div className="approval-card" role="region" aria-label={isQuestion ? 'Вопрос Codex' : 'Запрос разрешения'}>
    <div className="approval-title"><ShieldCheck size={17} /><strong>{isQuestion ? 'Codex уточняет' : isElicitation ? 'Запрос от инструмента' : 'Нужно ваше разрешение'}</strong></div>
    {isQuestion ? request.params.questions?.map(question => <div className="approval-question" key={question.id}><label htmlFor={`answer-${question.id}`}>{question.question}</label>{question.options?.length ? <div className="question-options">{question.options.map(option => <button key={option.label} title={option.description} onClick={() => setAnswers(value => ({ ...value, [question.id]: option.label }))} className={answers[question.id] === option.label ? 'chosen' : ''}>{option.label}</button>)}</div> : null}<input id={`answer-${question.id}`} placeholder="Ваш ответ" value={answers[question.id] || ''} onChange={event => setAnswers(value => ({ ...value, [question.id]: event.target.value }))} /></div>) : <>
      <p>{request.params.reason || request.params.message || (isPermission ? 'Codex запрашивает дополнительные права для текущего хода.' : 'Codex хочет выполнить действие за пределами текущих разрешений.')}</p>
      {request.params.command && <pre>{request.params.command}</pre>}
      {request.params.cwd && <div className="approval-cwd">{request.params.cwd}</div>}
      {request.params.grantRoot && <pre>{request.params.grantRoot}</pre>}
      {isPermission && <pre>{JSON.stringify(request.params.permissions, null, 2)}</pre>}
      {item?.changes?.map(change => <details className="approval-diff" key={change.path}><summary>{change.path}</summary><pre>{change.diff}</pre></details>)}
      {isElicitation && <p>Этот запрос требует формы или подтверждения, которое пока не поддерживается. Можно отклонить его и продолжить переписку.</p>}
    </>}
    <div className="approval-actions">{!isQuestion && <button className="secondary-button" disabled={busy} onClick={() => void answer('decline')}>Отклонить</button>}{!isElicitation && <button className="primary-button" disabled={busy || (isQuestion && request.params.questions?.some(question => !answers[question.id]?.trim()))} onClick={() => void answer('accept')}>{busy ? 'Отправляем…' : isQuestion ? 'Ответить' : isPermission ? 'Разрешить на этот ход' : 'Разрешить один раз'}</button>}</div>
  </div>;
}
