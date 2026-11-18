import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, ChevronDown, Cpu, Eye, FolderOpen, ShieldAlert, Zap } from 'lucide-react';
import type { Model, State } from './types';
import { effortLabel } from './presentation';
import { autoEffort, resolveAutoModels } from './auto-models';
import './RunOptions.css';

type Option = { value: string; label: string; description?: string; danger?: boolean; disabled?: boolean };
type Settings = Pick<State, 'model' | 'effort' | 'access' | 'serviceTier' | 'autoCoordinator' | 'autoWorker'>;

function OptionList({ label, options, value, onChange, compact = false, listRef }: {
  label: string; options: Option[]; value: string; onChange: (value: string) => void; compact?: boolean; listRef?: RefObject<HTMLDivElement | null>;
}) {
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = index;
    if (['ArrowDown', 'ArrowRight'].includes(event.key)) next = (index + 1 + buttons.length) % buttons.length;
    else if (['ArrowUp', 'ArrowLeft'].includes(event.key)) next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next]?.focus();
  }
  return <div ref={listRef} className={compact ? 'rc-reason-options' : 'rc-model-options'} role="listbox" aria-label={label} onKeyDown={navigate}>
    {options.map(option => <button type="button" key={`${option.value}-${option.label}`} role="option" disabled={option.disabled} aria-selected={value === option.value}
      tabIndex={value === option.value ? 0 : -1} className={`rc-option ${option.danger ? 'rc-danger-option' : ''}`}
      title={option.description || option.label} onClick={() => onChange(option.value)}>
      <span className="rc-option-label">{option.label}</span>
      {option.description && <span className="rc-option-description">{option.description}</span>}
      {!compact && <Check size={14} className="rc-check" aria-hidden="true" />}
    </button>)}
  </div>;
}

const ACCESS_LEVELS = ['read-only', 'workspace-write', 'danger-full-access'] as const;
const ACCESS_INFO = {
  'read-only': { label: 'Только чтение', title: 'Только чтение' },
  'workspace-write': { label: 'Работа в проекте', title: 'Запись в рабочую область' },
  'danger-full-access': { label: 'Полный доступ', title: 'Полный доступ без ограничений' },
} as const;

