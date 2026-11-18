import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, GitBranch, LoaderCircle, Pause, X } from 'lucide-react';
import type { Subagent } from './types';

export const agentFinished = (agent: Subagent) => ['completed', 'errored', 'shutdown', 'notFound', 'interrupted'].includes(agent.status);
const label = (agent: Subagent) => ({ pendingInit: 'Запускается', running: 'Работает', completed: 'Готово', errored: 'Ошибка', shutdown: 'Закрыт', notFound: 'Недоступен', interrupted: 'Остановлен', unknown: 'Уточняет состояние' }[agent.status] || agent.status);
function StatusIcon({ agent }: { agent: Subagent }) {
  return agent.status === 'completed' ? <Check size={14} /> : ['errored', 'notFound'].includes(agent.status) ? <X size={14} /> : agentFinished(agent) ? <Pause size={13} /> : <LoaderCircle size={14} className="spinning" />;
}
export function useAgents() {
  const [agents, setAgents] = useState<Subagent[]>([]);
  useEffect(() => window.codex.onEvent(event => {
    if (event.type === 'agents-updated' && Array.isArray(event.message)) setAgents(event.message);
  }), []);
  const seed = useCallback((initial: Subagent[] = []) => setAgents(current => {
    const next = new Map(initial.map(agent => [agent.id, agent]));
    for (const agent of current) if (agent.updatedAt >= (next.get(agent.id)?.updatedAt || 0)) next.set(agent.id, agent);
    return [...next.values()];
  }), []);
  return { agents, seed };
}
export function descendants(agents: Subagent[], id: string): (Subagent & { depth: number })[] {
  const result: (Subagent & { depth: number })[] = []; const seen = new Set([id]);
  function walk(parent: string, depth: number) {
    if (depth > 12) return;
    for (const agent of agents.filter(agent => agent.parentId === parent)) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id); result.push({ ...agent, depth }); walk(agent.id, depth + 1);
    }
  }
  walk(id, 0); return result;
}
export function AgentBranches({ agents, parentId, selectedId, onSelect }: { agents: Subagent[]; parentId: string; selectedId: string | null; onSelect: (id: string) => void }) {
  const rows = descendants(agents, parentId).filter(agent => !agentFinished(agent));
  if (!rows.length) return null;
  return <div className="agent-branches" aria-label="Работающие субагенты">{rows.map(agent => <button type="button" key={agent.id} className={`agent-branch ${selectedId === agent.id ? 'selected' : ''}`} style={{ paddingLeft: 12 + agent.depth * 12 }} onClick={() => onSelect(agent.id)} title={agent.task}>
    <span className="agent-branch-line" /><StatusIcon agent={agent} /><span><strong>{agent.name}</strong><small>{agent.model || agent.task || label(agent)}</small></span><ArrowUpRight size={12} />
  </button>)}</div>;
}
export function AgentProgress({ agents, parentId, onSelect }: { agents: Subagent[]; parentId: string; onSelect: (id: string) => void }) {
  const rows = useMemo(() => descendants(agents, parentId), [agents, parentId]);
  const [expanded, setExpanded] = useState(true);
  const active = rows.filter(agent => !agentFinished(agent));
  const complete = rows.filter(agent => agent.status === 'completed').length;
  const stopped = rows.filter(agent => agentFinished(agent) && agent.status !== 'completed').length;
  useEffect(() => { setExpanded(active.length > 0); }, [active.length]);
  if (!rows.length) return null;
  return <section className="agent-progress" aria-label="Прогресс субагентов">
    <button type="button" className="agent-progress-heading" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><GitBranch size={15} /><strong>Субагенты</strong><span>{complete}/{rows.length} готово{active.length ? ` · ${active.length} в работе` : ''}{stopped ? ` · ${stopped} остановлено` : ''}</span><ChevronDown size={14} className={expanded ? 'expanded' : ''} /></button>
    <div className="agent-progress-track" aria-label={`Завершено ${complete} из ${rows.length}`}><span style={{ transform: `scaleX(${complete / rows.length})` }} /></div>
    {expanded && <div className="agent-progress-list">{rows.map(agent => <details className={`agent-task ${agent.status}`} key={agent.id}>
      <summary><StatusIcon agent={agent} /><span><strong>{agent.name}</strong><small>{agent.model || 'Модель уточняется'}</small><b className="agent-task-preview">{agent.task || agent.introduction || agent.activity || 'Получает поручение'}</b>{!agentFinished(agent) && agent.activity && <small className="agent-live-activity">{agent.activity}</small>}</span><em>{label(agent)}</em></summary>
      {agent.task ? <p className="agent-task-prompt">{agent.task}</p> : agent.introduction ? <p className="agent-task-prompt"><small>Сообщение агента</small><br />{agent.introduction}</p> : <p className="agent-task-prompt">{agent.activity || 'Получает поручение'}</p>}
      {agent.activity && !agentFinished(agent) && <p className="agent-task-activity" role="status">{agent.activity}</p>}
      {agent.result && <details className="agent-result"><summary>Результат</summary><p>{agent.result}</p></details>}
      {agent.deleted ? <small>Диалог удалён · сводка сохранена</small> : <button type="button" className="agent-open" onClick={() => onSelect(agent.id)}>Открыть диалог<ArrowUpRight size={12} /></button>}
    </details>)}</div>}
  </section>;
}
export function AgentParent({ agent, onSelect }: { agent?: Subagent; onSelect: (id: string) => void }) {
  return agent ? <button className="agent-parent-link" type="button" onClick={() => onSelect(agent.parentId)}><ArrowLeft size={13} />Главный чат<span>{label(agent)}</span></button> : null;
}
