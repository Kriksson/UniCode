import { Presence } from './Presence';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ExternalLink, LoaderCircle, Plug, RefreshCw, Search, X } from 'lucide-react';
import type { Connection } from './types';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const statusOf = (app: Connection) => !app.runtimeKnown ? 'Статус не подтверждён' : app.callable ? 'Доступен агенту' : !app.enabled ? 'Выключен в Codex' : !app.isAccessible ? 'Не подключён' : 'Доступ ещё не подтверждён';

export function Connections({ disabled = false, onNewChat }: { disabled?: boolean; onNewChat: () => void }) {
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<Connection[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const queued = useRef(false);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [query, setQuery] = useState('');
  const queryRef = useRef(query); queryRef.current = query;
  const [waiting, setWaiting] = useState<string | null>(null);
  const [returned, setReturned] = useState(false);
  const loading = useRef(false);
  const generation = useRef(0);
  const opened = useRef(false);
  const waitingRef = useRef(waiting); waitingRef.current = waiting;
  const refreshAt = useRef(0);
  const load = useCallback(async (next: string | null = null, refresh = false): Promise<void> => {
    if (loading.current) { queued.current = true; return; }
    const epoch = generation.current;
    const search = queryRef.current;
    loading.current = true; setBusy(true); setError('');
    try {
      const page = await window.codex.connections(next, refresh, search);
      if (epoch !== generation.current || search !== queryRef.current) return;
      setApps(previous => [...new Map((next ? [...previous, ...page.data] : page.data).map(app => [app.id, app])).values()]);
      setCursor(page.nextCursor); setWarning(page.runtimeWarning || ''); setCatalogLoading(page.loading);
      const target = page.data.find(app => app.id === waitingRef.current);
      if (target) setReturned(target.callable);
    } catch (error) { if (epoch === generation.current) setError(errorText(error)); }
    finally {
      if (epoch === generation.current) {
        loading.current = false; setBusy(false);
        if (queued.current && opened.current) { queued.current = false; void load(null, false); }
      }
    }
  }, []);
  useEffect(() => {
    opened.current = open;
    if (!open) { generation.current++; loading.current = false; queued.current = false; setBusy(false); setAction(''); return; }
    void load(null, false);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    const focus = () => {
      if (!opened.current || !waitingRef.current || document.visibilityState !== 'visible' || Date.now() - refreshAt.current < 5000) return;
      refreshAt.current = Date.now(); void load(null, true);
    };
    window.addEventListener('keydown', key); window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [open, load]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void load(null, false), 250);
    return () => window.clearTimeout(timer);
  }, [query, open, load]);
  useEffect(() => {
    if (!open) return;
    let timer = 0;
    const unsubscribe = window.codex.onEvent(event => {
      if (event.type !== 'connections-updated') return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(null, false), 120);
    });
    return () => { unsubscribe(); window.clearTimeout(timer); };
  }, [open, load]);
  const rows = useMemo(() => apps.filter(app => `${app.name} ${app.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => Number(b.callable) - Number(a.callable) || a.name.localeCompare(b.name)), [apps, query]);
  async function enable(app: Connection) {
    if (action) return;
    const epoch = generation.current;
    setAction(app.id); setError('');
    try { await window.codex.connectionEnabled({ id: app.id, enabled: true }); if (epoch === generation.current) await load(null, true); }
    catch (error) { if (epoch === generation.current) setError(errorText(error)); }
    finally { if (epoch === generation.current) setAction(''); }
  }
  return <>
    <button type="button" className="icon-button connections-trigger" title="Подключения" aria-label="Подключения" disabled={disabled} onClick={() => { setOpen(true); setQuery(''); setError(''); }}><Plug size={18} /></button>
    {createPortal(<Presence show={open}><div className="modal-backdrop connections-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section className="connections-modal" role="dialog" aria-modal="true" aria-labelledby="connections-title">
        <div className="connections-heading"><div><h2 id="connections-title">Подключения</h2></div><button type="button" className="icon-button" aria-label="Закрыть подключения" onClick={() => setOpen(false)}><X size={18} /></button></div>
        <div className="connections-toolbar"><label><Search size={16} /><input aria-label="Поиск сервиса" placeholder="Gmail, Google Drive…" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} /></label><button type="button" className="icon-button" title="Обновить статус" aria-label="Обновить статус" disabled={busy || !!action} onClick={() => void load(null, true)}><RefreshCw size={17} className={busy ? 'spinning' : ''} /></button></div>
        {error && <p className="connections-error" role="alert">{error}</p>}
        {warning && <p className="connections-note" role="status">{warning}</p>}
        {waiting && <div className="connections-return"><span>{returned ? 'Сервис доступен агенту. Начни новый чат, чтобы использовать подключение.' : 'Заверши подключение в браузере, затем обнови статус.'}</span>{returned && <button type="button" disabled={!!action} onClick={() => { onNewChat(); setOpen(false); setWaiting(null); }}>Новый чат</button>}</div>}
        <div className="connections-list">{(busy || catalogLoading) && !apps.length ? <div className="connections-empty"><LoaderCircle size={23} className="spinning" /></div> : rows.map(app => <article className="connection-row" key={app.id}>
          <div className="connection-symbol">{app.callable ? <Check size={19} /> : <Plug size={19} />}</div>
          <div className="connection-description"><strong title={app.description || app.name}>{app.name}</strong><span className={app.callable ? 'connection-ready' : ''}>{statusOf(app)}</span></div>
          <div className="connection-actions">{!app.isEnabled ? <button type="button" className="secondary-button" disabled={!!action || busy} onClick={() => void enable(app)}>{action === app.id ? 'Включаем…' : 'Включить'}</button> : null}
            {!app.callable && app.installUrl && <button type="button" className="primary-button" disabled={!!action} onClick={() => {
              setError(''); setWaiting(app.id); setReturned(false);
              void window.codex.external(app.installUrl!).catch(error => setError(errorText(error)));
            }}><span>{waiting === app.id ? 'Открыть снова' : 'Подключить'}</span><ExternalLink size={12} /></button>}
            {!app.callable && !app.installUrl && <small>Ссылки подключения нет</small>}
          </div>
        </article>)}
          {!busy && !catalogLoading && !rows.length && <div className="connections-empty">{error || warning ? 'Список не удалось загрузить полностью. Обновите статус, чтобы повторить.' : query ? 'Сервис не найден в каталоге Codex.' : 'Codex вернул пустой каталог для этого аккаунта.'}</div>}
          {catalogLoading && <p className="connections-note" role="status">Обновление…</p>}
          {cursor && <button type="button" className="load-more" disabled={busy} onClick={() => void load(cursor)}>{busy ? 'Загружаем…' : 'Загрузить ещё сервисы'}</button>}
        </div>
      </section>
    </div></Presence>, document.body)}
  </>;
}
