/**
 * macOS-specific tools for Pocket Agent
 *
 * Provides:
 * - Native notifications via Electron
 * - PTY-based shell execution for interactive commands
 */

import { Notification } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';

// Type for timeout handle
type TimeoutHandle = ReturnType<typeof setTimeout>;

/**
 * Escape a shell argument for safe use in shell commands
 * Uses single quotes and escapes embedded single quotes
 */
function escapeShellArg(arg: string): string {
  // Wrap in single quotes and escape any embedded single quotes
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ============================================================================
// Native Notifications
// ============================================================================

export interface NotifyInput {
  title: string;
  body?: string;
  subtitle?: string;
  silent?: boolean;
  urgency?: 'normal' | 'critical' | 'low';
  timeout?: number; // ms before auto-dismiss (not supported on all platforms)
}

export interface NotifyResult {
  success: boolean;
  error?: string;
  clicked?: boolean;
}

/**
 * Show a native desktop notification
 *
 * Returns immediately after showing (fire-and-forget).
 * Does NOT wait for user interaction since macOS notifications
 * can sit in notification center indefinitely.
 */
export function showNotification(input: NotifyInput): Promise<NotifyResult> {
  return new Promise(resolve => {
    try {
      if (!Notification.isSupported()) {
        resolve({ success: false, error: 'Notifications not supported on this system' });
        return;
      }

      const notification = new Notification({
        title: input.title,
        body: input.body || '',
        subtitle: input.subtitle,
        silent: input.silent ?? false,
        urgency: input.urgency || 'normal',
      });

      // Listen for errors only (don't block on click/close)
      notification.on('failed', (_event, error) => {
        console.error('[Notify] Notification failed:', error);
      });

      notification.show();

      // Resolve immediately - don't wait for user interaction
      // macOS notifications can stay in notification center forever
      resolve({ success: true });

    } catch (error) {
      resolve({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}

/**
 * Tool definition for native notifications
 */
export function getNotifyToolDefinition() {
  return {
    name: 'notify',
    description: `Send a native desktop notification to the user.

Use this to:
- Alert the user about completed tasks
- Remind about scheduled events
- Notify about errors or important events
- Get user attention when they're away from the app

The notification appears in the system notification center.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Notification title (required)',
        },
        body: {
          type: 'string',
          description: 'Notification body text',
        },
        subtitle: {
          type: 'string',
          description: 'Subtitle (macOS only)',
        },
        silent: {
          type: 'boolean',
          description: 'Suppress notification sound (default: false)',
        },
        urgency: {
          type: 'string',
          enum: ['low', 'normal', 'critical'],
          description: 'Notification urgency level (default: normal)',
        },
      },
      required: ['title'],
    },
  };
}

/**
 * Handle notify tool invocation
 */
export async function handleNotifyTool(input: unknown): Promise<string> {
  const params = input as NotifyInput;

  if (!params.title) {
    return JSON.stringify({ success: false, error: 'title is required' });
  }

  const result = await showNotification(params);
  return JSON.stringify(result);
}

// ============================================================================
// PTY Shell Execution
// ============================================================================

export interface PtyExecInput {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number; // ms
  rows?: number;
  cols?: number;
}

export interface PtyExecResult {
  success: boolean;
  output: string;
  exitCode: number | null;
  error?: string;
  timedOut?: boolean;
}

// Track active PTY sessions for cleanup
const activeSessions: Map<string, ChildProcess> = new Map();

/**
 * Execute a command with PTY support
 *
 * Uses node-pty if available, falls back to regular spawn otherwise.
 * PTY is needed for:
 * - Interactive CLIs (npm prompts, git interactive)
 * - Programs that detect TTY
 * - Colored output
 * - Full terminal emulation
 */
export async function execWithPty(input: PtyExecInput): Promise<PtyExecResult> {
  const { command, args = [], cwd, env, timeout = 60000, rows = 30, cols = 120 } = input;

  // Try to use node-pty for full PTY support
  try {
    const pty = await import('node-pty');

    return new Promise(resolve => {
      let output = '';
      let resolved = false;
      let timeoutId: TimeoutHandle | null = null;

      const shell = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
      // Escape individual args to prevent injection, but NOT the command itself
      // (command is meant to be a shell command string like "npm install")
      const escapedArgs = args.map(escapeShellArg).join(' ');
      const shellArgs =
        os.platform() === 'win32' ? ['-Command', command] : ['-c', `${command}${args.length > 0 ? ' ' + escapedArgs : ''}`];

      const ptyProcess = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: cwd || process.cwd(),
        env: { ...process.env, ...env } as Record<string, string>,
      });

      const sessionId = `pty-${Date.now()}`;
      activeSessions.set(sessionId, ptyProcess as unknown as ChildProcess);

      ptyProcess.onData((data: string) => {
        output += data;
      });

      ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
        if (timeoutId) clearTimeout(timeoutId);
        activeSessions.delete(sessionId);

        if (!resolved) {
          resolved = true;
          resolve({
            success: exitCode === 0,
            output: cleanPtyOutput(output),
            exitCode,
          });
        }
      });

      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            ptyProcess.kill();
            activeSessions.delete(sessionId);
            resolve({
              success: false,
              output: cleanPtyOutput(output),
              exitCode: null,
              timedOut: true,
              error: `Command timed out after ${timeout}ms`,
            });
          }
        }, timeout);
      }
    });
  } catch {
    // node-pty not available, fall back to regular spawn
    console.log('[PTY] node-pty not available, using regular spawn');
    return execWithSpawn(input);
  }
}

/**
 * Fallback execution without PTY
 */
async function execWithSpawn(input: PtyExecInput): Promise<PtyExecResult> {
  const { command, args = [], cwd, env, timeout = 60000 } = input;

  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let resolved = false;
    let timeoutId: TimeoutHandle | null = null;

    const shell = os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash';
    // Escape individual args to prevent injection, but NOT the command itself
    const escapedArgs = args.map(escapeShellArg).join(' ');
    const shellArgs =
      os.platform() === 'win32' ? ['/c', command, ...args] : ['-c', `${command}${args.length > 0 ? ' ' + escapedArgs : ''}`];

    const child = spawn(shell, shellArgs, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const sessionId = `spawn-${Date.now()}`;
    activeSessions.set(sessionId, child);

    child.stdout?.on('data', data => {
      stdout += data.toString();
    });

    child.stderr?.on('data', data => {
      stderr += data.toString();
    });

    child.on('close', code => {
      if (timeoutId) clearTimeout(timeoutId);
      activeSessions.delete(sessionId);

      if (!resolved) {
        resolved = true;
        const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
        resolve({
          success: code === 0,
          output,
          exitCode: code,
        });
      }
    });

    child.on('error', error => {
      if (timeoutId) clearTimeout(timeoutId);
      activeSessions.delete(sessionId);

      if (!resolved) {
        resolved = true;
        resolve({
          success: false,
          output: stdout + stderr,
          exitCode: null,
          error: error.message,
        });
      }
    });

    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 1000);
          activeSessions.delete(sessionId);
          resolve({
            success: false,
            output: stdout + stderr,
            exitCode: null,
            timedOut: true,
            error: `Command timed out after ${timeout}ms`,
          });
        }
      }, timeout);
    }
  });
}

/**
 * Clean up ANSI escape codes and PTY artifacts from output
 */
function cleanPtyOutput(output: string): string {
  return (
    output
      // Remove ANSI escape codes (colors, cursor movement, etc.)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      // Remove bracketed paste mode codes [?2004h and [?2004l
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[\?[0-9]+[hl]/g, '')
      // Remove OSC sequences (title changes, etc.)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07]*\x07/g, '')
      // Remove any remaining escape sequences
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[^m]*m/g, '')
      // Remove carriage returns
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // Remove literal escape code representations that might slip through
      .replace(/\[(\?)?[0-9]+[hlm]/g, '')
      // Trim excessive whitespace
      .trim()
  );
}

/**
 * Tool definition for PTY shell execution
 */
export function getPtyExecToolDefinition() {
  return {
    name: 'pty_exec',
    description: `Execute a shell command with PTY (pseudo-terminal) support.

Use this instead of regular Bash when you need:
- Interactive CLI prompts (npm init, git interactive rebase)
- Commands that require a TTY
- Full terminal emulation with colors
- Commands that behave differently without a terminal

The output includes ANSI colors and terminal formatting.
Falls back to regular execution if PTY is unavailable.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'The command to execute',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Command arguments',
        },
        cwd: {
          type: 'string',
          description: 'Working directory',
        },
        env: {
          type: 'object',
          description: 'Environment variables to set',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 60000)',
        },
        rows: {
          type: 'number',
          description: 'Terminal rows (default: 30)',
        },
        cols: {
          type: 'number',
          description: 'Terminal columns (default: 120)',
        },
      },
      required: ['command'],
    },
  };
}

/**
 * Handle PTY exec tool invocation
 */
export async function handlePtyExecTool(input: unknown): Promise<string> {
  const params = input as PtyExecInput;

  if (!params.command) {
    return JSON.stringify({ success: false, error: 'command is required' });
  }

  const result = await execWithPty(params);
  return JSON.stringify(result);
}