export function RunOptions({ models, model, effort = '', access = 'workspace-write', serviceTier = 'default', autoCoordinator, autoWorker, defaults, disabled, onChange }: Settings & {
  models: Model[]; defaults: { model: string; effort: string }; disabled: boolean; onChange: (patch: Partial<Settings>) => void;
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const [autoStage, setAutoStage] = useState<'coordinator' | 'worker' | null>(null);
  const [position, setPosition] = useState({ left: 8, bottom: 64, width: 500, maxHeight: 400 });
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const modelButton = useRef<HTMLButtonElement>(null);
  const modelList = useRef<HTMLDivElement>(null);
  const reasoningList = useRef<HTMLDivElement>(null);
  const accessIndex = Math.max(0, ACCESS_LEVELS.indexOf(access as typeof ACCESS_LEVELS[number]));
  const defaultModel = models.find(item => item.model === defaults.model) || models.find(item => item.isDefault);
  const autoModels = resolveAutoModels(models, autoCoordinator, autoWorker);
  const selectedModel = chosenModel ?? model;
  const modelInfo = selectedModel === 'auto' ? autoModels.coordinator : selectedModel ? models.find(item => item.model === selectedModel) : defaultModel;
  const defaultEffort = (selectedModel === 'auto' ? autoEffort(modelInfo) : !selectedModel ? defaults.effort : '') || modelInfo?.defaultReasoningEffort || '';
  const fastSupported = !!(modelInfo?.serviceTiers?.some(tier => ['fast', 'priority'].includes(tier.id)) || modelInfo?.additionalSpeedTiers?.includes('fast'));
  const reasoning = modelInfo?.supportedReasoningEfforts || [];
  const modelLabel = model === 'auto' ? 'Auto' : modelInfo?.displayName || model || defaults.model || 'По умолчанию';
  const effortName = effortLabel(effort || defaultEffort);
  const coordinatorLabel = autoCoordinator ? autoModels.coordinator?.displayName || autoCoordinator : autoModels.coordinator?.displayName || 'не выбрана';
  const workerLabel = autoWorker ? autoModels.worker?.displayName || autoWorker : autoModels.worker?.displayName || 'не выбрана';
  const fullModelLabel = modelLabel === 'Auto' ? `Auto · Оркестратор: ${coordinatorLabel} · Лёгкие задачи: ${workerLabel}` : modelLabel;
  const accessInfo = ACCESS_INFO[ACCESS_LEVELS[accessIndex]];
  const modelOptions: Option[] = [
    { value: 'auto', label: 'Auto', description: 'Распределение задач между моделями', disabled: models.length === 0 },
    { value: '', label: 'По умолчанию', description: defaultModel?.displayName || defaults.model || undefined },
    ...(model && model !== 'auto' && !models.some(item => item.model === model) ? [{ value: model, label: model }] : []),
    ...models.map(item => ({ value: item.model, label: item.displayName })),
  ];

  useEffect(() => { if (disabled) { setModelOpen(false); setChosenModel(null); setAutoStage(null); } }, [disabled]);
  useLayoutEffect(() => {
    if (!modelOpen) return;
    function place() {
      const rect = modelButton.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(chosenModel !== null && reasoning.length || autoStage ? 560 : 280, window.innerWidth - 16);
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), bottom: window.innerHeight - rect.top + 8, width, maxHeight: Math.max(120, Math.min(520, rect.top - 24)) });
    }
    place();
    modelList.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')?.focus({ preventScroll: true });
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [autoStage, chosenModel, modelOpen, reasoning.length]);
  useEffect(() => {
    if (!modelOpen) return;
    if (autoStage) {
      const selected = reasoningList.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]:not(:disabled)');
      const firstAvailable = reasoningList.current?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)');
      (selected || firstAvailable)?.focus({ preventScroll: true });
    } else if (chosenModel !== null && reasoning.length) reasoningList.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')?.focus({ preventScroll: true });
  }, [autoStage, chosenModel, modelOpen, reasoning.length]);
  useEffect(() => {
    if (!modelOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) { setModelOpen(false); setChosenModel(null); setAutoStage(null); }
    };
    const keyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); setModelOpen(false); setChosenModel(null); setAutoStage(null); modelButton.current?.focus();
      }
    };
    const focus = (event: FocusEvent) => {
      if (!root.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) { setModelOpen(false); setChosenModel(null); setAutoStage(null); }
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keyboard);
    document.addEventListener('focusin', focus);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keyboard);
      document.removeEventListener('focusin', focus);
    };
  }, [modelOpen]);

  function chooseModel(value: string) {
    const nextModel = value === 'auto' ? autoModels.coordinator : value ? models.find(item => item.model === value) : defaultModel;
    const supportsFast = nextModel?.serviceTiers?.some(tier => ['fast', 'priority'].includes(tier.id)) || nextModel?.additionalSpeedTiers?.includes('fast');
    onChange({ model: value, effort: '', ...(serviceTier === 'fast' && !supportsFast ? { serviceTier: 'default' as const } : {}) });
    if (value === 'auto') { setChosenModel('auto'); setAutoStage('coordinator'); }
    else if (nextModel?.supportedReasoningEfforts?.length) { setChosenModel(value); setAutoStage(null); }
    else { setModelOpen(false); setChosenModel(null); setAutoStage(null); modelButton.current?.focus(); }
  }
  function finish() { setModelOpen(false); setChosenModel(null); setAutoStage(null); modelButton.current?.focus(); }
  function onModelTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); setChosenModel(null); setAutoStage(null); setModelOpen(true); }
  }
  const autoSelectedId = autoStage === 'coordinator' ? autoCoordinator : autoWorker;
  const autoSelectedModel = autoStage === 'coordinator' ? autoModels.coordinator : autoModels.worker;
  const autoSelectedValue = autoSelectedId || autoSelectedModel?.model || '';
  const autoRole = autoStage === 'coordinator' ? 'Оркестратор' : 'Лёгкие задачи';
  const autoOptions: Option[] = [
    ...(autoSelectedId && !models.some(item => item.model === autoSelectedId) ? [{ value: autoSelectedId, label: `${autoSelectedId} · Недоступна`, description: `${autoSelectedId} недоступна в текущем каталоге`, disabled: true }] : []),
    ...models.map(item => ({ value: item.model, label: item.displayName, description: item.model })),
  ];
  function chooseAutoModel(value: string) {
    if (autoStage === 'coordinator') {
      const nextModel = models.find(item => item.model === value);
      const supportsFast = nextModel?.serviceTiers?.some(tier => ['fast', 'priority'].includes(tier.id)) || nextModel?.additionalSpeedTiers?.includes('fast');
      onChange({ autoCoordinator: value, effort: '', ...(serviceTier === 'fast' && !supportsFast ? { serviceTier: 'default' as const } : {}) });
      setAutoStage('worker');
    } else {
      onChange({ autoWorker: value });
      setAutoStage(null);
      if (autoModels.coordinator?.supportedReasoningEfforts?.length) setChosenModel('auto');
      else finish();
    }
  }

  return <div className="run-options rc-controls" ref={root}>
    <button ref={modelButton} type="button" className="run-menu-trigger rc-model-trigger" disabled={disabled}
      aria-label={`Модель: ${fullModelLabel}${effortName ? ', ' + effortName : ''}`} aria-haspopup="dialog" aria-expanded={modelOpen}
      aria-controls={modelOpen ? 'rc-model-panel' : undefined} title={`${fullModelLabel}${effortName ? ' · ' + effortName : ''}`}
      onClick={() => { setChosenModel(null); setAutoStage(null); setModelOpen(value => !value); }} onKeyDown={onModelTriggerKeyDown}>
      <Cpu size={13} className="rc-model-cpu" aria-hidden="true" />
      <span className="rc-model-name rc-model-name-full">{modelLabel}</span>
      <span className="rc-model-name rc-model-name-short" aria-hidden="true">{modelLabel.replace(/^GPT-\s*/i, '')}</span>
      <ChevronDown size={12} aria-hidden="true" />
    </button>
    <button type="button" className="rc-speed-toggle" disabled={disabled || !fastSupported} aria-pressed={serviceTier === 'fast'}
      aria-label={serviceTier === 'fast' ? 'Быстрая скорость включена' : fastSupported ? 'Включить быструю скорость' : 'Быстрая скорость недоступна для этой модели'}
      title={serviceTier === 'fast' ? 'Fast · повышенный расход лимита' : fastSupported ? 'Standard · нажмите для Fast' : 'Fast недоступна для этой модели'}
      onClick={() => onChange({ serviceTier: serviceTier === 'fast' ? 'default' : 'fast' })}>
      <Zap size={15} aria-hidden="true" />
    </button>
    <div className={`rc-access-switch ${access === 'danger-full-access' ? 'is-danger' : ''}`} data-access-index={accessIndex} title={accessInfo.title}>
      <span className="rc-access-icon rc-access-icon-0" aria-hidden="true"><Eye size={13} /></span>
      <span className="rc-access-icon rc-access-icon-1" aria-hidden="true"><FolderOpen size={13} /></span>
      <span className="rc-access-icon rc-access-icon-2" aria-hidden="true"><ShieldAlert size={13} /></span>
      <span className="rc-access-thumb" aria-hidden="true" />
      <input type="range" min="0" max="2" step="1" value={accessIndex} disabled={disabled}
        aria-label="Уровень доступа" aria-valuetext={accessInfo.label} title={accessInfo.title}
        onChange={event => onChange({ access: ACCESS_LEVELS[Number(event.currentTarget.value)] as State['access'] })} />
    </div>
    {modelOpen && createPortal(<section ref={panel} id="rc-model-panel" className={`rc-model-panel ${chosenModel !== null && reasoning.length || autoStage ? 'has-reasoning' : ''} ${autoStage ? 'has-auto-stage' : ''}`}
      role="dialog" aria-label="Выбор модели и reasoning" style={position}>
      <div className="rc-model-column">
        <div className="rc-panel-heading">Модель</div>
        <div className="rc-list-scroll"><OptionList listRef={modelList} label="Модель Codex" options={modelOptions} value={selectedModel} onChange={chooseModel} /></div>
      </div>
      {autoStage && <div key={autoStage} className="rc-reason-column rc-auto-column">
        <div className="rc-panel-heading rc-stage-heading">
          {autoStage === 'worker' && <button type="button" className="rc-stage-back" aria-label="Вернуться к выбору оркестратора" title="Оркестратор" onClick={() => setAutoStage('coordinator')}><ArrowLeft size={13} /></button>}
          {autoRole}
          {autoSelectedModel && <span className="rc-stage-current" title={autoSelectedModel.displayName}>{autoSelectedModel.displayName}</span>}
        </div>
        <div className="rc-list-scroll"><OptionList listRef={reasoningList} label={autoRole} value={autoSelectedValue} options={autoOptions}
          onChange={chooseAutoModel} /></div>
      </div>}
      {!autoStage && chosenModel !== null && !!reasoning.length && <div className="rc-reason-column">
        <div className="rc-panel-heading">Reasoning</div>
        <div className="rc-list-scroll"><OptionList listRef={reasoningList} compact label="Глубина рассуждений" value={effort} options={[
          { value: '', label: 'Авто', description: defaultEffort ? `По умолчанию · ${effortLabel(defaultEffort)}` : 'По умолчанию' },
          ...reasoning.map(option => ({ value: option.reasoningEffort, label: effortLabel(option.reasoningEffort), description: option.description })),
        ]} onChange={value => { onChange({ effort: value }); finish(); }} /></div>
      </div>}
    </section>, document.body)}
  </div>;
}
