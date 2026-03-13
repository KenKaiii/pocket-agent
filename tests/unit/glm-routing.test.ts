/**
 * Tests for GLM/non-Anthropic provider routing in coder mode.
 *
 * Verifies that non-Anthropic models (GLM, Moonshot) are routed through the
 * ChatEngine instead of the Claude Agent SDK, which only speaks Anthropic protocol.
 */

import { describe, it, expect } from 'vitest';
import { getProviderForModel, MODEL_PROVIDERS } from '../../src/agent/providers';

describe('GLM Provider Routing', () => {
  describe('getProviderForModel', () => {
    it('should return "glm" for glm-5', () => {
      expect(getProviderForModel('glm-5')).toBe('glm');
    });

    it('should return "glm" for glm-4.7', () => {
      expect(getProviderForModel('glm-4.7')).toBe('glm');
    });

    it('should return "moonshot" for kimi-k2.5', () => {
      expect(getProviderForModel('kimi-k2.5')).toBe('moonshot');
    });

    it('should return "anthropic" for claude models', () => {
      expect(getProviderForModel('claude-opus-4-6')).toBe('anthropic');
      expect(getProviderForModel('claude-sonnet-4-6')).toBe('anthropic');
      expect(getProviderForModel('claude-haiku-4-5-20251001')).toBe('anthropic');
    });

    it('should default to "anthropic" for unknown models', () => {
      expect(getProviderForModel('unknown-model')).toBe('anthropic');
    });
  });

  describe('ChatEngine routing logic', () => {
    // Simulates the routing condition in AgentManager.processMessage():
    //   const useChatEngine = sessionMode === 'general' || provider !== 'anthropic';
    function shouldUseChatEngine(
      model: string,
      sessionMode: 'general' | 'coder'
    ): boolean {
      const provider = getProviderForModel(model);
      return sessionMode === 'general' || provider !== 'anthropic';
    }

    it('should route GLM coder sessions through ChatEngine', () => {
      expect(shouldUseChatEngine('glm-5', 'coder')).toBe(true);
      expect(shouldUseChatEngine('glm-4.7', 'coder')).toBe(true);
    });

    it('should route Moonshot coder sessions through ChatEngine', () => {
      expect(shouldUseChatEngine('kimi-k2.5', 'coder')).toBe(true);
    });

    it('should route Anthropic coder sessions through SDK (not ChatEngine)', () => {
      expect(shouldUseChatEngine('claude-opus-4-6', 'coder')).toBe(false);
      expect(shouldUseChatEngine('claude-sonnet-4-6', 'coder')).toBe(false);
    });

    it('should route all general sessions through ChatEngine', () => {
      expect(shouldUseChatEngine('claude-opus-4-6', 'general')).toBe(true);
      expect(shouldUseChatEngine('glm-5', 'general')).toBe(true);
      expect(shouldUseChatEngine('kimi-k2.5', 'general')).toBe(true);
    });
  });

  describe('MODEL_PROVIDERS mapping completeness', () => {
    it('should have entries for all GLM models', () => {
      expect(MODEL_PROVIDERS['glm-5']).toBe('glm');
      expect(MODEL_PROVIDERS['glm-4.7']).toBe('glm');
    });

    it('should not have GLM models mapped to anthropic', () => {
      for (const [model, provider] of Object.entries(MODEL_PROVIDERS)) {
        if (model.startsWith('glm-')) {
          expect(provider).toBe('glm');
        }
      }
    });
  });
});
