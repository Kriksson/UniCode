import type { Model } from './types';

export function resolveAutoModels(models: Model[], autoCoordinator?: string, autoWorker?: string) {
  const fallback = models.find(model => model.isDefault) || models[0];
  return {
    coordinator: autoCoordinator ? models.find(model => model.model === autoCoordinator)
      : models.find(model => model.model === 'gpt-6.2-sol') || models.find(model => model.model === 'gpt-6.1-sol') || fallback,
    worker: autoWorker ? models.find(model => model.model === autoWorker)
      : models.find(model => model.model === 'gpt-6-luna') || fallback,
  };
}

export function autoEffort(model?: Model, requested = ''): string {
  const supported = model?.supportedReasoningEfforts?.map(option => option.reasoningEffort) || [];
  if (requested && supported.includes(requested)) return requested;
  return supported.includes('high') ? 'high'
    : supported.includes(model?.defaultReasoningEffort || '') ? model!.defaultReasoningEffort!
    : supported[0] || '';
}
