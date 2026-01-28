/**
 * Settings Manager - SQLite-based configuration with encryption
 *
 * Uses Electron's safeStorage API to encrypt sensitive values like API keys.
 * All settings stored in SQLite for persistence and atomic updates.
 */

import Database from 'better-sqlite3';
import { safeStorage } from 'electron';

export interface Setting {
  key: string;
  value: string;
  encrypted: boolean;
  category: string;
  updated_at: string;
}

export interface SettingDefinition {
  key: string;
  defaultValue: string;
  encrypted: boolean;
  category: string;
  label: string;
  description?: string;
  type: 'string' | 'number' | 'boolean' | 'password' | 'array' | 'textarea';
  validation?: (value: string) => boolean;
}

// Default settings schema
export const SETTINGS_SCHEMA: SettingDefinition[] = [
  // Auth settings
  {
    key: 'auth.method',
    defaultValue: '',
    encrypted: false,
    category: 'auth',
    label: 'Authentication Method',
    description: 'How you authenticate with Claude (api_key or oauth)',
    type: 'string',
  },
  {
    key: 'auth.oauthToken',
    defaultValue: '',
    encrypted: true,
    category: 'auth',
    label: 'OAuth Token',
    description: 'OAuth access token for Claude subscription',
    type: 'password',
  },
  {
    key: 'auth.refreshToken',
    defaultValue: '',
    encrypted: true,
    category: 'auth',
    label: 'Refresh Token',
    description: 'OAuth refresh token',
    type: 'password',
  },
  {
    key: 'auth.tokenExpiresAt',
    defaultValue: '',
    encrypted: false,
    category: 'auth',
    label: 'Token Expiry',
    description: 'When the OAuth token expires',
    type: 'string',
  },

  // API Keys
  {
    key: 'anthropic.apiKey',
    defaultValue: '',
    encrypted: true,
    category: 'api_keys',
    label: 'Anthropic API Key',
    description: 'Your Anthropic API key for Claude',
    type: 'password',
  },
  {
    key: 'openai.apiKey',
    defaultValue: '',
    encrypted: true,
    category: 'api_keys',
    label: 'OpenAI API Key',
    description: 'Your OpenAI API key for embeddings and image generation',
    type: 'password',
  },
  {
    key: 'gemini.apiKey',
    defaultValue: '',
    encrypted: true,
    category: 'api_keys',
    label: 'Google Gemini API Key',
    description: 'For Gemini-powered skills (nano-banana-pro)',
    type: 'password',
  },
  {
    key: 'google.placesApiKey',
    defaultValue: '',
    encrypted: true,
    category: 'api_keys',
    label: 'Google Places API Key',
    description: 'For location skills (goplaces, local-places)',
    type: 'password',
  },
  {
    key: 'notion.apiKey',
    defaultValue: '',
    encrypted: true,
    category: 'api_keys',
    label: 'Notion API Key',
    description: 'For Notion integration',
    type: 'password',
  },
  {
    key: 'trello.apiKey',
    defaultValue: '',
    encrypted: true,
    category: 'api_keys',
    label: 'Trello API Key',
    description: 'For Trello integration',
    type: 'password',
  },
  {
    key: 'trello.token',
    defaultValue: '',
    encrypted: true,
    category: 'api_keys',
    label: 'Trello Token',
    description: 'Your Trello authorization token',
    type: 'password',
  },
  {
    key: 'elevenlabs.apiKey',
    defaultValue: '',
    encrypted: true,
    category: 'api_keys',
    label: 'ElevenLabs API Key',
    description: 'For text-to-speech (sag skill)',
    type: 'password',
  },

  // Agent settings
  {
    key: 'agent.model',
    defaultValue: 'claude-opus-4-5-20251101',
    encrypted: false,
    category: 'agent',
    label: 'Default Model',
    description: 'Claude model to use for conversations',
    type: 'string',
  },
  {
    key: 'agent.compactionThreshold',
    defaultValue: '120000',
    encrypted: false,
    category: 'agent',
    label: 'Compaction Threshold',
    description: 'Token count at which to start compacting context',
    type: 'number',
  },
  {
    key: 'agent.maxContextTokens',
    defaultValue: '150000',
    encrypted: false,
    category: 'agent',
    label: 'Max Context Tokens',
    description: 'Maximum tokens in conversation context',
    type: 'number',
  },
  {
    key: 'agent.thinkingLevel',
    defaultValue: 'normal',
    encrypted: false,
    category: 'agent',
    label: 'Thinking Level',
    description: 'How much reasoning to show (none, minimal, normal, extended)',
    type: 'string',
  },

  // Telegram settings
  {
    key: 'telegram.botToken',
    defaultValue: '',
    encrypted: true,
    category: 'telegram',
    label: 'Bot Token',
    description: 'Telegram bot token from @BotFather',
    type: 'password',
  },
  {
    key: 'telegram.allowedUserIds',
    defaultValue: '[]',
    encrypted: false,
    category: 'telegram',
    label: 'Allowed User IDs',
    description: 'Comma-separated list of Telegram user IDs',
    type: 'array',
  },
  {
    key: 'telegram.enabled',
    defaultValue: 'false',
    encrypted: false,
    category: 'telegram',
    label: 'Enable Telegram',
    description: 'Enable Telegram bot integration',
    type: 'boolean',
  },
  {
    key: 'telegram.defaultChatId',
    defaultValue: '',
    encrypted: false,
    category: 'telegram',
    label: 'Default Chat ID',
    description: 'Default chat ID for notifications',
    type: 'string',
  },

  // Memory settings
  {
    key: 'memory.embeddingProvider',
    defaultValue: 'openai',
    encrypted: false,
    category: 'memory',
    label: 'Embedding Provider',
    description: 'Provider for semantic embeddings (openai)',
    type: 'string',
  },
  {
    key: 'memory.vectorWeight',
    defaultValue: '0.7',
    encrypted: false,
    category: 'memory',
    label: 'Vector Search Weight',
    description: 'Weight for semantic similarity (0-1)',
    type: 'number',
  },
  {
    key: 'memory.keywordWeight',
    defaultValue: '0.3',
    encrypted: false,
    category: 'memory',
    label: 'Keyword Search Weight',
    description: 'Weight for keyword matching (0-1)',
    type: 'number',
  },
  {
    key: 'memory.minScoreThreshold',
    defaultValue: '0.35',
    encrypted: false,
    category: 'memory',
    label: 'Min Score Threshold',
    description: 'Minimum score for search results',
    type: 'number',
  },
  {
    key: 'memory.maxSearchResults',
    defaultValue: '6',
    encrypted: false,
    category: 'memory',
    label: 'Max Search Results',
    description: 'Maximum number of search results',
    type: 'number',
  },

  // Browser settings
  {
    key: 'browser.enabled',
    defaultValue: 'true',
    encrypted: false,
    category: 'browser',
    label: 'Enable Browser',
    description: 'Enable browser automation tools',
    type: 'boolean',
  },
  {
    key: 'browser.cdpUrl',
    defaultValue: 'http://localhost:9222',
    encrypted: false,
    category: 'browser',
    label: 'CDP URL',
    description: 'Chrome DevTools Protocol URL',
    type: 'string',
  },

  // Scheduler settings
  {
    key: 'scheduler.enabled',
    defaultValue: 'true',
    encrypted: false,
    category: 'scheduler',
    label: 'Enable Scheduler',
    description: 'Enable cron job scheduler',
    type: 'boolean',
  },

  // Window state settings
  {
    key: 'window.chatBounds',
    defaultValue: '',
    encrypted: false,
    category: 'window',
    label: 'Chat Window Bounds',
    description: 'Saved position and size of chat window (JSON)',
    type: 'string',
  },
  {
    key: 'window.cronBounds',
    defaultValue: '',
    encrypted: false,
    category: 'window',
    label: 'Cron Window Bounds',
    description: 'Saved position and size of cron window (JSON)',
    type: 'string',
  },
  {
    key: 'window.settingsBounds',
    defaultValue: '',
    encrypted: false,
    category: 'window',
    label: 'Settings Window Bounds',
    description: 'Saved position and size of settings window (JSON)',
    type: 'string',
  },
  {
    key: 'window.factsGraphBounds',
    defaultValue: '',
    encrypted: false,
    category: 'window',
    label: 'Facts Graph Window Bounds',
    description: 'Saved position and size of facts graph window (JSON)',
    type: 'string',
  },
  {
    key: 'window.customizeBounds',
    defaultValue: '',
    encrypted: false,
    category: 'window',
    label: 'Customize Window Bounds',
    description: 'Saved position and size of customize window (JSON)',
    type: 'string',
  },
  {
    key: 'window.factsBounds',
    defaultValue: '',
    encrypted: false,
    category: 'window',
    label: 'Facts Window Bounds',
    description: 'Saved position and size of facts window (JSON)',
    type: 'string',
  },
  {
    key: 'window.skillsSetupBounds',
    defaultValue: '',
    encrypted: false,
    category: 'window',
    label: 'Skills Setup Window Bounds',
    description: 'Saved position and size of skills setup window (JSON)',
    type: 'string',
  },

  // User Profile settings
  {
    key: 'profile.name',
    defaultValue: '',
    encrypted: false,
    category: 'profile',
    label: 'Your Name',
    description: 'Your name for the agent to use',
    type: 'string',
  },
  {
    key: 'profile.location',
    defaultValue: '',
    encrypted: false,
    category: 'profile',
    label: 'Location',
    description: 'Your city/region for context',
    type: 'string',
  },
  {
    key: 'profile.timezone',
    defaultValue: '',
    encrypted: false,
    category: 'profile',
    label: 'Timezone',
    description: 'Your timezone (e.g., America/New_York)',
    type: 'string',
  },
  {
    key: 'profile.occupation',
    defaultValue: '',
    encrypted: false,
    category: 'profile',
    label: 'Occupation',
    description: 'Your job or role',
    type: 'string',
  },
  {
    key: 'profile.birthday',
    defaultValue: '',
    encrypted: false,
    category: 'profile',
    label: 'Birthday',
    description: 'Your birthday (e.g., March 15)',
    type: 'string',
  },
  {
    key: 'profile.custom',
    defaultValue: '',
    encrypted: false,
    category: 'profile',
    label: 'Additional Info',
    description: 'Any other information about yourself',
    type: 'textarea',
  },
];

