import cron, { ScheduledTask } from 'node-cron';
import Database from 'better-sqlite3';
import { AgentManager } from '../agent';
import { MemoryManager, CronJob } from '../memory';
import type { TelegramBot } from '../channels/telegram';

/**
 * Silent acknowledgment token for scheduled tasks.
 * When the agent responds with only this token, the scheduler
 * skips notification - useful for "nothing to report" scenarios.
 */
export const HEARTBEAT_OK = 'HEARTBEAT_OK';

interface CalendarEvent {
  id: number;
  title: string;
  description: string | null;
  start_time: string;
  location: string | null;
  reminder_minutes: number;
  channel: string;
}

interface Task {
  id: number;
  title: string;
  description: string | null;
  due_date: string;
  priority: string;
  reminder_minutes: number;
  channel: string;
}

export interface ScheduledJob {
  id: number;
  name: string;
  scheduleType?: 'cron' | 'at' | 'every';
  schedule: string | null;
  runAt?: string | null;
  intervalMs?: number | null;
  prompt: string;
  channel: string;
  recipient?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  contextMessages?: number;
  nextRunAt?: string | null;
}

export interface JobResult {
  jobName: string;
  response: string;
  channel: string;
  success: boolean;
  error?: string;
  timestamp: Date;
}

/**
 * CronScheduler - Manages scheduled jobs from SQLite
 *
 * Loads jobs from cron_jobs table, runs them on schedule,
 * calls AgentManager.processMessage() and routes responses.
 */
