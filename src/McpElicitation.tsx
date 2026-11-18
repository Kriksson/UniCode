import { useMemo, useRef, useState } from 'react';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import { elicitationForm, elicitationResponse, type ElicitationField } from '../electron/elicitation.mjs';
import type { ServerRequest } from './types';

export function McpElicitation({ request, onError }: { request: ServerRequest; onError: (message: string) => void }) {
  const parsed = useMemo(() => {
    try { return { form: elicitationForm(request.params), error: '' }; }
    catch (error) { return { form: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [request]);
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries((parsed.form?.fields || []).filter(field => field.default !== undefined).map(field => [field.key, field.default])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState(false);
  const pending = useRef(false);
  const form = parsed.form;
  const change = (key: string, value: unknown) => setValues(all => {
    const next = { ...all };
    if (value === undefined) delete next[key]; else next[key] = value;
    return next;
  });
  const content = () => Object.fromEntries((form?.fields || []).filter(field => Object.hasOwn(values, field.key)).map(field => {
    const value = values[field.key];
    return [field.key, field.type === 'number' || field.type === 'integer' ? Number(value) : value];
  }));
  async function answer(decision: 'accept' | 'decline') {
    if (pending.current) return;
    setError('');
    try {
      const data = decision === 'accept' && form?.mode === 'form' ? content() : undefined;
      elicitationResponse(request.params, decision, data);
      pending.current = true; setBusy(true);
      await window.codex.answer({ id: request.id, decision, content: data });
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
      setError(message); onError(message); pending.current = false; setBusy(false);
    }
  }
  function fieldInput(field: ElicitationField) {
    const id = `mcp-${request.id}-${field.key}`;
    const value = values[field.key];
    if (field.type === 'boolean') return <div className="question-options" role="group" aria-label={field.label}>
      {[true, false].map(option => <button key={String(option)} type="button" disabled={busy} aria-pressed={value === option} className={value === option ? 'chosen' : ''} onClick={() => change(field.key, option)}>{option ? 'Да' : 'Нет'}</button>)}
    </div>;
    if (field.options) return <div className="question-options" role="group" aria-label={field.label}>{field.options.map(option => {
      const selected = field.type === 'array' ? Array.isArray(value) && value.includes(option.value) : value === option.value;
      return <button key={option.value} type="button" disabled={busy} aria-pressed={selected} className={selected ? 'chosen' : ''} onClick={() => {
        if (field.type === 'array') {
          const previous = Array.isArray(value) ? value : [];
          change(field.key, selected ? previous.filter(entry => entry !== option.value) : [...previous, option.value]);
        } else change(field.key, option.value);
      }}>{option.label}</button>;
    })}</div>;
    return <input id={id} type={field.type === 'number' || field.type === 'integer' ? 'number' : field.format === 'email' ? 'email' : field.format === 'date' ? 'date' : 'text'}
      step={field.type === 'integer' ? 1 : 'any'} min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength ?? 10000}
      required={field.required} autoComplete="off" disabled={busy} value={typeof value === 'string' || typeof value === 'number' ? value : ''}
      onChange={event => change(field.key, event.target.value === '' && !field.required ? undefined : event.target.value)} />;
  }
  return <form className="approval-card mcp-elicitation" aria-label="Подтверждение MCP-инструмента" onSubmit={event => { event.preventDefault(); void answer('accept'); }}>
    <div className="approval-title"><ShieldCheck size={17} /><strong>Запрос от инструмента</strong></div>
    {request.params.serverName && <div className="approval-cwd">{request.params.serverName}</div>}
    <p>{request.params.message || 'Инструмент ожидает подтверждения.'}</p>
    {form?.mode === 'form' && form.fields.map(field => <div className="approval-question" key={field.key}>
      {field.type === 'boolean' || field.options ? <div className="mcp-field-label">{field.label}{field.required ? ' *' : ''}</div> : <label htmlFor={`mcp-${request.id}-${field.key}`}>{field.label}{field.required ? ' *' : ''}</label>}
      {field.description && <p>{field.description}</p>}{fieldInput(field)}
    </div>)}
    {form?.mode === 'url' && <div className="mcp-url-flow"><p className="mcp-url">{form.url}</p><button type="button" className="secondary-button" disabled={busy} onClick={() => {
      void window.codex.external(form.url!).then(() => setOpened(true)).catch(error => setError(error instanceof Error ? error.message : String(error)));
    }}><ExternalLink size={14} />Открыть страницу</button></div>}
    {(error || parsed.error) && <p className="mcp-form-error" role="alert">{error || parsed.error}</p>}
    <div className="approval-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => void answer('decline')}>Отклонить</button>
      {form && <button type="submit" className="primary-button" disabled={busy || (form.mode === 'url' && !opened)}>{busy ? 'Отправляем…' : form.mode === 'url' ? 'Я завершил действие' : form.fields.length ? 'Подтвердить' : 'Разрешить один раз'}</button>}
    </div>
  </form>;
}
