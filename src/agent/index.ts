import { MemoryManager, Message, SmartContextOptions } from '../memory';
import { buildMCPServers, buildSdkMcpServers, setMemoryManager, ToolsConfig, validateToolsConfig, setCurrentSessionId } from '../tools';
import { closeBrowserManager } from '../browser';
import { loadIdentity } from '../config/identity';
import { loadInstructions } from '../config/instructions';
import { SettingsManager } from '../settings';
import { EventEmitter } from 'events';

// Token limits - defaults, can be overridden by settings
const DEFAULT_MAX_CONTEXT_TOKENS = 150000;
const COMPACTION_RATIO = 0.8; // Start compacting at 80% capacity

// Smart context defaults
const DEFAULT_RECENT_MESSAGE_LIMIT = 20;
const DEFAULT_ROLLING_SUMMARY_INTERVAL = 50;
const DEFAULT_SEMANTIC_RETRIEVAL_COUNT = 5;

// Get token limits from settings
function getTokenLimits(): { maxContextTokens: number; compactionThreshold: number } {
  const maxContextTokens = Number(SettingsManager.get('agent.maxContextTokens')) || DEFAULT_MAX_CONTEXT_TOKENS;
  const compactionThreshold = Math.floor(maxContextTokens * COMPACTION_RATIO);
  return { maxContextTokens, compactionThreshold };
}

// Get smart context options from settings
function getSmartContextOptions(currentQuery?: string): SmartContextOptions {
  return {
    recentMessageLimit: Number(SettingsManager.get('agent.recentMessageLimit')) || DEFAULT_RECENT_MESSAGE_LIMIT,
    rollingSummaryInterval: Number(SettingsManager.get('agent.rollingSummaryInterval')) || DEFAULT_ROLLING_SUMMARY_INTERVAL,
    semanticRetrievalCount: Number(SettingsManager.get('agent.semanticRetrievalCount')) || DEFAULT_SEMANTIC_RETRIEVAL_COUNT,
    currentQuery,
  };
}

// Status event types
export type AgentStatus = {
  type: 'thinking' | 'tool_start' | 'tool_end' | 'responding' | 'done' | 'subagent_start' | 'subagent_update' | 'subagent_end' | 'queued' | 'queue_processing';
  toolName?: string;
  toolInput?: string;
  message?: string;
  // Subagent tracking
  agentId?: string;
  agentType?: string;
  agentCount?: number;  // Number of active subagents
  // Queue tracking
  queuePosition?: number;
  queuedMessage?: string;
};

// SDK types (loaded dynamically)
type SDKQuery = AsyncGenerator<unknown, void>;
type SDKOptions = {
  model?: string;
  cwd?: string;
  maxTurns?: number;
  maxThinkingTokens?: number;
  abortController?: AbortController;
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  allowedTools?: string[];
  persistSession?: boolean;
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  mcpServers?: Record<string, unknown>;
  settingSources?: ('project' | 'user')[];  // Load skills from .claude/skills/
};

// Thinking level to token budget mapping
const THINKING_BUDGETS: Record<string, number | undefined> = {
  'none': 0,
  'minimal': 2048,
  'normal': 10000,
  'extended': 32000,
};

// Dynamic SDK loader
let sdkQuery: ((params: { prompt: string; options?: SDKOptions }) => SDKQuery) | null = null;

// Use Function to preserve native import() - TypeScript converts import() to require() in CommonJS
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

async function loadSDK(): Promise<typeof sdkQuery> {
  if (!sdkQuery) {
    const sdk = await dynamicImport('@anthropic-ai/claude-agent-sdk') as { query: typeof sdkQuery };
    sdkQuery = sdk.query;
  }
  return sdkQuery;
}

export interface AgentConfig {
  memory: MemoryManager;
  projectRoot?: string;
  workspace?: string;  // Isolated working directory for agent file operations
  model?: string;
  tools?: ToolsConfig;
}

export interface ProcessResult {
  response: string;
  tokensUsed: number;
  wasCompacted: boolean;
  suggestedPrompt?: string;
}

/**
 * AgentManager - Singleton wrapper around Claude Agent SDK
 */
