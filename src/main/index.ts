import { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain, Notification, globalShortcut, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { AgentManager } from '../agent';
import { MemoryManager } from '../memory';
import { createScheduler, CronScheduler } from '../scheduler';
import { createTelegramBot, getTelegramBot, TelegramBot } from '../channels/telegram';
import { SettingsManager } from '../settings';
import { loadIdentity, saveIdentity, getIdentityPath } from '../config/identity';
import { loadInstructions, saveInstructions, getInstructionsPath } from '../config/instructions';
import { closeTaskDb } from '../tools';
import { initializeUpdater, setupUpdaterIPC, setSettingsWindow } from './updater';
import cityTimezones from 'city-timezones';

// Fix PATH for packaged apps - node/npm binaries aren't in PATH when launched from Finder
if (app.isPackaged) {
  const fixedPath = [
    '/opt/homebrew/bin',        // Apple Silicon Homebrew
    '/usr/local/bin',           // Intel Homebrew / standard location
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    process.env.HOME + '/.nvm/versions/node/*/bin', // nvm
    process.env.HOME + '/.local/bin',
  ].join(':');
  process.env.PATH = fixedPath + ':' + (process.env.PATH || '');
  console.log('[Main] Fixed PATH for packaged app');
}

// Month name mapping for birthday parsing
const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

/**
 * Parse a birthday string into month and day
 * Supports formats like: "March 15", "15 March", "3/15", "03-15", "March 15th"
 */
function parseBirthday(birthday: string): { month: number; day: number } | null {
  if (!birthday || !birthday.trim()) return null;

  const cleaned = birthday.trim().toLowerCase();

  // Try "Month Day" or "Month Dayth/st/nd/rd" format (e.g., "March 15" or "March 15th")
  const monthDayMatch = cleaned.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/);
  if (monthDayMatch) {
    const month = MONTHS[monthDayMatch[1]];
    const day = parseInt(monthDayMatch[2], 10);
    if (month && day >= 1 && day <= 31) {
      return { month, day };
    }
  }

  // Try "Day Month" format (e.g., "15 March" or "15th March")
  const dayMonthMatch = cleaned.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)$/);
  if (dayMonthMatch) {
    const day = parseInt(dayMonthMatch[1], 10);
    const month = MONTHS[dayMonthMatch[2]];
    if (month && day >= 1 && day <= 31) {
      return { month, day };
    }
  }

  // Try numeric formats: "3/15", "03/15", "3-15", "03-15"
  const numericMatch = cleaned.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (numericMatch) {
    const first = parseInt(numericMatch[1], 10);
    const second = parseInt(numericMatch[2], 10);
    // Assume MM/DD format (US style)
    if (first >= 1 && first <= 12 && second >= 1 && second <= 31) {
      return { month: first, day: second };
    }
  }

  return null;
}

/**
 * Set up birthday cron jobs when birthday is configured
 */
async function setupBirthdayCronJobs(birthday: string): Promise<void> {
  if (!scheduler) return;

  const jobNameMidnight = 'birthday_midnight';
  const jobNameNoon = 'birthday_noon';

  // Always delete existing birthday jobs first (including legacy names with underscore prefix)
  scheduler.deleteJob(jobNameMidnight);
  scheduler.deleteJob(jobNameNoon);
  scheduler.deleteJob('_birthday_midnight');
  scheduler.deleteJob('_birthday_noon');

  const parsed = parseBirthday(birthday);
  if (!parsed) {
    console.log('[Birthday] No valid birthday to schedule');
    return;
  }

  const { month, day } = parsed;
  const userName = SettingsManager.get('profile.name') || 'the user';

  // Cron format: minute hour day month day-of-week
  // Midnight: 0 0 DAY MONTH *
  // Noon: 0 12 DAY MONTH *
  const cronMidnight = `0 0 ${day} ${month} *`;
  const cronNoon = `0 12 ${day} ${month} *`;

  const promptMidnight = `It's ${userName}'s birthday! The clock just struck midnight. Send them a warm, heartfelt birthday message to start their special day. Be genuine and celebratory - this is the first birthday wish of their day!`;

  const promptNoon = `It's ${userName}'s birthday and it's now midday! Send them another wonderful birthday message. Make this one even more special and celebratory than the morning one - wish them an amazing rest of their birthday, mention hoping their day has been great so far, and express how much you appreciate them.`;

  // Create the jobs (channel 'telegram' to send via Telegram if configured)
  const channel = SettingsManager.get('telegram.defaultChatId') ? 'telegram' : 'desktop';

  await scheduler.createJob(jobNameMidnight, cronMidnight, promptMidnight, channel);
  await scheduler.createJob(jobNameNoon, cronNoon, promptNoon, channel);

  console.log(`[Birthday] Scheduled birthday reminders for ${month}/${day} (${userName})`);
}

let tray: Tray | null = null;
let memory: MemoryManager | null = null;
let scheduler: CronScheduler | null = null;
let telegramBot: TelegramBot | null = null;
let chatWindow: BrowserWindow | null = null;
let cronWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let factsGraphWindow: BrowserWindow | null = null;
let customizeWindow: BrowserWindow | null = null;
let factsWindow: BrowserWindow | null = null;
let soulWindow: BrowserWindow | null = null;
let skillsSetupWindow: BrowserWindow | null = null;

/**
 * Get the agent's isolated workspace directory.
 * This is separate from the app's project root to prevent conflicts.
 * Located in ~/Documents/Pocket-agent/
 */
function getAgentWorkspace(): string {
  const documentsPath = app.getPath('documents');
  return path.join(documentsPath, 'Pocket-agent');
}

/**
 * Ensure the agent workspace directory exists.
 * Creates it if missing (on first run, after onboarding, or if deleted).
 * Sets up CLAUDE.md and .claude/skills for the SDK to load.
 */
