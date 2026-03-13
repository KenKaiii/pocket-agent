import { MemoryManager, Message, DailyLog } from '../memory';
import {
  buildMCPServers,
  buildSdkMcpServers,
  setMemoryManager,
  setSoulMemoryManager,
  ToolsConfig,
  validateToolsConfig,
  getCurrentSessionId,
} from '../tools';
import { closeBrowserManager } from '../browser';
import { SYSTEM_GUIDELINES } from '../config/system-guidelines';
import { SettingsManager } from '../settings';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildCanUseToolCallback, buildPreToolUseHook, setStatusEmitter } from './safety';
import { PersistentSDKSession, TurnResult } from './persistent-session';
import { ChatEngine } from './chat-engine';
import { PROVIDER_CONFIGS, getProviderForModel } from './providers';

/**
 * Build provider-specific environment variables for the selected model.
 * Returns a partial env object to merge — does NOT mutate process.env,
 * avoiding race conditions when multiple sessions configure concurrently.
 */
async function buildProviderEnv(model: string): Promise<Record<string, string | undefined>> {
  const provider = getProviderForModel(model);
  const config = PROVIDER_CONFIGS[provider];

  // Start with cleared provider vars
  const env: Record<string, string | undefined> = {
    ANTHROPIC_BASE_URL: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  };

  if (provider === 'moonshot') {
    const moonshotKey = SettingsManager.get('moonshot.apiKey');
    if (!moonshotKey) {
      throw new Error('Moonshot API key not configured. Please add your key in Settings > Keys.');
    }
    env.ANTHROPIC_BASE_URL = config.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = moonshotKey;
    env.ANTHROPIC_API_KEY = moonshotKey;
    console.log('[AgentManager] Provider configured: Moonshot (Kimi)');
  } else if (provider === 'glm') {
    const glmKey = SettingsManager.get('glm.apiKey');
    if (!glmKey) {
      throw new Error('Z.AI GLM API key not configured. Please add your key in Settings > LLM.');
    }
    env.ANTHROPIC_BASE_URL = config.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = glmKey;
    env.ANTHROPIC_API_KEY = glmKey;
    console.log('[AgentManager] Provider configured: Z.AI GLM');
  } else {
    // Anthropic provider
    const anthropicKey = SettingsManager.get('anthropic.apiKey');
    if (anthropicKey) {
      env.ANTHROPIC_API_KEY = anthropicKey;
    } else {
      const authMethod = SettingsManager.get('auth.method');
      if (authMethod === 'oauth') {
        const { ClaudeOAuth } = await import('../auth/oauth');
        const freshToken = await ClaudeOAuth.getAccessToken();
        if (freshToken) {
          env.CLAUDE_CODE_OAUTH_TOKEN = freshToken;
          env.ANTHROPIC_API_KEY = undefined;
          env.ANTHROPIC_AUTH_TOKEN = undefined;
          console.log('[AgentManager] Using OAuth token for Anthropic auth');
        } else {
          throw new Error('OAuth session expired. Please re-authenticate in Settings.');
        }
      } else {
        throw new Error('No API key configured. Please add your key in Settings.');
      }
    }
    console.log('[AgentManager] Provider configured: Anthropic');
  }

  return env;
}

/**
 * Map SDK/API error strings to human-readable messages.
 * No "Error:" prefix — display layers add their own (red bubble in UI, "Error:" in Telegram).
 * Covers Anthropic, Moonshot (Kimi), GLM (Z.AI), and common SDK errors.
 *
 * Errors that indicate potential app bugs (server, session, timeout, unknown)
 * get a developer-report hint appended. User-side errors (auth, billing, rate limit,
 * network, model config) do not.
 */
const REPORT_HINT = '\n\nIf this keeps happening, send this error to the developer.';

function reportable(msg: string): string {
  return msg + REPORT_HINT;
}

function formatAgentError(error: string): string {
  const e = error.toLowerCase();

  // Authentication errors (all providers)
  if (
    e.includes('authentication_failed') ||
    e.includes('invalid x-api-key') ||
    e.includes('invalid api key') ||
    e.includes('unauthorized') ||
    e.includes('invalid token') ||
    e.includes('token expired') ||
    (e.includes('auth') && e.includes('fail'))
  ) {
    return 'Invalid API key. Please check your key in Settings. [authentication_failed]';
  }

  // Billing / quota errors (all providers)
  if (
    e.includes('billing_error') ||
    e.includes('insufficient') ||
    e.includes('credit') ||
    e.includes('payment') ||
    e.includes('quota') ||
    e.includes('exceeded') ||
    e.includes('balance')
  ) {
    return 'Billing issue — your account may have run out of credits. Check your provider dashboard. [billing_error]';
  }

  // Rate limiting (all providers — Anthropic 429, Moonshot/GLM rate limits)
  if (
    e.includes('rate_limit') ||
    e.includes('too many requests') ||
    e.includes('overloaded') ||
    e.includes('throttl') ||
    e.includes('concurrency') ||
    e.includes('capacity')
  ) {
    return 'Rate limited — too many requests. Wait a moment and try again. [rate_limit]';
  }

  // Model / request errors
  if (e.includes('invalid_request') && !e.includes('key')) {
    return `Invalid request — ${error} [invalid_request]`;
  }
  if (e.includes('max_output_tokens') || e.includes('max tokens') || e.includes('output limit')) {
    return 'Response exceeded maximum token limit. Try a simpler request. [max_output_tokens]';
  }
  if (
    e.includes('context') &&
    (e.includes('too long') || e.includes('exceed') || e.includes('limit'))
  ) {
    return 'Message too long for model context window. Try a shorter message or start a new session. [context_overflow]';
  }
  if (
    e.includes('model') &&
    (e.includes('not found') ||
      e.includes('not available') ||
      e.includes('does not exist') ||
      e.includes('not support'))
  ) {
    return `Model not available — ${error}. Check Settings > Model. [model_not_found]`;
  }

  // Server errors (all providers)
  if (
    e.includes('server_error') ||
    e.includes('internal server') ||
    e.includes('bad gateway') ||
    e.includes('service unavailable') ||
    e.includes('temporarily')
  ) {
    return reportable(
      'API server error. The provider may be experiencing issues — try again shortly. [server_error]'
    );
  }

  // Network errors — user-side, no report needed
  if (
    e.includes('econnrefused') ||
    e.includes('enotfound') ||
    e.includes('etimedout') ||
    e.includes('econnreset') ||
    e.includes('epipe') ||
    e.includes('fetch failed') ||
    e.includes('network') ||
    e.includes('dns') ||
    e.includes('socket hang up')
  ) {
    return 'Network error — cannot reach the API. Check your internet connection. [network_error]';
  }

  // Session errors — include the underlying reason so the developer can debug
  if (
    e.includes('session error') ||
    e.includes('session closed') ||
    e.includes('session not alive')
  ) {
    // Extract the underlying error from "Session error: <reason>"
    const reasonMatch = error.match(/Session error:\s*(.+)/i);
    const reason = reasonMatch ? reasonMatch[1] : error;
    return reportable(`Agent session crashed: ${reason} [session_error]`);
  }

  // Timeout — could indicate app issue
  if (e.includes('timed out') || e.includes('timeout')) {
    return reportable('Request timed out. Try again or use a simpler prompt. [timeout]');
  }

  // Permission denied (SDK tool use)
  if (e.includes('permission') && e.includes('denied')) {
    return `Permission denied — ${error} [permission_denied]`;
  }

  // Fallback — unknown error, developer should know
  return reportable(error);
}

// Status event types
export type AgentStatus = {
  type:
    | 'thinking'
    | 'tool_start'
    | 'tool_end'
    | 'tool_blocked'
    | 'responding'
    | 'done'
    | 'subagent_start'
    | 'subagent_update'
    | 'subagent_end'
    | 'queued'
    | 'queue_processing'
    | 'teammate_start'
    | 'teammate_idle'
    | 'teammate_message'
    | 'task_completed'
    | 'background_task_start'
    | 'background_task_output'
    | 'background_task_end'
    | 'partial_text'
    | 'plan_mode_entered'
    | 'plan_mode_exited';
  sessionId?: string;
  toolName?: string;
  toolInput?: string;
  message?: string;
  // Partial text preview (streamed as agent composes)
  partialText?: string;
  // If true, partialText is the full accumulated text (replace, don't append)
  partialReplace?: boolean;
  // Subagent tracking
  agentId?: string;
  agentType?: string;
  agentCount?: number; // Number of active subagents
  // Queue tracking
  queuePosition?: number;
  queuedMessage?: string;
  // Safety blocking
  blockedReason?: string;
  // Pocket CLI indicator
  isPocketCli?: boolean;
  // Team tracking
  teammateName?: string;
  teamName?: string;
  taskId?: string;
  taskSubject?: string;
  // Background task tracking
  backgroundTaskId?: string;
  backgroundTaskDescription?: string;
  backgroundTaskCount?: number;
};

// SDK types (loaded dynamically)
type SDKQuery = AsyncGenerator<unknown, void>;
type CanUseToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string }
) => Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string; interrupt: boolean }>;
type PreToolUseHookCallback = (input: { tool_name: string; tool_input: unknown }) => Promise<{
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}>;
// Hook callback types for team events
type TeammateIdleHookCallback = (input: { teammate_name: string; team_name: string }) => Promise<{
  hookSpecificOutput: {
    hookEventName: 'TeammateIdle';
  };
}>;
type TaskCompletedHookCallback = (input: {
  task_id: string;
  task_subject: string;
  task_description?: string;
  teammate_name?: string;
  team_name?: string;
}) => Promise<{
  hookSpecificOutput: {
    hookEventName: 'TaskCompleted';
  };
}>;

type UserPromptSubmitHookCallback = (
  input: any,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<{
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit';
    additionalContext?: string;
  };
}>;

// Thinking config type (replaces deprecated maxThinkingTokens)
type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' };

type SDKOptions = {
  model?: string;
  cwd?: string;
  maxTurns?: number;
  maxThinkingTokens?: number; // deprecated — kept for non-Anthropic providers
  thinking?: ThinkingConfig;
  effort?: 'low' | 'medium' | 'high' | 'max';
  abortController?: AbortController;
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  allowedTools?: string[];
  persistSession?: boolean;
  resume?: string; // SDK session ID to resume
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  mcpServers?: Record<string, unknown>;
  settingSources?: ('project' | 'user')[];
  canUseTool?: CanUseToolCallback; // Pre-tool-use validation callback
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  env?: { [envVar: string]: string | undefined }; // Environment variables for Claude Code process
  hooks?: {
    PreToolUse?: Array<{ hooks: PreToolUseHookCallback[] }>;
    UserPromptSubmit?: Array<{ hooks: UserPromptSubmitHookCallback[] }>;
    TeammateIdle?: Array<{ hooks: TeammateIdleHookCallback[] }>;
    TaskCompleted?: Array<{ hooks: TaskCompletedHookCallback[] }>;
  };
};