class AgentManagerClass extends EventEmitter {
  private static instance: AgentManagerClass | null = null;
  private memory: MemoryManager | null = null;
  private projectRoot: string = process.cwd();
  private workspace: string = process.cwd();  // Isolated working directory for agent
  private model: string = 'claude-opus-4-5-20251101';
  private toolsConfig: ToolsConfig | null = null;
  private initialized: boolean = false;
  private identity: string = '';
  private instructions: string = '';
  private abortControllersBySession: Map<string, AbortController> = new Map();
  private processingBySession: Map<string, boolean> = new Map();
  private lastSuggestedPrompt: string | undefined = undefined;
  private messageQueueBySession: Map<string, Array<{ message: string; channel: string; resolve: (result: ProcessResult) => void; reject: (error: Error) => void }>> = new Map();

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
    this.model = config.model || 'claude-opus-4-5-20251101';
    this.toolsConfig = config.tools || null;
    this.initialized = true;

    this.identity = loadIdentity();
    this.instructions = loadInstructions();
    this.memory.setSummarizer(this.createSummary.bind(this));
    setMemoryManager(this.memory);

    console.log('[AgentManager] Initialized');
    console.log('[AgentManager] Project root:', this.projectRoot);
    console.log('[AgentManager] Workspace:', this.workspace);
    console.log('[AgentManager] Model:', this.model);
    console.log('[AgentManager] Identity loaded:', this.identity.length, 'chars');
    console.log('[AgentManager] Instructions loaded:', this.instructions.length, 'chars');

    if (this.toolsConfig) {
      const validation = validateToolsConfig(this.toolsConfig);
      if (!validation.valid) {
        console.warn('[AgentManager] Tool config issues:', validation.errors);
      }

      if (this.toolsConfig.browser.enabled) {
        console.log('[AgentManager] Browser: 2-tier (Electron, CDP)');
      }
    }