function ensureAgentWorkspace(): string {
  const workspace = getAgentWorkspace();

  if (!fs.existsSync(workspace)) {
    console.log('[Main] Creating agent workspace:', workspace);
    fs.mkdirSync(workspace, { recursive: true });
  }

  // Ensure .claude folder is symlinked from source (for skills and commands)
  const workspaceClaudeDir = path.join(workspace, '.claude');
  const sourceClaudeDir = path.join(__dirname, '../../.claude');

  if (fs.existsSync(sourceClaudeDir)) {
    try {
      if (!fs.existsSync(workspaceClaudeDir)) {
        // Create symlink to source .claude folder
        fs.symlinkSync(sourceClaudeDir, workspaceClaudeDir, 'dir');
        console.log('[Main] Symlinked .claude folder to workspace');
      } else {
        // Check if it's already a symlink
        const stats = fs.lstatSync(workspaceClaudeDir);
        if (!stats.isSymbolicLink()) {
          // Workspace has its own .claude folder - symlink skills subfolder instead
          const workspaceSkillsDir = path.join(workspaceClaudeDir, 'skills');
          const sourceSkillsDir = path.join(sourceClaudeDir, 'skills');
          if (!fs.existsSync(workspaceSkillsDir) && fs.existsSync(sourceSkillsDir)) {
            fs.symlinkSync(sourceSkillsDir, workspaceSkillsDir, 'dir');
            console.log('[Main] Symlinked skills folder to workspace');
          }
        }
      }
    } catch (err) {
      console.warn('[Main] Failed to setup .claude symlink:', err);
    }
  }

  // Ensure CLAUDE.md exists and is up to date
  const claudeMdPath = path.join(workspace, 'CLAUDE.md');
  const heartbeatInstruction = '**Silent Acknowledgment:** When a scheduled task has nothing to report, respond with only `HEARTBEAT_OK`. This tells the system not to notify the user.';

  if (fs.existsSync(claudeMdPath)) {
    // Update existing file if missing HEARTBEAT_OK instruction
    const existingContent = fs.readFileSync(claudeMdPath, 'utf-8');
    if (!existingContent.includes('HEARTBEAT_OK')) {
      console.log('[Main] Updating workspace CLAUDE.md with HEARTBEAT_OK instruction');
      // Insert after the Scheduler tools list
      const schedulerMarker = '- `delete_scheduled_task(name)`';
      if (existingContent.includes(schedulerMarker)) {
        const updatedContent = existingContent.replace(
          schedulerMarker,
          `${schedulerMarker}\n\n${heartbeatInstruction}`
        );
        fs.writeFileSync(claudeMdPath, updatedContent, 'utf-8');
      }
    }
  } else {
    console.log('[Main] Creating workspace CLAUDE.md');
    const claudeMdContent = `# Pocket Agent Workspace

This is your personal workspace directory. All file operations happen here by default.

## Workspace Guidelines
- Create subdirectories for different projects
- This workspace persists across sessions
- Use absolute paths to work outside this directory

## Core Behavior

**PROACTIVE MEMORY IS CRITICAL:**
- Save facts IMMEDIATELY when user shares info - don't ask, just remember
- Search memory before answering questions about the user
- Reference stored knowledge naturally: "As you mentioned before..."
- Update facts when information changes (forget + remember)

## Available Tools

All tools are pre-approved. Use them directly.

### Memory
- \`remember(category, subject, content)\` - Save facts
- \`forget(category, subject)\` - Remove facts
- \`list_facts(category?)\` - Show facts
- \`memory_search(query)\` - Search facts

**Categories:** user_info, preferences, projects, people, work, notes, decisions

### Calendar
- \`calendar_add(title, start_time, reminder_minutes?, location?)\`
- \`calendar_list(date?)\` - "today", "tomorrow", or date
- \`calendar_upcoming(hours?)\` - Next N hours
- \`calendar_delete(id)\`

### Tasks
- \`task_add(title, due?, priority?, reminder_minutes?)\`
- \`task_list(status?)\` - pending/completed/all
- \`task_complete(id)\`
- \`task_delete(id)\`
- \`task_due(hours?)\` - Overdue/upcoming

### Scheduler (Recurring)
- \`schedule_task(name, cron, prompt, channel?)\`
- \`list_scheduled_tasks()\`
- \`delete_scheduled_task(name)\`

${heartbeatInstruction}

### Browser
- \`browser(action, ...)\` - navigate, screenshot, click, type, scroll, hover, download, upload, tabs
- Use \`requires_auth: true\` for logged-in sessions

### System
- \`notify(title, body?, urgency?)\` - Desktop notification
- \`pty_exec(command)\` - Interactive terminal

## Time Formats
- Natural: "today 3pm", "tomorrow 9am", "monday 2pm"
- Relative: "in 2 hours", "in 30 minutes"

## Behavior
1. **Memory First** - Check/save relevant facts
2. **Offer Help** - Suggest tasks/events for mentioned plans
3. **Be Concise** - Verbose on desktop, brief on Telegram
4. **Stay Proactive** - Remind about overdue tasks
`;
    fs.writeFileSync(claudeMdPath, claudeMdContent, 'utf-8');
  }

  return workspace;
}

// ============ Tray Setup ============

async function createTray(): Promise<void> {
  const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
  let icon: Electron.NativeImage;

  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      icon = createDefaultIcon();
    } else {
      icon.setTemplateImage(true); // For macOS menu bar
    }
  } catch {
    icon = createDefaultIcon();
  }

  tray = new Tray(icon);
  tray.setToolTip('Pocket Agent');

  // Double-click opens chat
  tray.on('double-click', () => {
    openChatWindow();
  });

  updateTrayMenu();
}

function createDefaultIcon(): Electron.NativeImage {
  // Create a 16x16 robot face icon for macOS menu bar
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);

  // Helper to set a pixel white
  const setPixel = (x: number, y: number) => {
    if (x >= 0 && x < size && y >= 0 && y < size) {
      const i = (y * size + x) * 4;
      canvas[i] = 255;     // R
      canvas[i + 1] = 255; // G
      canvas[i + 2] = 255; // B
      canvas[i + 3] = 255; // A
    }
  };

  // Helper to draw a filled rectangle
  const fillRect = (x1: number, y1: number, x2: number, y2: number) => {
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        setPixel(x, y);
      }
    }
  };

  // Draw robot face (centered in 16x16)
  // Head outline - rounded rectangle (rows 2-13, cols 3-12)
  // Top edge
  fillRect(4, 2, 11, 2);
  // Bottom edge
  fillRect(4, 13, 11, 13);
  // Left edge
  fillRect(3, 3, 3, 12);
  // Right edge
  fillRect(12, 3, 12, 12);
  // Corners
  setPixel(4, 3); setPixel(11, 3);
  setPixel(4, 12); setPixel(11, 12);

  // Antenna
  setPixel(7, 0); setPixel(8, 0);
  setPixel(7, 1); setPixel(8, 1);

  // Eyes (2x2 squares)
  fillRect(5, 5, 6, 7);   // Left eye
  fillRect(9, 5, 10, 7);  // Right eye

  // Mouth (horizontal line)
  fillRect(5, 10, 10, 11);

  const icon = nativeImage.createFromBuffer(canvas, { width: size, height: size });
  icon.setTemplateImage(true); // For macOS menu bar
  return icon;
}

