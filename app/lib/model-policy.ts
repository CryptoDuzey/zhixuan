import { getModelSettings, type ModelSettings } from './model-settings.ts';

/** Keep lightweight conversation fast; use the same provider's stronger model
 * for evidence-bound answers. Explicit custom gateways are untouched. */
export function factualModelOptions(settings: Pick<ModelSettings, 'baseUrl' | 'model' | 'models'> = getModelSettings()): { models?: string[]; reasoning?: 'low' } {
  if (new URL(settings.baseUrl).hostname !== 'api.deepseek.com') return {};
  if (settings.model === 'deepseek-flash') return { models: [...new Set(['deepseek-v4-pro', ...settings.models])], reasoning: 'low' };
  if (settings.model === 'deepseek-v4-pro') return { reasoning: 'low' };
  return {};
}
