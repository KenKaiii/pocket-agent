/**
 * Chat mode provider configuration for @kenkaiiii/gg-ai
 *
 * Returns provider/apiKey/baseUrl configs matching gg-ai's StreamOptions shape.
 * Uses the shared MODEL_PROVIDERS mapping from providers.ts.
 */

import type { Provider } from '@kenkaiiii/gg-ai';
import { SettingsManager } from '../settings';
import { getProviderForModel, PROVIDER_CONFIGS, getGlmBaseUrl } from './providers';

export { getProviderForModel };

export interface StreamConfig {
  provider: Provider;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Get gg-ai stream configuration for the given model.
 * Returns { provider, apiKey, baseUrl } matching StreamOptions fields.
 */
export async function getStreamConfig(model: string): Promise<StreamConfig> {
  const providerType = getProviderForModel(model);
  const config = PROVIDER_CONFIGS[providerType];

  if (providerType === 'moonshot') {
    const apiKey = SettingsManager.get('moonshot.apiKey');
    if (!apiKey) {
      throw new Error('Moonshot API key not configured. Please add your key in Settings > Keys.');
    }
    return { provider: 'moonshot', apiKey, baseUrl: config.baseUrl };
  }

  if (providerType === 'glm') {
    const apiKey = SettingsManager.get('glm.apiKey');
    if (!apiKey) {
      throw new Error('Z.AI GLM API key not configured. Please add your key in Settings > LLM.');
    }
    return { provider: 'glm', apiKey, baseUrl: getGlmBaseUrl() };
  }

  // Anthropic provider
  const apiKey = SettingsManager.get('anthropic.apiKey');
  if (apiKey) {
    return { provider: 'anthropic', apiKey };
  }

  // Check for OAuth
  const authMethod = SettingsManager.get('auth.method');
  if (authMethod === 'oauth') {
    const { ClaudeOAuth } = await import('../auth/oauth');
    const token = await ClaudeOAuth.getAccessToken();
    if (token) {
      return { provider: 'anthropic', apiKey: token };
    }
    throw new Error('OAuth session expired. Please re-authenticate in Settings.');
  }

  throw new Error('No API key configured. Please add your key in Settings.');
}