// Thinking level to config mapping.
// For Opus 4.6: the CLI always forces adaptive thinking regardless of budget tokens,
// so the `effort` parameter is the proper way to control thinking depth.
// For other models: budget tokens are enforced via the `thinking` option.
const THINKING_CONFIGS: Record<
  string,
  { thinking: ThinkingConfig; effort?: 'low' | 'medium' | 'high' }
> = {
  none: { thinking: { type: 'disabled' } },
  minimal: { thinking: { type: 'enabled', budgetTokens: 2048 }, effort: 'low' },
  normal: { thinking: { type: 'enabled', budgetTokens: 10000 }, effort: 'medium' },
  extended: { thinking: { type: 'adaptive' }, effort: 'high' },
};

// Image content for multimodal messages
export interface ImageContent {
  type: 'base64';
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string; // base64 encoded
}

// Attachment info for tracking attachments in metadata
export interface AttachmentInfo {
  hasAttachment: boolean;
  attachmentType?: 'photo' | 'voice' | 'audio' | 'document' | 'location';
}

// Content block types for SDK
type TextBlock = { type: 'text'; text: string };
type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
type ContentBlock = TextBlock | ImageBlock;

// SDK User Message type for async iterable
interface SDKUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string | ContentBlock[];
  };
  parent_tool_use_id: string | null;
  session_id: string;
}

// Dynamic SDK loader - prompt can be string or async iterable of messages
let sdkQuery:
  | ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: SDKOptions }) => SDKQuery)
  | null = null;

// Use Function to preserve native import() - TypeScript converts import() to require() in CommonJS
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<unknown>;

async function loadSDK(): Promise<typeof sdkQuery> {
  if (!sdkQuery) {
    const sdk = (await dynamicImport('@anthropic-ai/claude-agent-sdk')) as {
      query: typeof sdkQuery;
    };
    sdkQuery = sdk.query;
  }
  return sdkQuery;
}

export interface AgentConfig {
  memory: MemoryManager;
  projectRoot?: string;
  workspace?: string; // Isolated working directory for agent file operations
  dataDir?: string; // App data directory (e.g. ~/Library/Application Support/pocket-agent)
  model?: string;
  tools?: ToolsConfig;
}

export interface MediaAttachment {
  type: 'image';
  filePath: string; // absolute path on disk
  mimeType: string; // e.g. 'image/png'
}

export interface ProcessResult {
  response: string;
  tokensUsed: number;
  wasCompacted: boolean;
  suggestedPrompt?: string;
  contextTokens?: number;
  contextWindow?: number;
  media?: MediaAttachment[];
  planPending?: boolean;
}

/**
 * AgentManager - Singleton wrapper around Claude Agent SDK
 */
class AgentManagerClass extends EventEmitter {
  private static instance: AgentManagerClass | null = null;
  private memory: MemoryManager | null = null;
  private projectRoot: string = process.cwd();
  private workspace: string = process.cwd(); // Isolated working directory for agent
  private model: string = 'claude-opus-4-6';
  private mode: 'general' | 'coder' = 'coder';
  private chatEngine: ChatEngine | null = null;
  private toolsConfig: ToolsConfig | null = null;
  private initialized: boolean = false;
  private abortControllersBySession: Map<string, AbortController> = new Map();
  private processingBySession: Map<string, boolean> = new Map();
  private lastSuggestedPromptBySession: Map<string, string | undefined> = new Map();
  private messageQueueBySession: Map<
    string,
    Array<{
      message: string;
      channel: string;
      images?: ImageContent[];
      attachmentInfo?: AttachmentInfo;
      resolve: (result: ProcessResult) => void;
      reject: (error: Error) => void;
    }>
  > = new Map();
  private sdkSessionIdBySession: Map<string, string> = new Map();
  private persistentSessions: Map<string, PersistentSDKSession> = new Map();
  private contextUsageBySession: Map<string, { contextTokens: number; contextWindow: number }> =
    new Map();
  private pendingMediaBySession: Map<string, MediaAttachment[]> = new Map();
  private stoppedByUserSession: Set<string> = new Set();
  private sdkToolTimers: Map<string, { timer: ReturnType<typeof setTimeout>; sessionId: string }> =
    new Map();
  private pendingProjectSwitch: Set<string> = new Set();

  // Per-tool timeouts for SDK built-in tools (MCP tools have their own via wrapToolHandler)
  private static readonly SDK_TOOL_TIMEOUTS: Record<string, number> = {
    Bash: 120_000, // 2 min — commands can be long-running
    Read: 15_000,
    Write: 15_000,
    Edit: 15_000,
    Glob: 15_000,
    Grep: 30_000, // large codebases
    WebSearch: 30_000,
    WebFetch: 45_000,
    Task: 300_000, // 5 min — subagent work
  };
  private static readonly SDK_TOOL_DEFAULT_TIMEOUT = 60_000; // 1 min default

  private constructor() {
    super();
  }

  static getInstance(): AgentManagerClass {
    if (!AgentManagerClass.instance) {
      AgentManagerClass.instance = new AgentManagerClass();
    }
    return AgentManagerClass.instance;
  }

  initialize(config: AgentConfig): void {
    this.memory = config.memory;
    this.projectRoot = config.projectRoot || process.cwd();
    this.workspace = config.workspace || this.projectRoot;
    this.model = config.model || 'claude-opus-4-6';
    this.toolsConfig = config.tools || null;
    this.initialized = true;

    // Isolate SDK session storage from global Claude Code installation
    if (config.dataDir) {
      process.env.CLAUDE_CONFIG_DIR = path.join(config.dataDir, '.claude');
    }

    setMemoryManager(this.memory);
    setSoulMemoryManager(this.memory);

    // Set up safety status emitter for UI feedback on blocked tools
    setStatusEmitter((status) => {
      this.emitStatus(status);
    });

    console.log('[AgentManager] Initialized');
    console.log('[AgentManager] Project root:', this.projectRoot);
    console.log('[AgentManager] Workspace:', this.workspace);
    console.log('[AgentManager] Model:', this.model);

    if (this.toolsConfig) {
      const validation = validateToolsConfig(this.toolsConfig);
      if (!validation.valid) {
        console.warn('[AgentManager] Tool config issues:', validation.errors);
      }

      if (this.toolsConfig.browser.enabled) {
        console.log('[AgentManager] Browser: 2-tier (Electron, CDP)');
      }
    }

    // Instantiate Chat engine for General mode
    if (this.toolsConfig) {
      this.chatEngine = new ChatEngine({
        memory: this.memory,
        toolsConfig: this.toolsConfig,
        statusEmitter: (status) => this.emitStatus(status),
      });
      console.log('[AgentManager] Chat engine initialized');
    }

    // Read persisted mode from settings
    const savedMode = SettingsManager.get('agent.mode');
    if (savedMode === 'general' || savedMode === 'coder') {
      this.mode = savedMode;
      console.log('[AgentManager] Mode:', this.mode);
    }

    // Backfill message embeddings asynchronously (for semantic retrieval)
    this.backfillMessageEmbeddings().catch((e) => {
      console.error('[AgentManager] Embedding backfill failed:', e);
    });
  }

  /**
   * Backfill embeddings for messages that don't have them yet.
   * Runs asynchronously in the background during initialization.
   */
  private async backfillMessageEmbeddings(): Promise<void> {
    if (!this.memory) return;

    // Get all sessions and backfill each
    const sessions = this.memory.getSessions();
    for (const session of sessions) {
      const embedded = await this.memory.embedRecentMessages(session.id, 100);
      if (embedded > 0) {
        console.log(`[AgentManager] Backfilled ${embedded} embeddings for session ${session.id}`);
      }
    }
  }

  isInitialized(): boolean {
    return this.initialized && this.memory !== null;
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
    SettingsManager.set('agent.model', model);
    console.log('[AgentManager] Model changed to:', model);

    // Update model on all live persistent sessions
    for (const [sid, session] of this.persistentSessions.entries()) {
      if (session.isAlive()) {
        session.setModel(model).catch((err) => {
          console.error(`[AgentManager] Failed to set model on session ${sid}:`, err);
        });
      }
    }

    this.emit('model:changed', model);
  }

  getMode(): 'general' | 'coder' {
    return this.mode;
  }

  setMode(mode: 'general' | 'coder'): void {
    if (this.mode === mode) return;
    const previousMode = this.mode;
    this.mode = mode;
    console.log(`[AgentManager] Default mode changed: ${previousMode} -> ${mode}`);
    this.emit('mode:changed', mode);
  }

  async processMessage(
    userMessage: string,
    channel: string = 'default',
    sessionId: string = 'default',
    images?: ImageContent[],
    attachmentInfo?: AttachmentInfo
  ): Promise<ProcessResult> {
    if (!this.memory) {
      throw new Error('AgentManager not initialized - call initialize() first');
    }

    // Route by per-session mode (not global mode)
    const sessionMode = this.memory.getSessionMode(sessionId);
    // Non-Anthropic providers (GLM, Moonshot) use OpenAI-compatible APIs that the
    // Claude Agent SDK can't speak. Route them through the ChatEngine regardless of
    // session mode so they hit the correct /chat/completions endpoint.
    const provider = getProviderForModel(this.model);
    const useChatEngine = sessionMode === 'general' || provider !== 'anthropic';
    if (useChatEngine && this.chatEngine) {
      const result = await this.chatEngine.processMessage(
        userMessage,
        channel,
        sessionId,
        images,
        attachmentInfo
      );
      // Store context usage for stats display
      if (result.contextTokens !== undefined || result.contextWindow !== undefined) {
        this.contextUsageBySession.set(sessionId, {
          contextTokens: result.contextTokens ?? 0,
          contextWindow: result.contextWindow ?? 0,
        });
      }
      return result;
    }

    // If already processing, queue the message
    if (this.processingBySession.get(sessionId)) {
      return this.queueMessage(userMessage, channel, sessionId, images, attachmentInfo);
    }

    return this.executeMessage(userMessage, channel, sessionId, images, attachmentInfo);
  }

