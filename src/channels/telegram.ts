import { Bot, Context } from 'grammy';
import { BaseChannel } from './index';
import { AgentManager } from '../agent';
import { SettingsManager } from '../settings';

/**
 * Convert markdown to Telegram HTML format
 * Telegram supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">
 * IMPORTANT: Telegram does NOT support nested tags or tables!
 */
function markdownToTelegramHtml(text: string): string {
  let result = text;

  // Placeholders for protected content
  const protected_content: string[] = [];

  // Extract and protect code blocks first (```...```)
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
    const idx = protected_content.length;
    const escapedCode = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .trim();
    protected_content.push(`<pre>${escapedCode}</pre>`);
    return `\n@@PROTECTED_${idx}@@\n`;
  });

  // Extract and protect inline code (`...`)
  result = result.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = protected_content.length;
    const escapedCode = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    protected_content.push(`<code>${escapedCode}</code>`);
    return `@@PROTECTED_${idx}@@`;
  });

  // Extract and protect links [text](url) - before escaping
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    const idx = protected_content.length;
    const escapedText = linkText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    protected_content.push(`<a href="${url}">${escapedText}</a>`);
    return `@@PROTECTED_${idx}@@`;
  });

  // Escape HTML in the rest of the text
  result = result
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Process line by line
  const lines = result.split('\n');
  const processedLines: string[] = [];

  // Collect table rows for batch processing
  let tableRows: string[][] = [];

  for (const line of lines) {
    // Check if this is a table row
    const isTableRow = line.startsWith('|') && line.endsWith('|');
    const isTableSeparator = /^\|[-:\s|]+\|$/.test(line);

    if (isTableRow && !isTableSeparator) {
      // Collect table row
      const cells = line.slice(1, -1).split('|').map(c => stripInlineMarkdown(c.trim()));
      tableRows.push(cells);
      continue;
    } else if (isTableSeparator) {
      // Skip separator rows
      continue;
    } else if (tableRows.length > 0) {
      // End of table - output formatted table
      processedLines.push(formatTable(tableRows));
      tableRows = [];
    }

    // Headers: # ## ### etc -> Bold
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const content = stripInlineMarkdown(headerMatch[2]);
      processedLines.push(`<b>${content}</b>`);
      continue;
    }

    // Blockquotes: > text -> bar + italic
    const quoteMatch = line.match(/^&gt;\s*(.+)$/);
    if (quoteMatch) {
      const content = stripInlineMarkdown(quoteMatch[1]);
      processedLines.push(`│ <i>${content}</i>`);
      continue;
    }

    // Checkboxes: - [ ] or - [x]
    const uncheckedMatch = line.match(/^[-*]\s+\[\s*\]\s+(.+)$/);
    if (uncheckedMatch) {
      processedLines.push(`☐ ${applyInlineFormatting(uncheckedMatch[1])}`);
      continue;
    }
    const checkedMatch = line.match(/^[-*]\s+\[x\]\s+(.+)$/i);
    if (checkedMatch) {
      processedLines.push(`☑ ${applyInlineFormatting(checkedMatch[1])}`);
      continue;
    }

    // Unordered lists: - item or * item -> bullet
    const ulMatch = line.match(/^[-*]\s+(.+)$/);
    if (ulMatch) {
      processedLines.push(`• ${applyInlineFormatting(ulMatch[1])}`);
      continue;
    }

    // Ordered lists: 1. item
    const olMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (olMatch) {
      processedLines.push(`${olMatch[1]}. ${applyInlineFormatting(olMatch[2])}`);
      continue;
    }

    // Horizontal rules: --- or *** or ___
    if (/^[-*_]{3,}$/.test(line)) {
      processedLines.push('─────────');
      continue;
    }

    // Regular line - apply inline formatting
    processedLines.push(applyInlineFormatting(line));
  }

  // Handle any remaining table rows at end of text
  if (tableRows.length > 0) {
    processedLines.push(formatTable(tableRows));
  }

  result = processedLines.join('\n');

  // Restore protected content
  protected_content.forEach((content, idx) => {
    result = result.replace(`@@PROTECTED_${idx}@@`, content);
  });

  // Clean up excessive newlines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

