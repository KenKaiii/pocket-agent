/**
 * End-to-end test: GLM model in coder mode routes through ChatEngine.
 *
 * Verifies that when a GLM model is selected and the session is in coder mode,
 * the message goes through ChatEngine (which uses @kenkaiiii/gg-agent with
 * OpenAI-compatible API) instead of the Claude Agent SDK (Anthropic-only).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Track which engine processes the message
let chatEngineProcessed = false;

// ── Mock gg-agent (ChatEngine's dependency) ────────────────────────
vi.mock('@kenkaiiii/gg-agent', () => ({
  agentLoop: vi.fn(function* () {
    chatEngineProcessed = true;
    yield { type: 'text_delta', text: 'Hello from GLM!' };
    yield {
      type: 'turn_end',
      turn: 1,
      usage: { inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheWrite: 0 },
    };
    yield {
      type: 'agent_done',
      totalTurns: 1,
      totalUsage: { inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheWrite: 0 },
    };
  }),
}));

vi.mock('@kenkaiiii/gg-ai', () => ({
  stream: vi.fn(),
}));

// ── Mock settings ──────────────────────────────────────────────────
vi.mock('../../src/settings', () => ({
  SettingsManager: {
    get: vi.fn((key: string) => {
      if (key === 'agent.model') return 'glm-5';
      if (key === 'agent.mode') return 'coder';
      if (key === 'agent.thinkingLevel') return 'normal';
      if (key === 'glm.apiKey') return 'test-glm-key';
      return undefined;
    }),
    set: vi.fn(),
    getFormattedIdentity: vi.fn(() => ''),
    getFormattedUserContext: vi.fn(() => ''),
    getFormattedProfile: vi.fn(() => ''),
  },
}));

// ── Mock other dependencies ────────────────────────────────────────
vi.mock('../../src/memory', () => {
  class MockMemoryManager {
    saveMessage = vi.fn(() => 1);
    getRecentMessages = vi.fn(() => []);
    getSessionMode = vi.fn(() => 'coder');
    getSessionMessageCount = vi.fn(() => 0);
    getFactsForContext = vi.fn(() => '');
    getSoulContext = vi.fn(() => '');
    getDailyLogsContext = vi.fn(() => '');
    getStats = vi.fn(() => ({ messageCount: 0, factCount: 0, estimatedTokens: 0 }));
    getSessions = vi.fn(() => []);
    embedRecentMessages = vi.fn(async () => 0);
    embedMessage = vi.fn(async () => {});
    setSummarizer = vi.fn();
    getSdkSessionId = vi.fn(() => null);
    clearSdkSessionId = vi.fn();
    setSdkSessionId = vi.fn();
    getSessionWorkingDirectory = vi.fn(() => null);
    close = vi.fn();
  }
  return {
    MemoryManager: MockMemoryManager,
  };
});

vi.mock('../../src/memory/embeddings', () => ({
  initEmbeddings: vi.fn(),
  hasEmbeddings: vi.fn(() => false),
  embed: vi.fn(),
  cosineSimilarity: vi.fn(),
  serializeEmbedding: vi.fn(),
  deserializeEmbedding: vi.fn(),
}));

vi.mock('../../src/config/system-guidelines', () => ({
  SYSTEM_GUIDELINES: 'Test guidelines',
}));

vi.mock('../../src/agent/chat-providers', () => ({
  getStreamConfig: vi.fn(async () => ({
    provider: 'glm',
    apiKey: 'test-glm-key',
    baseUrl: 'https://api.z.ai/api/paas/v4',
  })),
  getProviderForModel: vi.fn((model: string) => {
    if (model.startsWith('glm-')) return 'glm';
    if (model.startsWith('kimi-')) return 'moonshot';
    return 'anthropic';
  }),
}));

vi.mock('../../src/agent/chat-tools', () => ({
  getChatAgentTools: vi.fn(() => []),
  getServerTools: vi.fn(() => []),
}));

vi.mock('../../src/tools', () => ({
  getCustomTools: vi.fn(() => []),
  buildMCPServers: vi.fn(() => ({})),
  buildSdkMcpServers: vi.fn(async () => ({})),
  setMemoryManager: vi.fn(),
  setSoulMemoryManager: vi.fn(),
  validateToolsConfig: vi.fn(() => ({ valid: true, errors: [] })),
  getCurrentSessionId: vi.fn(() => 'test-session'),
  setCurrentSessionId: vi.fn(),
  runWithSessionId: vi.fn((_sid: string, fn: () => unknown) => fn()),
}));

vi.mock('../../src/browser', () => ({
  closeBrowserManager: vi.fn(),
}));

vi.mock('../../src/agent/safety', () => ({
  buildCanUseToolCallback: vi.fn(() => vi.fn()),
  buildPreToolUseHook: vi.fn(() => ({ hooks: [] })),
  setStatusEmitter: vi.fn(),
}));

vi.mock('../../src/agent/persistent-session', () => ({
  PersistentSDKSession: vi.fn(),
}));

describe('GLM Coder Mode E2E', () => {
  beforeEach(() => {
    chatEngineProcessed = false;
    vi.clearAllMocks();
  });

  it('should route GLM coder messages through ChatEngine (not Claude SDK)', async () => {
    // Import after mocks are set up
    const { ChatEngine } = await import('../../src/agent/chat-engine');
    const { MemoryManager } = await import('../../src/memory');

    const memory = new MemoryManager(':memory:');
    const statusEvents: Array<{ type: string }> = [];

    const engine = new ChatEngine({
      memory: memory as any,
      toolsConfig: {
        browser: { enabled: false },
        memory: { enabled: false },
        system: { enabled: false },
      } as any,
      statusEmitter: (status: any) => statusEvents.push(status),
    });

    const result = await engine.processMessage('Write a hello world script', 'desktop', 'test-session');

    // Verify ChatEngine processed the message
    expect(chatEngineProcessed).toBe(true);
    expect(result.response).toBe('Hello from GLM!');
    expect(result.tokensUsed).toBeGreaterThan(0);

    // Verify status events were emitted
    const statusTypes = statusEvents.map((e) => e.type);
    expect(statusTypes).toContain('thinking');
    expect(statusTypes).toContain('done');
  });
});