export class CronScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private jobs: Map<string, ScheduledJob> = new Map();
  private memory: MemoryManager | null = null;
  private telegramBot: TelegramBot | null = null;
  private jobHistory: JobResult[] = [];
  private maxHistorySize: number = 100;
  private reloadInterval: ReturnType<typeof setInterval> | null = null;
  private reminderInterval: ReturnType<typeof setInterval> | null = null;
  private lastJobCount: number = 0;
  private dbPath: string | null = null;
  private db: Database.Database | null = null; // Persistent DB connection for reminders
  private isCheckingReminders: boolean = false; // Mutex to prevent overlapping checks

  constructor() {}

  /**
   * Initialize scheduler with memory manager and load jobs
   */
  async initialize(memory: MemoryManager, dbPath?: string): Promise<void> {
    this.memory = memory;
    this.dbPath = dbPath || null;

    // Open persistent DB connection for reminder checks (avoids creating new connection every 30s)
    if (this.dbPath) {
      this.db = new Database(this.dbPath);
    }

    await this.loadJobsFromDatabase();
    this.lastJobCount = this.jobs.size;
    console.log(`[Scheduler] Initialized with ${this.jobs.size} jobs`);

    // Start periodic check for new jobs (every 60 seconds)
    this.reloadInterval = setInterval(() => {
      this.checkForNewJobs();
    }, 60000);

    // Start periodic check for calendar/task reminders (every 30 seconds)
    this.reminderInterval = setInterval(() => {
      this.checkReminders();
    }, 30000);

    // Run initial reminder check
    this.checkReminders();
  }

  /**
   * Check if new jobs have been added to the database
   */
  private async checkForNewJobs(): Promise<void> {
    if (!this.memory) return;

    const dbJobs = this.memory.getCronJobs(false); // Get all jobs
    const currentCount = dbJobs.length;

    // If job count changed, reload
    if (currentCount !== this.lastJobCount) {
      console.log(`[Scheduler] Job count changed (${this.lastJobCount} -> ${currentCount}), reloading...`);
      await this.loadJobsFromDatabase();
      this.lastJobCount = this.jobs.size;
    }
  }

  /**
   * Check for calendar events and tasks that need reminders
   * Uses mutex to prevent overlapping executions
   */
  private async checkReminders(): Promise<void> {
    if (!this.db) return;

    // Mutex: prevent overlapping executions
    if (this.isCheckingReminders) {
      console.log('[Scheduler] Skipping reminder check - previous check still running');
      return;
    }

    this.isCheckingReminders = true;

    try {
      const db = this.db;
      const now = new Date();

      // Check calendar events
      const events = db.prepare(`
        SELECT id, title, description, start_time, location, reminder_minutes, channel
        FROM calendar_events
        WHERE reminded = 0
          AND datetime(start_time, '-' || reminder_minutes || ' minutes') <= datetime(?)
          AND datetime(start_time) > datetime(?)
      `).all(now.toISOString(), now.toISOString()) as CalendarEvent[];

      for (const event of events) {
        const startTime = new Date(event.start_time);
        const minutesUntil = Math.round((startTime.getTime() - now.getTime()) / 60000);

        let message = `Upcoming event: "${event.title}"`;
        if (minutesUntil > 0) {
          message += ` in ${minutesUntil} minute${minutesUntil === 1 ? '' : 's'}`;
        } else {
          message += ' starting now';
        }
        if (event.location) {
          message += ` at ${event.location}`;
        }

        await this.sendReminder('calendar', event.title, message, event.channel);

        // Mark as reminded
        db.prepare('UPDATE calendar_events SET reminded = 1 WHERE id = ?').run(event.id);
      }

      // Check tasks with due dates
      const tasks = db.prepare(`
        SELECT id, title, description, due_date, priority, reminder_minutes, channel
        FROM tasks
        WHERE status != 'completed'
          AND reminded = 0
          AND reminder_minutes IS NOT NULL
          AND datetime(due_date, '-' || reminder_minutes || ' minutes') <= datetime(?)
          AND datetime(due_date) > datetime(?)
      `).all(now.toISOString(), now.toISOString()) as Task[];

      for (const task of tasks) {
        const dueDate = new Date(task.due_date);
        const minutesUntil = Math.round((dueDate.getTime() - now.getTime()) / 60000);

        let message = `Task due soon: "${task.title}"`;
        if (minutesUntil > 0) {
          message += ` in ${minutesUntil} minute${minutesUntil === 1 ? '' : 's'}`;
        } else {
          message += ' due now';
        }
        if (task.priority === 'high') {
          message += ' (High Priority)';
        }

        await this.sendReminder('task', task.title, message, task.channel);

        // Mark as reminded
        db.prepare('UPDATE tasks SET reminded = 1 WHERE id = ?').run(task.id);
      }

      // Check for due cron jobs
      await this.checkDueJobs(db, now);
    } catch (error) {
      console.error('[Scheduler] Reminder check failed:', error);
    } finally {
      // Release mutex (DB stays open for reuse)
      this.isCheckingReminders = false;
    }
  }

  /**
   * Check for cron jobs that are due to run
   */
  private async checkDueJobs(db: Database.Database, now: Date): Promise<void> {
    interface DueJob {
      id: number;
      name: string;
      schedule_type: string;
      schedule: string | null;
      run_at: string | null;
      interval_ms: number | null;
      prompt: string;
      channel: string;
      delete_after_run: number;
      context_messages: number;
    }

    const dueJobs = db.prepare(`
      SELECT id, name, schedule_type, schedule, run_at, interval_ms, prompt, channel, delete_after_run, context_messages
      FROM cron_jobs
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND datetime(next_run_at) <= datetime(?)
    `).all(now.toISOString()) as DueJob[];

    for (const job of dueJobs) {
      const startTime = Date.now();

      try {
        console.log(`[Scheduler] Executing job: ${job.name}`);

        // Get context messages if requested
        let contextText = '';
        if (job.context_messages > 0 && this.memory) {
          const history = this.memory.getRecentMessages(job.context_messages);
          if (history.length > 0) {
            const lines = history.map(m => {
              const role = m.role === 'user' ? 'User' : 'Assistant';
              const text = m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content;
              return `- ${role}: ${text}`;
            });
            contextText = '\n\nRecent context:\n' + lines.join('\n');
          }
        }

        const fullPrompt = job.prompt + contextText + '\n\nIf nothing needs attention, reply with only HEARTBEAT_OK.';

        // Execute through agent
        if (!AgentManager.isInitialized()) {
          throw new Error('AgentManager not initialized');
        }

        const result = await AgentManager.processMessage(
          `[Scheduled: ${job.name}] ${fullPrompt}`,
          `cron:${job.name}`
        );

        const duration = Date.now() - startTime;

        // Update job state
        const nextRunAt = this.calculateNextRun(job.schedule_type, job.schedule, job.interval_ms);

        if (job.delete_after_run === 1) {
          // Delete one-time job
          db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(job.id);
          console.log(`[Scheduler] Deleted one-time job: ${job.name}`);
        } else {
          // Update state
          db.prepare(`
            UPDATE cron_jobs SET
              last_run_at = datetime(?),
              last_status = 'ok',
              last_error = NULL,
              last_duration_ms = ?,
              next_run_at = ?,
              updated_at = datetime('now')
            WHERE id = ?
          `).run(now.toISOString(), duration, nextRunAt, job.id);
        }

        // Route response
        await this.routeJobResponse(job.name, job.prompt, result.response, job.channel);

        this.addToHistory({
          jobName: job.name,
          response: result.response,
          channel: job.channel,
          success: true,
          timestamp: now,
        });

      } catch (error) {
        const duration = Date.now() - startTime;
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';

        console.error(`[Scheduler] Job ${job.name} failed:`, errorMsg);

        // Update state with error
        const nextRunAt = this.calculateNextRun(job.schedule_type, job.schedule, job.interval_ms);
        db.prepare(`
          UPDATE cron_jobs SET
            last_run_at = datetime(?),
            last_status = 'error',
            last_error = ?,
            last_duration_ms = ?,
            next_run_at = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(now.toISOString(), errorMsg, duration, nextRunAt, job.id);

        this.addToHistory({
          jobName: job.name,
          response: '',
          channel: job.channel,
          success: false,
          error: errorMsg,
          timestamp: now,
        });
      }
    }
  }

  /**
   * Calculate next run time based on schedule type
   */
  private calculateNextRun(type: string, schedule: string | null, intervalMs: number | null): string | null {
    const now = new Date();

    if (type === 'at') {
      // One-time job, no next run
      return null;
    }

    if (type === 'every' && intervalMs) {
      return new Date(now.getTime() + intervalMs).toISOString();
    }

    if (type === 'cron' && schedule) {
      // Simple next cron calculation
      const parts = schedule.split(/\s+/);
      if (parts.length !== 5) {
        console.warn(`[Scheduler] Invalid cron expression (expected 5 parts): "${schedule}"`);
        // Return a fallback of 24 hours to prevent job from being permanently disabled
        return new Date(now.getTime() + 86400000).toISOString();
      }

      const [min, hour] = parts;
      const next = new Date(now);
      next.setSeconds(0, 0);

      if (min !== '*') next.setMinutes(parseInt(min, 10));
      if (hour !== '*') next.setHours(parseInt(hour, 10));

      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }

      return next.toISOString();
    }

    // Fallback for unknown schedule types - don't disable the job
    console.warn(`[Scheduler] Unknown schedule type "${type}", defaulting to 24h interval`);
    return new Date(now.getTime() + 86400000).toISOString();
  }

  /**
   * Route job response to appropriate channel(s).
   * Skips notification if response is just HEARTBEAT_OK (nothing to report).
   * Always sends to desktop, and also to Telegram if configured.
   */
  private async routeJobResponse(jobName: string, prompt: string, response: string, channel: string): Promise<void> {
    // Check for silent acknowledgment - agent has nothing to report
    // Match HEARTBEAT_OK anywhere in response (case-insensitive)
    if (response.toUpperCase().includes(HEARTBEAT_OK)) {
      console.log(`[Scheduler] Job ${jobName} returned HEARTBEAT_OK, skipping notification`);
      return;
    }

    // Always send to desktop (notification + chat)
    const plainResponse = this.stripMarkdown(response);
    if (this.onNotification) {
      this.onNotification('Pocket Agent', plainResponse.slice(0, 200));
    }
    if (this.onChatMessage) {
      this.onChatMessage(jobName, prompt, response);
    }

    // Also send to Telegram if configured
    if (channel === 'telegram' && this.telegramBot) {
      await this.telegramBot.broadcast(`📅 ${jobName}\n\n${response}`);
    }
  }

  /**
   * Send a reminder notification.
   * Always sends to desktop, and also to Telegram if configured.
   */
  private async sendReminder(type: 'calendar' | 'task', title: string, message: string, channel: string): Promise<void> {
    console.log(`[Scheduler] Sending ${type} reminder: ${title}`);

    // Always send to desktop (notification + chat)
    if (this.onNotification) {
      this.onNotification('Pocket Agent', message);
    }
    if (this.onChatMessage) {
      this.onChatMessage(`${type}_reminder`, message, message);
    }

    // Also send to Telegram if configured
    if (channel === 'telegram' && this.telegramBot) {
      await this.telegramBot.broadcast(`${type === 'calendar' ? '📅' : '✓'} ${message}`);
    }

    // Log to history
    this.addToHistory({
      jobName: `${type}:${title}`,
      response: message,
      channel,
      success: true,
      timestamp: new Date(),
    });
  }

  /**
   * Set Telegram bot for routing messages
   */
  setTelegramBot(bot: TelegramBot): void {
    this.telegramBot = bot;
    console.log('[Scheduler] Telegram bot connected');
  }

  /**
   * Load all enabled jobs from database and schedule them
   * Note: Only 'cron' type jobs are scheduled with node-cron.
   * 'at' and 'every' jobs are handled by checkDueJobs() timer.
   */
  async loadJobsFromDatabase(): Promise<void> {
    if (!this.memory) {
      console.error('[Scheduler] Memory not initialized');
      return;
    }

    // Stop all existing cron tasks (but not the reminder interval)
    for (const [name, task] of this.tasks) {
      task.stop();
      console.log(`[Scheduler] Stopped: ${name}`);
    }
    this.tasks.clear();
    this.jobs.clear();

    // Load jobs from SQLite
    const dbJobs = this.memory.getCronJobs(true); // enabled only
    let cronJobCount = 0;

    for (const dbJob of dbJobs) {
      // Only schedule 'cron' type jobs with node-cron
      // 'at' and 'every' jobs are handled by the timer in checkDueJobs()
      const scheduleType = dbJob.schedule_type || 'cron';
      if (scheduleType !== 'cron' || !dbJob.schedule) {
        continue;
      }

      const job: ScheduledJob = {
        id: dbJob.id,
        name: dbJob.name,
        scheduleType: 'cron',
        schedule: dbJob.schedule,
        prompt: dbJob.prompt,
        channel: dbJob.channel,
        recipient: this.extractRecipient(dbJob.prompt),
        enabled: dbJob.enabled,
      };

      if (this.scheduleJob(job)) {
        cronJobCount++;
      }
    }

    console.log(`[Scheduler] Loaded ${dbJobs.length} jobs (${cronJobCount} cron, ${dbJobs.length - cronJobCount} timer-based)`);
  }

  /**
   * Extract recipient from prompt if specified (format: @recipient: prompt)
   */
  private extractRecipient(prompt: string): string | undefined {
    const match = prompt.match(/^@(\S+):\s*/);
    return match ? match[1] : undefined;
  }

  /**
   * Schedule a single job
   */
  scheduleJob(job: ScheduledJob): boolean {
    if (!job.schedule || !cron.validate(job.schedule)) {
      console.error(`[Scheduler] Invalid cron expression for ${job.name}: ${job.schedule}`);
      return false;
    }

    // Stop existing task with same name
    this.stopJob(job.name);

    const schedule = job.schedule;
    const task = cron.schedule(schedule, async () => {
      await this.executeJob(job);
    });

    this.tasks.set(job.name, task);
    this.jobs.set(job.name, job);

    console.log(`[Scheduler] Scheduled: ${job.name} (${job.schedule}) → ${job.channel}`);
    return true;
  }

  /**
   * Execute a job
   */
  private async executeJob(job: ScheduledJob): Promise<void> {
    console.log(`[Scheduler] Executing: ${job.name}`);

    const result: JobResult = {
      jobName: job.name,
      response: '',
      channel: job.channel,
      success: false,
      timestamp: new Date(),
    };

    if (!AgentManager.isInitialized()) {
      result.error = 'AgentManager not initialized';
      this.addToHistory(result);
      console.error(`[Scheduler] ${result.error}`);
      return;
    }

    try {
      // Clean prompt (remove recipient prefix if present)
      const cleanPrompt = job.prompt.replace(/^@\S+:\s*/, '');

      // Process through agent
      const agentResult = await AgentManager.processMessage(
        `[Scheduled Task: ${job.name}] ${cleanPrompt}`,
        `cron:${job.name}`
      );

      result.response = agentResult.response;
      result.success = true;

      // Route response to channel
      await this.routeResponse(job, result.response);

    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Scheduler] Job ${job.name} failed:`, result.error);
    }

    this.addToHistory(result);
  }

  /**
   * Route response to appropriate channel
   */
  private async routeResponse(job: ScheduledJob, response: string): Promise<void> {
    switch (job.channel) {
      case 'telegram':
        if (this.telegramBot) {
          if (job.recipient) {
            // Send to specific chat
            const chatId = parseInt(job.recipient, 10);
            if (!isNaN(chatId)) {
              await this.telegramBot.sendMessage(chatId, `📅 ${job.name}\n\n${response}`);
            }
          } else {
            // Broadcast to all active chats
            await this.telegramBot.broadcast(`📅 ${job.name}\n\n${response}`);
          }
        } else {
          console.warn(`[Scheduler] Telegram not available for job: ${job.name}`);
        }
        break;

      case 'desktop':
      case 'default':
        // Send to chat window AND show notification
        this.emitChatMessage(job.name, job.prompt, response);
        // Notification: friendly title, plain text body (strip markdown)
        const plainResponse = this.stripMarkdown(response);
        this.emitDesktopNotification('Pocket Agent', plainResponse.slice(0, 200));
        break;

      default:
        console.log(`[Scheduler] Response for ${job.name} (${job.channel}): ${response.slice(0, 100)}...`);
    }
  }

  /**
   * Emit desktop notification (handled by main process)
   */
  private emitDesktopNotification(title: string, body: string): void {
    if (this.onNotification) {
      this.onNotification(title, body);
    }
  }

  /**
   * Emit chat message (sends to chat window)
   */
  private emitChatMessage(jobName: string, prompt: string, response: string): void {
    if (this.onChatMessage) {
      this.onChatMessage(jobName, prompt, response);
    }
  }

  /**
   * Strip markdown formatting for plain text (notifications)
   */
  private stripMarkdown(text: string): string {
    return text
      // Remove headers
      .replace(/^#{1,6}\s+/gm, '')
      // Remove bold/italic
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, '[code]')
      .replace(/`([^`]+)`/g, '$1')
      // Remove links
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove bullet points
      .replace(/^[\s]*[-*+]\s+/gm, '• ')
      // Remove extra whitespace
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Set notification handler
   */
  setNotificationHandler(handler: (title: string, body: string) => void): void {
    this.onNotification = handler;
  }

  /**
   * Set chat message handler (for sending to chat window)
   */
  setChatHandler(handler: (jobName: string, prompt: string, response: string) => void): void {
    this.onChatMessage = handler;
  }

  private onNotification?: (title: string, body: string) => void;
  private onChatMessage?: (jobName: string, prompt: string, response: string) => void;

  /**
   * Add result to history
   */
  private addToHistory(result: JobResult): void {
    this.jobHistory.unshift(result);
    if (this.jobHistory.length > this.maxHistorySize) {
      this.jobHistory.pop();
    }
  }

  /**
   * Create a new job and save to database
   */
  async createJob(
    name: string,
    schedule: string,
    prompt: string,
    channel: string = 'default'
  ): Promise<boolean> {
    if (!this.memory) return false;

    if (!cron.validate(schedule)) {
      console.error(`[Scheduler] Invalid cron: ${schedule}`);
      return false;
    }

    // Save to database
    const id = this.memory.saveCronJob(name, schedule, prompt, channel);

    // Schedule it
    const job: ScheduledJob = {
      id,
      name,
      schedule,
      prompt,
      channel,
      recipient: this.extractRecipient(prompt),
      enabled: true,
    };

    return this.scheduleJob(job);
  }

  /**
   * Delete a job
   */
  deleteJob(name: string): boolean {
    this.stopJob(name);

    if (this.memory) {
      return this.memory.deleteCronJob(name);
    }

    return false;
  }

  /**
   * Stop a specific job
   */
  stopJob(name: string): boolean {
    const task = this.tasks.get(name);
    if (task) {
      task.stop();
      this.tasks.delete(name);
      this.jobs.delete(name);
      console.log(`[Scheduler] Stopped: ${name}`);
      return true;
    }
    return false;
  }

  /**
   * Stop all jobs
   */
  stopAll(): void {
    // Stop reload interval
    if (this.reloadInterval) {
      clearInterval(this.reloadInterval);
      this.reloadInterval = null;
    }

    // Stop reminder interval
    if (this.reminderInterval) {
      clearInterval(this.reminderInterval);
      this.reminderInterval = null;
    }

    // Close persistent DB connection
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Ignore close errors
      }
      this.db = null;
    }

    for (const [name, task] of this.tasks) {
      task.stop();
      console.log(`[Scheduler] Stopped: ${name}`);
    }
    this.tasks.clear();
    this.jobs.clear();
  }

  /**
   * Enable/disable a job
   */
  setJobEnabled(name: string, enabled: boolean): boolean {
    if (!this.memory) return false;

    const success = this.memory.setCronJobEnabled(name, enabled);

    if (success) {
      if (enabled) {
        // Reload from database to reschedule
        const dbJobs = this.memory.getCronJobs(false);
        const dbJob = dbJobs.find(j => j.name === name);
        if (dbJob) {
          this.scheduleJob({
            id: dbJob.id,
            name: dbJob.name,
            schedule: dbJob.schedule,
            prompt: dbJob.prompt,
            channel: dbJob.channel,
            recipient: this.extractRecipient(dbJob.prompt),
            enabled: true,
          });
        }
      } else {
        this.stopJob(name);
      }
    }

    return success;
  }

  /**
   * Run a job immediately (for testing)
   */
  async runJobNow(name: string): Promise<JobResult | null> {
    const job = this.jobs.get(name);
    if (!job) {
      console.error(`[Scheduler] Job not found: ${name}`);
      return null;
    }

    await this.executeJob(job);
    return this.jobHistory[0] || null;
  }

  /**
   * Get all jobs
   */
  getJobs(): ScheduledJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Get all jobs including disabled ones
   */
  getAllJobs(): CronJob[] {
    return this.memory?.getCronJobs(false) || [];
  }

  /**
   * Get job history
   */
  getHistory(limit: number = 20): JobResult[] {
    return this.jobHistory.slice(0, limit);
  }

  /**
   * Check if a job is running
   */
  isRunning(name: string): boolean {
    return this.tasks.has(name);
  }

  /**
   * Get scheduler stats
   */
  getStats(): { activeJobs: number; totalExecutions: number; lastExecution?: Date } {
    return {
      activeJobs: this.tasks.size,
      totalExecutions: this.jobHistory.length,
      lastExecution: this.jobHistory[0]?.timestamp,
    };
  }
}

// Singleton instance
let schedulerInstance: CronScheduler | null = null;

export function getScheduler(): CronScheduler | null {
  return schedulerInstance;
}

export function createScheduler(): CronScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new CronScheduler();
  }
  return schedulerInstance;
}