function updateTrayMenu(): void {
  if (!tray) return;

  const stats = AgentManager.getStats();
  const telegramEnabled = SettingsManager.getBoolean('telegram.enabled');

  const statusText = AgentManager.isInitialized()
    ? `Messages: ${stats?.messageCount || 0} | Facts: ${stats?.factCount || 0}`
    : 'Not initialized';

  const telegramStatus = telegramEnabled
    ? (getTelegramBot()?.isRunning ? '✓ Connected' : '✗ Disconnected')
    : 'Disabled';

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Pocket Agent',
      enabled: false,
      icon: createDefaultIcon(),
    },
    { type: 'separator' },
    {
      label: 'Chat',
      click: () => openChatWindow(),
      accelerator: 'Alt+Z',
    },
    { type: 'separator' },
    {
      label: statusText,
      enabled: false,
    },
    {
      label: `Telegram: ${telegramStatus}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Tweaks...',
      click: () => openSettingsWindow(),
      accelerator: 'CmdOrCtrl+,',
    },
    {
      label: 'Superpowers...',
      click: () => createSkillsSetupWindow(),
    },
    { type: 'separator' },
    {
      label: 'Reboot',
      click: async () => {
        await restartAgent();
        showNotification('Pocket Agent', 'Back online! ✨');
      },
    },
    { type: 'separator' },
    {
      label: 'Bye!',
      click: () => app.quit(),
      accelerator: 'CmdOrCtrl+Q',
    },
  ]);

  tray.setContextMenu(contextMenu);
}

// ============ Windows ============

function openChatWindow(): void {
  console.log('[Main] Opening chat window...');
  if (chatWindow && !chatWindow.isDestroyed()) {
    console.log('[Main] Chat window already exists, focusing');
    chatWindow.focus();
    return;
  }

  // Load saved window bounds
  const savedBoundsJson = SettingsManager.get('window.chatBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 600,
    height: 800,
    title: 'Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  // Apply saved bounds if available
  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
      console.log('[Main] Restored chat window bounds:', savedBounds);
    } catch {
      console.warn('[Main] Failed to parse saved window bounds');
    }
  }

  chatWindow = new BrowserWindow(windowOptions);

  chatWindow.loadFile(path.join(__dirname, '../../ui/chat.html'));

  chatWindow.once('ready-to-show', () => {
    chatWindow?.show();
  });

  // Save window bounds when moved, resized, or closed
  const saveBounds = () => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      const bounds = chatWindow.getBounds();
      SettingsManager.set('window.chatBounds', JSON.stringify(bounds));
    }
  };

  chatWindow.on('moved', saveBounds);
  chatWindow.on('resized', saveBounds);
  chatWindow.on('close', saveBounds);

  chatWindow.on('closed', () => {
    chatWindow = null;
  });
}

function openCronWindow(): void {
  if (cronWindow && !cronWindow.isDestroyed()) {
    cronWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.cronBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 700,
    height: 500,
    title: 'My Routines - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  cronWindow = new BrowserWindow(windowOptions);

  cronWindow.loadFile(path.join(__dirname, '../../ui/cron.html'));

  cronWindow.once('ready-to-show', () => {
    cronWindow?.show();
  });

  const saveBounds = () => {
    if (cronWindow && !cronWindow.isDestroyed()) {
      SettingsManager.set('window.cronBounds', JSON.stringify(cronWindow.getBounds()));
    }
  };
  cronWindow.on('moved', saveBounds);
  cronWindow.on('resized', saveBounds);
  cronWindow.on('close', saveBounds);

  cronWindow.on('closed', () => {
    cronWindow = null;
  });
}

function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.settingsBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 700,
    height: 600,
    title: 'Tweaks - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  settingsWindow = new BrowserWindow(windowOptions);

  // Clear cache to ensure fresh HTML loads during development
  settingsWindow.webContents.session.clearCache().then(() => {
    settingsWindow?.loadFile(path.join(__dirname, '../../ui/settings.html'));
  });

  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show();
  });

  const saveBounds = () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      SettingsManager.set('window.settingsBounds', JSON.stringify(settingsWindow.getBounds()));
    }
  };
  settingsWindow.on('moved', saveBounds);
  settingsWindow.on('resized', saveBounds);
  settingsWindow.on('close', saveBounds);

  settingsWindow.on('closed', () => {
    setSettingsWindow(null);
    settingsWindow = null;
  });

  // Connect updater to settings window for status updates
  setSettingsWindow(settingsWindow);
}

function openSetupWindow(): void {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 520,
    height: 580,
    title: 'Welcome!',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
    resizable: false,
    minimizable: false,
    closable: true,
  });

  setupWindow.loadFile(path.join(__dirname, '../../ui/setup.html'));

  setupWindow.once('ready-to-show', () => {
    setupWindow?.show();
  });

  setupWindow.on('closed', () => {
    setupWindow = null;
    // After setup is closed, check if we can initialize
    if (SettingsManager.hasRequiredKeys() && !AgentManager.isInitialized()) {
      initializeAgent();
    }
  });
}

function openFactsGraphWindow(): void {
  if (factsGraphWindow && !factsGraphWindow.isDestroyed()) {
    factsGraphWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.factsGraphBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 900,
    height: 700,
    title: 'Mind Map - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  factsGraphWindow = new BrowserWindow(windowOptions);

  factsGraphWindow.loadFile(path.join(__dirname, '../../ui/facts-graph.html'));

  factsGraphWindow.once('ready-to-show', () => {
    factsGraphWindow?.show();
  });

  const saveBounds = () => {
    if (factsGraphWindow && !factsGraphWindow.isDestroyed()) {
      SettingsManager.set('window.factsGraphBounds', JSON.stringify(factsGraphWindow.getBounds()));
    }
  };
  factsGraphWindow.on('moved', saveBounds);
  factsGraphWindow.on('resized', saveBounds);
  factsGraphWindow.on('close', saveBounds);

  factsGraphWindow.on('closed', () => {
    factsGraphWindow = null;
  });
}

function openCustomizeWindow(): void {
  if (customizeWindow && !customizeWindow.isDestroyed()) {
    customizeWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.customizeBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 800,
    height: 650,
    title: 'Make It Yours - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  customizeWindow = new BrowserWindow(windowOptions);

  customizeWindow.loadFile(path.join(__dirname, '../../ui/customize.html'));

  customizeWindow.once('ready-to-show', () => {
    customizeWindow?.show();
  });

  const saveBounds = () => {
    if (customizeWindow && !customizeWindow.isDestroyed()) {
      SettingsManager.set('window.customizeBounds', JSON.stringify(customizeWindow.getBounds()));
    }
  };
  customizeWindow.on('moved', saveBounds);
  customizeWindow.on('resized', saveBounds);
  customizeWindow.on('close', saveBounds);

  customizeWindow.on('closed', () => {
    customizeWindow = null;
  });
}

function openFactsWindow(): void {
  if (factsWindow && !factsWindow.isDestroyed()) {
    factsWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.factsBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 700,
    height: 550,
    title: 'My Brain - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  factsWindow = new BrowserWindow(windowOptions);

  factsWindow.loadFile(path.join(__dirname, '../../ui/facts.html'));

  factsWindow.once('ready-to-show', () => {
    factsWindow?.show();
  });

  const saveBounds = () => {
    if (factsWindow && !factsWindow.isDestroyed()) {
      SettingsManager.set('window.factsBounds', JSON.stringify(factsWindow.getBounds()));
    }
  };
  factsWindow.on('moved', saveBounds);
  factsWindow.on('resized', saveBounds);
  factsWindow.on('close', saveBounds);

  factsWindow.on('closed', () => {
    factsWindow = null;
  });
}

function openSoulWindow(): void {
  if (soulWindow && !soulWindow.isDestroyed()) {
    soulWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.soulBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 700,
    height: 550,
    title: 'My Approach - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  soulWindow = new BrowserWindow(windowOptions);

  soulWindow.loadFile(path.join(__dirname, '../../ui/soul.html'));

  soulWindow.once('ready-to-show', () => {
    soulWindow?.show();
  });

  const saveBounds = () => {
    if (soulWindow && !soulWindow.isDestroyed()) {
      SettingsManager.set('window.soulBounds', JSON.stringify(soulWindow.getBounds()));
    }
  };
  soulWindow.on('moved', saveBounds);
  soulWindow.on('resized', saveBounds);
  soulWindow.on('close', saveBounds);

  soulWindow.on('closed', () => {
    soulWindow = null;
  });
}

function createSkillsSetupWindow(): void {
  if (skillsSetupWindow && !skillsSetupWindow.isDestroyed()) {
    skillsSetupWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.skillsSetupBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 900,
    height: 700,
    title: 'Superpowers - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  skillsSetupWindow = new BrowserWindow(windowOptions);

  skillsSetupWindow.loadFile(path.join(__dirname, '../../ui/skills-setup.html'));

  skillsSetupWindow.once('ready-to-show', () => {
    skillsSetupWindow?.show();
  });

  const saveBounds = () => {
    if (skillsSetupWindow && !skillsSetupWindow.isDestroyed()) {
      SettingsManager.set('window.skillsSetupBounds', JSON.stringify(skillsSetupWindow.getBounds()));
    }
  };
  skillsSetupWindow.on('moved', saveBounds);
  skillsSetupWindow.on('resized', saveBounds);
  skillsSetupWindow.on('close', saveBounds);

  skillsSetupWindow.on('closed', () => {
    skillsSetupWindow = null;
  });
}

function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

// ============ IPC Handlers ============

function setupIPC(): void {
  // Chat messages with status streaming
  ipcMain.handle('agent:send', async (event, message: string, sessionId?: string) => {
    console.log(`[IPC] agent:send received sessionId: ${sessionId}`);
    // Set up status listener to forward to renderer
    const statusHandler = (status: { type: string; toolName?: string; toolInput?: string; message?: string }) => {
      // Send status update to the chat window that initiated the request
      const webContents = event.sender;
      if (!webContents.isDestroyed()) {
        webContents.send('agent:status', status);
      }
    };

    AgentManager.on('status', statusHandler);

    try {
      const result = await AgentManager.processMessage(message, 'desktop', sessionId || 'default');
      updateTrayMenu();

      // Sync to Telegram (Desktop -> Telegram) - only to the linked chat for this session
      const effectiveSessionId = sessionId || 'default';
      const linkedChatId = memory?.getChatForSession(effectiveSessionId);
      console.log('[Main] Checking telegram sync - bot exists:', !!telegramBot, 'session:', effectiveSessionId, 'linked chat:', linkedChatId);
      if (telegramBot && linkedChatId) {
        console.log('[Main] Syncing desktop message to Telegram chat:', linkedChatId);
        telegramBot.syncToChat(message, result.response, linkedChatId).catch((err) => {
          console.error('[Main] Failed to sync desktop message to Telegram:', err);
        });
      }

      return {
        success: true,
        response: result.response,
        tokensUsed: result.tokensUsed,
        suggestedPrompt: result.suggestedPrompt,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMsg };
    } finally {
      AgentManager.off('status', statusHandler);
    }
  });

  ipcMain.handle('agent:history', async (_, limit: number = 50, sessionId?: string) => {
    return AgentManager.getRecentMessages(limit, sessionId || 'default');
  });

  ipcMain.handle('agent:stats', async (_, sessionId?: string) => {
    return AgentManager.getStats(sessionId);
  });

  ipcMain.handle('agent:clear', async (_, sessionId?: string) => {
    AgentManager.clearConversation(sessionId);
    updateTrayMenu();
    return { success: true };
  });

  // Sessions
  ipcMain.handle('sessions:list', async () => {
    return memory?.getSessions() || [];
  });

  ipcMain.handle('sessions:create', async (_, name: string) => {
    try {
      return { success: true, session: memory?.createSession(name) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('sessions:rename', async (_, id: string, name: string) => {
    try {
      const success = memory?.renameSession(id, name) ?? false;
      return { success };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('sessions:delete', async (_, id: string) => {
    const success = memory?.deleteSession(id) ?? false;
    return { success };
  });

  ipcMain.handle('agent:stop', async (_, sessionId?: string) => {
    const stopped = AgentManager.stopQuery(sessionId);
    return { success: stopped };
  });

  // Facts
  ipcMain.handle('facts:list', async () => {
    return AgentManager.getAllFacts();
  });

  ipcMain.handle('facts:search', async (_, query: string) => {
    return AgentManager.searchFacts(query);
  });

  ipcMain.handle('facts:categories', async () => {
    return memory?.getFactCategories() || [];
  });

  ipcMain.handle('facts:delete', async (_, id: number) => {
    if (!memory) return { success: false };
    const success = memory.deleteFact(id);
    return { success };
  });

  ipcMain.handle('facts:graph-data', async () => {
    if (!memory) return { nodes: [], links: [] };
    return memory.getFactsGraphData();
  });

  // Soul (Self-Knowledge)
  ipcMain.handle('soul:list', async () => {
    if (!memory) return [];
    return memory.getAllSoulAspects();
  });

  ipcMain.handle('soul:get', async (_, aspect: string) => {
    if (!memory) return null;
    return memory.getSoulAspect(aspect);
  });

  ipcMain.handle('soul:delete', async (_, id: number) => {
    if (!memory) return { success: false };
    const success = memory.deleteSoulAspectById(id);
    return { success };
  });

  ipcMain.handle('app:openFactsGraph', async () => {
    openFactsGraphWindow();
  });

  ipcMain.handle('app:openFacts', async () => {
    openFactsWindow();
  });

  ipcMain.handle('app:openSoul', async () => {
    openSoulWindow();
  });

  ipcMain.handle('app:openCustomize', async () => {
    openCustomizeWindow();
  });

  ipcMain.handle('app:openRoutines', async () => {
    openCronWindow();
  });

  ipcMain.handle('app:openExternal', async (_, url: string) => {
    await shell.openExternal(url);
  });

  // Customize - Identity
  ipcMain.handle('customize:getIdentity', async () => {
    return loadIdentity();
  });

  ipcMain.handle('customize:saveIdentity', async (_, content: string) => {
    const success = saveIdentity(content);
    return { success };
  });

  ipcMain.handle('customize:getIdentityPath', async () => {
    return getIdentityPath();
  });

  // Customize - Instructions
  ipcMain.handle('customize:getInstructions', async () => {
    return loadInstructions();
  });

  ipcMain.handle('customize:saveInstructions', async (_, content: string) => {
    const success = saveInstructions(content);
    return { success };
  });

  ipcMain.handle('customize:getInstructionsPath', async () => {
    return getInstructionsPath();
  });

  // Location and timezone lookup
  ipcMain.handle('location:lookup', async (_, query: string) => {
    if (!query || query.length < 2) return [];

    const results = cityTimezones.lookupViaCity(query);
    // Return top 10 results with city, country, and timezone
    return results.slice(0, 10).map((r: { city: string; country: string; timezone: string; province?: string }) => ({
      city: r.city,
      country: r.country,
      province: r.province || '',
      timezone: r.timezone,
      display: r.province ? `${r.city}, ${r.province}, ${r.country}` : `${r.city}, ${r.country}`,
    }));
  });

  ipcMain.handle('timezone:list', async () => {
    // Get all IANA timezones
    try {
      const timezones = Intl.supportedValuesOf('timeZone');
      return timezones;
    } catch {
      // Fallback for older environments
      return [
        'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
        'America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'America/Sao_Paulo',
        'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Rome', 'Europe/Madrid',
        'Europe/Amsterdam', 'Europe/Stockholm', 'Europe/Moscow',
        'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Seoul',
        'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Jerusalem',
        'Australia/Sydney', 'Australia/Melbourne', 'Australia/Perth',
        'Pacific/Auckland', 'Pacific/Honolulu', 'Pacific/Fiji',
        'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos',
      ];
    }
  });

  // Cron jobs
  ipcMain.handle('cron:list', async () => {
    return scheduler?.getAllJobs() || [];
  });

  ipcMain.handle('cron:create', async (_, name: string, schedule: string, prompt: string, channel: string, sessionId: string) => {
    const success = await scheduler?.createJob(name, schedule, prompt, channel, sessionId || 'default');
    updateTrayMenu();
    return { success };
  });

  ipcMain.handle('cron:delete', async (_, name: string) => {
    const success = scheduler?.deleteJob(name);
    updateTrayMenu();
    return { success };
  });

  ipcMain.handle('cron:toggle', async (_, name: string, enabled: boolean) => {
    const success = scheduler?.setJobEnabled(name, enabled);
    updateTrayMenu();
    return { success };
  });

  ipcMain.handle('cron:run', async (_, name: string) => {
    const result = await scheduler?.runJobNow(name);
    return result;
  });

  ipcMain.handle('cron:history', async (_, limit: number = 20) => {
    return scheduler?.getHistory(limit) || [];
  });

  // App info
  ipcMain.handle('app:getVersion', () => {
    return app.getVersion();
  });

  // Settings
  ipcMain.handle('settings:getAll', async () => {
    return SettingsManager.getAll();
  });

  ipcMain.handle('settings:get', async (_, key: string) => {
    return SettingsManager.get(key);
  });

  ipcMain.handle('settings:set', async (_, key: string, value: string) => {
    try {
      SettingsManager.set(key, value);

      // Auto-setup birthday cron jobs when birthday is set
      if (key === 'profile.birthday') {
        await setupBirthdayCronJobs(value);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('settings:delete', async (_, key: string) => {
    const success = SettingsManager.delete(key);
    return { success };
  });

  ipcMain.handle('settings:schema', async (_, category?: string) => {
    return SettingsManager.getSchema(category);
  });

  ipcMain.handle('settings:isFirstRun', async () => {
    return SettingsManager.isFirstRun();
  });

  ipcMain.handle('settings:initializeKeychain', async () => {
    return SettingsManager.initializeKeychain();
  });

  ipcMain.handle('settings:validateAnthropic', async (_, key: string) => {
    return SettingsManager.validateAnthropicKey(key);
  });

  ipcMain.handle('settings:validateOpenAI', async (_, key: string) => {
    return SettingsManager.validateOpenAIKey(key);
  });

  ipcMain.handle('settings:validateTelegram', async (_, token: string) => {
    return SettingsManager.validateTelegramToken(token);
  });

  ipcMain.handle('settings:validateMoonshot', async (_, key: string) => {
    return SettingsManager.validateMoonshotKey(key);
  });

  // Get available models based on configured API keys
  ipcMain.handle('settings:getAvailableModels', async () => {
    const models: Array<{ id: string; name: string; provider: string }> = [];

    // Check for Anthropic keys (OAuth or API key)
    const authMethod = SettingsManager.get('auth.method');
    const hasOAuth = authMethod === 'oauth' && SettingsManager.get('auth.oauthToken');
    const hasAnthropicKey = SettingsManager.get('anthropic.apiKey');

    if (hasOAuth || hasAnthropicKey) {
      models.push(
        { id: 'claude-opus-4-5-20251101', name: 'Opus 4.5', provider: 'anthropic' },
        { id: 'claude-sonnet-4-5-20250929', name: 'Sonnet 4.5', provider: 'anthropic' },
        { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', provider: 'anthropic' }
      );
    }

    // Check for Moonshot/Kimi key
    const hasMoonshotKey = SettingsManager.get('moonshot.apiKey');
    if (hasMoonshotKey) {
      models.push(
        { id: 'kimi-k2.5', name: 'Kimi K2.5', provider: 'moonshot' }
      );
    }

    return models;
  });

  ipcMain.handle('agent:restart', async () => {
    try {
      await restartAgent();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('app:openSettings', async () => {
    openSettingsWindow();
  });

  ipcMain.handle('app:openChat', async () => {
    openChatWindow();
  });

  // OAuth flow for Claude subscription
  ipcMain.handle('auth:startOAuth', async () => {
    const { ClaudeOAuth } = await import('../auth/oauth');
    return ClaudeOAuth.startFlow();
  });

  ipcMain.handle('auth:completeOAuth', async (_, code: string) => {
    const { ClaudeOAuth } = await import('../auth/oauth');
    return ClaudeOAuth.completeWithCode(code);
  });

  ipcMain.handle('auth:cancelOAuth', async () => {
    const { ClaudeOAuth } = await import('../auth/oauth');
    ClaudeOAuth.cancelFlow();
    return { success: true };
  });

  ipcMain.handle('auth:isOAuthPending', async () => {
    const { ClaudeOAuth } = await import('../auth/oauth');
    return ClaudeOAuth.isPending();
  });

  // File attachments
  ipcMain.handle('attachment:save', async (_, name: string, dataUrl: string) => {
    try {
      // Create attachments directory
      const attachmentsDir = path.join(app.getPath('userData'), 'attachments');
      if (!fs.existsSync(attachmentsDir)) {
        fs.mkdirSync(attachmentsDir, { recursive: true });
      }

      // Generate unique filename
      const timestamp = Date.now();
      const safeName = name.replace(/[^a-zA-Z0-9.-]/g, '_');
      const filePath = path.join(attachmentsDir, `${timestamp}-${safeName}`);

      // Extract base64 data and save
      const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        throw new Error('Invalid data URL format');
      }

      const buffer = Buffer.from(matches[2], 'base64');
      fs.writeFileSync(filePath, buffer);

      console.log(`[Attachment] Saved: ${filePath}`);
      return filePath;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Attachment] Save failed:', errorMsg);
      throw error;
    }
  });

  // Skills
  ipcMain.handle('skills:getStatus', async () => {
    const {
      loadSkillsManifest,
      getAllSkillStatuses,
      getSkillsSummary,
      checkPrerequisites,
    } = await import('../skills');

    const projectRoot = app.isPackaged
      ? path.join(process.resourcesPath, 'app')
      : path.join(__dirname, '../..');
    const skillsDir = path.join(projectRoot, '.claude');

    const manifest = loadSkillsManifest(skillsDir);
    if (!manifest) {
      return {
        skills: [],
        summary: { total: 0, available: 0, unavailable: 0, incompatible: 0 },
        prerequisites: checkPrerequisites(),
      };
    }

    const skills = getAllSkillStatuses(manifest);
    const summary = getSkillsSummary(manifest);
    const prerequisites = checkPrerequisites();

    return { skills, summary, prerequisites };
  });

  ipcMain.handle('skills:install', async (_, skillName: string) => {
    const {
      loadSkillsManifest,
      getSkillStatus,
      installSkillDependencies,
    } = await import('../skills');

    const projectRoot = app.isPackaged
      ? path.join(process.resourcesPath, 'app')
      : path.join(__dirname, '../..');
    const skillsDir = path.join(projectRoot, '.claude');

    const manifest = loadSkillsManifest(skillsDir);
    if (!manifest || !manifest.skills[skillName]) {
      return { success: false, installed: [], failed: ['Skill not found'] };
    }

    const status = getSkillStatus(skillName, manifest.skills[skillName]);
    const result = await installSkillDependencies(status, (msg) => {
      console.log(`[Skills] ${skillName}: ${msg}`);
    });

    return result;
  });

  ipcMain.handle('skills:uninstall', async (_, skillName: string) => {
    const {
      loadSkillsManifest,
      getSkillStatus,
      uninstallSkillDependencies,
    } = await import('../skills');

    const projectRoot = app.isPackaged
      ? path.join(process.resourcesPath, 'app')
      : path.join(__dirname, '../..');
    const skillsDir = path.join(projectRoot, '.claude');

    const manifest = loadSkillsManifest(skillsDir);
    if (!manifest || !manifest.skills[skillName]) {
      return { success: false, removed: [], failed: ['Skill not found'] };
    }

    const status = getSkillStatus(skillName, manifest.skills[skillName]);
    const result = await uninstallSkillDependencies(status, (msg) => {
      console.log(`[Skills] ${skillName}: ${msg}`);
    });

    return result;
  });

  ipcMain.handle('skills:openPermissionSettings', async (_, permissionType: string) => {
    const { openPermissionSettings } = await import('../permissions/macos');
    await openPermissionSettings(permissionType as Parameters<typeof openPermissionSettings>[0]);
  });

  ipcMain.handle('skills:checkPermission', async (_, permissionType: string) => {
    const { getPermissionStatus } = await import('../permissions/macos');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return getPermissionStatus(permissionType as any);
  });

  ipcMain.handle('app:openSkillsSetup', async () => {
    createSkillsSetupWindow();
  });

  // Skill setup handlers
  ipcMain.handle('skills:getSetupConfig', async (_, skillName: string) => {
    const { loadSkillsManifest } = await import('../skills');

    const projectRoot = app.isPackaged
      ? path.join(process.resourcesPath, 'app')
      : path.join(__dirname, '../..');
    const skillsDir = path.join(projectRoot, '.claude');

    const manifest = loadSkillsManifest(skillsDir);
    if (!manifest || !manifest.skills[skillName]) {
      return { found: false };
    }

    const skill = manifest.skills[skillName];
    return {
      found: true,
      setup: skill.setup || undefined,
    };
  });

  // Secure setup command execution - validates against manifest and sanitizes inputs
  ipcMain.handle(
    'skills:runSetupCommand',
    async (
      _,
      params: { skillName: string; stepId: string; inputs?: Record<string, string> }
    ) => {
      const { loadSkillsManifest } = await import('../skills');

      // Load manifest and validate skill exists
      const projectRoot = app.isPackaged
        ? path.join(process.resourcesPath, 'app')
        : path.join(__dirname, '../..');
      const skillsDir = path.join(projectRoot, '.claude');
      const manifest = loadSkillsManifest(skillsDir);

      if (!manifest || !manifest.skills[params.skillName]) {
        return { success: false, error: 'Skill not found', output: '' };
      }

      const skill = manifest.skills[params.skillName];
      if (!skill.setup || !skill.setup.steps) {
        return { success: false, error: 'Skill has no setup steps', output: '' };
      }

      // Find the step
      const step = skill.setup.steps.find(
        (s: { id: string }) => s.id === params.stepId
      );
      if (!step || !step.command) {
        return { success: false, error: 'Step not found or has no command', output: '' };
      }

      // Build command with sanitized input substitutions
      let commandTemplate = step.command as string;
      const inputs = params.inputs || {};

      // Validate inputs don't contain shell metacharacters
      const shellMetaChars = /[;&|`$(){}[\]<>\\!#*?"'\n\r]/;
      for (const [key, value] of Object.entries(inputs)) {
        if (shellMetaChars.test(value)) {
          return {
            success: false,
            error: `Invalid characters in input "${key}"`,
            output: '',
          };
        }
        // Only substitute if the placeholder exists in template
        if (commandTemplate.includes(`{{${key}}}`)) {
          commandTemplate = commandTemplate.replace(
            new RegExp(`\\{\\{${key}\\}\\}`, 'g'),
            value
          );
        }
      }

      // Check for any remaining unsubstituted placeholders
      if (/\{\{[^}]+\}\}/.test(commandTemplate)) {
        return {
          success: false,
          error: 'Missing required inputs',
          output: '',
        };
      }

      // Parse command into binary and args (simple shell-like parsing)
      const parts = commandTemplate.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
      if (parts.length === 0) {
        return { success: false, error: 'Empty command', output: '' };
      }

      const binary = parts[0] as string;
      const args = parts.slice(1).map((arg) => {
        // Remove surrounding quotes if present
        if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
          return arg.slice(1, -1);
        }
        return arg;
      });

      // Add common paths for homebrew, go, npm binaries
      const home = process.env.HOME || '';
      const extraPaths = [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        `${home}/go/bin`,
        `${home}/.npm-global/bin`,
        `${home}/.local/bin`,
      ].join(':');

      return new Promise<{ success: boolean; output: string; error?: string }>((resolve) => {
        let stdout = '';
        let stderr = '';

        const child: ChildProcess = spawn(binary, args, {
          env: {
            ...process.env,
            PATH: `${extraPaths}:${process.env.PATH}`,
          },
          timeout: 60000,
          shell: false, // Explicitly disable shell to prevent injection
        });

        child.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        child.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        child.on('error', (error: Error) => {
          resolve({
            success: false,
            error: error.message,
            output: [stdout, stderr].filter(Boolean).join('\n'),
          });
        });

        child.on('close', (code: number | null) => {
          const output = [stdout, stderr].filter(Boolean).join('\n');
          resolve({
            success: code === 0,
            output,
            ...(code !== 0 && { error: `Command exited with code ${code}` }),
          });
        });
      });
    }
  );
}