  /**
   * Queue a message to be processed after the current one finishes
   */
  private queueMessage(
    userMessage: string,
    channel: string,
    sessionId: string,
    images?: ImageContent[],
    attachmentInfo?: AttachmentInfo
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      // Get or create queue for this session
      if (!this.messageQueueBySession.has(sessionId)) {
        this.messageQueueBySession.set(sessionId, []);
      }
      const queue = this.messageQueueBySession.get(sessionId)!;

      // Add to queue
      queue.push({ message: userMessage, channel, images, attachmentInfo, resolve, reject });

      const queuePosition = queue.length;
      console.log(
        `[AgentManager] Message queued at position ${queuePosition} for session ${sessionId}`
      );

      // Emit queued status
      this.emitStatus({
        type: 'queued',
        sessionId,
        queuePosition,
        queuedMessage: userMessage.slice(0, 100),
        message: `in the litter queue (#${queuePosition})`,
      });
    });
  }

  /**
   * Process the next message in the queue for a session
   */
  private async processQueue(sessionId: string): Promise<void> {
    const queue = this.messageQueueBySession.get(sessionId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift()!;
    console.log(
      `[AgentManager] Processing queued message for session ${sessionId}, ${queue.length} remaining`
    );

    // Emit status that we're processing a queued message
    this.emitStatus({
      type: 'queue_processing',
      sessionId,
      queuedMessage: next.message.slice(0, 100),
      message: 'digging it up now...',
    });

    try {
      const result = await this.executeMessage(
        next.message,
        next.channel,
        sessionId,
        next.images,
        next.attachmentInfo
      );
      next.resolve(result);
    } catch (error) {
      next.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Actually execute a message (internal implementation)
   * Uses persistent sessions: first message creates a Query, subsequent messages
   * use streamInput() to keep the subprocess alive (preserving background tasks).
   */
  private async executeMessage(
    userMessage: string,
    channel: string,
    sessionId: string,
    images?: ImageContent[],
    attachmentInfo?: AttachmentInfo
  ): Promise<ProcessResult> {
    // Memory should already be checked by processMessage, but guard anyway
    if (!this.memory) {
      throw new Error('AgentManager not initialized - call initialize() first');
    }

    const memory = this.memory; // Local reference for TypeScript narrowing

    this.processingBySession.set(sessionId, true);
    this.stoppedByUserSession.delete(sessionId);
    this.lastSuggestedPromptBySession.set(sessionId, undefined);
    this.pendingMediaBySession.set(sessionId, []);

    try {
      const existingSession = this.persistentSessions.get(sessionId);
      let turnResult: TurnResult;
      let hadSdkSessionBeforeStart = false;

      if (existingSession?.isAlive()) {
        // === Existing session: send via streamInput ===
        console.log(`[AgentManager] Sending to existing persistent session: ${sessionId}`);
        this.lastPartialTextBySession.delete(sessionId);
        this.emitStatus({ type: 'thinking', sessionId, message: '*stretches paws* thinking...' });

        // Build content blocks for images
        const contentBlocks =
          images && images.length > 0
            ? [
                { type: 'text' as const, text: userMessage },
                ...images.map((img) => ({
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: img.mediaType,
                    data: img.data,
                  },
                })),
              ]
            : undefined;

        turnResult = await existingSession.send(userMessage, contentBlocks);
      } else {
        // === New session: create Query with first message ===
        // Clean up dead session if present
        if (existingSession) {
          this.persistentSessions.delete(sessionId);
        }

        // Look up SDK session for resume (in-memory cache first, then DB)
        let sdkSessionId =
          this.sdkSessionIdBySession.get(sessionId) ||
          memory.getSdkSessionId(sessionId) ||
          undefined;
        hadSdkSessionBeforeStart = !!sdkSessionId;

        if (sdkSessionId) {
          console.log(`[AgentManager] Resuming SDK session: ${sdkSessionId}`);
        } else {
          console.log('[AgentManager] Starting new persistent SDK session');
        }

        const queryFn = await loadSDK();
        if (!queryFn) throw new Error('Failed to load SDK');

        // Build options with dynamic context
        const options = await this.buildPersistentOptions(memory, sessionId, sdkSessionId);

        console.log(
          '[AgentManager] Calling query() with model:',
          options.model,
          'thinking:',
          JSON.stringify(options.thinking) || 'default',
          'effort:',
          options.effort || 'default'
        );
        this.lastPartialTextBySession.delete(sessionId);
        this.emitStatus({ type: 'thinking', sessionId, message: '*stretches paws* thinking...' });

        // Create persistent session
        const session = new PersistentSDKSession(
          sessionId,
          (msg) => this.processStatusFromMessage(msg),
          (msg, current) => this.extractFromMessage(msg, current, sessionId)
        );

        this.setupSessionListeners(session, sessionId, memory);

        this.persistentSessions.set(sessionId, session);

        // Build content blocks for images (if any)
        const firstContentBlocks: ContentBlock[] | undefined =
          images && images.length > 0
            ? [
                { type: 'text' as const, text: userMessage },
                ...images.map((img) => ({
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: img.mediaType,
                    data: img.data,
                  },
                })),
              ]
            : undefined;

        if (firstContentBlocks) {
          console.log(`[AgentManager] Starting persistent session with ${images!.length} image(s)`);
        }

        try {
          turnResult = await session.start(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            queryFn as any,
            userMessage,
            options as unknown as Record<string, unknown>,
            firstContentBlocks
          );
        } catch (startError) {
          // If resume failed (corrupted/missing SDK session), retry without resume
          if (sdkSessionId) {
            const errMsg = startError instanceof Error ? startError.message : String(startError);
            console.warn(`[AgentManager] Resume failed (${errMsg}), retrying without resume...`);
            sdkSessionId = undefined;
            this.sdkSessionIdBySession.delete(sessionId);
            memory.clearSdkSessionId(sessionId);

            // Clean up failed session
            session.close();
            this.persistentSessions.delete(sessionId);

            // Create new session without resume
            const freshOptions = await this.buildPersistentOptions(memory, sessionId, undefined);
            const freshSession = new PersistentSDKSession(
              sessionId,
              (msg) => this.processStatusFromMessage(msg),
              (msg, current) => this.extractFromMessage(msg, current, sessionId)
            );

            this.setupSessionListeners(freshSession, sessionId, memory);

            this.persistentSessions.set(sessionId, freshSession);

            turnResult = await freshSession.start(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              queryFn as any,
              userMessage,
              freshOptions as unknown as Record<string, unknown>,
              firstContentBlocks
            );
          } else {
            throw startError;
          }
        }
      }

      // === Check for stale/crashed session errors and retry without resume ===
      // Use the flag captured BEFORE session.start() — the sdkSessionIdBySession map
      // is populated mid-call by the 'sdkSessionId' event, so checking it here would always be true.
      const wasResuming = hadSdkSessionBeforeStart;
      if (turnResult.errors && turnResult.errors.length > 0) {
        console.log(
          `[AgentManager] Turn errors: ${JSON.stringify(turnResult.errors)}, response length: ${turnResult.response.length}, wasResuming: ${wasResuming}`
        );
      }
      const isStaleSession = turnResult.errors?.some((e) =>
        e.includes('No conversation found with session ID')
      );
      const isInvalidThinking = turnResult.errors?.some((e) =>
        e.includes('Invalid signature in thinking block')
      );
      // "unknown" errors during resume are typically invalid thinking signatures or corrupted sessions.
      // The SDK may still return error text as "response", so don't require empty response.
      const isUnknownResumeError = wasResuming && turnResult.errors?.some((e) => e === 'unknown');
      const isSessionCrash =
        !turnResult.response &&
        turnResult.errors?.some((e) => e.includes('Session error') || e.includes('session closed'));
      // OAuth token expired mid-session — the subprocess can't refresh it, so we must
      // kill the session, refresh the token, and retry with a new subprocess.
      const isAuthFailed = turnResult.errors?.some((e) => e.includes('authentication_failed'));
      if (
        isStaleSession ||
        isInvalidThinking ||
        isUnknownResumeError ||
        isSessionCrash ||
        isAuthFailed
      ) {
        const staleId = this.sdkSessionIdBySession.get(sessionId);
        const reason = isStaleSession
          ? 'stale SDK session'
          : isInvalidThinking
            ? 'invalid thinking signature'
            : isUnknownResumeError
              ? 'unknown resume error'
              : isAuthFailed
                ? 'OAuth token expired'
                : 'session crash';
        console.warn(`[AgentManager] ${reason} detected (${staleId}), retrying...`);

        // For auth failures, keep the SDK session ID so we can resume with a fresh token.
        // For other errors, clear the session to start fresh.
        if (!isAuthFailed) {
          this.sdkSessionIdBySession.delete(sessionId);
          memory.clearSdkSessionId(sessionId);
        }

        // Close the dead session (subprocess has stale token or corrupted state)
        const deadSession = this.persistentSessions.get(sessionId);
        if (deadSession) {
          deadSession.close();
          this.persistentSessions.delete(sessionId);
        }

        // Retry: buildPersistentOptions will refresh the OAuth token via configureProviderEnvironment.
        // For auth failures, resume the same SDK session (context is valid, just token expired).
        const queryFn = await loadSDK();
        if (!queryFn) throw new Error('Failed to load SDK');

        const resumeId = isAuthFailed ? staleId : undefined;
        const freshOptions = await this.buildPersistentOptions(memory, sessionId, resumeId);
        const freshSession = new PersistentSDKSession(
          sessionId,
          (msg) => this.processStatusFromMessage(msg),
          (msg, current) => this.extractFromMessage(msg, current, sessionId)
        );

        this.setupSessionListeners(freshSession, sessionId, memory);

        this.persistentSessions.set(sessionId, freshSession);
        this.emitStatus({ type: 'thinking', sessionId, message: 'reconnecting...' });

        // Build content blocks for images (if any)
        const retryContentBlocks =
          images && images.length > 0
            ? [
                { type: 'text' as const, text: userMessage },
                ...images.map((img) => ({
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: img.mediaType,
                    data: img.data,
                  },
                })),
              ]
            : undefined;

        turnResult = await freshSession.start(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          queryFn as any,
          userMessage,
          freshOptions as unknown as Record<string, unknown>,
          retryContentBlocks
        );
      }

      // === Process turn result (same for both paths) ===

      // If the request was aborted (user pressed stop), bail out cleanly
      const wasAborted =
        this.stoppedByUserSession.has(sessionId) ||
        turnResult.errors?.some((e) => e.includes('aborted') || e.includes('interrupted'));
      if (wasAborted) {
        this.stoppedByUserSession.delete(sessionId);
        this.emitStatus({ type: 'done', sessionId });
        this.processingBySession.set(sessionId, false);
        const partialResponse = turnResult.response?.trim() || '';
        return {
          response: partialResponse,
          tokensUsed: 0,
          wasCompacted: false,
          suggestedPrompt: partialResponse
            ? this.lastSuggestedPromptBySession.get(sessionId)
            : undefined,
        };
      }

      // Plan mode interception: if the agent exited plan mode, return early
      // so the UI shows approval overlay instead of normal response flow
      if (turnResult.exitedPlanMode && !wasAborted) {
        // Prefer the plan file content over the agent's conversational response,
        // which may include error commentary about ExitPlanMode retries
        let planContent = turnResult.response || '';
        if (turnResult.planFilePath) {
          try {
            planContent = fs.readFileSync(turnResult.planFilePath, 'utf-8');
            console.log(
              `[AgentManager] Read plan from file: ${turnResult.planFilePath} (${planContent.length} chars)`
            );
          } catch (err) {
            console.warn(
              `[AgentManager] Could not read plan file ${turnResult.planFilePath}:`,
              err
            );
            // Fall back to turnResult.response
          }
        }

        // Save messages to memory
        const isScheduledJob = channel.startsWith('cron:');
        if (!isScheduledJob && planContent) {
          memory.saveMessage('user', userMessage, sessionId);
          memory.saveMessage('assistant', planContent, sessionId);
        }

        this.emitStatus({ type: 'done', sessionId });
        this.processingBySession.set(sessionId, false);

        // Process next message in queue
        setTimeout(() => {
          this.processQueue(sessionId).catch((err) => {
            console.error('[AgentManager] Queue processing failed:', err);
          });
        }, 0);

        return {
          response: planContent,
          tokensUsed: 0,
          wasCompacted: turnResult.wasCompacted,
          planPending: true,
          media:
            (this.pendingMediaBySession.get(sessionId) || []).length > 0
              ? this.pendingMediaBySession.get(sessionId)
              : undefined,
        };
      }

      let response = turnResult.response;
      const wasCompacted = turnResult.wasCompacted;

      // Store context window usage from SDK result
      if (turnResult.contextTokens !== undefined || turnResult.contextWindow !== undefined) {
        const existing = this.contextUsageBySession.get(sessionId);
        this.contextUsageBySession.set(sessionId, {
          contextTokens: turnResult.contextTokens ?? existing?.contextTokens ?? 0,
          contextWindow: turnResult.contextWindow ?? existing?.contextWindow ?? 0,
        });
      }

      this.emitStatus({ type: 'done', sessionId });

      // If no text response, try to recover or surface the actual problem
      if (!response) {
        // Check if the SDK reported errors — throw so they route through the error display path
        // (red bubble in UI, "Error:" prefix in Telegram)
        if (turnResult.errors && turnResult.errors.length > 0) {
          const errorSummary = turnResult.errors.join('; ');
          console.error(`[AgentManager] Empty response with SDK errors: ${errorSummary}`);
          throw new Error(formatAgentError(turnResult.errors[0]));
        }

        // No errors — agent likely did tool-only work, request a summary
        const currentSession = this.persistentSessions.get(sessionId);
        if (currentSession?.isAlive()) {
          console.log('[AgentManager] No text response (no errors), requesting summary...');
          this.emitStatus({ type: 'thinking', sessionId, message: 'summarizing...' });

          try {
            const summaryResult = await currentSession.send(
              'Briefly summarize what you just did in 1-2 sentences.'
            );
            if (summaryResult.response) {
              response = summaryResult.response;
            } else if (summaryResult.errors && summaryResult.errors.length > 0) {
              console.error(
                `[AgentManager] Summary returned errors: ${summaryResult.errors.join('; ')}`
              );
              throw new Error(formatAgentError(summaryResult.errors[0]));
            } else {
              console.warn('[AgentManager] Summary also returned empty — no errors, no text');
              response = 'Task completed (no details available).';
            }
          } catch (summaryError) {
            // Re-throw formatted errors (from above), format raw errors
            if (summaryError instanceof Error && summaryError.message.includes('[')) {
              throw summaryError;
            }
            const errMsg =
              summaryError instanceof Error ? summaryError.message : String(summaryError);
            console.error(`[AgentManager] Summary request failed: ${errMsg}`);
            throw new Error(formatAgentError(errMsg), { cause: summaryError });
          }

          this.emitStatus({ type: 'done', sessionId });
        } else {
          console.warn('[AgentManager] Session not alive for summary — session may have crashed');
          throw new Error(
            reportable(
              'Agent session ended unexpectedly. Send another message to start a new session.'
            )
          );
        }
      }

      // Skip saving HEARTBEAT_OK responses from scheduled jobs to memory/chat
      const isScheduledJob = channel.startsWith('cron:');
      const isHeartbeat = response.toUpperCase().includes('HEARTBEAT_OK');

      if (isScheduledJob && isHeartbeat) {
        console.log(
          '[AgentManager] Skipping HEARTBEAT_OK from scheduled job - not saving to memory'
        );
      } else {
        // Clean up scheduled job messages before saving - remove internal LLM instructions
        let messageToSave = userMessage;

        // Strip the heartbeat instruction suffix (for routines)
        const heartbeatSuffix = '\n\nIf nothing needs attention, reply with only HEARTBEAT_OK.';
        if (messageToSave.endsWith(heartbeatSuffix)) {
          messageToSave = messageToSave.slice(0, -heartbeatSuffix.length);
        }

        // Convert reminder prompts to clean display format (for reminders)
        const reminderMatch = messageToSave.match(
          /^\[SCHEDULED REMINDER - DELIVER NOW\]\nThe user previously asked to be reminded about: "(.+?)"\n\nDeliver this reminder/
        );
        if (reminderMatch) {
          messageToSave = `Reminder: ${reminderMatch[1]}`;
        }

        // Add metadata for message source and attachments
        let metadata: Record<string, unknown> | undefined;
        if (channel.startsWith('cron:')) {
          metadata = { source: 'scheduler', jobName: channel.slice(5) };
        } else if (channel === 'telegram') {
          // Use explicit attachmentInfo if provided, otherwise check for images
          const hasAttachment = attachmentInfo?.hasAttachment ?? (images && images.length > 0);
          const attachmentType =
            attachmentInfo?.attachmentType ?? (images && images.length > 0 ? 'photo' : undefined);
          metadata = { source: 'telegram', hasAttachment, attachmentType };
        } else if (channel === 'ios') {
          metadata = { source: 'ios' };
        }

        const userMsgId = memory.saveMessage('user', messageToSave, sessionId, metadata);
        // Assistant response doesn't need hasAttachment but keep source for consistency
        const assistantMetadata = metadata ? { source: metadata.source } : undefined;
        const assistantMsgId = memory.saveMessage(
          'assistant',
          response,
          sessionId,
          assistantMetadata
        );
        console.log('[AgentManager] Saved messages to SQLite (session: ' + sessionId + ')');

        // Embed messages asynchronously for future semantic retrieval
        // Don't await - let it run in background
        memory
          .embedMessage(userMsgId)
          .catch((e) => console.error('[AgentManager] Failed to embed user message:', e));
        memory
          .embedMessage(assistantMsgId)
          .catch((e) => console.error('[AgentManager] Failed to embed assistant message:', e));
      }

      this.extractAndStoreFacts(userMessage);

      // If set_project was called during this turn, close the persistent session
      // so the next message creates a new one with the updated cwd.
      if (this.pendingProjectSwitch.has(sessionId)) {
        this.pendingProjectSwitch.delete(sessionId);
        const switchedSession = this.persistentSessions.get(sessionId);
        if (switchedSession) {
          console.log(
            `[AgentManager] Closing session ${sessionId} after project switch — new cwd takes effect next message`
          );
          switchedSession.close();
          this.persistentSessions.delete(sessionId);
          this.sdkSessionIdBySession.delete(sessionId);
          memory.clearSdkSessionId(sessionId);
        }
      }

      const statsAfter = memory.getStats(sessionId);
      const contextUsage = this.contextUsageBySession.get(sessionId);

      return {
        response,
        tokensUsed: statsAfter.estimatedTokens,
        wasCompacted,
        suggestedPrompt: this.lastSuggestedPromptBySession.get(sessionId),
        contextTokens: contextUsage?.contextTokens,
        contextWindow: contextUsage?.contextWindow,
        media:
          (this.pendingMediaBySession.get(sessionId) || []).length > 0
            ? this.pendingMediaBySession.get(sessionId)
            : undefined,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';

      // Abort/interrupt errors are intentional (user pressed stop) — don't treat as failures
      if (errorMsg.includes('aborted') || errorMsg.includes('interrupted')) {
        console.log(`[AgentManager] Query aborted for session ${sessionId}`);
        this.emitStatus({ type: 'done', sessionId });
        return { response: '', tokensUsed: 0, wasCompacted: false };
      }

      console.error('[AgentManager] Query failed:', errorMsg);
      if (error instanceof Error && error.stack) {
        console.error('[AgentManager] Stack trace:', error.stack);
      }
      // Log full error object for debugging
      console.error(
        '[AgentManager] Full error:',
        JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
      );

      // Save user message and error response so they persist across reloads
      memory.saveMessage('user', userMessage, sessionId);
      memory.saveMessage('assistant', errorMsg, sessionId, { isError: true });

      throw error;
    } finally {
      this.processingBySession.set(sessionId, false);

      // Process next message in queue (if any)
      // Use setTimeout(0) to avoid blocking the current promise resolution
      setTimeout(() => {
        this.processQueue(sessionId).catch((err) => {
          console.error('[AgentManager] Queue processing failed:', err);
        });
      }, 0);
    }
  }

  /**
   * Get the number of queued messages for a session
   */
  getQueueLength(sessionId: string = 'default'): number {
    return this.messageQueueBySession.get(sessionId)?.length || 0;
  }

  /**
   * Clear the message queue for a session
   */
  clearQueue(sessionId: string = 'default'): void {
    const queue = this.messageQueueBySession.get(sessionId);
    if (queue && queue.length > 0) {
      // Reject all pending messages
      for (const item of queue) {
        item.reject(new Error('Queue cleared'));
      }
      // Delete the key entirely to prevent memory leak from accumulated empty arrays
      this.messageQueueBySession.delete(sessionId);
      console.log(`[AgentManager] Queue cleared for session ${sessionId}`);
    } else if (queue) {
      // Clean up empty queue entries
      this.messageQueueBySession.delete(sessionId);
    }
  }

  /**
   * Stop the current turn for a specific session (or any running query if no sessionId).
   * Uses interrupt() on persistent sessions to stop the current turn while keeping
   * the subprocess alive (preserving background tasks).
   * Also clears any queued messages for that session.
   */
  stopQuery(sessionId?: string, clearQueuedMessages: boolean = true): boolean {
    // Delegate to Chat engine for general mode or non-Anthropic providers
    const provider = getProviderForModel(this.model);
    if ((this.mode === 'general' || provider !== 'anthropic') && this.chatEngine) {
      return this.chatEngine.stopQuery(sessionId);
    }

    // Clear SDK tool timeout timers for the session being stopped
    const targetSessionId =
      sessionId || [...this.processingBySession.entries()].find(([, v]) => v)?.[0];
    if (targetSessionId) {
      for (const [id, entry] of this.sdkToolTimers.entries()) {
        if (entry.sessionId === targetSessionId) {
          clearTimeout(entry.timer);
          this.sdkToolTimers.delete(id);
        }
      }
    }

    if (sessionId) {
      // Clear the queue first
      if (clearQueuedMessages) {
        this.clearQueue(sessionId);
      }

      const session = this.persistentSessions.get(sessionId);
      if (session?.isAlive() && this.processingBySession.get(sessionId)) {
        console.log(
          `[AgentManager] Interrupting persistent session ${sessionId} (bg tasks survive)...`
        );
        this.stoppedByUserSession.add(sessionId);
        session.interrupt().catch((err) => {
          console.error(`[AgentManager] Interrupt failed for ${sessionId}:`, err);
        });
        return true;
      }

      // Fallback to abort controller (for non-persistent queries)
      const abortController = this.abortControllersBySession.get(sessionId);
      if (this.processingBySession.get(sessionId) && abortController) {
        console.log(`[AgentManager] Stopping query for session ${sessionId} via abort...`);
        this.stoppedByUserSession.add(sessionId);
        abortController.abort();
        return true;
      }
      return false;
    }

    // Legacy: stop any running query (first one found)
    for (const [sid, isProcessing] of this.processingBySession.entries()) {
      if (isProcessing) {
        if (clearQueuedMessages) {
          this.clearQueue(sid);
        }

        const session = this.persistentSessions.get(sid);
        if (session?.isAlive()) {
          console.log(`[AgentManager] Interrupting persistent session ${sid}...`);
          this.stoppedByUserSession.add(sid);
          session.interrupt().catch((err) => {
            console.error(`[AgentManager] Interrupt failed for ${sid}:`, err);
          });
          return true;
        }

        const abortController = this.abortControllersBySession.get(sid);
        if (abortController) {
          console.log(`[AgentManager] Stopping query for session ${sid} via abort...`);
          this.stoppedByUserSession.add(sid);
          abortController.abort();
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Check if a query is currently processing (optionally for a specific session)
   */
  isQueryProcessing(sessionId?: string): boolean {
    // Check Chat engine for general mode or non-Anthropic providers
    const provider = getProviderForModel(this.model);
    if ((this.mode === 'general' || provider !== 'anthropic') && this.chatEngine) {
      return this.chatEngine.isQueryProcessing(sessionId);
    }

    if (sessionId) {
      return this.processingBySession.get(sessionId) || false;
    }
    // Check if any session is processing
    for (const isProcessing of this.processingBySession.values()) {
      if (isProcessing) return true;
    }
    return false;
  }

  /**
   * Get the current workspace directory
   */
  getWorkspace(): string {
    return this.workspace;
  }

  /**
   * Get the default project root directory
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  /**
   * Flag that a project switch occurred for a session.
   * After the current turn completes, the persistent session will be closed
   * so the next message picks up the new cwd.
   */
  flagProjectSwitch(sessionId: string): void {
    this.pendingProjectSwitch.add(sessionId);
    console.log(`[AgentManager] Project switch flagged for session ${sessionId}`);
  }

  /**
   * Set the workspace directory for agent file operations.
   * This takes effect on the next SDK query (cwd option).
   * Closes all persistent sessions and clears SDK session mappings since sessions are tied to cwd.
   */
  setWorkspace(path: string): void {
    console.log('[AgentManager] Workspace changed:', this.workspace, '->', path);
    this.workspace = path;
    // SDK sessions are stored per-cwd, so changing cwd invalidates them
    this.closeAllPersistentSessions();
    this.sdkSessionIdBySession.clear();
  }

  /**
   * Reset workspace to default project root
   * Closes all persistent sessions and clears SDK session mappings since sessions are tied to cwd.
   */
  resetWorkspace(): void {
    console.log('[AgentManager] Workspace reset to project root:', this.projectRoot);
    this.workspace = this.projectRoot;
    this.closeAllPersistentSessions();
    this.sdkSessionIdBySession.clear();
  }

  /**
   * Clear the SDK session mapping for a given session (e.g., on session delete or clear).
   * Also closes the persistent session subprocess.
   */
  clearSdkSessionMapping(sessionId: string): void {
    this.closePersistentSession(sessionId);
    this.sdkSessionIdBySession.delete(sessionId);
    console.log(`[AgentManager] Cleared SDK session mapping for ${sessionId}`);
  }

  /**
   * Set up event listeners shared across all persistent session creation sites.
   */
  private setupSessionListeners(
    session: PersistentSDKSession,
    sessionId: string,
    memory: MemoryManager
  ): void {
    session.on('sdkSessionId', (capturedId: string) => {
      this.sdkSessionIdBySession.set(sessionId, capturedId);
      memory.setSdkSessionId(sessionId, capturedId);
    });

    session.on('closed', () => {
      console.log(`[AgentManager] Persistent session closed: ${sessionId}`);
      for (const [id, entry] of this.sdkToolTimers.entries()) {
        if (entry.sessionId === sessionId) {
          clearTimeout(entry.timer);
          this.sdkToolTimers.delete(id);
        }
      }
    });

    session.on('planModeEntered', () => {
      this.emitStatus({
        type: 'plan_mode_entered',
        sessionId,
        message: 'planning the pounce...',
      });
    });

    session.on('planModeExited', () => {
      this.emitStatus({
        type: 'plan_mode_exited',
        sessionId,
        message: 'plan ready for review',
      });
    });
  }

  /**
   * Close a single persistent session (kills subprocess and all background tasks).
   */
  closePersistentSession(sessionId: string): void {
    const session = this.persistentSessions.get(sessionId);
    if (session) {
      console.log(`[AgentManager] Closing persistent session: ${sessionId}`);
      session.close();
      this.persistentSessions.delete(sessionId);
    }
  }

  /**
   * Close all persistent sessions (e.g., on workspace change or cleanup).
   */
  private closeAllPersistentSessions(): void {
    for (const [sid, session] of this.persistentSessions.entries()) {
      console.log(`[AgentManager] Closing persistent session: ${sid}`);
      session.close();
    }
    this.persistentSessions.clear();
  }

  /**
   * Build options for persistent sessions.
   *
   * Static context (identity, instructions, profile, capabilities) goes in systemPrompt.append
   * since it only needs to be set once when the session is created.
   *
   * Dynamic context (temporal, facts, soul, daily logs) is injected per-message via
   * the UserPromptSubmit hook's additionalContext, so it's fresh for each turn.
   */
  private async buildPersistentOptions(
    memory: MemoryManager,
    sessionId: string,
    sdkSessionId?: string
  ): Promise<SDKOptions> {
    // Determine session mode — coder mode gets lean context (SDK preset + CLAUDE.md only)
    const sessionMode = memory.getSessionMode(sessionId);
    const isCoder = sessionMode === 'coder';

    // === Static context (set once at session creation) ===
    // NOTE: CLAUDE.md (this.instructions) is NOT included here because the SDK
    // already reads it from the workspace via cwd + settingSources: ['project'].
    // Including it here would inject it twice.
    const staticParts: string[] = [];

    // Personalize, guidelines, and profile are only needed for general (personal assistant) mode
    if (isCoder) {
      console.log(
        `[AgentManager] Coder mode — skipping identity, user context, guidelines, capabilities (SDK uses workspace CLAUDE.md)`
      );
    }
    if (!isCoder) {
      // 1. Agent Identity: name, description, personality
      const identity = SettingsManager.getFormattedIdentity();
      if (identity) {
        staticParts.push(identity);
        console.log(`[AgentManager] Identity injected: ${identity.length} chars`);
      }

      // 2. User Context: profile + world
      const userContext = SettingsManager.getFormattedUserContext();
      if (userContext) {
        staticParts.push(userContext);
        console.log(`[AgentManager] User context injected: ${userContext.length} chars`);
      }

      // 3. System Guidelines: developer-controlled instructions
      staticParts.push(SYSTEM_GUIDELINES);
      console.log(`[AgentManager] System guidelines injected: ${SYSTEM_GUIDELINES.length} chars`);
    }

    // Look up per-session working directory (falls back to global workspace)
    const sessionWorkingDir = memory.getSessionWorkingDirectory(sessionId);
    const effectiveCwd = sessionWorkingDir || this.workspace;
    console.log(
      `[AgentManager] buildPersistentOptions session=${sessionId} mode=${sessionMode} | sessionWorkingDir=${sessionWorkingDir || 'null'} | effectiveCwd=${effectiveCwd}`
    );

    // Log prompt summary for the mode
    if (isCoder) {
      console.log(
        `[AgentManager] Coder mode prompt — static: ${staticParts.join('').length} chars (SDK reads CLAUDE.md from workspace cwd)`
      );
    } else {
      console.log(
        `[AgentManager] General mode prompt — static: ${staticParts.join('\n\n').length} chars`
      );
    }

    // Get thinking level config — only Anthropic models support thinking/effort.
    // Non-Anthropic providers (Kimi, GLM) use Anthropic-compatible APIs but may not
    // handle thinking parameters correctly, causing all output to go to thinking blocks.
    const provider = getProviderForModel(this.model);
    const thinkingLevel = SettingsManager.get('agent.thinkingLevel') || 'normal';
    const thinkingEntry = THINKING_CONFIGS[thinkingLevel] || THINKING_CONFIGS['normal'];
    const isAnthropicModel = provider === 'anthropic';

    // Build provider env vars without mutating process.env (race-safe)
    const providerEnv = await buildProviderEnv(this.model);
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...providerEnv,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    };
    delete env.CLAUDE_CONFIG_DIR;

    const options: SDKOptions = {
      model: this.model,
      cwd: effectiveCwd,
      maxTurns: 100,
      ...(isAnthropicModel && { thinking: thinkingEntry.thinking }),
      ...(isAnthropicModel && thinkingEntry.effort && { effort: thinkingEntry.effort }),
      tools: { type: 'preset', preset: 'claude_code' },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project'],
      canUseTool: buildCanUseToolCallback(),
      env,
      hooks: {
        PreToolUse: [buildPreToolUseHook()],
        // Dynamic context injection: fresh facts/soul/temporal for each message
        // Coder mode skips all personal assistant context for lean coding sessions
        UserPromptSubmit: [
          {
            hooks: [
              async () => {
                if (isCoder) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'UserPromptSubmit' as const,
                      additionalContext: '',
                    },
                  };
                }

                const dynamicParts: string[] = [];

                // Temporal context (current time)
                const recentMsgs = memory.getRecentMessages(1, sessionId);
                const lastUserMsg = recentMsgs.find((m) => m.role === 'user');
                const temporalContext = this.buildTemporalContext(lastUserMsg?.timestamp);
                dynamicParts.push(temporalContext);

                // Facts context
                const factsContext = memory.getFactsForContext();
                if (factsContext) {
                  dynamicParts.push(factsContext);
                }

                // Soul context
                const soulContext = memory.getSoulContext();
                if (soulContext) {
                  dynamicParts.push(soulContext);
                }

                // Daily logs
                const dailyLogsContext = memory.getDailyLogsContext(3);
                if (dailyLogsContext) {
                  dynamicParts.push(dailyLogsContext);
                }

                return {
                  hookSpecificOutput: {
                    hookEventName: 'UserPromptSubmit' as const,
                    additionalContext: dynamicParts.join('\n\n'),
                  },
                };
              },
            ],
          },
        ],
        TeammateIdle: [
          {
            hooks: [
              async (input: { teammate_name: string; team_name: string }) => {
                this.emitStatus({
                  type: 'teammate_idle',
                  teammateName: input.teammate_name,
                  teamName: input.team_name,
                  message: `${input.teammate_name} is idle`,
                });
                return { hookSpecificOutput: { hookEventName: 'TeammateIdle' as const } };
              },
            ],
          },
        ],
        TaskCompleted: [
          {
            hooks: [
              async (input: {
                task_id: string;
                task_subject: string;
                task_description?: string;
                teammate_name?: string;
                team_name?: string;
              }) => {
                this.emitStatus({
                  type: 'task_completed',
                  taskId: input.task_id,
                  taskSubject: input.task_subject,
                  teammateName: input.teammate_name,
                  teamName: input.team_name,
                  message: `task done: ${input.task_subject}`,
                });
                return { hookSpecificOutput: { hookEventName: 'TaskCompleted' as const } };
              },
            ],
          },
        ],
      },
      allowedTools: [
        // Built-in SDK tools
        'Read',
        'Write',
        'Edit',
        'Bash',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        // Plan mode tools
        'EnterPlanMode',
        'ExitPlanMode',
        'AskUserQuestion',
        // Agent Teams tools
        'TeammateTool',
        'TeamCreate',
        'SendMessage',
        'TaskCreate',
        'TaskGet',
        'TaskUpdate',
        'TaskList',
        // Background task tools (persist across turns with persistent sessions)
        'TaskOutput',
        'TaskStop',
        'BashOutput',
        'KillBash',
        // Custom MCP tools - browser & system
        'mcp__pocket-agent__browser',
        'mcp__pocket-agent__notify',
        // Custom MCP tools - project
        'mcp__pocket-agent__set_project',
        'mcp__pocket-agent__get_project',
        'mcp__pocket-agent__clear_project',
        // Coder-only tools
        ...(isCoder ? ['mcp__grep__searchGitHub'] : []),
        // Personal assistant tools — only in general mode
        ...(isCoder
          ? []
          : [
              // Memory
              'mcp__pocket-agent__remember',
              'mcp__pocket-agent__forget',
              'mcp__pocket-agent__list_facts',
              'mcp__pocket-agent__memory_search',
              'mcp__pocket-agent__daily_log',
              // Soul
              'mcp__pocket-agent__soul_set',
              'mcp__pocket-agent__soul_get',
              'mcp__pocket-agent__soul_list',
              'mcp__pocket-agent__soul_delete',
              // Scheduler
              'mcp__pocket-agent__schedule_task',
              'mcp__pocket-agent__create_reminder',
              'mcp__pocket-agent__list_scheduled_tasks',
              'mcp__pocket-agent__delete_scheduled_task',
            ]),
      ],
      persistSession: true,
      ...(sdkSessionId && { resume: sdkSessionId }),
    };

    if (staticParts.length > 0) {
      options.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: staticParts.join('\n\n'),
      };
    }

    if (this.toolsConfig) {
      // Build child process MCP servers (e.g., computer use)
      const mcpServers = buildMCPServers(this.toolsConfig);

      // Build SDK MCP servers (in-process tools like browser, notify, memory)
      // Coder mode only registers coding-relevant tools (browser, notify, project)
      const sdkMcpServers = await buildSdkMcpServers(this.toolsConfig, sessionMode);

      // Merge both types + remote MCP servers (coder only)
      const allServers: Record<string, unknown> = {
        ...mcpServers,
        ...(sdkMcpServers || {}),
        // Grep MCP — remote code search across 1M+ public GitHub repos (coder only)
        ...(isCoder ? { grep: { type: 'http', url: 'https://mcp.grep.app' } } : {}),
      };

      if (Object.keys(allServers).length > 0) {
        options.mcpServers = allServers;
        console.log('[AgentManager] MCP servers:', Object.keys(allServers).join(', '));
      }
    }

    return options;
  }

  private extractFromMessage(message: unknown, current: string, sessionId: string): string {
    const msg = message as {
      type?: string;
      subtype?: string;
      message?: { content?: unknown };
      output?: string;
      result?: string;
      errors?: string[];
    };
    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        // Extract image blocks and save to disk
        this.extractImageBlocks(content, sessionId);

        const textBlocks = content
          .filter((block: unknown) => (block as { type?: string })?.type === 'text')
          .map((block: unknown) => (block as { text: string }).text);
        // If no text blocks (tool-only turn), preserve the accumulated response
        if (textBlocks.length === 0) {
          const blockTypes = content.map((b: unknown) => (b as { type?: string })?.type).join(', ');
          console.log(
            `[AgentManager] Assistant message with no text blocks (block types: ${blockTypes})`
          );
          return current;
        }
        const text = textBlocks.join('\n');
        // Extract and strip any trailing "User:" suggested prompts
        const { text: cleanedText, suggestion } = this.extractSuggestedPrompt(text);
        if (suggestion) {
          this.lastSuggestedPromptBySession.set(getCurrentSessionId(), suggestion);
        }
        if (!cleanedText && text) {
          console.warn(
            `[AgentManager] extractSuggestedPrompt stripped entire response (original ${text.length} chars)`
          );
        }
        // Accumulate text across multi-message turns (e.g. text → tool → text)
        return current ? current + '\n\n' + cleanedText : cleanedText;
      } else if (content !== undefined) {
        // content exists but isn't an array — unexpected format
        console.warn(
          `[AgentManager] Assistant message content is not an array (type: ${typeof content})`
        );
      }
    }

    if (msg.type === 'result') {
      // Log error results for diagnostics
      if (msg.subtype && msg.subtype !== 'success') {
        console.warn(
          `[AgentManager] Result subtype: ${msg.subtype}, errors: ${msg.errors?.join('; ') || 'none'}`
        );
      }
      const result = msg.output || msg.result;
      if (result) {
        // Extract and strip any trailing "User:" suggested prompts from result
        const { text: cleanedText, suggestion } = this.extractSuggestedPrompt(result);
        if (suggestion) {
          this.lastSuggestedPromptBySession.set(getCurrentSessionId(), suggestion);
        }
        // If we've already accumulated text from assistant messages, keep it
        // (SDK result.output only contains the last assistant message's text)
        return current || cleanedText;
      }
    }

    return current;
  }

  /**
   * Extract image blocks from SDK assistant message content and save to disk.
   * Images are accumulated in pendingMediaBySession and included in the final ProcessResult.
   */
  private extractImageBlocks(content: unknown[], sessionId: string): void {
    const pendingMedia = this.pendingMediaBySession.get(sessionId) || [];
    if (!this.pendingMediaBySession.has(sessionId)) {
      this.pendingMediaBySession.set(sessionId, pendingMedia);
    }
    for (const block of content) {
      const b = block as {
        type?: string;
        source?: { type?: string; media_type?: string; data?: string; url?: string };
      };
      if (b.type !== 'image' || !b.source) continue;

      try {
        const mediaDir = path.join(os.homedir(), 'Documents', 'Pocket-agent', 'media');
        if (!fs.existsSync(mediaDir)) {
          fs.mkdirSync(mediaDir, { recursive: true });
        }

        const mimeType = b.source.media_type || 'image/png';
        const ext =
          mimeType.includes('jpeg') || mimeType.includes('jpg')
            ? '.jpg'
            : mimeType.includes('gif')
              ? '.gif'
              : mimeType.includes('webp')
                ? '.webp'
                : '.png';

        if (b.source.type === 'base64' && b.source.data) {
          // Base64 image — save directly to disk
          const filename = `img-${Date.now()}-${pendingMedia.length}${ext}`;
          const filePath = path.join(mediaDir, filename);
          fs.writeFileSync(filePath, Buffer.from(b.source.data, 'base64'));

          pendingMedia.push({ type: 'image', filePath, mimeType });
          console.log(`[AgentManager] Saved image: ${filePath}`);
        } else if (b.source.type === 'url' && b.source.url) {
          // URL image — download and save to disk
          const filename = `img-${Date.now()}-${pendingMedia.length}${ext}`;
          const filePath = path.join(mediaDir, filename);

          // Fire-and-forget download; image will be available for Telegram sync
          fetch(b.source.url)
            .then((res) =>
              res.ok ? res.arrayBuffer() : Promise.reject(new Error(`HTTP ${res.status}`))
            )
            .then((buf) => {
              fs.writeFileSync(filePath, Buffer.from(buf));
              console.log(`[AgentManager] Downloaded image: ${filePath}`);
            })
            .catch((err) => console.error('[AgentManager] Failed to download image:', err));

          pendingMedia.push({ type: 'image', filePath, mimeType });
        }
      } catch (err) {
        console.error('[AgentManager] Failed to save image block:', err);
      }
    }
  }

  /**
   * Extract screenshot file paths from tool result blocks.
   * The browser tool saves full-res screenshots and includes the path in its result JSON.
   */
  private extractScreenshotPaths(block: unknown, sessionId: string): void {
    try {
      const b = block as { content?: unknown };
      if (!b.content) return;

      const pendingMedia = this.pendingMediaBySession.get(sessionId) || [];
      if (!this.pendingMediaBySession.has(sessionId)) {
        this.pendingMediaBySession.set(sessionId, pendingMedia);
      }

      if (Array.isArray(b.content)) {
        // Extract image blocks from tool result content (e.g. computer_use screenshots)
        this.extractImageBlocks(b.content, sessionId);

        // Also check text blocks for file paths
        for (const part of b.content) {
          const p = part as { type?: string; text?: string };
          if (p.type === 'text' && p.text) {
            const match = p.text.match(/saved to (\/[^\s"]+\/screenshot-\d+\.png)/);
            if (match && fs.existsSync(match[1])) {
              if (!pendingMedia.some((m) => m.filePath === match[1])) {
                pendingMedia.push({ type: 'image', filePath: match[1], mimeType: 'image/png' });
                console.log(`[AgentManager] Found screenshot in tool result: ${match[1]}`);
              }
            }
          }
        }
      } else if (typeof b.content === 'string') {
        const match = b.content.match(/saved to (\/[^\s"]+\/screenshot-\d+\.png)/);
        if (match && fs.existsSync(match[1])) {
          if (!pendingMedia.some((m) => m.filePath === match[1])) {
            pendingMedia.push({ type: 'image', filePath: match[1], mimeType: 'image/png' });
            console.log(`[AgentManager] Found screenshot in tool result: ${match[1]}`);
          }
        }
      }
    } catch {
      // Ignore parsing errors
    }
  }

  /**
   * Extract and strip trailing suggested user prompts that the SDK might include
   * These appear as "User: ..." at the end of responses
   * Returns both the cleaned text and the extracted suggestion
   */
  private extractSuggestedPrompt(text: string): { text: string; suggestion?: string } {
    if (!text) return { text };

    // Pattern: newlines followed by "User:" (case-insensitive) and any text until end
    const match = text.match(/\n\nuser:\s*(.+)$/is);

    if (match) {
      const suggestion = match[1].trim();
      const cleanedText = text.replace(/\n\nuser:[\s\S]*$/is, '').trim();

      // Validate that the suggestion looks like a user prompt, not an assistant question
      const isValidUserPrompt = this.isValidUserPrompt(suggestion);

      if (isValidUserPrompt) {
        console.log('[AgentManager] Extracted suggested prompt:', suggestion);
        return { text: cleanedText, suggestion };
      } else {
        // Not a valid prompt suggestion — return original text unmodified
        return { text: text.trim() };
      }
    }

    return { text: text.trim() };
  }

  /**
   * Check if a suggestion looks like a valid user prompt
   * Rejects questions and assistant-style speech
   */
  private isValidUserPrompt(suggestion: string): boolean {
    if (!suggestion) return false;

    // Reject if it ends with a question mark (assistant asking a question)
    if (suggestion.endsWith('?')) return false;

    // Reject if it starts with common question/assistant words
    const assistantPatterns =
      /^(what|how|would|do|does|is|are|can|could|shall|should|may|might|let me|i can|i'll|i will|here's|here is)/i;
    if (assistantPatterns.test(suggestion)) return false;

    // Reject if it's too long (likely not a simple user command)
    if (suggestion.length > 100) return false;

    // Accept short, command-like suggestions
    return true;
  }

  private emitStatus(status: AgentStatus): void {
    this.emit('status', status);
  }

  // Track active subagents per session
  private activeSubagentsBySession: Map<
    string,
    Map<string, { type: string; description: string }>
  > = new Map();
  private lastPartialTextBySession: Map<string, string> = new Map();
  // Track background tasks per session
  private backgroundTasksBySession: Map<
    string,
    Map<string, { type: string; description: string; toolUseId: string }>
  > = new Map();

  private getActiveSubagents(
    sessionId: string
  ): Map<string, { type: string; description: string }> {
    let map = this.activeSubagentsBySession.get(sessionId);
    if (!map) {
      map = new Map();
      this.activeSubagentsBySession.set(sessionId, map);
    }
    return map;
  }

  private getBackgroundTasks(
    sessionId: string
  ): Map<string, { type: string; description: string; toolUseId: string }> {
    let map = this.backgroundTasksBySession.get(sessionId);
    if (!map) {
      map = new Map();
      this.backgroundTasksBySession.set(sessionId, map);
    }
    return map;
  }

  private processStatusFromMessage(message: unknown): void {
    const sessionId = getCurrentSessionId();
    const activeSubagents = this.getActiveSubagents(sessionId);
    const backgroundTasks = this.getBackgroundTasks(sessionId);

    // Handle tool use from assistant messages
    const msg = message as { type?: string; subtype?: string; message?: { content?: unknown } };
    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        // Emit partial text for visibility while agent is composing
        const textBlocks = content
          .filter((block: unknown) => (block as { type?: string })?.type === 'text')
          .map((block: unknown) => (block as { text: string }).text);
        if (textBlocks.length > 0) {
          const fullText = textBlocks.join('\n').trim();
          const prevText = this.lastPartialTextBySession.get(sessionId) || '';
          if (fullText && fullText !== prevText) {
            this.lastPartialTextBySession.set(sessionId, fullText);
            this.emitStatus({
              type: 'partial_text',
              sessionId,
              partialText: fullText,
              partialReplace: true,
              message: 'composing...',
            });
          }
        }

        for (const block of content) {
          if (block?.type === 'tool_use') {
            const rawName = block.name as string;
            const toolName = this.formatToolName(rawName);
            const toolInput = this.formatToolInput(block.input);
            const blockInput = block.input as Record<string, unknown>;
            const toolUseId = (block.id as string) || `bg-${Date.now()}`;

            // Detect background tasks (Bash or Task with run_in_background)
            if (blockInput?.run_in_background === true) {
              const bgId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              const description =
                (rawName === 'Bash'
                  ? (blockInput.command as string)?.slice(0, 60)
                  : (blockInput.description as string) ||
                    (blockInput.prompt as string)?.slice(0, 60)) || rawName;

              backgroundTasks.set(bgId, { type: rawName, description, toolUseId });
              console.log(
                `[AgentManager] Background task started: ${rawName} - ${description} (${backgroundTasks.size} active)`
              );

              this.emitStatus({
                type: 'background_task_start',
                sessionId,
                backgroundTaskId: bgId,
                backgroundTaskDescription: description,
                backgroundTaskCount: backgroundTasks.size,
                toolName: rawName,
                message: `background: ${description}`,
              });
            }

            // Detect TaskOutput (checking on background tasks)
            if (rawName === 'TaskOutput') {
              this.emitStatus({
                type: 'background_task_output',
                sessionId,
                backgroundTaskId: blockInput.task_id as string,
                backgroundTaskCount: backgroundTasks.size,
                message: 'checking background task...',
              });
            }

            // Detect TaskStop/KillBash — remove bg task from tracking
            // Note: SDK task IDs don't match our toolUseIds, so remove oldest matching type
            if (rawName === 'TaskStop' || rawName === 'KillBash') {
              const firstKey = backgroundTasks.keys().next().value;
              if (firstKey) {
                backgroundTasks.delete(firstKey);
                console.log(
                  `[AgentManager] Background task removed via ${rawName}: ${firstKey} (${backgroundTasks.size} remaining)`
                );
                this.emitStatus({
                  type: 'background_task_end',
                  sessionId,
                  backgroundTaskId: firstKey,
                  backgroundTaskCount: backgroundTasks.size,
                  message: 'background task stopped',
                });
              }
            }

            // Check if this is a Task (subagent) tool
            if (rawName === 'Task') {
              const input = block.input as {
                subagent_type?: string;
                description?: string;
                prompt?: string;
              };
              const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              const agentType = input.subagent_type || 'general';
              const description =
                input.description || input.prompt?.slice(0, 50) || 'working on it';

              activeSubagents.set(agentId, { type: agentType, description });

              this.emitStatus({
                type: 'subagent_start',
                sessionId,
                agentId,
                agentType,
                toolInput: description,
                agentCount: activeSubagents.size,
                message: this.getSubagentMessage(agentType),
              });
            } else if (rawName === 'TeammateTool') {
              const input = block.input as {
                name?: string;
                team_name?: string;
                description?: string;
              };
              this.emitStatus({
                type: 'teammate_start',
                sessionId,
                teammateName: input.name,
                teamName: input.team_name,
                toolName,
                toolInput: input.description || input.name || 'spawning teammate',
                message: `rallying ${input.name || 'a teammate'}`,
              });
            } else if (rawName === 'SendMessage') {
              const input = block.input as { to?: string; type?: string; message?: string };
              this.emitStatus({
                type: 'teammate_message',
                sessionId,
                teammateName: input.to,
                toolName,
                toolInput: input.message?.slice(0, 80) || '',
                message:
                  input.type === 'broadcast'
                    ? 'broadcasting to the squad'
                    : `messaging ${input.to || 'teammate'}`,
              });
            } else if (rawName === 'EnterPlanMode') {
              this.emitStatus({
                type: 'plan_mode_entered',
                sessionId,
                message: 'planning the pounce...',
              });
            } else if (rawName === 'ExitPlanMode') {
              this.emitStatus({
                type: 'plan_mode_exited',
                sessionId,
                message: 'plan ready for review',
              });
            } else if (rawName === 'Bash' && this.isPocketCliCommand(block.input)) {
              const pocketName = this.formatPocketCommand(block.input);
              this.emitStatus({
                type: 'tool_start',
                sessionId,
                toolName: pocketName,
                toolInput,
                message: `batting at ${pocketName}...`,
                isPocketCli: true,
              });
            } else {
              this.emitStatus({
                type: 'tool_start',
                sessionId,
                toolName,
                toolInput,
                message: `batting at ${toolName}...`,
              });
            }

            // Start timeout timer for SDK built-in tools (MCP tools have their own via wrapToolHandler)
            // NOTE: On timeout we only log a warning — we do NOT interrupt the session.
            // The SDK handles tool failures internally and returns error tool_results to the
            // model, letting it recover gracefully (e.g. retry or respond without the tool).
            // Interrupting kills the entire turn and leaves the user with no response.
            if (!rawName.startsWith('mcp__')) {
              const timeoutMs =
                AgentManagerClass.SDK_TOOL_TIMEOUTS[rawName] ??
                AgentManagerClass.SDK_TOOL_DEFAULT_TIMEOUT;
              const timer = setTimeout(() => {
                console.warn(
                  `[AgentManager] SDK tool ${rawName} (${toolUseId}) exceeded ${timeoutMs}ms — waiting for SDK to handle`
                );
                this.sdkToolTimers.delete(toolUseId);
              }, timeoutMs);
              this.sdkToolTimers.set(toolUseId, { timer, sessionId });
            }
          }
        }
      }
    }

    // Handle tool results
    if (msg.type === 'user' && msg.message?.content) {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_result') {
            // Clear SDK tool timeout timer if this result matches one
            const resultToolUseId = (block as { tool_use_id?: string }).tool_use_id;
            if (resultToolUseId) {
              const entry = this.sdkToolTimers.get(resultToolUseId);
              if (entry) {
                clearTimeout(entry.timer);
                this.sdkToolTimers.delete(resultToolUseId);
              }
            }

            // Extract screenshot paths and images from tool results
            this.extractScreenshotPaths(block, sessionId);

            // Check if any subagents completed
            if (activeSubagents.size > 0) {
              // Remove one subagent (we don't have exact ID matching, so remove oldest)
              const firstKey = activeSubagents.keys().next().value;
              if (firstKey) {
                activeSubagents.delete(firstKey);
              }

              if (activeSubagents.size > 0) {
                // Still have active subagents
                this.emitStatus({
                  type: 'subagent_update',
                  sessionId,
                  agentCount: activeSubagents.size,
                  message: `${activeSubagents.size} kitty${activeSubagents.size > 1 ? 'ies' : ''} still hunting`,
                });
              } else {
                this.emitStatus({
                  type: 'subagent_end',
                  sessionId,
                  agentCount: 0,
                  message: 'squad done! cleaning up...',
                });
              }
            } else {
              this.emitStatus({
                type: 'tool_end',
                sessionId,
                message: 'caught it! processing...',
              });
            }
          }
        }
      }
    }

    // Handle system messages
    if (msg.type === 'system') {
      if (msg.subtype === 'init') {
        this.emitStatus({ type: 'thinking', sessionId, message: 'waking up from a nap...' });
      } else if (msg.subtype === 'status') {
        const statusMsg = msg as { status?: string };
        if (statusMsg.status === 'compacting') {
          console.log('[AgentManager] SDK auto-compaction triggered');
          this.emitStatus({ type: 'thinking', sessionId, message: 'compacting context...' });
        }
      } else if (msg.subtype === 'compact_boundary') {
        const compactMsg = msg as { compact_metadata?: { trigger: string; pre_tokens: number } };
        const meta = compactMsg.compact_metadata;
        console.log(
          `[AgentManager] SDK compaction complete: trigger=${meta?.trigger}, pre_tokens=${meta?.pre_tokens}`
        );
      } else if (msg.subtype === 'task_notification') {
        const taskMsg = msg as { task_id?: string; status?: string; summary?: string };
        const taskStatus = taskMsg.status;
        if (taskStatus === 'completed' || taskStatus === 'failed' || taskStatus === 'stopped') {
          // Remove oldest tracked bg task (SDK task IDs don't map to our internal IDs)
          const firstKey = backgroundTasks.keys().next().value;
          if (firstKey) {
            backgroundTasks.delete(firstKey);
            console.log(
              `[AgentManager] Background task ${taskStatus} (notification): removed ${firstKey} (${backgroundTasks.size} remaining)`
            );
            this.emitStatus({
              type: 'background_task_end',
              sessionId,
              backgroundTaskId: firstKey,
              backgroundTaskCount: backgroundTasks.size,
              message: `background task ${taskStatus}`,
            });
          } else {
            console.log(
              `[AgentManager] Background task ${taskStatus} (notification): ${taskMsg.task_id} (not tracked)`
            );
          }
        }
      }
    }
  }

  private getSubagentMessage(agentType: string): string {
    const messages: Record<string, string> = {
      Explore: 'sent a curious kitten to explore',
      Plan: 'calling in the architect cat',
      Bash: 'summoning a terminal tabby',
      'general-purpose': 'summoning a helper kitty',
    };
    return messages[agentType] || `summoning ${agentType} cat friend`;
  }

  private formatToolName(name: string): string {
    // Fun, cat-themed tool names that match PA's vibe
    const friendlyNames: Record<string, string> = {
      // SDK built-in tools
      Read: 'sniffing this file',
      Write: 'scratching notes down',
      Edit: 'pawing at some code',
      Bash: 'hacking at the terminal',
      Glob: 'hunting for files',
      Grep: 'digging through code',
      WebSearch: 'prowling the web',
      WebFetch: 'fetching that page',
      Task: 'summoning a helper kitty',
      NotebookEdit: 'editing notebook',

      // Memory tools
      remember: 'stashing in my cat brain',
      forget: 'knocking it off the shelf',
      list_facts: 'checking my memories',
      memory_search: 'sniffing through archives',

      // Browser tool
      browser: 'pouncing on browser',

      // Computer use tool
      computer: 'walking on the keyboard',

      // Scheduler tools
      schedule_task: 'setting an alarm meow',
      list_scheduled_tasks: 'checking the schedule',
      delete_scheduled_task: 'knocking that off',

      // macOS tools
      notify: 'sending a meow',


      // Agent Teams tools
      TeammateTool: 'rallying the squad',
      TeamCreate: 'rallying the squad',
      SendMessage: 'passing a note',
      TaskCreate: 'creating a team task',
      TaskGet: 'checking task details',
      TaskUpdate: 'updating team task',
      TaskList: 'listing team tasks',
      TaskOutput: 'checking background task',
      TaskStop: 'stopping background task',
      BashOutput: 'checking background command',
      KillBash: 'killing background command',
    };
    return friendlyNames[name] || name;
  }

  private formatToolInput(input: unknown): string {
    if (!input) return '';
    // Extract meaningful info from tool input
    if (typeof input === 'string') return input.slice(0, 100);
    const inp = input as Record<string, string | number[] | undefined>;

    // File operations
    if (inp.file_path) return inp.file_path as string;
    if (inp.notebook_path) return inp.notebook_path as string;

    // Search/patterns
    if (inp.pattern) return inp.pattern as string;
    if (inp.query) return inp.query as string;

    // Commands
    if (inp.command) return (inp.command as string).slice(0, 80);

    // Web
    if (inp.url) return inp.url as string;

    // Agent/Task
    if (inp.prompt) return (inp.prompt as string).slice(0, 80);
    if (inp.description) return (inp.description as string).slice(0, 80);

    // Memory tools
    if (inp.category && inp.subject) return `${inp.category}/${inp.subject}`;
    if (inp.content) return (inp.content as string).slice(0, 80);

    // Browser tool
    if (inp.action) {
      const browserActions: Record<string, string> = {
        navigate: inp.url ? `→ ${inp.url}` : 'navigating',
        screenshot: 'capturing screen',
        click: inp.selector ? `clicking ${inp.selector}` : 'clicking',
        type: inp.text ? `typing "${(inp.text as string).slice(0, 30)}"` : 'typing',
        evaluate: 'running script',
        extract: (inp.extract_type as string) || 'extracting data',
      };
      return browserActions[inp.action as string] || (inp.action as string);
    }

    // Computer use
    if (inp.coordinate && Array.isArray(inp.coordinate) && inp.coordinate.length >= 2) {
      return `at (${inp.coordinate[0]}, ${inp.coordinate[1]})`;
    }
    if (inp.text) return `"${(inp.text as string).slice(0, 40)}"`;

    // Agent Teams tools
    if (inp.to && inp.message) return `→ ${inp.to}: ${(inp.message as string).slice(0, 60)}`;
    if (inp.name && inp.team_name) return `${inp.name} in ${inp.team_name}`;
    if (inp.name) return inp.name as string;

    return '';
  }

  private isPocketCliCommand(input: unknown): boolean {
    if (!input || typeof input !== 'object') return false;
    const command = (input as Record<string, unknown>).command;
    if (typeof command !== 'string') return false;
    return command.trimStart().startsWith('pocket');
  }

  private formatPocketCommand(input: unknown): string {
    if (!input || typeof input !== 'object') return 'running pocket cli';
    const command = ((input as Record<string, unknown>).command as string) || '';
    const parts = command.trimStart().split(/\s+/);
    const subcommand = parts[1] || '';
    const categories: Record<string, string> = {
      news: 'fetching the latest news',
      utility: 'running pocket utility',
      knowledge: 'checking the knowledge base',
      dev: 'querying dev tools',
      commands: 'listing pocket commands',
      setup: 'configuring pocket',
      integrations: 'checking integrations',
    };
    return categories[subcommand] || 'running pocket cli';
  }

  /**
   * Parse database timestamp
   * If user has timezone configured, treat DB timestamps as UTC
   * Otherwise, use system local time (original behavior)
   */
  private parseDbTimestamp(timestamp: string): Date {
    // If already has timezone indicator, parse directly
    if (/Z$|[+-]\d{2}:?\d{2}$/.test(timestamp)) {
      return new Date(timestamp);
    }

    // Check if user has configured a timezone
    const userTimezone = SettingsManager.get('profile.timezone');

    if (userTimezone) {
      // User has timezone set - treat DB timestamps as UTC
      const normalized = timestamp.replace(' ', 'T');
      return new Date(normalized + 'Z');
    } else {
      // No timezone configured - use system local time
      const normalized = timestamp.replace(' ', 'T');
      return new Date(normalized);
    }
  }

  /**
   * Build temporal context for the system prompt
   * Gives the agent awareness of current time and conversation timing
   */
  private buildTemporalContext(lastMessageTimestamp?: string): string {
    const now = new Date();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = dayNames[now.getDay()];

    const timeStr = now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

    const dateStr = now.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });

    const lines = ['## Current Time', `It is ${dayName}, ${dateStr} at ${timeStr}.`];

    // Add time since last message if available
    if (lastMessageTimestamp) {
      try {
        const lastDate = this.parseDbTimestamp(lastMessageTimestamp);
        const diffMs = now.getTime() - lastDate.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        let timeSince = '';
        if (diffMins < 1) timeSince = 'just now';
        else if (diffMins < 60) timeSince = `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
        else if (diffHours < 24) timeSince = `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
        else if (diffDays < 7) timeSince = `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
        else timeSince = lastDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

        lines.push(`Last message from user was ${timeSince}.`);
      } catch {
        // Ignore timestamp parsing errors
      }
    }

    return lines.join('\n');
  }

  private extractAndStoreFacts(userMessage: string): void {
    if (!this.memory) return;

    const patterns: Array<{ pattern: RegExp; category: string; subject: string }> = [
      { pattern: /my name is (\w+)/i, category: 'user_info', subject: 'name' },
      { pattern: /call me (\w+)/i, category: 'user_info', subject: 'name' },
      { pattern: /i live in ([^.,]+)/i, category: 'user_info', subject: 'location' },
      { pattern: /i'm from ([^.,]+)/i, category: 'user_info', subject: 'location' },
      { pattern: /i work (?:at|for) ([^.,]+)/i, category: 'work', subject: 'employer' },
      { pattern: /i work as (?:a |an )?([^.,]+)/i, category: 'work', subject: 'role' },
      { pattern: /my job is ([^.,]+)/i, category: 'work', subject: 'role' },
    ];

    for (const { pattern, category, subject } of patterns) {
      const match = userMessage.match(pattern);
      if (match && match[1]) {
        this.memory.saveFact(category, subject, match[1].trim());
        console.log(`[AgentManager] Extracted fact: [${category}] ${subject}: ${match[1]}`);
      }
    }
  }

  // ============ Public API ============

  getStats(
    sessionId?: string
  ):
    | (ReturnType<MemoryManager['getStats']> & { contextTokens?: number; contextWindow?: number })
    | null {
    const stats = this.memory?.getStats(sessionId);
    if (!stats) return null;
    const contextUsage = sessionId ? this.contextUsageBySession.get(sessionId) : undefined;
    return {
      ...stats,
      contextTokens: contextUsage?.contextTokens,
      contextWindow: contextUsage?.contextWindow,
    };
  }

  clearConversation(sessionId?: string): void {
    this.memory?.clearConversation(sessionId);
    if (sessionId && this.chatEngine) {
      this.chatEngine.clearSession(sessionId);
    }
    console.log(
      '[AgentManager] Conversation cleared' + (sessionId ? ` (session: ${sessionId})` : '')
    );
  }

  getMemory(): MemoryManager | null {
    return this.memory;
  }

  searchFacts(queryStr: string): Array<{ category: string; subject: string; content: string }> {
    return this.memory?.searchFacts(queryStr) || [];
  }

  saveFact(category: string, subject: string, content: string): void {
    this.memory?.saveFact(category, subject, content);
  }

  /**
   * Get the assembled General mode system prompt for display in the UI.
   */
  getSystemPrompt(): { staticPrompt: string; dynamicPrompt: string } | null {
    if (!this.chatEngine) return null;
    return this.chatEngine.buildSystemPrompt();
  }

  /**
   * Get only developer-controlled prompt sections (Ken's Settings + Capabilities).
   * Excludes user-editable content and dynamic injections.
   */
  getDeveloperPrompt(): string | null {
    if (!this.chatEngine) return null;
    return this.chatEngine.getDeveloperPrompt();
  }

  getAllFacts(): Array<{ id: number; category: string; subject: string; content: string }> {
    return this.memory?.getAllFacts() || [];
  }

  getDailyLogsSince(days: number = 3): DailyLog[] {
    return this.memory?.getDailyLogsSince(days) || [];
  }

  getRecentMessages(limit: number = 10, sessionId: string = 'default'): Message[] {
    return this.memory?.getRecentMessages(limit, sessionId) || [];
  }

  cleanup(): void {
    this.closeAllPersistentSessions();
    closeBrowserManager();
    console.log('[AgentManager] Cleanup complete');
  }
}

export const AgentManager = AgentManagerClass.getInstance();
