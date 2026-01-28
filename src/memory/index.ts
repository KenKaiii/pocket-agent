import Database from 'better-sqlite3';
import {
  initEmbeddings,
  hasEmbeddings,
  embed,
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
} from './embeddings';

// Types
export interface Session {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  token_count?: number;
  session_id?: string;
}

export interface Fact {
  id: number;
  category: string;
  subject: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface CronJob {
  id: number;
  name: string;
  schedule_type?: string;
  schedule: string | null;
  run_at?: string | null;
  interval_ms?: number | null;
  prompt: string;
  channel: string;
  enabled: boolean;
  delete_after_run?: boolean;
  context_messages?: number;
  next_run_at?: string | null;
}

export interface ConversationContext {
  messages: Array<{ role: string; content: string }>;
  totalTokens: number;
  summarizedCount: number;
  summary?: string;
}

export interface SearchResult {
  fact: Fact;
  score: number;
  vectorScore: number;
  keywordScore: number;
}

export interface GraphNode {
  id: number;
  subject: string;
  category: string;
  content: string;
  group: number;
}

export interface GraphLink {
  source: number;
  target: number;
  type: 'category' | 'semantic' | 'keyword';
  strength: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface DailyLog {
  id: number;
  date: string;
  content: string;
  updated_at: string;
}

export interface TelegramChatSession {
  chat_id: number;
  session_id: string;
  group_name: string | null;
  created_at: string;
}

// Summarizer function type - injected to avoid circular dependency with agent
export type SummarizerFn = (messages: Message[]) => Promise<string>;

// Token estimation: ~4 characters per token
const CHARS_PER_TOKEN = 4;
const DEFAULT_TOKEN_LIMIT = 150000;

// Search weights
const VECTOR_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;
const MIN_SCORE_THRESHOLD = 0.35;
const MAX_SEARCH_RESULTS = 6;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export class MemoryManager {
  private db: Database.Database;
  private summarizer?: SummarizerFn;
  private embeddingsReady: boolean = false;

  // Cache for facts context (invalidated on fact changes)
  private factsContextCache: string | null = null;
  private factsContextCacheValid: boolean = false;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      -- Sessions for isolated conversation threads
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Main conversation messages (per-session)
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        timestamp TEXT DEFAULT (datetime('now')),
        token_count INTEGER,
        session_id TEXT REFERENCES sessions(id)
      );

      -- Facts extracted from conversations (long-term memory)
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Embedding chunks linked to facts
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fact_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
      );