// ============ Agent Lifecycle ============

async function initializeAgent(): Promise<void> {
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'pocket-agent.db');

  // Check if we have required API keys
  if (!SettingsManager.hasRequiredKeys()) {
    console.log('[Main] No API keys configured, skipping agent initialization');
    return;
  }

  // Project root (where CLAUDE.md and CLI tools live)
  const projectRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app')
    : path.join(__dirname, '../..');

  // Agent workspace (isolated working directory for file operations)
  const workspace = ensureAgentWorkspace();

  // Initialize memory (if not already done)
  if (!memory) {
    memory = new MemoryManager(dbPath);
  }

  // Initialize embeddings if OpenAI key is available
  const openaiKey = SettingsManager.get('openai.apiKey');
  if (openaiKey) {
    memory.initializeEmbeddings(openaiKey);
    console.log('[Main] Embeddings enabled with OpenAI');
  } else {
    console.log('[Main] Embeddings disabled (no OpenAI API key)');
  }

  // Build tools config from settings
  const toolsConfig = {
    mcpServers: {},
    computerUse: {
      enabled: false,
      dockerized: true,
      displaySize: { width: 1920, height: 1080 },
    },
    browser: {
      enabled: SettingsManager.getBoolean('browser.enabled'),
      cdpUrl: SettingsManager.get('browser.cdpUrl') || 'http://localhost:9222',
    },
  };

  // Initialize agent with tools config
  AgentManager.initialize({
    memory,
    projectRoot,
    workspace,  // Isolated working directory for agent file operations
    model: SettingsManager.get('agent.model'),
    tools: toolsConfig,
  });

  // Initialize scheduler
  if (SettingsManager.getBoolean('scheduler.enabled')) {
    scheduler = createScheduler();
    await scheduler.initialize(memory, dbPath);

    // Set notification handler for scheduler
    scheduler.setNotificationHandler((title: string, body: string) => {
      showNotification(title, body);
    });

    // Set chat handler for scheduler (sends messages to chat window with session context)
    scheduler.setChatHandler((jobName: string, prompt: string, response: string, sessionId: string) => {
      console.log(`[Scheduler] Sending chat message for job: ${jobName} (session: ${sessionId})`);
      // Send to chat window if open, with session context
      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.webContents.send('scheduler:message', { jobName, prompt, response, sessionId });
      }
      // Also open chat window if not open
      if (!chatWindow || chatWindow.isDestroyed()) {
        openChatWindow();
        // Wait a bit for window to load, then send message
        setTimeout(() => {
          if (chatWindow && !chatWindow.isDestroyed()) {
            chatWindow.webContents.send('scheduler:message', { jobName, prompt, response, sessionId });
          }
        }, 1000);
      }
    });

    // Set up birthday reminders if birthday is configured
    const birthday = SettingsManager.get('profile.birthday');
    if (birthday) {
      await setupBirthdayCronJobs(birthday);
    }
  }

  // Initialize Telegram
  const telegramEnabled = SettingsManager.getBoolean('telegram.enabled');
  const telegramToken = SettingsManager.get('telegram.botToken');

  if (telegramEnabled && telegramToken) {
    try {
      telegramBot = createTelegramBot();

      if (!telegramBot) {
        console.error('[Main] Telegram bot creation failed');
      } else {
        // Set up cross-channel sync: Telegram -> Desktop
        // Only send to chat window if it's already open - don't force open or notify
        telegramBot.setOnMessageCallback((data) => {
          // Only sync to desktop UI if chat window is already open
          if (chatWindow && !chatWindow.isDestroyed()) {
            chatWindow.webContents.send('telegram:message', {
              userMessage: data.userMessage,
              response: data.response,
              chatId: data.chatId,
              sessionId: data.sessionId,
            });
          }
          // Messages are already saved to SQLite, so they'll appear when user opens chat
        });

        await telegramBot.start();

        if (scheduler) {
          scheduler.setTelegramBot(telegramBot);
        }

        console.log('[Main] Telegram started');
      }
    } catch (error) {
      console.error('[Main] Telegram failed:', error);
    }
  }

  console.log('[Main] Pocket Agent initialized');
  updateTrayMenu();
}