/**
 * Format table rows with aligned columns using monospace
 */
function formatTable(rows: string[][]): string {
  if (rows.length === 0) return '';

  // Calculate max width for each column
  const colWidths: number[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      colWidths[i] = Math.max(colWidths[i] || 0, row[i].length);
    }
  }

  // Format each row with padding
  const formattedRows = rows.map(row => {
    const cells = row.map((cell, i) => cell.padEnd(colWidths[i]));
    return cells.join(' │ ');
  });

  // Wrap in <pre> for monospace alignment
  return `<pre>${formattedRows.join('\n')}</pre>`;
}

/**
 * Strip inline markdown formatting (for contexts where we can't nest tags)
 */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')  // Remove **bold**
    .replace(/__(.+?)__/g, '$1')       // Remove __bold__
    .replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, '$1')  // Remove *italic*
    .replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, '$1')    // Remove _italic_
    .replace(/~~(.+?)~~/g, '$1');      // Remove ~~strike~~
}

/**
 * Apply inline formatting (bold, italic, strikethrough) - one at a time to avoid nesting
 */
function applyInlineFormatting(text: string): string {
  // Process bold first: **text** or __text__
  // We process each match individually to avoid nesting
  let result = text;

  // Bold: **text**
  result = result.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

  // Bold: __text__ (only if not inside a word)
  result = result.replace(/(?<!\w)__([^_]+)__(?!\w)/g, '<b>$1</b>');

  // Italic: *text* (but not **)
  result = result.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>');

  // Italic: _text_ (but not __)
  result = result.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~([^~]+)~~/g, '<s>$1</s>');

  return result;
}

export type MessageCallback = (data: {
  userMessage: string;
  response: string;
  channel: 'telegram';
  chatId: number;
  sessionId: string;
}) => void;

export class TelegramBot extends BaseChannel {
  name = 'telegram';
  private bot: Bot;
  private allowedUserIds: Set<number>;
  private activeChatIds: Set<number> = new Set();
  private onMessageCallback: MessageCallback | null = null;

  constructor() {
    super();
    const botToken = SettingsManager.get('telegram.botToken');
    if (!botToken) {
      throw new Error('Telegram bot token not configured');
    }
    const allowedUsers = SettingsManager.getArray('telegram.allowedUserIds');
    this.bot = new Bot(botToken);
    this.allowedUserIds = new Set(allowedUsers.map(id => parseInt(id, 10)).filter(id => !isNaN(id)));
    this.loadPersistedChatIds();
    this.setupHandlers();
  }

  /**
   * Load persisted chat IDs from settings
   */
  private loadPersistedChatIds(): void {
    const savedIds = SettingsManager.getArray('telegram.activeChatIds');
    for (const id of savedIds) {
      const parsed = parseInt(id, 10);
      if (!isNaN(parsed)) {
        this.activeChatIds.add(parsed);
      }
    }
    if (this.activeChatIds.size > 0) {
      console.log(`[Telegram] Loaded ${this.activeChatIds.size} persisted chat IDs`);
    }
  }

  /**
   * Persist chat IDs to settings
   */
  private persistChatIds(): void {
    const ids = Array.from(this.activeChatIds).map(String);
    SettingsManager.set('telegram.activeChatIds', JSON.stringify(ids));
  }

  /**
   * Set callback for when messages are received (for cross-channel sync)
   */
  setOnMessageCallback(callback: MessageCallback): void {
    this.onMessageCallback = callback;
  }

