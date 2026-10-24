import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Cpu, ShieldCheck, X } from 'lucide-react';
import type { Model, State } from './types';
import { effortLabel } from './presentation';

type Option = { value: string; label: string; description?: string; danger?: boolean };
type Settings = Pick<State, 'model' | 'effort' | 'access'>;

function OptionList({ label, options, value, onChange, compact = false }: {
  label: string; options: Option[]; value: string; onChange: (value: string) => void; compact?: boolean;
}) {
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = index;
    if (['ArrowDown', 'ArrowRight'].includes(event.key)) next = (index + 1) % buttons.length;
    else if (['ArrowUp', 'ArrowLeft'].includes(event.key)) next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next]?.focus();
  }
  return <div className={compact ? 'reasoning-options' : 'run-option-list'} role="listbox" aria-label={label} onKeyDown={navigate}>
    {options.map(option => <button type="button" key={option.value} role="option" aria-selected={value === option.value}
      tabIndex={value === option.value ? 0 : -1} className={`run-option ${option.danger ? 'danger-option' : ''}`}
      title={compact ? option.description : undefined} onClick={() => onChange(option.value)}>
      <span className="run-option-copy"><span>{option.label}</span>{!compact && option.description && <small>{option.description}</small>}</span>
      {!compact && <Check size={14} className="option-check" />}
    </button>)}
  </div>;
}

export function RunOptions({ models, model, effort = '', access = 'workspace-write', defaults, disabled, onChange }: Settings & {
  models: Model[]; defaults: { model: string; effort: string }; disabled: boolean; onChange: (patch: Partial<Settings>) => void;
}) {
  const [open, setOpen] = useState<'model' | 'access' | null>(null);
  const [position, setPosition] = useState({ left: 0, bottom: 0, maxHeight: 500 });
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const modelButton = useRef<HTMLButtonElement>(null);
  const accessButton = useRef<HTMLButtonElement>(null);
  const defaultModel = models.find(item => item.model === defaults.model) || models.find(item => item.isDefault);
  const modelInfo = model ? models.find(item => item.model === model) : defaultModel;
  const defaultEffort = (!model ? defaults.effort : '') || modelInfo?.defaultReasoningEffort || '';
  const reasoning = modelInfo?.supportedReasoningEfforts || [];
  const modelLabel = modelInfo?.displayName || model || defaults.model || 'По умолчанию';
  const effortName = effortLabel(effort || defaultEffort);
  const accessOptions: Option[] = [
    { value: 'read-only', label: 'Только чтение', description: 'Чтение файлов. Дополнительные права — с разрешения.' },
    { value: 'workspace-write', label: 'Работа в проекте', description: 'Изменения в проекте. За его пределами — с разрешения.' },
    { value: 'danger-full-access', label: 'Полный доступ', description: 'Файлы и команды без запросов разрешения.', danger: true },
  ];
  const accessLabel = accessOptions.find(option => option.value === access)!.label;
  const modelOptions: Option[] = [
    { value: '', label: 'По умолчанию', description: defaultModel?.displayName || defaults.model || undefined },
    ...(model && !models.some(item => item.model === model) ? [{ value: model, label: model }] : []),
    ...models.map(item => ({ value: item.model, label: item.displayName })),
  ];

  useEffect(() => { if (disabled) setOpen(null); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = open === 'model' ? modelButton : accessButton;
    function place() {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(330, window.innerWidth - 32);
      setPosition({ left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)), bottom: window.innerHeight - rect.top + 10, maxHeight: Math.max(120, rect.top - 26) });
    }
    place();
    panel.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')?.focus({ preventScroll: true });
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(null);
    };
    const keyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); setOpen(null);
        (open === 'model' ? modelButton : accessButton).current?.focus();
      }
    };
    const focus = (event: FocusEvent) => {
      if (!root.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keyboard);
    document.addEventListener('focusin', focus);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keyboard);
      document.removeEventListener('focusin', focus);
    };
  }, [open]);

  function close() {
    setOpen(null);
    (open === 'model' ? modelButton : accessButton).current?.focus();
  }
  function openWithKeyboard(event: KeyboardEvent<HTMLButtonElement>, menu: 'model' | 'access') {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(menu); }
  }

  return <div className="run-options" ref={root}>
    <button ref={modelButton} type="button" className="run-menu-trigger model-trigger" disabled={disabled}
      aria-label={`Модель и reasoning: ${modelLabel}${effortName ? ', ' + effortName : ''}`} aria-haspopup="dialog" aria-expanded={open === 'model'}
      aria-controls={open === 'model' ? 'model-options' : undefined} title={`${modelLabel}${effortName ? ' · ' + effortName : ''}`}
      onClick={() => setOpen(value => value === 'model' ? null : 'model')} onKeyDown={event => openWithKeyboard(event, 'model')}>
      <span className="model-name">{modelLabel}</span>{effortName && <span className="effort-name">{effortName}</span>}<ChevronDown size={12} />
    </button>
    <button ref={accessButton} type="button" className={`run-menu-trigger access-trigger ${access === 'danger-full-access' ? 'full-access' : ''}`} disabled={disabled}
      aria-label={`Доступ: ${accessLabel}`} aria-haspopup="dialog" aria-expanded={open === 'access'} aria-controls={open === 'access' ? 'access-options' : undefined}
      title={accessLabel} onClick={() => setOpen(value => value === 'access' ? null : 'access')} onKeyDown={event => openWithKeyboard(event, 'access')}>
      <ShieldCheck size={14} /><span>{accessLabel}</span><ChevronDown size={12} />
    </button>
    {open && createPortal(<section ref={panel} id={open === 'model' ? 'model-options' : 'access-options'} className="run-options-popover" role="dialog"
      aria-label={open === 'model' ? 'Модель и reasoning' : 'Доступ агента'} style={position}>
      <div className="run-menu-heading"><span>{open === 'model' ? <Cpu size={15} /> : <ShieldCheck size={15} />}{open === 'model' ? 'Модель' : 'Доступ'}</span>
        <button type="button" className="icon-button" aria-label="Закрыть меню" onClick={close}><X size={14} /></button>
      </div>
      {open === 'model' ? <>
        <div className="model-options-scroll"><OptionList label="Модель Codex" options={modelOptions} value={model} onChange={value => onChange({ model: value, effort: '' })} /></div>
        {!!reasoning.length && <div className="reasoning-section"><div className="reasoning-heading">Reasoning</div>
          <OptionList label="Глубина рассуждений" compact value={effort} options={[
            { value: '', label: 'Авто', description: defaultEffort ? `По умолчанию · ${effortLabel(defaultEffort)}` : 'По умолчанию' },
            ...reasoning.map(option => ({ value: option.reasoningEffort, label: effortLabel(option.reasoningEffort), description: option.description })),
          ]} onChange={value => { onChange({ effort: value }); close(); }} />
        </div>}
      </> : <OptionList label="Доступ агента" options={accessOptions} value={access} onChange={value => { onChange({ access: value as State['access'] }); close(); }} />}
    </section>, document.body)}
  </div>;
}