    // Backfill message embeddings asynchronously (for semantic retrieval)
    this.backfillMessageEmbeddings().catch(e => {
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

  async processMessage(
    userMessage: string,
    channel: string = 'default',
    sessionId: string = 'default'
  ): Promise<ProcessResult> {
    if (!this.memory) {
      throw new Error('AgentManager not initialized - call initialize() first');
    }

    // If already processing, queue the message
    if (this.processingBySession.get(sessionId)) {
      return this.queueMessage(userMessage, channel, sessionId);
    }

    return this.executeMessage(userMessage, channel, sessionId);
  }

  /**
   * Queue a message to be processed after the current one finishes
   */
  private queueMessage(
    userMessage: string,
    channel: string,
    sessionId: string
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      // Get or create queue for this session
      if (!this.messageQueueBySession.has(sessionId)) {
        this.messageQueueBySession.set(sessionId, []);
      }
      const queue = this.messageQueueBySession.get(sessionId)!;

      // Add to queue
      queue.push({ message: userMessage, channel, resolve, reject });

      const queuePosition = queue.length;
      console.log(`[AgentManager] Message queued at position ${queuePosition} for session ${sessionId}`);

      // Emit queued status
      this.emitStatus({
        type: 'queued',
        queuePosition,
        queuedMessage: userMessage.slice(0, 100),
        message: `Message queued (#${queuePosition})`,
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
    console.log(`[AgentManager] Processing queued message for session ${sessionId}, ${queue.length} remaining`);

    // Emit status that we're processing a queued message
    this.emitStatus({
      type: 'queue_processing',
      queuedMessage: next.message.slice(0, 100),
      message: 'Processing queued message...',
    });

    try {
      const result = await this.executeMessage(next.message, next.channel, sessionId);
      next.resolve(result);
    } catch (error) {
      next.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Actually execute a message (internal implementation)
   */
  private async executeMessage(
    userMessage: string,
    channel: string,
    sessionId: string
  ): Promise<ProcessResult> {
    // Memory should already be checked by processMessage, but guard anyway
    if (!this.memory) {
      throw new Error('AgentManager not initialized - call initialize() first');
    }

    const memory = this.memory; // Local reference for TypeScript narrowing

    this.processingBySession.set(sessionId, true);
    const abortController = new AbortController();
    this.abortControllersBySession.set(sessionId, abortController);
    this.lastSuggestedPrompt = undefined;
    let wasCompacted = false;

    // Set session context for MCP tools to use
    setCurrentSessionId(sessionId);

    try {
      // Use smart context: recent messages + rolling summary + semantic retrieval
      const smartContextOptions = getSmartContextOptions(userMessage);
      const smartContext = await memory.getSmartContext(sessionId, smartContextOptions);
      const factsContext = memory.getFactsForContext();

      console.log(`[AgentManager] Smart context: ${smartContext.stats.recentCount} recent, ${smartContext.stats.summarizedMessages} summarized, ${smartContext.stats.relevantCount} relevant (${smartContext.totalTokens} tokens)`);

      const contextParts: string[] = [];

      // Add rolling summary of older conversations
      if (smartContext.rollingSummary) {
        contextParts.push(`[Summary of previous conversations]\n${smartContext.rollingSummary}`);
      }

      // Add semantically relevant past messages
      if (smartContext.relevantMessages.length > 0) {
        const relevantText = smartContext.relevantMessages
          .map(m => {
            const timeStr = m.timestamp ? this.formatMessageTimestamp(m.timestamp) : '';
            const prefix = timeStr ? `${m.role.toUpperCase()} [${timeStr}]` : m.role.toUpperCase();
            return `${prefix}: ${m.content}`;
          })
          .join('\n\n');
        contextParts.push(`[Relevant past context]\n${relevantText}`);
      }

      // Add recent conversation
      if (smartContext.recentMessages.length > 0) {
        const historyText = smartContext.recentMessages
          .map(m => {
            const timeStr = m.timestamp ? this.formatMessageTimestamp(m.timestamp) : '';
            const prefix = timeStr ? `${m.role.toUpperCase()} [${timeStr}]` : m.role.toUpperCase();
            return `${prefix}: ${m.content}`;
          })
          .join('\n\n');
        contextParts.push(`[Recent conversation]\n${historyText}`);
      }

      const fullPrompt = contextParts.length > 0
        ? `${contextParts.join('\n\n---\n\n')}\n\n---\n\nUser: ${userMessage}`
        : userMessage;

      const query = await loadSDK();
      if (!query) throw new Error('Failed to load SDK');

      // Get last user message timestamp for temporal context
      const userMessages = smartContext.recentMessages.filter(m => m.role === 'user');
      const lastUserMessageTimestamp = userMessages.length > 0
        ? userMessages[userMessages.length - 1].timestamp
        : undefined;

      const options = await this.buildOptions(factsContext, abortController, lastUserMessageTimestamp);

      console.log('[AgentManager] Calling query() with model:', options.model, 'thinking:', options.maxThinkingTokens || 'default');
      this.emitStatus({ type: 'thinking', message: 'hmm let me think 🤔' });

      const queryResult = query({ prompt: fullPrompt, options });
      let response = '';

      for await (const message of queryResult) {
        // Check if aborted
        if (abortController.signal.aborted) {
          console.log('[AgentManager] Query aborted by user');
          throw new Error('Query stopped by user');
        }
        this.processStatusFromMessage(message);
        response = this.extractFromMessage(message, response);
      }

      this.emitStatus({ type: 'done' });

      if (!response) {
        response = 'I processed your request but have no text response.';
      }

      // Skip saving HEARTBEAT_OK responses from scheduled jobs to memory/chat
      const isScheduledJob = channel.startsWith('cron:');
      const isHeartbeat = response.toUpperCase().includes('HEARTBEAT_OK');

      if (isScheduledJob && isHeartbeat) {
        console.log('[AgentManager] Skipping HEARTBEAT_OK from scheduled job - not saving to memory');
      } else {
        // Strip the heartbeat instruction suffix from scheduled job messages before saving
        // This is purely an LLM instruction and should not be shown in the UI
        const heartbeatSuffix = '\n\nIf nothing needs attention, reply with only HEARTBEAT_OK.';
        const messageToSave = userMessage.endsWith(heartbeatSuffix)
          ? userMessage.slice(0, -heartbeatSuffix.length)
          : userMessage;

        const userMsgId = memory.saveMessage('user', messageToSave, sessionId);
        const assistantMsgId = memory.saveMessage('assistant', response, sessionId);
        console.log('[AgentManager] Saved messages to SQLite (session: ' + sessionId + ')');

        // Embed messages asynchronously for future semantic retrieval
        // Don't await - let it run in background
        memory.embedMessage(userMsgId).catch(e => console.error('[AgentManager] Failed to embed user message:', e));
        memory.embedMessage(assistantMsgId).catch(e => console.error('[AgentManager] Failed to embed assistant message:', e));
      }

      this.extractAndStoreFacts(userMessage);

      const statsAfter = memory.getStats();

      return {
        response,
        tokensUsed: statsAfter.estimatedTokens,
        wasCompacted,
        suggestedPrompt: this.lastSuggestedPrompt,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[AgentManager] Query failed:', errorMsg);
      if (error instanceof Error && error.stack) {
        console.error('[AgentManager] Stack trace:', error.stack);
      }
      // Log full error object for debugging
      console.error('[AgentManager] Full error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));

      // Only save user message if not aborted
      if (!abortController.signal.aborted) {
        memory.saveMessage('user', userMessage, sessionId);
      }

      throw error;
    } finally {
      this.processingBySession.set(sessionId, false);
      this.abortControllersBySession.delete(sessionId);

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
      queue.length = 0;
      console.log(`[AgentManager] Queue cleared for session ${sessionId}`);
    }
  }

  /**
   * Stop the query for a specific session (or any running query if no sessionId)
   * Also clears any queued messages for that session
   */
  stopQuery(sessionId?: string, clearQueuedMessages: boolean = true): boolean {
    if (sessionId) {
      // Clear the queue first
      if (clearQueuedMessages) {
        this.clearQueue(sessionId);
      }

      const abortController = this.abortControllersBySession.get(sessionId);
      if (this.processingBySession.get(sessionId) && abortController) {
        console.log(`[AgentManager] Stopping query for session ${sessionId}...`);
        abortController.abort();
        this.emitStatus({ type: 'done' });
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
        const abortController = this.abortControllersBySession.get(sid);
        if (abortController) {
          console.log(`[AgentManager] Stopping query for session ${sid}...`);
          abortController.abort();
          this.emitStatus({ type: 'done' });
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
    if (sessionId) {
      return this.processingBySession.get(sessionId) || false;
    }
    // Check if any session is processing
    for (const isProcessing of this.processingBySession.values()) {
      if (isProcessing) return true;
    }
    return false;
  }

  private async buildOptions(factsContext: string, abortController: AbortController, lastMessageTimestamp?: string): Promise<SDKOptions> {
    const appendParts: string[] = [];

    // Add temporal context first (current time awareness)
    const temporalContext = this.buildTemporalContext(lastMessageTimestamp);
    appendParts.push(temporalContext);

    if (this.instructions) {
      appendParts.push(this.instructions);
    }

    if (this.identity) {
      appendParts.push(this.identity);
    }

    // Add user profile from settings
    const userProfile = SettingsManager.getFormattedProfile();
    if (userProfile) {
      appendParts.push(userProfile);
    }

    if (factsContext) {
      appendParts.push(factsContext);
    }

    // Add daily logs context (recent activity journal)
    const dailyLogsContext = this.memory?.getDailyLogsContext(3);
    if (dailyLogsContext) {
      appendParts.push(dailyLogsContext);
    }

    // Add capabilities information
    const capabilities = this.buildCapabilitiesPrompt();
    if (capabilities) {
      appendParts.push(capabilities);
    }

    // Get thinking level and convert to token budget
    const thinkingLevel = SettingsManager.get('agent.thinkingLevel') || 'normal';
    const thinkingBudget = THINKING_BUDGETS[thinkingLevel];

    const options: SDKOptions = {
      model: this.model,
      cwd: this.workspace,  // Use isolated workspace for agent file operations
      maxTurns: 20,
      ...(thinkingBudget !== undefined && thinkingBudget > 0 && { maxThinkingTokens: thinkingBudget }),
      abortController,
      tools: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project'],  // Load skills from .claude/skills/
      allowedTools: [
        // Built-in SDK tools
        'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
        'Skill',  // Enable skills from .claude/skills/
        // Custom MCP tools - browser & system
        'mcp__pocket-agent__browser',
        'mcp__pocket-agent__notify',
        'mcp__pocket-agent__pty_exec',
        // Custom MCP tools - memory
        'mcp__pocket-agent__remember',
        'mcp__pocket-agent__forget',
        'mcp__pocket-agent__list_facts',
        'mcp__pocket-agent__memory_search',
        'mcp__pocket-agent__daily_log',
        // Custom MCP tools - scheduler
        'mcp__pocket-agent__schedule_task',
        'mcp__pocket-agent__list_scheduled_tasks',
        'mcp__pocket-agent__delete_scheduled_task',
        // Custom MCP tools - calendar
        'mcp__pocket-agent__calendar_add',
        'mcp__pocket-agent__calendar_list',
        'mcp__pocket-agent__calendar_upcoming',
        'mcp__pocket-agent__calendar_delete',
        // Custom MCP tools - tasks
        'mcp__pocket-agent__task_add',
        'mcp__pocket-agent__task_list',
        'mcp__pocket-agent__task_complete',
        'mcp__pocket-agent__task_delete',
        'mcp__pocket-agent__task_due',
      ],
      persistSession: false,
    };

    if (appendParts.length > 0) {
      options.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: appendParts.join('\n\n'),
      };
    }

    if (this.toolsConfig) {
      // Build child process MCP servers (e.g., computer use)
      const mcpServers = buildMCPServers(this.toolsConfig);

      // Build SDK MCP servers (in-process tools like browser, notify, memory)
      const sdkMcpServers = await buildSdkMcpServers(this.toolsConfig);

      // Merge both types
      const allServers = {
        ...mcpServers,
        ...(sdkMcpServers || {}),
      };

      if (Object.keys(allServers).length > 0) {
        options.mcpServers = allServers;
        console.log('[AgentManager] MCP servers:', Object.keys(allServers).join(', '));
      }
    }

    return options;
  }

  private buildCapabilitiesPrompt(): string {
    return `## Your Capabilities as Pocket Agent

You are a persistent personal AI assistant with special capabilities.

### Your Workspace
Your working directory is: ${this.workspace}
This is an isolated environment separate from the application code.
All file operations (reading, writing, creating projects) happen here by default.
Feel free to create subdirectories, projects, and files as needed.

### Scheduling & Reminders
Use the schedule_task tool to create reminders. Three schedule formats are supported:

- One-time: "in 10 minutes", "in 2 hours", "tomorrow 3pm", "monday 9am"
- Interval: "30m", "2h", "1d" (runs every X)
- Cron: "0 9 * * *" (minute hour day month weekday)

Examples:
- schedule_task(name="call_mom", schedule="in 2 hours", prompt="Time to call mom!")
- schedule_task(name="water", schedule="2h", prompt="Time to drink water!")
- schedule_task(name="standup", schedule="0 9 * * 1-5", prompt="Daily standup time")

Use list_scheduled_tasks to see all scheduled tasks.
Use delete_scheduled_task to remove a task.

RULES:
- Use short, clean names (water, standup, break) - NO timestamps
- One-time jobs auto-delete after running

### Calendar Events
Use calendar tools to manage events with reminders:

- calendar_add: Create an event with optional reminder
- calendar_list: List events for a date
- calendar_upcoming: Show upcoming events
- calendar_delete: Remove an event

Time formats: "today 3pm", "tomorrow 9am", "monday 2pm", "in 2 hours", ISO format
Reminders trigger automatically before the event starts.

### Tasks / Todos
Use task tools to manage tasks with due dates and priorities:

- task_add: Create a task with optional due date, priority (low/medium/high), reminder
- task_list: List tasks by status (pending/completed/all)
- task_complete: Mark a task as done
- task_delete: Remove a task
- task_due: Show tasks due soon

Priorities: low, medium, high
Status: pending, in_progress, completed

### Memory & Facts
You have persistent memory! PROACTIVELY save important info when the user shares it.

Use memory tools:
- remember: Save a fact (category, key, value)
- forget: Delete a fact
- list_facts: List all facts or by category
- memory_search: Search facts by keyword

Categories: user_info, preferences, projects, people, work, notes, decisions

IMPORTANT: Save facts PROACTIVELY when user mentions:
- Personal info (name, birthday, location)
- Preferences (favorite things, likes/dislikes)
- Projects they're working on
- People important to them
- Work/job details

### Browser Automation
You have a browser tool for JS rendering and authenticated sessions:

\`\`\`
Actions:
- navigate: Go to URL
- screenshot: Capture page image
- click: Click an element
- type: Enter text in input
- evaluate: Run JavaScript
- extract: Get page data (text/html/links/tables/structured)
- scroll: Scroll page or element (up/down/left/right)
- hover: Hover over element (triggers dropdowns)
- download: Download a file
- upload: Upload file to input
- tabs_list: List open tabs (CDP tier only)
- tabs_open: Open new tab (CDP tier only)
- tabs_close: Close a tab (CDP tier only)
- tabs_focus: Switch to tab (CDP tier only)

Tiers:
- Electron (default): Hidden window for JS rendering
- CDP: Connects to user's Chrome for logged-in sessions + multi-tab

Set requires_auth=true for pages needing login.
For CDP, user must start Chrome with: --remote-debugging-port=9222
\`\`\`

### Native Notifications
You can send native desktop notifications:

\`\`\`bash
# Use the notify tool to alert the user
notify(title="Task Complete", body="Your download has finished")
notify(title="Reminder", body="Meeting in 5 minutes", urgency="critical")
\`\`\`

### Interactive Commands (PTY)
For interactive CLI commands that need a terminal:

\`\`\`bash
# Use pty_exec instead of Bash when you need:
# - Interactive prompts (npm init, git interactive)
# - Commands that require TTY
# - Colored output
pty_exec(command="npm init")
pty_exec(command="htop", timeout=30000)
\`\`\`

### Limitations
- Cannot send SMS or make calls
- For full desktop automation, user needs to enable Computer Use (Docker-based)`;
  }

  private extractFromMessage(message: unknown, current: string): string {
    const msg = message as { type?: string; message?: { content?: unknown }; output?: string; result?: string };
    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        const textBlocks = content
          .filter((block: unknown) => (block as { type?: string })?.type === 'text')
          .map((block: unknown) => (block as { text: string }).text);
        const text = textBlocks.join('\n');
        // Extract and strip any trailing "User:" suggested prompts
        const { text: cleanedText, suggestion } = this.extractSuggestedPrompt(text);
        if (suggestion) {
          this.lastSuggestedPrompt = suggestion;
        }
        return cleanedText;
      }
    }

    if (msg.type === 'result') {
      const result = msg.output || msg.result;
      if (result) {
        // Extract and strip any trailing "User:" suggested prompts from result
        const { text: cleanedText, suggestion } = this.extractSuggestedPrompt(result);
        if (suggestion) {
          this.lastSuggestedPrompt = suggestion;
        }
        return cleanedText;
      }
    }

    return current;
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
        console.log('[AgentManager] Rejected invalid suggestion (assistant-style):', suggestion);
        return { text: cleanedText }; // Strip but don't use as suggestion
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
    const assistantPatterns = /^(what|how|would|do|does|is|are|can|could|shall|should|may|might|let me|i can|i'll|i will|here's|here is)/i;
    if (assistantPatterns.test(suggestion)) return false;

    // Reject if it's too long (likely not a simple user command)
    if (suggestion.length > 100) return false;

    // Accept short, command-like suggestions
    return true;
  }

  private emitStatus(status: AgentStatus): void {
    this.emit('status', status);
  }

  // Track active subagents
  private activeSubagents: Map<string, { type: string; description: string }> = new Map();

  private processStatusFromMessage(message: unknown): void {
    // Handle tool use from assistant messages
    const msg = message as { type?: string; subtype?: string; message?: { content?: unknown } };
    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use') {
            const rawName = block.name as string;
            const toolName = this.formatToolName(rawName);
            const toolInput = this.formatToolInput(block.input);

            // Check if this is a Task (subagent) tool
            if (rawName === 'Task') {
              const input = block.input as { subagent_type?: string; description?: string; prompt?: string };
              const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              const agentType = input.subagent_type || 'general';
              const description = input.description || input.prompt?.slice(0, 50) || 'working on it';

              this.activeSubagents.set(agentId, { type: agentType, description });

              this.emitStatus({
                type: 'subagent_start',
                agentId,
                agentType,
                toolInput: description,
                agentCount: this.activeSubagents.size,
                message: this.getSubagentMessage(agentType),
              });
            } else {
              this.emitStatus({
                type: 'tool_start',
                toolName,
                toolInput,
                message: `Using ${toolName}...`,
              });
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
            // Check if any subagents completed
            if (this.activeSubagents.size > 0) {
              // Remove one subagent (we don't have exact ID matching, so remove oldest)
              const firstKey = this.activeSubagents.keys().next().value;
              if (firstKey) {
                this.activeSubagents.delete(firstKey);
              }

              if (this.activeSubagents.size > 0) {
                // Still have active subagents
                this.emitStatus({
                  type: 'subagent_update',
                  agentCount: this.activeSubagents.size,
                  message: `${this.activeSubagents.size} helper${this.activeSubagents.size > 1 ? 's' : ''} still working 🔄`,
                });
              } else {
                this.emitStatus({
                  type: 'subagent_end',
                  agentCount: 0,
                  message: 'helpers done, processing... ✨',
                });
              }
            } else {
              this.emitStatus({
                type: 'tool_end',
                message: 'got it, thinking... 💭',
              });
            }
          }
        }
      }
    }

    // Handle system messages
    if (msg.type === 'system') {
      if (msg.subtype === 'init') {
        this.emitStatus({ type: 'thinking', message: 'Initializing...' });
      }
    }
  }

  private getSubagentMessage(agentType: string): string {
    const messages: Record<string, string> = {
      'Explore': 'sent out a scout to explore 🔭',
      'Plan': 'calling in the architect 📐',
      'Bash': 'spawning a terminal wizard 🧙',
      'general-purpose': 'summoning a helper 🤖',
    };
    return messages[agentType] || `spawning ${agentType} agent 🚀`;
  }

  private formatToolName(name: string): string {
    // Fun, casual tool names that match PA's vibe
    const friendlyNames: Record<string, string> = {
      // SDK built-in tools
      Read: 'peeking at this file 👀',
      Write: 'writing stuff down ✍️',
      Edit: 'tweaking some code',
      Bash: 'running terminal magic 🪄',
      Glob: 'hunting for files 🔍',
      Grep: 'digging through code',
      WebSearch: 'googling it rn',
      WebFetch: 'grabbing that page',
      Task: 'summoning a helper 🧙',
      NotebookEdit: 'editing notebook',

      // Memory tools
      remember: 'saving this to the brain 🧠',
      forget: 'yeeting from memory',
      list_facts: 'checking what i know',
      memory_search: 'searching the archives',

      // Browser tool
      browser: 'doing browser things 🌐',

      // Computer use tool
      computer: 'taking over the desktop 🖥️',

      // Scheduler tools
      schedule_task: 'setting a reminder ⏰',
      list_scheduled_tasks: 'checking the schedule',
      delete_scheduled_task: 'nuking that reminder',

      // macOS tools
      notify: 'sending a ping 🔔',
      pty_exec: 'running fancy terminal stuff',

      // Task tools
      task_add: 'adding to the todo list ✅',
      task_list: 'checking your tasks',
      task_complete: 'marking it done 🎉',
      task_delete: 'removing that task',
      task_due: 'checking what\'s due',

      // Calendar tools
      calendar_add: 'adding to calendar 📅',
      calendar_list: 'checking the calendar',
      calendar_upcoming: 'seeing what\'s coming up',
      calendar_delete: 'removing that event',
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

    return '';
  }

  private async runCompaction(sessionId: string = 'default'): Promise<void> {
    if (!this.memory) return;

    console.log('[AgentManager] Running compaction for session:', sessionId);

    // Before compaction, extract and save important facts from recent messages
    await this.extractFactsBeforeCompaction(sessionId);

    const { maxContextTokens } = getTokenLimits();
    await this.memory.getConversationContext(maxContextTokens, sessionId);
    const stats = this.memory.getStats(sessionId);
    console.log(`[AgentManager] Compaction complete. Now at ${stats.estimatedTokens} tokens`);
  }

  /**
   * Extract important facts from recent conversation before compaction
   */
  private async extractFactsBeforeCompaction(sessionId: string = 'default'): Promise<void> {
    if (!this.memory) return;

    try {
      const query = await loadSDK();
      if (!query) return;

      // Get recent messages that haven't been processed for facts
      const recentMessages = this.memory.getRecentMessages(30, sessionId);
      if (recentMessages.length < 5) return;

      const conversationText = recentMessages
        .map(m => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n\n');

      const extractionPrompt = `Analyze this conversation and extract important facts about the user that should be saved to long-term memory. Only extract concrete, specific information - not general conversation topics.

Focus on:
- Personal info (name, location, job, etc.)
- Preferences and opinions
- Projects and goals
- Important dates or deadlines
- Relationships and people mentioned
- Decisions made

For each fact, output in this exact format (one per line):
FACT|category|subject|content

Categories: user_info, preferences, projects, people, work, notes, decisions

Example:
FACT|user_info|name|John Smith
FACT|work|employer|Works at Acme Corp as a software engineer
FACT|preferences|coffee|Prefers oat milk lattes

If no important facts are found, output: NO_FACTS

Conversation:
${conversationText}`;

      const options: SDKOptions = {
        model: 'claude-haiku-4-5-20251001',
        maxTurns: 1,
        abortController: new AbortController(),
        tools: [],
        persistSession: false,
      };

      const queryResult = query({ prompt: extractionPrompt, options });
      let response = '';

      for await (const message of queryResult) {
        response = this.extractFromMessage(message, response);
      }

      if (!response || response.includes('NO_FACTS')) {
        console.log('[AgentManager] No new facts extracted before compaction');
        return;
      }

      // Parse and save facts
      const lines = response.split('\n').filter(line => line.startsWith('FACT|'));
      let savedCount = 0;

      for (const line of lines) {
        const parts = line.split('|');
        if (parts.length >= 4) {
          const [, category, subject, ...contentParts] = parts;
          const content = contentParts.join('|').trim();

          if (category && subject && content) {
            this.memory.saveFact(category.trim(), subject.trim(), content);
            savedCount++;
          }
        }
      }

      if (savedCount > 0) {
        console.log(`[AgentManager] Extracted ${savedCount} facts before compaction`);
      }
    } catch (error) {
      console.error('[AgentManager] Fact extraction before compaction failed:', error);
      // Don't block compaction on fact extraction failure
    }
  }

  private async createSummary(messages: Message[]): Promise<string> {
    if (messages.length === 0) {
      return '';
    }

    const conversationText = messages
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n---\n\n');

    try {
      const query = await loadSDK();
      if (!query) throw new Error('Failed to load SDK');

      const summaryPrompt = `Summarize this conversation concisely, preserving key facts about the user (name, preferences, work), important decisions, ongoing tasks, and context needed to continue the conversation:\n\n${conversationText}`;

      const options: SDKOptions = {
        model: 'claude-haiku-4-5-20251001',
        maxTurns: 1,
        abortController: new AbortController(),
        tools: [],
        persistSession: false,
      };

      const queryResult = query({ prompt: summaryPrompt, options });
      let summary = '';

      for await (const message of queryResult) {
        summary = this.extractFromMessage(message, summary);
      }

      console.log(`[AgentManager] Created summary of ${messages.length} messages`);
      return summary || `Previous conversation (${messages.length} messages) summarized.`;
    } catch (error) {
      console.error('[AgentManager] Summarization failed:', error);

      const userMessages = messages.filter(m => m.role === 'user');
      const snippets = userMessages
        .slice(-10)
        .map(m => m.content.slice(0, 100))
        .join('; ');

      return `Previous conversation (${messages.length} messages). Topics discussed: ${snippets}`;
    }
  }

  /**
   * Format a message timestamp for display in conversation context
   * Shows relative time for recent messages, date for older ones
   */
  private formatMessageTimestamp(timestamp: string): string {
    try {
      const date = new Date(timestamp);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      // Very recent: show relative time
      if (diffMins < 1) return 'just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffDays < 7) return `${diffDays}d ago`;

      // Older: show date
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch {
      return '';
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

    const lines = [
      '## Current Time',
      `It is ${dayName}, ${dateStr} at ${timeStr}.`,
    ];

    // Add time since last message if available
    if (lastMessageTimestamp) {
      try {
        const lastDate = new Date(lastMessageTimestamp);
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

  getStats(sessionId?: string): ReturnType<MemoryManager['getStats']> | null {
    return this.memory?.getStats(sessionId) || null;
  }

  clearConversation(sessionId?: string): void {
    this.memory?.clearConversation(sessionId);
    console.log('[AgentManager] Conversation cleared' + (sessionId ? ` (session: ${sessionId})` : ''));
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

  getAllFacts(): Array<{ id: number; category: string; subject: string; content: string }> {
    return this.memory?.getAllFacts() || [];
  }

  getRecentMessages(limit: number = 10, sessionId: string = 'default'): Message[] {
    return this.memory?.getRecentMessages(limit, sessionId) || [];
  }

  getToolsConfig(): ToolsConfig | null {
    return this.toolsConfig;
  }

  cleanup(): void {
    closeBrowserManager();
    console.log('[AgentManager] Cleanup complete');
  }
}

export const AgentManager = AgentManagerClass.getInstance();
export { AgentManagerClass };