class SettingsManagerClass {
  private static instance: SettingsManagerClass | null = null;
  private db: Database.Database | null = null;
  private cache: Map<string, string> = new Map();
  private initialized: boolean = false;

  private constructor() {}

  static getInstance(): SettingsManagerClass {
    if (!SettingsManagerClass.instance) {
      SettingsManagerClass.instance = new SettingsManagerClass();
    }
    return SettingsManagerClass.instance;
  }

  /**
   * Initialize settings with database path
   */
  initialize(dbPath: string): void {
    this.db = new Database(dbPath);
    this.createTable();
    this.loadDefaults();
    this.loadToCache();
    this.initialized = true;
    console.log('[Settings] Initialized');
  }

  private createTable(): void {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        encrypted INTEGER DEFAULT 0,
        category TEXT DEFAULT 'general',
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_settings_category ON settings(category);
    `);
  }

  /**
   * Load default settings that don't exist yet
   */
  private loadDefaults(): void {
    if (!this.db) return;

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO settings (key, value, encrypted, category)
      VALUES (?, ?, ?, ?)
    `);

    for (const def of SETTINGS_SCHEMA) {
      insert.run(def.key, def.defaultValue, def.encrypted ? 1 : 0, def.category);
    }
  }

  /**
   * Load all settings to memory cache
   */
  private loadToCache(): void {
    if (!this.db) return;

    const rows = this.db.prepare('SELECT key, value, encrypted FROM settings').all() as Array<{
      key: string;
      value: string;
      encrypted: number;
    }>;

    for (const row of rows) {
      let value = row.value;

      // Decrypt if needed
      if (row.encrypted && value) {
        try {
          value = this.decrypt(value);
        } catch {
          // If decryption fails, value stays encrypted (might be from old install)
          console.warn(`[Settings] Failed to decrypt ${row.key}`);
        }
      }

      this.cache.set(row.key, value);
    }
  }

  /**
   * Encrypt a value using safeStorage
   */
  private encrypt(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[Settings] Encryption not available, storing as plain text');
      return value;
    }
    const encrypted = safeStorage.encryptString(value);
    return encrypted.toString('base64');
  }

  /**
   * Decrypt a value using safeStorage
   */
  private decrypt(encrypted: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      return encrypted;
    }
    const buffer = Buffer.from(encrypted, 'base64');
    return safeStorage.decryptString(buffer);
  }

  /**
   * Get a setting value
   */
  get(key: string): string {
    if (!this.initialized) {
      console.warn('[Settings] Not initialized, returning default');
      const def = SETTINGS_SCHEMA.find(s => s.key === key);
      return def?.defaultValue || '';
    }

    return this.cache.get(key) || '';
  }

  /**
   * Get a setting as a specific type
   */
  getNumber(key: string): number {
    return parseFloat(this.get(key)) || 0;
  }

  getBoolean(key: string): boolean {
    return this.get(key) === 'true';
  }

  getArray(key: string): string[] {
    try {
      const value = this.get(key);
      if (!value) return [];
      // Try JSON parse first
      if (value.startsWith('[')) {
        return JSON.parse(value);
      }
      // Fall back to comma-separated
      return value.split(',').map(s => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Set a setting value
   */
  set(key: string, value: string, encrypted?: boolean): void {
    if (!this.db) {
      console.warn('[Settings] Not initialized, cannot save:', key);
      return;
    }

    // Determine if should be encrypted
    const def = SETTINGS_SCHEMA.find(s => s.key === key);
    const shouldEncrypt = encrypted ?? def?.encrypted ?? false;
    const category = def?.category || 'general';

    // Encrypt if needed
    let storedValue = value;
    if (shouldEncrypt && value) {
      storedValue = this.encrypt(value);
    }

    // Update database
    this.db.prepare(`
      INSERT INTO settings (key, value, encrypted, category, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        encrypted = excluded.encrypted,
        updated_at = excluded.updated_at
    `).run(key, storedValue, shouldEncrypt ? 1 : 0, category);

    // Update cache with unencrypted value
    this.cache.set(key, value);

    console.log(`[Settings] Updated: ${key}`);
  }

  /**
   * Delete a setting
   */
  delete(key: string): boolean {
    if (!this.db) return false;

    const result = this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    this.cache.delete(key);

    return result.changes > 0;
  }

  /**
   * Get all settings
   */
  getAll(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of this.cache) {
      result[key] = value;
    }
    return result;
  }

  /**
   * Get all settings by category
   */
  getByCategory(category: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const def of SETTINGS_SCHEMA) {
      if (def.category === category) {
        result[def.key] = this.get(def.key);
      }
    }
    return result;
  }

  /**
   * Get schema for a category
   */
  getSchema(category?: string): SettingDefinition[] {
    if (category) {
      return SETTINGS_SCHEMA.filter(s => s.category === category);
    }
    return SETTINGS_SCHEMA;
  }

  /**
   * Check if required authentication is set
   */
  hasRequiredKeys(): boolean {
    const authMethod = this.get('auth.method');

    // Check for OAuth authentication
    if (authMethod === 'oauth') {
      const oauthToken = this.get('auth.oauthToken');
      return !!oauthToken;
    }

    // Check for API key authentication
    const anthropicKey = this.get('anthropic.apiKey');
    return !!anthropicKey;
  }

  /**
   * Get the current authentication method
   */
  getAuthMethod(): 'api_key' | 'oauth' | null {
    const method = this.get('auth.method');
    if (method === 'oauth' || method === 'api_key') {
      return method;
    }
    // Legacy check - if API key exists, assume api_key method
    if (this.get('anthropic.apiKey')) {
      return 'api_key';
    }
    return null;
  }

  /**
   * Check if first run (no authentication set)
   */
  isFirstRun(): boolean {
    return !this.hasRequiredKeys();
  }

  /**
   * Initialize keychain access by triggering a test encryption.
   * This prompts macOS for keychain permission upfront during onboarding
   * rather than surprising users later when saving API keys.
   * Returns true if encryption is available and working.
   */
  initializeKeychain(): { available: boolean; error?: string } {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        return { available: false, error: 'Encryption not available on this system' };
      }
      // Trigger keychain access with a test encryption
      const testValue = 'keychain-init-test';
      const encrypted = safeStorage.encryptString(testValue);
      const decrypted = safeStorage.decryptString(encrypted);
      if (decrypted !== testValue) {
        return { available: false, error: 'Encryption verification failed' };
      }
      return { available: true };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get formatted user profile for agent context
   */
  getFormattedProfile(): string {
    const name = this.get('profile.name');
    const location = this.get('profile.location');
    const timezone = this.get('profile.timezone');
    const occupation = this.get('profile.occupation');
    const birthday = this.get('profile.birthday');
    const custom = this.get('profile.custom');

    // If no profile data, return empty string
    if (!name && !location && !timezone && !occupation && !birthday && !custom) {
      return '';
    }

    const lines: string[] = ['## User Profile'];

    if (name) lines.push(`- **Name:** ${name}`);
    if (location) lines.push(`- **Location:** ${location}`);
    if (timezone) lines.push(`- **Timezone:** ${timezone}`);
    if (occupation) lines.push(`- **Occupation:** ${occupation}`);
    if (birthday) lines.push(`- **Birthday:** ${birthday}`);
    if (custom) {
      lines.push('');
      lines.push('### Additional Information');
      lines.push(custom);
    }

    return lines.join('\n');
  }

  /**
   * Validate an API key by making a test call
   */
  async validateAnthropicKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      if (response.ok) {
        return { valid: true };
      }

      const data = await response.json();
      return { valid: false, error: data.error?.message || 'Invalid API key' };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Connection failed' };
    }
  }

  async validateOpenAIKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      });

      if (response.ok) {
        return { valid: true };
      }

      const data = await response.json();
      return { valid: false, error: data.error?.message || 'Invalid API key' };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Connection failed' };
    }
  }

  async validateTelegramToken(token: string): Promise<{ valid: boolean; error?: string; botInfo?: unknown }> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = await response.json();

      if (data.ok) {
        return { valid: true, botInfo: data.result };
      }

      return { valid: false, error: data.description || 'Invalid token' };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Connection failed' };
    }
  }

  /**
   * Get API keys as environment variables for skill execution.
   * Maps settings keys to the environment variable names that skills expect.
   * Returns empty object if SettingsManager is not initialized yet.
   */
  getApiKeysAsEnv(): Record<string, string> {
    if (!this.initialized) {
      return {};
    }

    const env: Record<string, string> = {};

    // Map settings keys to environment variable names
    const keyMappings: Record<string, string> = {
      'openai.apiKey': 'OPENAI_API_KEY',
      'gemini.apiKey': 'GEMINI_API_KEY',
      'google.placesApiKey': 'GOOGLE_PLACES_API_KEY',
      'notion.apiKey': 'NOTION_API_KEY',
      'trello.apiKey': 'TRELLO_API_KEY',
      'trello.token': 'TRELLO_TOKEN',
      'elevenlabs.apiKey': 'ELEVENLABS_API_KEY',
      'anthropic.apiKey': 'ANTHROPIC_API_KEY',
    };

    for (const [settingKey, envVar] of Object.entries(keyMappings)) {
      const value = this.get(settingKey);
      if (value) {
        env[envVar] = value;
      }
    }

    return env;
  }

  /**
   * Check if a specific API key is configured.
   * Returns false if SettingsManager is not initialized yet.
   */
  hasApiKey(envVarName: string): boolean {
    if (!this.initialized) {
      return false;
    }

    const reverseMapping: Record<string, string> = {
      'OPENAI_API_KEY': 'openai.apiKey',
      'GEMINI_API_KEY': 'gemini.apiKey',
      'GOOGLE_PLACES_API_KEY': 'google.placesApiKey',
      'NOTION_API_KEY': 'notion.apiKey',
      'TRELLO_API_KEY': 'trello.apiKey',
      'TRELLO_TOKEN': 'trello.token',
      'ELEVENLABS_API_KEY': 'elevenlabs.apiKey',
      'ANTHROPIC_API_KEY': 'anthropic.apiKey',
    };

    const settingKey = reverseMapping[envVarName];
    if (!settingKey) return false;

    return !!this.get(settingKey);
  }

  /**
   * Export settings for backup (excluding encrypted values)
   */
  exportSettings(): Record<string, unknown> {
    const all = this.getAll();
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(all)) {
      const def = SETTINGS_SCHEMA.find(s => s.key === key);
      if (def?.encrypted) {
        result[key] = '***ENCRYPTED***';
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Import settings from backup
   */
  importSettings(settings: Record<string, string>): void {
    for (const [key, value] of Object.entries(settings)) {
      if (value !== '***ENCRYPTED***') {
        this.set(key, value);
      }
    }
  }

  /**
   * Migrate settings from old config.json file
   */
  async migrateFromConfig(configPath: string): Promise<boolean> {
    try {
      const fs = await import('fs');
      if (!fs.existsSync(configPath)) {
        return false;
      }

      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content);

      // Migrate Anthropic settings
      if (config.anthropic?.apiKey) {
        this.set('anthropic.apiKey', config.anthropic.apiKey);
      }
      if (config.anthropic?.model) {
        this.set('agent.model', config.anthropic.model);
      }

      // Migrate OpenAI settings
      if (config.openai?.apiKey) {
        this.set('openai.apiKey', config.openai.apiKey);
      }

      // Migrate Telegram settings
      if (config.telegram?.botToken) {
        this.set('telegram.botToken', config.telegram.botToken);
      }
      if (config.telegram?.enabled !== undefined) {
        this.set('telegram.enabled', config.telegram.enabled.toString());
      }
      if (config.telegram?.allowedUserIds?.length) {
        this.set('telegram.allowedUserIds', JSON.stringify(config.telegram.allowedUserIds));
      }

      // Migrate scheduler settings
      if (config.scheduler?.enabled !== undefined) {
        this.set('scheduler.enabled', config.scheduler.enabled.toString());
      }

      // Migrate browser settings
      if (config.tools?.browser?.enabled !== undefined) {
        this.set('browser.enabled', config.tools.browser.enabled.toString());
      }
      if (config.tools?.browser?.cdpUrl) {
        this.set('browser.cdpUrl', config.tools.browser.cdpUrl);
      }

      console.log('[Settings] Migrated settings from config.json');

      // Rename the old config file to indicate migration
      fs.renameSync(configPath, configPath + '.migrated');

      return true;
    } catch (error) {
      console.error('[Settings] Migration failed:', error);
      return false;
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
  }
}

export const SettingsManager = SettingsManagerClass.getInstance();