async function stopAgent(): Promise<void> {
  if (telegramBot) {
    await telegramBot.stop();
    telegramBot = null;
  }
  if (scheduler) {
    scheduler.stopAll();
    scheduler = null;
  }
  // Cleanup browser resources
  AgentManager.cleanup();
  console.log('[Main] Agent stopped');
  updateTrayMenu();
}

async function restartAgent(): Promise<void> {
  await stopAgent();
  await initializeAgent();
}

// ============ App Lifecycle ============

app.whenReady().then(async () => {
  console.log('[Main] App ready, starting initialization...');

  try {
    // Set Dock icon on macOS
    if (process.platform === 'darwin') {
      const dockIconPath = path.join(__dirname, '../../assets/icon.png');
      if (fs.existsSync(dockIconPath)) {
        app.dock?.setIcon(dockIconPath);
      }
    }

    const userDataPath = app.getPath('userData');
    const dbPath = path.join(userDataPath, 'pocket-agent.db');
    console.log('[Main] DB path:', dbPath);

    // Initialize settings first (uses same DB)
    console.log('[Main] Initializing settings...');
    SettingsManager.initialize(dbPath);

    // Migrate from old config.json if it exists
    const oldConfigPath = path.join(userDataPath, 'config.json');
    await SettingsManager.migrateFromConfig(oldConfigPath);
    console.log('[Main] Settings initialized');

    // Initialize memory (shared with settings)
    console.log('[Main] Initializing memory...');
    memory = new MemoryManager(dbPath);
    console.log('[Main] Memory initialized');

    setupIPC();
    setupUpdaterIPC();
    console.log('[Main] Creating tray...');
    await createTray();
    console.log('[Main] Tray created');

    // Initialize auto-updater (only in packaged app)
    if (app.isPackaged) {
      initializeUpdater();
      console.log('[Main] Auto-updater initialized');
    }

    // Register global shortcut (Option+Z on macOS, Alt+Z on Windows/Linux)
    const shortcut = process.platform === 'darwin' ? 'Alt+Z' : 'Alt+Z';
    const registered = globalShortcut.register(shortcut, () => {
      openChatWindow();
    });
    if (registered) {
      console.log(`[Main] Global shortcut ${shortcut} registered`);
    } else {
      console.warn(`[Main] Failed to register global shortcut ${shortcut}`);
    }

    // Check for first run
    if (SettingsManager.isFirstRun()) {
      console.log('[Main] First run detected, showing setup wizard');
      openSetupWindow();
    } else {
      console.log('[Main] Initializing agent...');
      await initializeAgent();
      // Open chat window on launch so users see the app
      openChatWindow();
    }

    // Periodic tray update
    setInterval(updateTrayMenu, 30000);
  } catch (error) {
    console.error('[Main] FATAL ERROR during initialization:', error);
  }
});

app.on('window-all-closed', () => {
  // Keep running (tray app)
});

app.on('activate', () => {
  // macOS: clicking Dock icon opens chat window
  openChatWindow();
});

app.on('before-quit', async () => {
  if (app.isReady()) {
    globalShortcut.unregisterAll(); // Clean up global shortcuts
  }
  await stopAgent();
  if (memory) {
    memory.close();
  }
  closeTaskDb(); // Clean up task tools database connection
  SettingsManager.close();
});

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    openChatWindow();
  });
}