      -- Scheduled cron jobs (supports cron/at/every schedule types)
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        schedule_type TEXT NOT NULL DEFAULT 'cron' CHECK(schedule_type IN ('cron', 'at', 'every')),
        schedule TEXT,
        run_at TEXT,
        interval_ms INTEGER,
        prompt TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'desktop',
        enabled INTEGER DEFAULT 1,
        delete_after_run INTEGER DEFAULT 0,
        context_messages INTEGER DEFAULT 0,
        next_run_at TEXT,
        last_run_at TEXT,
        last_status TEXT CHECK(last_status IN ('ok', 'error', 'skipped')),
        last_error TEXT,
        last_duration_ms INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Summaries of older conversation chunks (per-session)
      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_message_id INTEGER NOT NULL,
        end_message_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER,
        session_id TEXT REFERENCES sessions(id),
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Calendar events
      CREATE TABLE IF NOT EXISTS calendar_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        start_time TEXT NOT NULL,
        end_time TEXT,
        all_day INTEGER DEFAULT 0,
        location TEXT,
        reminder_minutes INTEGER DEFAULT 15,
        reminded INTEGER DEFAULT 0,
        channel TEXT DEFAULT 'desktop',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Tasks / Todos
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        due_date TEXT,
        priority TEXT DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')),
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed')),
        reminder_minutes INTEGER,
        reminded INTEGER DEFAULT 0,
        channel TEXT DEFAULT 'desktop',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Daily logs for memory journaling (global across all sessions)
      CREATE TABLE IF NOT EXISTS daily_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT UNIQUE NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Telegram chat to session mapping
      CREATE TABLE IF NOT EXISTS telegram_chat_sessions (
        chat_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        group_name TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
      CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject);
      CREATE INDEX IF NOT EXISTS idx_chunks_fact_id ON chunks(fact_id);
      CREATE INDEX IF NOT EXISTS idx_summaries_range ON summaries(start_message_id, end_message_id);
      CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id);
      CREATE INDEX IF NOT EXISTS idx_calendar_start ON calendar_events(start_time);
      CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_daily_logs_date ON daily_logs(date);

      -- Unique constraint on session names (for Telegram group linking)
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_name_unique ON sessions(name);
    `);

    // Create FTS5 virtual table for keyword search
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
          category,
          subject,
          content,
          content='facts',
          content_rowid='id'
        );
      `);

      // Create triggers to keep FTS index in sync
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
          INSERT INTO facts_fts(rowid, category, subject, content)
          VALUES (new.id, new.category, new.subject, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
          INSERT INTO facts_fts(facts_fts, rowid, category, subject, content)
          VALUES ('delete', old.id, old.category, old.subject, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
          INSERT INTO facts_fts(facts_fts, rowid, category, subject, content)
          VALUES ('delete', old.id, old.category, old.subject, old.content);
          INSERT INTO facts_fts(rowid, category, subject, content)
          VALUES (new.id, new.category, new.subject, new.content);
        END;
      `);
    } catch {
      // FTS5 triggers may already exist
    }

    // Rebuild FTS index from existing facts
    this.rebuildFtsIndex();

    // Migration: add subject column if missing
    const columns = this.db.pragma('table_info(facts)') as Array<{ name: string }>;
    const hasSubject = columns.some(c => c.name === 'subject');
    if (!hasSubject) {
      this.db.exec(`ALTER TABLE facts ADD COLUMN subject TEXT NOT NULL DEFAULT ''`);
      console.log('[Memory] Migrated facts table: added subject column');
    }

    // Migration: add session_id to messages if missing
    const msgColumns = this.db.pragma('table_info(messages)') as Array<{ name: string }>;
    const hasSessionId = msgColumns.some(c => c.name === 'session_id');
    if (!hasSessionId) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN session_id TEXT REFERENCES sessions(id)`);
      console.log('[Memory] Migrated messages table: added session_id column');
    }

    // Migration: add session_id to summaries if missing
    const sumColumns = this.db.pragma('table_info(summaries)') as Array<{ name: string }>;
    const sumHasSessionId = sumColumns.some(c => c.name === 'session_id');
    if (!sumHasSessionId) {
      this.db.exec(`ALTER TABLE summaries ADD COLUMN session_id TEXT REFERENCES sessions(id)`);
      console.log('[Memory] Migrated summaries table: added session_id column');
    }

    // Migration: create default session and migrate orphan messages
    this.migrateToDefaultSession();
  }

  /**
   * Create default session and migrate existing messages without session_id
   */
  private migrateToDefaultSession(): void {
    const DEFAULT_SESSION_ID = 'default';
    const DEFAULT_SESSION_NAME = 'Chat';

    // Check if default session exists
    const existing = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(DEFAULT_SESSION_ID);
    if (!existing) {
      // Create default session
      this.db.prepare(`
        INSERT INTO sessions (id, name, created_at, updated_at)
        VALUES (?, ?, datetime('now'), datetime('now'))
      `).run(DEFAULT_SESSION_ID, DEFAULT_SESSION_NAME);
      console.log('[Memory] Created default session');
    }

    // Migrate orphan messages (no session_id) to default session
    const orphanCount = (this.db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id IS NULL').get() as { c: number }).c;
    if (orphanCount > 0) {
      this.db.prepare('UPDATE messages SET session_id = ? WHERE session_id IS NULL').run(DEFAULT_SESSION_ID);
      console.log(`[Memory] Migrated ${orphanCount} messages to default session`);
    }

    // Migrate orphan summaries to default session
    const orphanSumCount = (this.db.prepare('SELECT COUNT(*) as c FROM summaries WHERE session_id IS NULL').get() as { c: number }).c;
    if (orphanSumCount > 0) {
      this.db.prepare('UPDATE summaries SET session_id = ? WHERE session_id IS NULL').run(DEFAULT_SESSION_ID);
      console.log(`[Memory] Migrated ${orphanSumCount} summaries to default session`);
    }
  }

  /**
   * Rebuild FTS index from existing facts
   */
  private rebuildFtsIndex(): void {
    try {
      // Check if FTS table is empty but facts exist
      const ftsCount = (this.db.prepare('SELECT COUNT(*) as c FROM facts_fts').get() as { c: number }).c;
      const factsCount = (this.db.prepare('SELECT COUNT(*) as c FROM facts').get() as { c: number }).c;

      if (ftsCount === 0 && factsCount > 0) {
        console.log('[Memory] Rebuilding FTS index...');
        const facts = this.db.prepare('SELECT id, category, subject, content FROM facts').all() as Fact[];
        const insert = this.db.prepare('INSERT INTO facts_fts(rowid, category, subject, content) VALUES (?, ?, ?, ?)');

        for (const fact of facts) {
          insert.run(fact.id, fact.category, fact.subject, fact.content);
        }
        console.log(`[Memory] Rebuilt FTS index with ${facts.length} facts`);
      }
    } catch (e) {
      console.warn('[Memory] FTS rebuild failed:', e);
    }
  }

  /**
   * Initialize embeddings with OpenAI API key
   */
  initializeEmbeddings(openaiApiKey: string): void {
    initEmbeddings(openaiApiKey);
    this.embeddingsReady = true;
    console.log('[Memory] Embeddings initialized');

    // Embed any facts that don't have embeddings
    this.embedMissingFacts().catch(err => {
      console.error('[Memory] Failed to embed missing facts:', err);
    });
  }

  /**
   * Embed facts that don't have embeddings yet
   */
  private async embedMissingFacts(): Promise<void> {
    if (!hasEmbeddings()) return;

    const factsWithoutEmbeddings = this.db.prepare(`
      SELECT f.id, f.category, f.subject, f.content
      FROM facts f
      LEFT JOIN chunks c ON f.id = c.fact_id
      WHERE c.id IS NULL
    `).all() as Fact[];

    if (factsWithoutEmbeddings.length === 0) return;

    console.log(`[Memory] Embedding ${factsWithoutEmbeddings.length} facts...`);

    for (const fact of factsWithoutEmbeddings) {
      await this.embedFact(fact);
    }

    console.log('[Memory] Finished embedding facts');
  }

  /**
   * Generate and store embedding for a fact
   */
  private async embedFact(fact: Fact): Promise<void> {
    if (!hasEmbeddings()) return;

    try {
      // Combine fact fields for embedding
      const textToEmbed = `${fact.category}: ${fact.subject} - ${fact.content}`;
      const embedding = await embed(textToEmbed);
      const embeddingBuffer = serializeEmbedding(embedding);

      // Delete existing chunk for this fact
      this.db.prepare('DELETE FROM chunks WHERE fact_id = ?').run(fact.id);

      // Insert new chunk with embedding
      this.db.prepare(`
        INSERT INTO chunks (fact_id, content, embedding)
        VALUES (?, ?, ?)
      `).run(fact.id, textToEmbed, embeddingBuffer);
    } catch (err) {
      console.error(`[Memory] Failed to embed fact ${fact.id}:`, err);
    }
  }

  /**
   * Set the summarizer function
   */
  setSummarizer(fn: SummarizerFn): void {
    this.summarizer = fn;
  }

  // ============ SESSION METHODS ============

  /**
   * Create a new session
   * @throws Error if session name already exists
   */
  createSession(name: string): Session {
    // Check for duplicate name
    const existing = this.getSessionByName(name);
    if (existing) {
      throw new Error(`Session name "${name}" already exists`);
    }

    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(`
      INSERT INTO sessions (id, name, created_at, updated_at)
      VALUES (?, ?, datetime('now'), datetime('now'))
    `).run(id, name);

    return this.getSession(id)!;
  }

  /**
   * Get a session by name (exact match)
   */
  getSessionByName(name: string): Session | null {
    const row = this.db.prepare(`
      SELECT id, name, created_at, updated_at
      FROM sessions
      WHERE name = ?
    `).get(name) as Session | undefined;

    return row || null;
  }

  /**
   * Get a session by ID
   */
  getSession(id: string): Session | null {
    const row = this.db.prepare(`
      SELECT id, name, created_at, updated_at
      FROM sessions
      WHERE id = ?
    `).get(id) as Session | undefined;

    return row || null;
  }

  /**
   * Get all sessions, ordered by most recent activity
   */
  getSessions(): Session[] {
    return this.db.prepare(`
      SELECT id, name, created_at, updated_at
      FROM sessions
      ORDER BY updated_at DESC
    `).all() as Session[];
  }

  /**
   * Rename a session
   * @throws Error if new name already exists
   */
  renameSession(id: string, name: string): boolean {
    // Check for duplicate name (excluding self)
    const existing = this.getSessionByName(name);
    if (existing && existing.id !== id) {
      throw new Error(`Session name "${name}" already exists`);
    }

    const result = this.db.prepare(`
      UPDATE sessions SET name = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(name, id);

    return result.changes > 0;
  }

  /**
   * Delete a session and all its messages/summaries
   */
  deleteSession(id: string): boolean {
    // Don't allow deleting the default session
    if (id === 'default') {
      console.warn('[Memory] Cannot delete the default session');
      return false;
    }

    // Delete related data first (due to foreign key constraints)
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM summaries WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM telegram_chat_sessions WHERE session_id = ?').run(id);
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);

    return result.changes > 0;
  }

  /**
   * Touch session (update updated_at timestamp)
   */
  touchSession(id: string): void {
    this.db.prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(id);
  }

  /**
   * Get session message count
   */
  getSessionMessageCount(sessionId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(sessionId) as { c: number };
    return row.c;
  }

  // ============ TELEGRAM CHAT SESSION METHODS ============

  /**
   * Link a Telegram chat to a session
   */
  linkTelegramChat(chatId: number, sessionId: string, groupName?: string): boolean {
    try {
      this.db.prepare(`
        INSERT INTO telegram_chat_sessions (chat_id, session_id, group_name)
        VALUES (?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          session_id = excluded.session_id,
          group_name = excluded.group_name
      `).run(chatId, sessionId, groupName || null);
      return true;
    } catch (err) {
      console.error('[Memory] Failed to link Telegram chat:', err);
      return false;
    }
  }

  /**
   * Unlink a Telegram chat from its session
   */
  unlinkTelegramChat(chatId: number): boolean {
    const result = this.db.prepare('DELETE FROM telegram_chat_sessions WHERE chat_id = ?').run(chatId);
    return result.changes > 0;
  }

  /**
   * Get the session ID for a Telegram chat
   */
  getSessionForChat(chatId: number): string | null {
    const row = this.db.prepare(`
      SELECT session_id FROM telegram_chat_sessions WHERE chat_id = ?
    `).get(chatId) as { session_id: string } | undefined;
    return row?.session_id || null;
  }

  /**
   * Get the Telegram chat ID for a session
   */
  getChatForSession(sessionId: string): number | null {
    const row = this.db.prepare(`
      SELECT chat_id FROM telegram_chat_sessions WHERE session_id = ?
    `).get(sessionId) as { chat_id: number } | undefined;
    return row?.chat_id || null;
  }

  /**
   * Get all Telegram chat to session mappings
   */
  getAllTelegramChatSessions(): TelegramChatSession[] {
    return this.db.prepare(`
      SELECT chat_id, session_id, group_name, created_at
      FROM telegram_chat_sessions
      ORDER BY created_at DESC
    `).all() as TelegramChatSession[];
  }

  // ============ DAILY LOG METHODS ============

  /**
   * Get today's date in YYYY-MM-DD format
   */
  private getTodayDate(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Get a daily log by date (defaults to today)
   */
  getDailyLog(date?: string): DailyLog | null {
    const targetDate = date || this.getTodayDate();
    const row = this.db.prepare(`
      SELECT id, date, content, updated_at
      FROM daily_logs
      WHERE date = ?
    `).get(targetDate) as DailyLog | undefined;

    return row || null;
  }

  /**
   * Append an entry to today's daily log
   * Creates the log if it doesn't exist
   */
  appendToDailyLog(entry: string): DailyLog {
    const today = this.getTodayDate();
    const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const formattedEntry = `[${timestamp}] ${entry}`;

    const existing = this.getDailyLog(today);

    if (existing) {
      // Append to existing log
      const newContent = existing.content + '\n' + formattedEntry;
      this.db.prepare(`
        UPDATE daily_logs
        SET content = ?, updated_at = datetime('now')
        WHERE date = ?
      `).run(newContent, today);
    } else {
      // Create new log for today
      this.db.prepare(`
        INSERT INTO daily_logs (date, content, updated_at)
        VALUES (?, ?, datetime('now'))
      `).run(today, formattedEntry);
    }

    return this.getDailyLog(today)!;
  }

  /**
   * Get recent daily logs (for context)
   */
  getRecentDailyLogs(days: number = 3): DailyLog[] {
    return this.db.prepare(`
      SELECT id, date, content, updated_at
      FROM daily_logs
      ORDER BY date DESC
      LIMIT ?
    `).all(days) as DailyLog[];
  }

  /**
   * Get daily logs as formatted context string for the agent
   */
  getDailyLogsContext(days: number = 3): string {
    const logs = this.getRecentDailyLogs(days);
    if (logs.length === 0) {
      return '';
    }

    const lines: string[] = ['## Recent Daily Logs'];
    for (const log of logs.reverse()) {  // Show oldest first
      const dateLabel = log.date === this.getTodayDate() ? 'Today' : log.date;
      lines.push(`\n### ${dateLabel}`);
      lines.push(log.content);
    }

    return lines.join('\n');
  }

  // ============ MESSAGE METHODS ============

  saveMessage(role: 'user' | 'assistant' | 'system', content: string, sessionId: string = 'default'): number {
    const tokenCount = estimateTokens(content);
    const stmt = this.db.prepare(`
      INSERT INTO messages (role, content, token_count, session_id)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(role, content, tokenCount, sessionId);

    // Touch session to update activity timestamp
    this.touchSession(sessionId);

    return result.lastInsertRowid as number;
  }

  getRecentMessages(limit: number = 50, sessionId: string = 'default'): Message[] {
    const stmt = this.db.prepare(`
      SELECT id, role, content, timestamp, token_count, session_id
      FROM messages
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `);
    const rows = stmt.all(sessionId, limit) as Message[];
    return rows.reverse();
  }

  getMessageCount(sessionId?: string): number {
    if (sessionId) {
      const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?');
      const row = stmt.get(sessionId) as { count: number };
      return row.count;
    }
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  async getConversationContext(
    tokenLimit: number = DEFAULT_TOKEN_LIMIT,
    sessionId: string = 'default'
  ): Promise<ConversationContext> {
    const reservedTokens = 10000;
    const availableTokens = tokenLimit - reservedTokens;

    // Limit query to reasonable number of messages (avoids loading entire history into memory)
    // 1000 messages at ~300 tokens each = ~300k tokens, well above our typical limit
    const MAX_MESSAGES_TO_FETCH = 1000;

    const recentMessagesQuery = this.db.prepare(`
      SELECT id, role, content, timestamp, token_count, session_id
      FROM messages
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(sessionId, MAX_MESSAGES_TO_FETCH) as Message[];

    if (recentMessagesQuery.length === 0) {
      return { messages: [], totalTokens: 0, summarizedCount: 0 };
    }

    // Get total count to know if there are older messages beyond our limit
    const totalCount = this.getMessageCount(sessionId);

    const recentMessages: Message[] = [];
    let tokenCount = 0;

    for (let i = 0; i < recentMessagesQuery.length; i++) {
      const msg = recentMessagesQuery[i];
      const msgTokens = msg.token_count || estimateTokens(msg.content);

      if (tokenCount + msgTokens > availableTokens) {
        break;
      }

      recentMessages.unshift(msg);
      tokenCount += msgTokens;
    }

    // Calculate how many messages are older than what we're including
    const olderMessageCount = totalCount - recentMessages.length;

    if (olderMessageCount <= 0) {
      return {
        messages: recentMessages.map(m => ({ role: m.role, content: m.content })),
        totalTokens: tokenCount,
        summarizedCount: 0,
      };
    }

    const oldestRecentId = recentMessages[0]?.id || 0;
    const summary = await this.getOrCreateSummary(oldestRecentId, sessionId);

    const contextMessages: Array<{ role: string; content: string }> = [];

    if (summary) {
      console.log(`[Memory] Including summary for ${olderMessageCount} older messages`);
      contextMessages.push({
        role: 'system',
        content: `[Previous conversation summary]\n${summary}`,
      });
      tokenCount += estimateTokens(summary);
    }

    contextMessages.push(
      ...recentMessages.map(m => ({ role: m.role, content: m.content }))
    );

    return {
      messages: contextMessages,
      totalTokens: tokenCount,
      summarizedCount: olderMessageCount,
      summary,
    };
  }

  private async getOrCreateSummary(beforeMessageId: number, sessionId: string = 'default'): Promise<string | undefined> {
    if (beforeMessageId <= 1) {
      return undefined;
    }

    const existingSummary = this.db.prepare(`
      SELECT content FROM summaries
      WHERE end_message_id = ? AND session_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(beforeMessageId - 1, sessionId) as { content: string } | undefined;

    if (existingSummary) {
      console.log(`[Memory] Retrieved existing summary for session ${sessionId}, messages up to ID ${beforeMessageId - 1}`);
      return existingSummary.content;
    }

    const messagesToSummarize = this.db.prepare(`
      SELECT id, role, content, timestamp
      FROM messages
      WHERE id < ? AND session_id = ?
      ORDER BY id ASC
    `).all(beforeMessageId, sessionId) as Message[];

    if (messagesToSummarize.length === 0) {
      return undefined;
    }

    const partialSummary = this.db.prepare(`
      SELECT id, end_message_id, content FROM summaries
      WHERE end_message_id < ? AND session_id = ?
      ORDER BY end_message_id DESC
      LIMIT 1
    `).get(beforeMessageId, sessionId) as { id: number; end_message_id: number; content: string } | undefined;

    let summary: string;
    let startId: number;

    if (partialSummary && this.summarizer) {
      const newMessages = messagesToSummarize.filter(m => m.id > partialSummary.end_message_id);
      if (newMessages.length === 0) {
        return partialSummary.content;
      }

      const combinedContent = [
        { role: 'system' as const, content: `Previous summary: ${partialSummary.content}` },
        ...newMessages,
      ];
      summary = await this.summarizer(combinedContent as Message[]);
      startId = 1;
    } else if (this.summarizer) {
      summary = await this.summarizer(messagesToSummarize);
      startId = messagesToSummarize[0].id;
    } else {
      summary = this.createBasicSummary(messagesToSummarize);
      startId = messagesToSummarize[0].id;
    }

    const endId = messagesToSummarize[messagesToSummarize.length - 1].id;
    console.log(`[Memory] Created new summary for session ${sessionId}, messages ${startId}-${endId} (${messagesToSummarize.length} messages, ${estimateTokens(summary)} tokens)`);
    this.db.prepare(`
      INSERT INTO summaries (start_message_id, end_message_id, content, token_count, session_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(startId, endId, summary, estimateTokens(summary), sessionId);

    // Clean up old summaries that are now superseded (keep only the 3 most recent per session)
    this.db.prepare(`
      DELETE FROM summaries WHERE session_id = ? AND id NOT IN (
        SELECT id FROM summaries WHERE session_id = ? ORDER BY end_message_id DESC LIMIT 3
      )
    `).run(sessionId, sessionId);

    return summary;
  }

  private createBasicSummary(messages: Message[]): string {
    const userMessages = messages.filter(m => m.role === 'user');
    const topics = new Set<string>();

    for (const msg of userMessages.slice(-20)) {
      const topic = msg.content.slice(0, 100).replace(/\n/g, ' ');
      topics.add(topic);
    }

    const topicList = Array.from(topics).slice(0, 10);
    return `Previous conversation (${messages.length} messages) covered:\n${topicList.map(t => `- ${t}...`).join('\n')}`;
  }

  // ============ FACT METHODS ============

  /**
   * Save a fact to long-term memory (with embedding)
   */
  saveFact(category: string, subject: string, content: string): number {
    const existing = this.db.prepare(`
      SELECT id FROM facts WHERE category = ? AND subject = ?
    `).get(category, subject) as { id: number } | undefined;

    let factId: number;

    if (existing) {
      this.db.prepare(`
        UPDATE facts SET content = ?, updated_at = datetime('now') WHERE id = ?
      `).run(content, existing.id);
      factId = existing.id;
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO facts (category, subject, content)
        VALUES (?, ?, ?)
      `);
      const result = stmt.run(category, subject, content);
      factId = result.lastInsertRowid as number;
    }

    // Invalidate facts context cache
    this.factsContextCacheValid = false;

    // Embed the fact asynchronously
    if (hasEmbeddings()) {
      const fact: Fact = { id: factId, category, subject, content, created_at: '', updated_at: '' };
      this.embedFact(fact).catch(err => {
        console.error(`[Memory] Failed to embed fact ${factId}:`, err);
      });
    }

    return factId;
  }

  getAllFacts(): Fact[] {
    const stmt = this.db.prepare(`
      SELECT id, category, subject, content, created_at, updated_at
      FROM facts
      ORDER BY category, subject
    `);
    return stmt.all() as Fact[];
  }

  getFactsForContext(): string {
    // Return cached result if valid (avoids repeated DB queries on every message)
    if (this.factsContextCacheValid && this.factsContextCache !== null) {
      return this.factsContextCache;
    }

    const facts = this.getAllFacts();
    if (facts.length === 0) {
      this.factsContextCache = '';
      this.factsContextCacheValid = true;
      return '';
    }

    const byCategory = new Map<string, Fact[]>();
    for (const fact of facts) {
      const list = byCategory.get(fact.category) || [];
      list.push(fact);
      byCategory.set(fact.category, list);
    }

    const lines: string[] = ['## Known Facts'];
    for (const [category, categoryFacts] of byCategory) {
      lines.push(`\n### ${category}`);
      for (const fact of categoryFacts) {
        if (fact.subject) {
          lines.push(`- **${fact.subject}**: ${fact.content}`);
        } else {
          lines.push(`- ${fact.content}`);
        }
      }
    }

    const result = lines.join('\n');
    this.factsContextCache = result;
    this.factsContextCacheValid = true;
    return result;
  }

  deleteFact(id: number): boolean {
    // Chunks will be deleted by CASCADE
    const stmt = this.db.prepare('DELETE FROM facts WHERE id = ?');
    const result = stmt.run(id);
    if (result.changes > 0) {
      this.factsContextCacheValid = false; // Invalidate cache
    }
    return result.changes > 0;
  }

  deleteFactBySubject(category: string, subject: string): boolean {
    const stmt = this.db.prepare('DELETE FROM facts WHERE category = ? AND subject = ?');
    const result = stmt.run(category, subject);
    if (result.changes > 0) {
      this.factsContextCacheValid = false; // Invalidate cache
    }
    return result.changes > 0;
  }

  /**
   * Hybrid semantic + keyword search for facts
   */
  async searchFactsHybrid(query: string): Promise<SearchResult[]> {
    const results: Map<number, SearchResult> = new Map();

    // Determine weights based on whether embeddings are available
    const embeddingsAvailable = hasEmbeddings();
    const vectorWeight = embeddingsAvailable ? VECTOR_WEIGHT : 0;
    const keywordWeight = embeddingsAvailable ? KEYWORD_WEIGHT : 1.0; // 100% weight when no embeddings
    const scoreThreshold = embeddingsAvailable ? MIN_SCORE_THRESHOLD : 0.15; // Lower threshold for keyword-only

    // 1. Vector search (if embeddings available)
    if (embeddingsAvailable) {
      try {
        const queryEmbedding = await embed(query);

        // Limit chunks to prevent loading entire table into memory
        const chunks = this.db.prepare(`
          SELECT c.fact_id, c.embedding, f.id, f.category, f.subject, f.content, f.created_at, f.updated_at
          FROM chunks c
          JOIN facts f ON c.fact_id = f.id
          WHERE c.embedding IS NOT NULL
          ORDER BY c.created_at DESC
          LIMIT 500
        `).all() as Array<{
          fact_id: number;
          embedding: Buffer;
          id: number;
          category: string;
          subject: string;
          content: string;
          created_at: string;
          updated_at: string;
        }>;

        for (const chunk of chunks) {
          const chunkEmbedding = deserializeEmbedding(chunk.embedding);
          // Validate embedding before computing similarity
          if (!chunkEmbedding || chunkEmbedding.length === 0 || chunkEmbedding.length !== queryEmbedding.length) {
            continue; // Skip invalid embeddings
          }
          const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);

          const fact: Fact = {
            id: chunk.id,
            category: chunk.category,
            subject: chunk.subject,
            content: chunk.content,
            created_at: chunk.created_at,
            updated_at: chunk.updated_at,
          };

          results.set(chunk.id, {
            fact,
            score: similarity * vectorWeight,
            vectorScore: similarity,
            keywordScore: 0,
          });
        }
      } catch (err) {
        console.error('[Memory] Vector search failed:', err);
      }
    }

    // 2. Keyword search using FTS5
    try {
      // Escape special FTS5 characters and create search query
      const escapedQuery = query.replace(/['"]/g, '').trim();
      if (escapedQuery) {
        const ftsResults = this.db.prepare(`
          SELECT f.id, f.category, f.subject, f.content, f.created_at, f.updated_at,
                 bm25(facts_fts) as rank
          FROM facts_fts
          JOIN facts f ON facts_fts.rowid = f.id
          WHERE facts_fts MATCH ?
          ORDER BY rank
          LIMIT 20
        `).all(`"${escapedQuery}" OR ${escapedQuery.split(/\s+/).join(' OR ')}`) as Array<Fact & { rank: number }>;

        // Normalize keyword scores (BM25 returns negative values, lower is better)
        const maxRank = Math.max(...ftsResults.map(r => Math.abs(r.rank)), 1);

        for (const ftsResult of ftsResults) {
          const normalizedScore = 1 - (Math.abs(ftsResult.rank) / maxRank);
          const existing = results.get(ftsResult.id);

          if (existing) {
            existing.keywordScore = normalizedScore;
            existing.score += normalizedScore * keywordWeight;
          } else {
            const fact: Fact = {
              id: ftsResult.id,
              category: ftsResult.category,
              subject: ftsResult.subject,
              content: ftsResult.content,
              created_at: ftsResult.created_at,
              updated_at: ftsResult.updated_at,
            };

            results.set(ftsResult.id, {
              fact,
              score: normalizedScore * keywordWeight,
              vectorScore: 0,
              keywordScore: normalizedScore,
            });
          }
        }
      }
    } catch (err) {
      console.error('[Memory] Keyword search failed:', err);
    }

    // 3. Sort by score and filter
    const sortedResults = Array.from(results.values())
      .filter(r => r.score >= scoreThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SEARCH_RESULTS);

    return sortedResults;
  }

  /**
   * Simple search (fallback, no embeddings)
   */
  searchFacts(query: string, category?: string): Fact[] {
    const searchPattern = `%${query}%`;

    if (category) {
      const stmt = this.db.prepare(`
        SELECT id, category, subject, content, created_at, updated_at
        FROM facts
        WHERE category = ? AND (content LIKE ? OR subject LIKE ?)
        ORDER BY updated_at DESC
      `);
      return stmt.all(category, searchPattern, searchPattern) as Fact[];
    }

    const stmt = this.db.prepare(`
      SELECT id, category, subject, content, created_at, updated_at
      FROM facts
      WHERE content LIKE ? OR subject LIKE ? OR category LIKE ?
      ORDER BY updated_at DESC
    `);
    return stmt.all(searchPattern, searchPattern, searchPattern) as Fact[];
  }

  getFactsByCategory(category: string): Fact[] {
    const stmt = this.db.prepare(`
      SELECT id, category, subject, content, created_at, updated_at
      FROM facts
      WHERE category = ?
      ORDER BY subject, updated_at DESC
    `);
    return stmt.all(category) as Fact[];
  }

  getFactCategories(): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT category FROM facts ORDER BY category
    `);
    const rows = stmt.all() as { category: string }[];
    return rows.map(r => r.category);
  }

  // ============ CRON JOB METHODS ============

  saveCronJob(
    name: string,
    schedule: string,
    prompt: string,
    channel: string = 'default'
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO cron_jobs (name, schedule, prompt, channel)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        schedule = excluded.schedule,
        prompt = excluded.prompt,
        channel = excluded.channel
    `);
    const result = stmt.run(name, schedule, prompt, channel);
    return result.lastInsertRowid as number;
  }

  getCronJobs(enabledOnly: boolean = true): CronJob[] {
    const query = enabledOnly
      ? 'SELECT * FROM cron_jobs WHERE enabled = 1'
      : 'SELECT * FROM cron_jobs';
    const stmt = this.db.prepare(query);
    const rows = stmt.all() as Array<{
      id: number;
      name: string;
      schedule: string;
      prompt: string;
      channel: string;
      enabled: number;
    }>;
    return rows.map(r => ({ ...r, enabled: r.enabled === 1 }));
  }

  setCronJobEnabled(name: string, enabled: boolean): boolean {
    const stmt = this.db.prepare(`
      UPDATE cron_jobs SET enabled = ? WHERE name = ?
    `);
    const result = stmt.run(enabled ? 1 : 0, name);
    return result.changes > 0;
  }

  deleteCronJob(name: string): boolean {
    const stmt = this.db.prepare('DELETE FROM cron_jobs WHERE name = ?');
    const result = stmt.run(name);
    return result.changes > 0;
  }

  // ============ UTILITY METHODS ============

  getStats(sessionId?: string): {
    messageCount: number;
    factCount: number;
    cronJobCount: number;
    summaryCount: number;
    estimatedTokens: number;
    embeddedFactCount: number;
    sessionCount?: number;
  } {
    let messages: { c: number; t: number };
    let summaries: { c: number };

    if (sessionId) {
      // Session-specific stats
      messages = this.db.prepare('SELECT COUNT(*) as c, SUM(token_count) as t FROM messages WHERE session_id = ?').get(sessionId) as { c: number; t: number };
      summaries = this.db.prepare('SELECT COUNT(*) as c FROM summaries WHERE session_id = ?').get(sessionId) as { c: number };
    } else {
      // Global stats
      messages = this.db.prepare('SELECT COUNT(*) as c, SUM(token_count) as t FROM messages').get() as { c: number; t: number };
      summaries = this.db.prepare('SELECT COUNT(*) as c FROM summaries').get() as { c: number };
    }

    const facts = this.db.prepare('SELECT COUNT(*) as c FROM facts').get() as { c: number };
    const cronJobs = this.db.prepare('SELECT COUNT(*) as c FROM cron_jobs').get() as { c: number };
    const embeddedFacts = this.db.prepare('SELECT COUNT(DISTINCT fact_id) as c FROM chunks WHERE embedding IS NOT NULL').get() as { c: number };
    const sessionCount = this.db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number };

    return {
      messageCount: messages.c,
      factCount: facts.c,
      cronJobCount: cronJobs.c,
      summaryCount: summaries.c,
      estimatedTokens: messages.t || 0,
      embeddedFactCount: embeddedFacts.c,
      sessionCount: sessionCount.c,
    };
  }

  clearConversation(sessionId?: string): void {
    if (sessionId) {
      // Clear only the specified session
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM summaries WHERE session_id = ?').run(sessionId);
    } else {
      // Clear all (legacy behavior)
      this.db.exec('DELETE FROM messages');
      this.db.exec('DELETE FROM summaries');
    }
  }

  /**
   * Get facts as graph data for visualization
   * Returns nodes (facts) and links (connections between facts)
   */
  async getFactsGraphData(): Promise<GraphData> {
    const facts = this.getAllFacts();
    if (facts.length === 0) {
      return { nodes: [], links: [] };
    }

    // Category to group index mapping
    const categoryGroups: Record<string, number> = {
      user_info: 0,
      preferences: 1,
      projects: 2,
      people: 3,
      work: 4,
      notes: 5,
      decisions: 6,
    };

    // Create nodes
    const nodes: GraphNode[] = facts.map(fact => ({
      id: fact.id,
      subject: fact.subject || fact.content.slice(0, 30),
      category: fact.category,
      content: fact.content,
      group: categoryGroups[fact.category] ?? 7, // 7 = other
    }));

    const links: GraphLink[] = [];
    const linkSet = new Set<string>(); // Track unique links

    const addLink = (source: number, target: number, type: GraphLink['type'], strength: number) => {
      const key = `${Math.min(source, target)}-${Math.max(source, target)}-${type}`;
      if (!linkSet.has(key) && source !== target) {
        linkSet.add(key);
        links.push({ source, target, type, strength });
      }
    };

    // 1. Category connections - facts in same category
    const factsByCategory = new Map<string, Fact[]>();
    for (const fact of facts) {
      const list = factsByCategory.get(fact.category) || [];
      list.push(fact);
      factsByCategory.set(fact.category, list);
    }

    for (const categoryFacts of factsByCategory.values()) {
      // Connect each fact to up to 3 others in the same category
      for (let i = 0; i < categoryFacts.length; i++) {
        for (let j = i + 1; j < Math.min(i + 4, categoryFacts.length); j++) {
          addLink(categoryFacts[i].id, categoryFacts[j].id, 'category', 0.3);
        }
      }
    }

    // 2. Semantic connections (if embeddings available)
    // Limit to prevent O(N²) explosion with many facts
    const MAX_SEMANTIC_COMPARISONS = 200; // Max facts to compare for semantic links
    if (hasEmbeddings()) {
      try {
        // Get chunks with embeddings (limited for performance)
        const chunks = this.db.prepare(`
          SELECT c.fact_id, c.embedding
          FROM chunks c
          WHERE c.embedding IS NOT NULL
          ORDER BY c.created_at DESC
          LIMIT ?
        `).all(MAX_SEMANTIC_COMPARISONS) as Array<{ fact_id: number; embedding: Buffer }>;

        // Build fact ID to embedding map
        const factEmbeddings = new Map<number, number[]>();
        for (const chunk of chunks) {
          const emb = deserializeEmbedding(chunk.embedding);
          // Validate embedding
          if (emb && emb.length > 0) {
            factEmbeddings.set(chunk.fact_id, emb);
          }
        }

        // Compare each pair of facts with embeddings
        const factIds = Array.from(factEmbeddings.keys());
        let comparisons = 0;
        const MAX_COMPARISONS = 10000; // Cap total comparisons to prevent freeze

        outer: for (let i = 0; i < factIds.length; i++) {
          const embA = factEmbeddings.get(factIds[i])!;
          for (let j = i + 1; j < factIds.length; j++) {
            if (++comparisons > MAX_COMPARISONS) break outer;

            const embB = factEmbeddings.get(factIds[j])!;
            // Validate lengths match
            if (embA.length !== embB.length) continue;

            const similarity = cosineSimilarity(embA, embB);

            // Only link if similarity is strong enough (above 0.5)
            if (similarity >= 0.5) {
              addLink(factIds[i], factIds[j], 'semantic', similarity);
            }
          }
        }
      } catch (err) {
        console.error('[Memory] Failed to compute semantic links:', err);
      }
    }

    // 3. Keyword connections
    // Extract significant words from each fact
    // Limit facts processed for keyword matching to prevent O(N²M) explosion
    const MAX_KEYWORD_FACTS = 300;
    const COMMON_WORDS = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one',
      'our', 'out', 'has', 'have', 'been', 'this', 'that', 'they', 'from', 'with', 'will',
      'what', 'when', 'where', 'which', 'their', 'about', 'would', 'there', 'could', 'other',
      'into', 'than', 'then', 'them', 'these', 'some', 'like', 'just', 'only', 'over', 'such',
      'make', 'made', 'also', 'most', 'very', 'does', 'being', 'those', 'after', 'before',
    ]);

    const extractKeywords = (text: string): Set<string> => {
      const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
      return new Set(words.filter(w => !COMMON_WORDS.has(w)));
    };

    // Only process limited facts for keyword matching
    const factsToProcess = facts.slice(0, MAX_KEYWORD_FACTS);
    const factKeywords = new Map<number, Set<string>>();
    for (const fact of factsToProcess) {
      const keywords = extractKeywords(`${fact.subject} ${fact.content}`);
      factKeywords.set(fact.id, keywords);
    }

    // Find keyword overlaps between facts
    const factIds = Array.from(factKeywords.keys());
    let keywordComparisons = 0;
    const MAX_KEYWORD_COMPARISONS = 15000; // Cap total comparisons

    outer: for (let i = 0; i < factIds.length; i++) {
      const kwA = factKeywords.get(factIds[i])!;
      if (kwA.size === 0) continue;

      for (let j = i + 1; j < factIds.length; j++) {
        if (++keywordComparisons > MAX_KEYWORD_COMPARISONS) break outer;

        const kwB = factKeywords.get(factIds[j])!;
        if (kwB.size === 0) continue;

        // Count shared keywords
        let shared = 0;
        for (const kw of kwA) {
          if (kwB.has(kw)) shared++;
        }

        // Link if at least 2 shared keywords
        if (shared >= 2) {
          const strength = Math.min(1, shared / 5); // Max strength at 5 shared words
          addLink(factIds[i], factIds[j], 'keyword', strength);
        }
      }
    }

    return { nodes, links };
  }

  close(): void {
    this.db.close();
  }
}

export { MemoryManager as MemoryStore };
