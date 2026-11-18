const MAX_MODEL_ID_LENGTH = 128;

function requestedValue(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${name}: укажите строковый идентификатор модели.`);
  if (value.length > MAX_MODEL_ID_LENGTH) throw new Error(`${name}: идентификатор модели слишком длинный.`);
  if (!value) return undefined;
  if (!value.trim()) throw new Error(`${name}: идентификатор модели имеет неверный формат.`);
  if (value !== value.trim()) throw new Error(`${name}: идентификатор модели имеет неверный формат.`);
  return value;
}

function supportedEfforts(model) {
  return Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
      .map(item => typeof item === 'string' ? item : item?.reasoningEffort)
      .filter(value => typeof value === 'string' && value.length > 0)
    : [];
}

function chooseModel(available, requested, preferredIDs, name) {
  if (requested) {
    const match = available.find(model => model.model === requested);
    if (!match) throw new Error(`${name}: модель «${requested}» недоступна или скрыта в каталоге.`);
    return match;
  }
  for (const id of preferredIDs) {
    const match = available.find(model => model.model === id);
    if (match) return match;
  }
  return available.find(model => model.isDefault) || available[0];
}

function selectEffort(model, requested) {
  const efforts = supportedEfforts(model);
  if (requested) {
    if (!efforts.includes(requested)) {
      throw new Error(`Режим рассуждения «${requested}» не поддерживается моделью «${model.model}».`);
    }
    return requested;
  }
  if (efforts.includes('high')) return 'high';
  if (efforts.includes(model.defaultReasoningEffort)) return model.defaultReasoningEffort;
  return efforts[0];
}

/** Scoped to this thread; never rewrites the user's global Codex configuration. */
export function autoOptions(models, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Параметры Auto должны быть объектом.');
  }
  const { autoCoordinator, autoWorker, effort } = options;
  if (!Array.isArray(models)) throw new Error('Auto не получил каталог моделей.');
  const available = models.filter(model => model && typeof model.model === 'string' && model.model && !model.hidden);
  if (!available.length) throw new Error('Auto не нашёл доступных моделей в каталоге.');

  const coordinatorRequest = requestedValue(autoCoordinator, 'Модель координатора');
  const workerRequest = requestedValue(autoWorker, 'Модель рабочего агента');
  if (effort !== undefined && typeof effort !== 'string') {
    throw new Error('Режим рассуждения должен быть строкой.');
  }
  if (typeof effort === 'string' && effort.length > MAX_MODEL_ID_LENGTH) {
    throw new Error('Режим рассуждения слишком длинный.');
  }

  const coordinator = chooseModel(available, coordinatorRequest, ['gpt-6.2-sol', 'gpt-6.1-sol'], 'Модель координатора');
  const worker = chooseModel(available, workerRequest, ['gpt-6-luna'], 'Модель рабочего агента');
  const coordinatorEffort = selectEffort(coordinator, effort || undefined);
  const workerEffort = selectEffort(worker, undefined);
  const displayName = coordinator.displayName || coordinator.model;
  const effortSetting = { 'agents.default_subagent_reasoning_effort': workerEffort || null };

  return {
    model: coordinator.model,
    workerModel: worker.model,
    effort: coordinatorEffort,
    config: {
      'agents.enabled': true,
      'agents.max_concurrent_threads_per_session': 3,
      'agents.default_subagent_model': worker.model,
      ...effortSetting,
    },
    developerInstructions: `UniCode Auto orchestration mode. You are ${displayName} (${coordinator.model}), the coordinator and final reviewer. Start workers with ${worker.model}${workerEffort ? ` at ${workerEffort} reasoning effort` : ' using its catalog default reasoning effort'}.
These coordinator instructions apply only to the primary thread. A subagent must execute only its assigned task and must not delegate further.
The user explicitly requests delegation for implementation and other substantive tasks in this mode. Use 2-3 workers when there are independent tasks; use one for a small task. Answer simple conversational questions directly.
Available models and supported reasoning: ${JSON.stringify(available.map(model => ({ model: model.model, displayName: model.displayName, efforts: supportedEfforts(model), defaultReasoningEffort: model.defaultReasoningEffort })))}.
Start clearly scoped execution tasks with the selected worker model ${worker.model}${workerEffort ? `, reasoning ${workerEffort}` : ' at its catalog default'}; use fork_turns none and provide sufficient requirements, relevant paths, acceptance criteria and ownership in each worker's message. Workers must not spawn other workers. Never have workers concurrently edit the same files.
Before spawning, publish a commentary message containing an HTML comment with a JSON array, exactly in this format: <!-- unicode:tasks [{"name":"implementation","task":"Concrete task and acceptance criteria"},{"name":"qa","task":"Concrete QA task and acceptance criteria"}] -->. Match each name to the spawn task_name, use unique names across this conversation, and put real task descriptions in the JSON. Also include a short human-readable explanation outside the comment. This gives UniCode task labels even when spawn events omit prompts. For reassignment publish the updated task first.
Require each worker to begin with a short commentary stating its assigned task, and return changed files, actual checks performed, findings and unresolved problems. Do not assume tests passed. Respect the user's instructions about whether to write or run tests; QA tasks explicitly requesting tests authorize the relevant test work.
You must personally inspect actual changes and evidence against the original requirements; do not accept a worker summary as proof. Send concrete corrections back to the worker. After two unsuccessful correction attempts, or immediately for a clearly unsuitable task, close the unsuccessful worker and escalate that task to an available stronger model. Prefer available GPT-6.2 models, then gpt-6-sol, gpt-6.1-sol, and gpt-6-astra when present in the live catalog. Never select a model absent from the catalog, retry endlessly, or silently substitute an unavailable model.
Wait for every worker before your final answer. Preserve concise task/result summaries in your final response, distinguish verified results from unverified behavior, and close completed workers with the collaboration tool. UniCode deletes only this Auto run's worker chats after the coordinator turn and all workers have finished, retaining their summaries. Do not delete the main chat or user files. Never push, publish, or commit without the user's authorization.`,
  };
}
