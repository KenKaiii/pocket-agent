/**
 * Shared provider configuration for LLM backends.
 * Single source of truth — imported by both coder mode (agent/index.ts)
 * and general/chat mode (chat-providers.ts).
 */

import { SettingsManager } from '../settings';

export type ProviderType = 'anthropic' | 'moonshot' | 'glm';

export interface ProviderConfig {
  baseUrl?: string;
}

// Z.AI GLM endpoints:
// - Standard (pay-as-you-go): https://api.z.ai/api/paas/v4
// - Coding Plan (subscription): https://api.z.ai/api/coding/paas/v4
const GLM_STANDARD_URL = 'https://api.z.ai/api/paas/v4';
const GLM_CODING_PLAN_URL = 'https://api.z.ai/api/coding/paas/v4';

export function getGlmBaseUrl(): string {
  const isCodingPlan = SettingsManager.getBoolean('glm.codingPlan');
  return isCodingPlan ? GLM_CODING_PLAN_URL : GLM_STANDARD_URL;
}

export const PROVIDER_CONFIGS: Record<ProviderType, ProviderConfig> = {
  anthropic: {
    // No baseUrl = uses default Anthropic endpoint
  },
  moonshot: {
    // No baseUrl = uses gg-ai default (https://api.moonshot.ai/v1)
  },
  glm: {
    // baseUrl is dynamic — use getGlmBaseUrl() instead of config.baseUrl for GLM
    baseUrl: GLM_STANDARD_URL,
  },
};

// Model to provider mapping
export const MODEL_PROVIDERS: Record<string, ProviderType> = {
  // Anthropic models
  'claude-opus-4-6': 'anthropic',
  'claude-opus-4-5-20251101': 'anthropic',
  'claude-sonnet-4-6': 'anthropic',
  'claude-haiku-4-5-20251001': 'anthropic',
  // Moonshot/Kimi models
  'kimi-k2.5': 'moonshot',
  // Z.AI GLM models
  'glm-5': 'glm',
  'glm-4.7': 'glm',
};

export function getProviderForModel(model: string): ProviderType {
  return MODEL_PROVIDERS[model] || 'anthropic';
}