  private setupHandlers(): void {
    // Middleware to check allowed users (if configured)
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;

      // Track active chat IDs for proactive messaging
      if (chatId) {
        const isNew = !this.activeChatIds.has(chatId);
        this.activeChatIds.add(chatId);
        if (isNew) {
          this.persistChatIds();
          console.log(`[Telegram] New chat ID registered: ${chatId}`);
        }
      }

      // If allowlist is configured, enforce it
      if (this.allowedUserIds.size > 0) {
        if (!userId || !this.allowedUserIds.has(userId)) {
          console.log(`[Telegram] Unauthorized user: ${userId}`);
          await ctx.reply('Sorry, you are not authorized to use this bot.');
          return;
        }
      }

      await next();
    });

    // Handle bot being added to a group - auto-link to session
    this.bot.on('my_chat_member', async (ctx) => {
      const chatId = ctx.chat?.id;
      const newStatus = ctx.myChatMember?.new_chat_member?.status;
      const chatType = ctx.chat?.type;

      // Only handle when bot is added to a group (not kicked/left)
      if (!chatId || !['member', 'administrator'].includes(newStatus || '')) {
        return;
      }

      // Only handle group chats (not private chats)
      if (chatType !== 'group' && chatType !== 'supergroup') {
        return;
      }

      const groupName = ctx.chat?.title || '';
      console.log(`[Telegram] Bot added to group "${groupName}" (chatId: ${chatId})`);

      // Try to match group name to a session
      const memory = AgentManager.getMemory();
      if (!memory) {
        await ctx.reply('⚠️ Memory not initialized. Please try again later.');
        return;
      }

      const session = memory.getSessionByName(groupName);
      if (session) {
        // Link the chat to the session
        memory.linkTelegramChat(chatId, session.id, groupName);
        await ctx.reply(
          `✅ Linked to session "${session.name}"\n\n` +
          `Messages in this group will now sync with the "${session.name}" session in the desktop app.\n\n` +
          `⚠️ Note: To see all messages (not just commands), either:\n` +
          `• Make me an admin in this group, OR\n` +
          `• Disable Privacy Mode via @BotFather (/setprivacy → Disable)`
        );
        console.log(`[Telegram] Linked group "${groupName}" (chatId: ${chatId}) to session "${session.id}"`);
      } else {
        // List available sessions
        const sessions = memory.getSessions();
        const sessionNames = sessions.map(s => `• ${s.name}`).join('\n');
        await ctx.reply(
          `⚠️ No session found with name "${groupName}"\n\n` +
          `Available sessions:\n${sessionNames}\n\n` +
          `To link this group, rename it to match one of the session names above, or use /link <session-name>.`
        );
      }
    });

    // Handle /link command for manual linking
    this.bot.command('link', async (ctx) => {
      const chatId = ctx.chat?.id;
      const chatType = ctx.chat?.type;
      const sessionName = ctx.message?.text?.replace('/link', '').trim();

      if (!chatId) return;

      // Only allow linking in groups
      if (chatType !== 'group' && chatType !== 'supergroup') {
        await ctx.reply('The /link command only works in group chats. Create a group and add me to it first.');
        return;
      }

      if (!sessionName) {
        const memory = AgentManager.getMemory();
        const sessions = memory?.getSessions() || [];
        const sessionNames = sessions.map(s => `• ${s.name}`).join('\n');
        await ctx.reply(
          `Usage: /link <session-name>\n\n` +
          `Available sessions:\n${sessionNames}`
        );
        return;
      }

      const memory = AgentManager.getMemory();
      if (!memory) {
        await ctx.reply('⚠️ Memory not initialized. Please try again later.');
        return;
      }

      const session = memory.getSessionByName(sessionName);
      if (!session) {
        const sessions = memory.getSessions();
        const sessionNames = sessions.map(s => `• ${s.name}`).join('\n');
        await ctx.reply(
          `❌ No session found with name "${sessionName}"\n\n` +
          `Available sessions:\n${sessionNames}`
        );
        return;
      }

      // Link the chat to the session
      memory.linkTelegramChat(chatId, session.id, ctx.chat?.title || undefined);
      await ctx.reply(
        `✅ Linked to session "${session.name}"\n\n` +
        `Messages in this group will now sync with the "${session.name}" session.\n\n` +
        `⚠️ Note: To see all messages (not just commands), either:\n` +
        `• Make me an admin in this group, OR\n` +
        `• Disable Privacy Mode via @BotFather (/setprivacy → Disable)`
      );
      console.log(`[Telegram] Manually linked chat ${chatId} to session "${session.id}"`);
    });

    // Handle /unlink command
    this.bot.command('unlink', async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const memory = AgentManager.getMemory();
      if (!memory) {
        await ctx.reply('⚠️ Memory not initialized.');
        return;
      }

      const currentSession = memory.getSessionForChat(chatId);
      if (!currentSession) {
        await ctx.reply('This chat is not linked to any session.');
        return;
      }

      memory.unlinkTelegramChat(chatId);
      await ctx.reply('✅ Chat unlinked. Messages will now go to the default session.');
      console.log(`[Telegram] Unlinked chat ${chatId}`);
    });

    // Handle /start command
    this.bot.command('start', async (ctx) => {
      const userId = ctx.from?.id;
      const chatType = ctx.chat?.type;
      const isGroup = chatType === 'group' || chatType === 'supergroup';

      await ctx.reply(
        `Welcome to Pocket Agent!\n\n` +
        `I'm your personal AI assistant with persistent memory. ` +
        `I remember our conversations across sessions.\n\n` +
        `Your user ID: ${userId}\n\n` +
        `Commands:\n` +
        `/status - Show agent status\n` +
        `/facts [query] - Search stored facts\n` +
        `/clear - Clear conversation (keeps facts)\n` +
        `/mychatid - Show your chat ID for cron jobs` +
        (isGroup ? `\n/link <session> - Link this group to a session\n/unlink - Unlink this group` : '')
      );
    });

    // Handle /mychatid command (for setting up cron notifications)
    this.bot.command('mychatid', async (ctx) => {
      const chatId = ctx.chat?.id;
      const userId = ctx.from?.id;
      await ctx.reply(
        `Your IDs for cron job configuration:\n\n` +
        `Chat ID: ${chatId}\n` +
        `User ID: ${userId}\n\n` +
        `Use the Chat ID when scheduling tasks that should message you.`
      );
    });

    // Handle /status command
    this.bot.command('status', async (ctx) => {
      const stats = AgentManager.getStats();
      if (!stats) {
        await ctx.reply('Agent not initialized');
        return;
      }

      const memoryMB = process.memoryUsage().heapUsed / 1024 / 1024;

      await ctx.reply(
        `📊 Pocket Agent Status\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💬 Messages: ${stats.messageCount}\n` +
        `🧠 Facts: ${stats.factCount}\n` +
        `⏰ Cron Jobs: ${stats.cronJobCount}\n` +
        `📝 Summaries: ${stats.summaryCount}\n` +
        `🎯 Est. Tokens: ${stats.estimatedTokens.toLocaleString()}\n` +
        `💾 Memory: ${memoryMB.toFixed(1)} MB`
      );
    });

    // Handle /facts command
    this.bot.command('facts', async (ctx) => {
      const query = ctx.message?.text?.replace('/facts', '').trim();

      if (!query) {
        // List all facts grouped by category
        const facts = AgentManager.getAllFacts();
        if (facts.length === 0) {
          await ctx.reply('No facts stored yet.\n\nI learn facts when you tell me things about yourself, or when I use the remember tool.');
          return;
        }

        // Group by category
        const byCategory = new Map<string, typeof facts>();
        for (const fact of facts) {
          const list = byCategory.get(fact.category) || [];
          list.push(fact);
          byCategory.set(fact.category, list);
        }

        const lines: string[] = [`📚 Known Facts (${facts.length} total)`];
        for (const [category, categoryFacts] of byCategory) {
          lines.push(`\n📁 ${category}`);
          for (const fact of categoryFacts) {
            lines.push(`  • ${fact.subject}: ${fact.content}`);
          }
        }

        await this.sendResponse(ctx, lines.join('\n'));
        return;
      }

      const facts = AgentManager.searchFacts(query);
      if (facts.length === 0) {
        await ctx.reply(`No facts found for "${query}"`);
        return;
      }

      const response = facts
        .slice(0, 15)
        .map(f => `[${f.category}] ${f.subject}: ${f.content}`)
        .join('\n');

      await ctx.reply(`Found ${facts.length} fact(s):\n\n${response}`);
    });

    // Handle /clear command
    this.bot.command('clear', async (ctx) => {
      AgentManager.clearConversation();
      await ctx.reply('✅ Conversation history cleared.\nFacts and scheduled tasks are preserved.');
    });

    // Handle /testhtml command - for debugging HTML formatting
    this.bot.command('testhtml', async (ctx) => {
      const testHtml = `<b>Bold text</b>
<i>Italic text</i>
<u>Underline text</u>
<s>Strikethrough text</s>
<code>inline code</code>
<pre>code block
multiline</pre>
<a href="https://example.com">Link text</a>

• Bullet point 1
• Bullet point 2

1. Numbered item
2. Another item`;

      try {
        await ctx.reply(testHtml, { parse_mode: 'HTML' });
      } catch (error) {
        console.error('[Telegram] Test HTML failed:', error);
        await ctx.reply('HTML test failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
      }
    });

    // Handle all text messages
    this.bot.on('message:text', async (ctx: Context) => {
      const message = ctx.message?.text;
      const chatId = ctx.chat?.id;
      if (!message || !chatId) return;

      // Show typing indicator
      await ctx.replyWithChatAction('typing');

      // Keep typing indicator active for long operations
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);

      try {
        // Look up which session this chat is linked to
        const memory = AgentManager.getMemory();
        const sessionId = memory?.getSessionForChat(chatId) || 'default';

        const result = await AgentManager.processMessage(message, 'telegram', sessionId);

        // Send response, splitting if necessary
        await this.sendResponse(ctx, result.response);

        // Notify callback for cross-channel sync (to desktop)
        if (this.onMessageCallback) {
          this.onMessageCallback({
            userMessage: message,
            response: result.response,
            channel: 'telegram',
            chatId,
            sessionId,
          });
        }

        // If compaction happened, notify
        if (result.wasCompacted) {
          await ctx.reply('📦 (Conversation history was compacted to save space)');
        }
      } catch (error) {
        console.error('[Telegram] Error:', error);
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        await ctx.reply(`❌ Error: ${errorMsg}`);
      } finally {
        // Always clear the typing interval to prevent leaks
        clearInterval(typingInterval);
      }
    });

    // Error handler
    this.bot.catch((err) => {
      console.error('[Telegram] Bot error:', err);
    });
  }

  /**
   * Send a response, splitting into multiple messages if needed
   * Converts markdown to Telegram HTML format
   */
  private async sendResponse(ctx: Context, text: string): Promise<void> {
    const MAX_LENGTH = 4000; // Telegram limit is 4096, leave buffer

    if (text.length <= MAX_LENGTH) {
      const html = markdownToTelegramHtml(text);
      try {
        await ctx.reply(html, { parse_mode: 'HTML' });
      } catch (error) {
        // Fallback to plain text if HTML parsing fails
        console.error('[Telegram] HTML parse failed, falling back to plain text:', error);
        await ctx.reply(text);
      }
      return;
    }

    const chunks = this.splitMessage(text, MAX_LENGTH);
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length}) ` : '';
      const html = markdownToTelegramHtml(prefix + chunks[i]);
      try {
        await ctx.reply(html, { parse_mode: 'HTML' });
      } catch {
        // Fallback to plain text if HTML parsing fails
        await ctx.reply(prefix + chunks[i]);
      }
      // Small delay between messages to maintain order
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  /**
   * Split long text into chunks at natural boundaries
   */
  private splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try to find a good split point
      let splitPoint = -1;

      // Priority 1: Double newline (paragraph break)
      const doubleNewline = remaining.lastIndexOf('\n\n', maxLength);
      if (doubleNewline > maxLength / 2) {
        splitPoint = doubleNewline;
      }

      // Priority 2: Single newline
      if (splitPoint === -1) {
        const singleNewline = remaining.lastIndexOf('\n', maxLength);
        if (singleNewline > maxLength / 2) {
          splitPoint = singleNewline;
        }
      }

      // Priority 3: Sentence end
      if (splitPoint === -1) {
        const sentenceEnd = Math.max(
          remaining.lastIndexOf('. ', maxLength),
          remaining.lastIndexOf('! ', maxLength),
          remaining.lastIndexOf('? ', maxLength)
        );
        if (sentenceEnd > maxLength / 2) {
          splitPoint = sentenceEnd + 1;
        }
      }

      // Priority 4: Space
      if (splitPoint === -1) {
        const space = remaining.lastIndexOf(' ', maxLength);
        if (space > maxLength / 2) {
          splitPoint = space;
        }
      }

      // Fallback: Hard cut
      if (splitPoint === -1) {
        splitPoint = maxLength;
      }

      chunks.push(remaining.substring(0, splitPoint).trim());
      remaining = remaining.substring(splitPoint).trim();
    }

    return chunks;
  }

  /**
   * Proactively send a message to a specific chat
   * Used by scheduler for cron jobs
   * Converts markdown to Telegram HTML format
   */
  async sendMessage(chatId: number, text: string): Promise<boolean> {
    if (!this.isRunning) {
      console.error('[Telegram] Bot not running, cannot send message');
      return false;
    }

    try {
      const MAX_LENGTH = 4000;

      if (text.length <= MAX_LENGTH) {
        const html = markdownToTelegramHtml(text);
        try {
          await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
        } catch {
          // Fallback to plain text
          await this.bot.api.sendMessage(chatId, text);
        }
      } else {
        const chunks = this.splitMessage(text, MAX_LENGTH);
        for (let i = 0; i < chunks.length; i++) {
          const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length}) ` : '';
          const html = markdownToTelegramHtml(prefix + chunks[i]);
          try {
            await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
          } catch {
            await this.bot.api.sendMessage(chatId, prefix + chunks[i]);
          }
          if (i < chunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }

      console.log(`[Telegram] Sent proactive message to chat ${chatId}`);
      return true;
    } catch (error) {
      console.error(`[Telegram] Failed to send message to chat ${chatId}:`, error);
      return false;
    }
  }

  /**
   * Send a message to all active chats (broadcast)
   */
  async broadcast(text: string): Promise<number> {
    let sent = 0;
    for (const chatId of this.activeChatIds) {
      const success = await this.sendMessage(chatId, text);
      if (success) sent++;
    }
    return sent;
  }

  /**
   * Sync a desktop conversation to Telegram
   * Shows both the user message and assistant response
   */
  async syncFromDesktop(userMessage: string, response: string): Promise<number> {
    const text = `💻 [Desktop]\n\n👤 ${userMessage}\n\n🤖 ${response}`;
    return this.broadcast(text);
  }

  /**
   * Get list of active chat IDs
   */
  getActiveChatIds(): number[] {
    return Array.from(this.activeChatIds);
  }

  /**
   * Add a user to the allowlist
   */
  addAllowedUser(userId: number): void {
    this.allowedUserIds.add(userId);
  }

  /**
   * Remove a user from the allowlist
   */
  removeAllowedUser(userId: number): void {
    this.allowedUserIds.delete(userId);
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    const botToken = SettingsManager.get('telegram.botToken');
    if (!botToken) {
      console.error('[Telegram] No bot token configured');
      return;
    }

    try {
      // Start bot and wait for it to be ready
      // Note: bot.start() returns a Promise that resolves when polling starts
      await this.bot.start({
        onStart: (botInfo) => {
          console.log(`[Telegram] Bot @${botInfo.username} started`);
          console.log(`[Telegram] Allowlist: ${this.allowedUserIds.size > 0
            ? Array.from(this.allowedUserIds).join(', ')
            : 'disabled (all users allowed)'}`);
        },
      });
      // Only set isRunning after successful start
      this.isRunning = true;
    } catch (error) {
      console.error('[Telegram] Failed to start bot:', error);
      this.isRunning = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    await this.bot.stop();
    this.isRunning = false;
    console.log('[Telegram] Bot stopped');
  }
}

// Singleton instance
let telegramBotInstance: TelegramBot | null = null;

export function getTelegramBot(): TelegramBot | null {
  return telegramBotInstance;
}

export function createTelegramBot(): TelegramBot | null {
  if (!telegramBotInstance) {
    try {
      telegramBotInstance = new TelegramBot();
    } catch (error) {
      console.error('[Telegram] Failed to create bot:', error);
      return null;
    }
  }
  return telegramBotInstance;
}
