import path from 'path';
import { MemoryManager, Message } from '../memory';
import { buildMCPServers, buildSdkMcpServers, setMemoryManager, ToolsConfig, validateToolsConfig } from '../tools';
import { closeBrowserManager } from '../browser';
import { loadIdentity } from '../config/identity';
import { loadInstructions } from '../config/instructions';
import { SettingsManager } from '../settings';
import { EventEmitter } from 'events';

// Token limits
const MAX_CONTEXT_TOKENS = 150000;
const COMPACTION_THRESHOLD = 120000; // Start compacting at 80% capacity

// Status event types
export type AgentStatus = {
  type: 'thinking' | 'tool_start' | 'tool_end' | 'responding' | 'done';
  toolName?: string;
  toolInput?: string;
  message?: string;
};

// SDK types (loaded dynamically)
type SDKQuery = AsyncGenerator<unknown, void>;
type SDKOptions = {
  model?: string;
  cwd?: string;
  maxTurns?: number;
  abortController?: AbortController;
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  allowedTools?: string[];
  persistSession?: boolean;
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  mcpServers?: Record<string, unknown>;
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
  private model: string = 'claude-opus-4-5-20251101';
  private toolsConfig: ToolsConfig | null = null;
  private initialized: boolean = false;
  private identity: string = '';
  private instructions: string = '';
  private currentAbortController: AbortController | null = null;
  private isProcessing: boolean = false;
  private lastSuggestedPrompt: string | undefined = undefined;

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
    this.model = config.model || 'claude-opus-4-5-20251101';
    this.toolsConfig = config.tools || null;
    this.initialized = true;

    this.identity = loadIdentity();
    this.instructions = loadInstructions();
    this.memory.setSummarizer(this.createSummary.bind(this));
    setMemoryManager(this.memory);

    console.log('[AgentManager] Initialized');
    console.log('[AgentManager] Project root:', this.projectRoot);
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
  }

  isInitialized(): boolean {
    return this.initialized && this.memory !== null;
  }

  async processMessage(
    userMessage: string,
    _channel: string = 'default'
  ): Promise<ProcessResult> {
    if (!this.memory) {
      throw new Error('AgentManager not initialized - call initialize() first');
    }

    if (this.isProcessing) {
      throw new Error('A message is already being processed');
    }

    this.isProcessing = true;
    this.currentAbortController = new AbortController();
    this.lastSuggestedPrompt = undefined;
    let wasCompacted = false;

    try {
      const statsBefore = this.memory.getStats();
      if (statsBefore.estimatedTokens > COMPACTION_THRESHOLD) {
        console.log('[AgentManager] Token limit approaching, running compaction...');
        await this.runCompaction();
        wasCompacted = true;
      }

      const context = await this.memory.getConversationContext(MAX_CONTEXT_TOKENS);
      const factsContext = this.memory.getFactsForContext();

      console.log(`[AgentManager] Loaded ${context.messages.length} messages (${context.totalTokens} tokens)`);

      const contextParts: string[] = [];

      if (context.messages.length > 0) {
        const historyText = context.messages
          .map(m => `${m.role.toUpperCase()}: ${m.content}`)
          .join('\n\n');
        contextParts.push(`Previous conversation:\n${historyText}`);
      }

      const fullPrompt = contextParts.length > 0
        ? `${contextParts.join('\n\n---\n\n')}\n\n---\n\nUser: ${userMessage}`
        : userMessage;

      const query = await loadSDK();
      if (!query) throw new Error('Failed to load SDK');

      const options = await this.buildOptions(factsContext);

      console.log('[AgentManager] Calling query()...');
      this.emitStatus({ type: 'thinking', message: 'Processing...' });

      const queryResult = query({ prompt: fullPrompt, options });
      let response = '';

      for await (const message of queryResult) {
        // Check if aborted
        if (this.currentAbortController?.signal.aborted) {
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

      this.memory.saveMessage('user', userMessage);
      this.memory.saveMessage('assistant', response);

      console.log('[AgentManager] Saved messages to SQLite');

      this.extractAndStoreFacts(userMessage);

      const statsAfter = this.memory.getStats();

      return {
        response,
        tokensUsed: statsAfter.estimatedTokens,
        wasCompacted,
        suggestedPrompt: this.lastSuggestedPrompt,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[AgentManager] Query failed:', errorMsg);

      // Only save user message if not aborted
      if (!this.currentAbortController?.signal.aborted) {
        this.memory.saveMessage('user', userMessage);
      }

      throw error;
    } finally {
      this.isProcessing = false;
      this.currentAbortController = null;
    }
  }

  /**
   * Stop the currently running query
   */
  stopQuery(): boolean {
    if (this.isProcessing && this.currentAbortController) {
      console.log('[AgentManager] Stopping current query...');
      this.currentAbortController.abort();
      this.emitStatus({ type: 'done' });
      return true;
    }
    return false;
  }

  /**
   * Check if a query is currently processing
   */
  isQueryProcessing(): boolean {
    return this.isProcessing;
  }

  private async buildOptions(factsContext: string): Promise<SDKOptions> {
    const appendParts: string[] = [];

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

    // Add capabilities information
    const capabilities = this.buildCapabilitiesPrompt();
    if (capabilities) {
      appendParts.push(capabilities);
    }

    const options: SDKOptions = {
      model: this.model,
      cwd: this.projectRoot,
      maxTurns: 20,
      abortController: this.currentAbortController || new AbortController(),
      tools: { type: 'preset', preset: 'claude_code' },
      allowedTools: [
        // Built-in SDK tools
        'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
        // Custom MCP tools - browser & system
        'mcp__pocket-agent__browser',
        'mcp__pocket-agent__notify',
        'mcp__pocket-agent__pty_exec',
        // Custom MCP tools - memory
        'mcp__pocket-agent__remember',
        'mcp__pocket-agent__forget',
        'mcp__pocket-agent__list_facts',
        'mcp__pocket-agent__memory_search',
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
    const cliPath = path.join(this.projectRoot, 'dist/cli/scheduler-cli.js');

    return `## Your Capabilities as Pocket Agent

You are a persistent personal AI assistant with special capabilities.

### Scheduling & Reminders
You CAN create scheduled tasks and reminders! Three schedule types are supported:

\`\`\`bash
# ONE-TIME reminder (auto-deletes after running)
node "${cliPath}" add "call_mom" "in 2 hours" "Time to call mom!"
node "${cliPath}" add "meeting_prep" "tomorrow 9am" "Prepare for the meeting"

# RECURRING with interval
node "${cliPath}" add "water" "2h" "Time to drink water!"
node "${cliPath}" add "break" "30m" "Take a short break"

# RECURRING with cron expression
node "${cliPath}" add "standup" "0 9 * * 1-5" "Daily standup time" --channel desktop

# With context (includes recent messages in the prompt)
node "${cliPath}" add "followup" "in 1 hour" "Follow up on our conversation" --context 5

# List/delete/status
node "${cliPath}" list
node "${cliPath}" delete "water"
node "${cliPath}" status
\`\`\`

Schedule formats:
- One-time: "in 2 hours", "tomorrow 3pm", "monday 9am"
- Interval: "30m", "2h", "1d" (runs every X)
- Cron: "0 9 * * *" (minute hour day month weekday)

Options:
- --context N: Include last N messages as context (max 10)
- --channel: "desktop" or "telegram"

RULES:
- Use short, clean names (water, standup, break) - NO timestamps
- One-time jobs auto-delete after running
- Do NOT run npm/yarn - CLI is ready to use

### Calendar Events
You can manage calendar events with reminders:

\`\`\`bash
# Add an event
node "${path.join(this.projectRoot, 'dist/cli/calendar-cli.js')}" add "Team meeting" "tomorrow 2pm" --reminder 15
node "${path.join(this.projectRoot, 'dist/cli/calendar-cli.js')}" add "Lunch with Sarah" "today 12pm" --end "today 1pm" --location "Cafe"

# List events
node "${path.join(this.projectRoot, 'dist/cli/calendar-cli.js')}" list today
node "${path.join(this.projectRoot, 'dist/cli/calendar-cli.js')}" upcoming 24

# Delete event
node "${path.join(this.projectRoot, 'dist/cli/calendar-cli.js')}" delete <id>
\`\`\`

Time formats: "today 3pm", "tomorrow 9am", "monday 2pm", "in 2 hours", ISO format
Reminders trigger automatically before the event starts.

### Tasks / Todos
You can manage tasks with due dates and priorities:

\`\`\`bash
# Add a task
node "${path.join(this.projectRoot, 'dist/cli/tasks-cli.js')}" add "Buy groceries" --due "tomorrow" --priority high
node "${path.join(this.projectRoot, 'dist/cli/tasks-cli.js')}" add "Call mom" --due "today 5pm" --reminder 30

# List tasks
node "${path.join(this.projectRoot, 'dist/cli/tasks-cli.js')}" list pending
node "${path.join(this.projectRoot, 'dist/cli/tasks-cli.js')}" list all
node "${path.join(this.projectRoot, 'dist/cli/tasks-cli.js')}" due 24

# Complete/delete task
node "${path.join(this.projectRoot, 'dist/cli/tasks-cli.js')}" complete <id>
node "${path.join(this.projectRoot, 'dist/cli/tasks-cli.js')}" delete <id>
\`\`\`

Priorities: low, medium, high
Status: pending, in_progress, completed

### Memory & Facts
You have persistent memory! PROACTIVELY save important info when the user shares it. Use the memory CLI:

\`\`\`bash
# Save a fact (use this PROACTIVELY when user shares info)
node "${path.join(this.projectRoot, 'dist/cli/memory-cli.js')}" save "user_info" "name" "John Smith"
node "${path.join(this.projectRoot, 'dist/cli/memory-cli.js')}" save "preferences" "color" "Favorite color is blue"

# List all facts
node "${path.join(this.projectRoot, 'dist/cli/memory-cli.js')}" list

# List by category
node "${path.join(this.projectRoot, 'dist/cli/memory-cli.js')}" list preferences

# Search facts (fast keyword search)
node "${path.join(this.projectRoot, 'dist/cli/memory-cli.js')}" search "coffee"

# Delete a fact
node "${path.join(this.projectRoot, 'dist/cli/memory-cli.js')}" delete "preferences" "color"
\`\`\`

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

  private processStatusFromMessage(message: unknown): void {
    // Handle tool use from assistant messages
    const msg = message as { type?: string; subtype?: string; message?: { content?: unknown } };
    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use') {
            const toolName = this.formatToolName(block.name);
            const toolInput = this.formatToolInput(block.input);
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

    // Handle tool results
    if (msg.type === 'user' && msg.message?.content) {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_result') {
            this.emitStatus({
              type: 'tool_end',
              message: 'Processing result...',
            });
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

  private formatToolName(name: string): string {
    // Make tool names more user-friendly
    const friendlyNames: Record<string, string> = {
      // SDK built-in tools
      Read: 'Reading file',
      Write: 'Writing file',
      Edit: 'Editing file',
      Bash: 'Running command',
      Glob: 'Searching files',
      Grep: 'Searching code',
      WebSearch: 'Searching web',
      WebFetch: 'Fetching page',
      Task: 'Spawning agent',
      NotebookEdit: 'Editing notebook',

      // Memory tools
      remember: 'Saving to memory',
      forget: 'Removing from memory',
      list_facts: 'Listing facts',
      memory_search: 'Searching memory',

      // Browser tool
      browser: 'Browser automation',

      // Computer use tool
      computer: 'Desktop automation',

      // Scheduler tools
      schedule_task: 'Creating reminder',
      list_scheduled_tasks: 'Listing reminders',
      delete_scheduled_task: 'Deleting reminder',

      // macOS tools
      notify: 'Sending notification',
      pty_exec: 'Running interactive command',
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
    if (inp.coordinate) return `at (${(inp.coordinate as number[])[0]}, ${(inp.coordinate as number[])[1]})`;
    if (inp.text) return `"${(inp.text as string).slice(0, 40)}"`;

    return '';
  }

  private async runCompaction(): Promise<void> {
    if (!this.memory) return;

    console.log('[AgentManager] Running compaction...');

    // Before compaction, extract and save important facts from recent messages
    await this.extractFactsBeforeCompaction();

    await this.memory.getConversationContext(MAX_CONTEXT_TOKENS);
    const stats = this.memory.getStats();
    console.log(`[AgentManager] Compaction complete. Now at ${stats.estimatedTokens} tokens`);
  }

  /**
   * Extract important facts from recent conversation before compaction
   */
  private async extractFactsBeforeCompaction(): Promise<void> {
    if (!this.memory) return;

    try {
      const query = await loadSDK();
      if (!query) return;

      // Get recent messages that haven't been processed for facts
      const recentMessages = this.memory.getRecentMessages(30);
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

  getStats(): ReturnType<MemoryManager['getStats']> | null {
    return this.memory?.getStats() || null;
  }

  clearConversation(): void {
    this.memory?.clearConversation();
    console.log('[AgentManager] Conversation cleared');
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

  getRecentMessages(limit: number = 10): Message[] {
    return this.memory?.getRecentMessages(limit) || [];
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
