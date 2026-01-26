#!/usr/bin/env node
/**
 * MCP Server for Browser Tools
 *
 * Uses puppeteer-core directly for browser automation.
 * For Electron tier features, use the Pocket Agent chat UI.
 */

import { createInterface } from 'readline';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { spawn } from 'child_process';
import * as os from 'os';

const DEFAULT_CDP_URL = 'http://localhost:9222';

// Types
interface MCPRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

// Browser state
let browser: Browser | null = null;
let page: Page | null = null;

// Tool definitions
const TOOLS = [
  {
    name: 'browser',
    description: `Browser automation using Chrome DevTools Protocol.

IMPORTANT: Requires Chrome to be running with:
  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222

Actions:
- navigate: Go to URL (requires url)
- screenshot: Capture page as base64 image
- click: Click element (requires selector)
- type: Type text (requires selector, text)
- evaluate: Run JavaScript (requires script)
- extract: Get page data (extract_type: text/html/links/tables)
- scroll: Scroll page (scroll_direction, scroll_amount)
- hover: Hover over element (requires selector)

Example: { "action": "navigate", "url": "https://example.com" }`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'screenshot', 'click', 'type', 'evaluate', 'extract', 'scroll', 'hover'],
        },
        url: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        script: { type: 'string' },
        extract_type: { type: 'string', enum: ['text', 'html', 'links', 'tables'] },
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'number' },
        wait_for: { type: 'number' },
      },
      required: ['action'],
    },
  },
  {
    name: 'notify',
    description: 'Send desktop notification (macOS/Windows/Linux)',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title' },
        body: { type: 'string', description: 'Notification body' },
      },
      required: ['title'],
    },
  },
  {
    name: 'pty_exec',
    description: 'Execute command with PTY for interactive CLIs',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeout: { type: 'number' },
      },
      required: ['command'],
    },
  },
];

// Browser functions
async function connectBrowser(): Promise<Browser> {
  if (browser?.connected) return browser;

  try {
    browser = await puppeteer.connect({
      browserURL: DEFAULT_CDP_URL,
      defaultViewport: { width: 1280, height: 800 },
    });
    console.error('[Browser] Connected to Chrome CDP');
    return browser;
  } catch {
    throw new Error(
      `Cannot connect to Chrome. Start Chrome with:\n` +
        `/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222`
    );
  }
}

async function ensurePage(): Promise<Page> {
  const b = await connectBrowser();
  if (!page || page.isClosed()) {
    const pages = await b.pages();
    page = pages[0] || (await b.newPage());
  }
  return page;
}

async function handleBrowser(args: Record<string, unknown>): Promise<string> {
  const action = args.action as string;

  try {
    const p = await ensurePage();

    switch (action) {
      case 'navigate': {
        const url = args.url as string;
        if (!url) return JSON.stringify({ error: 'url required' });
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (args.wait_for) await new Promise((r) => setTimeout(r, args.wait_for as number));
        return JSON.stringify({
          success: true,
          url: p.url(),
          title: await p.title(),
        });
      }

      case 'screenshot': {
        const screenshot = await p.screenshot({ encoding: 'base64' });
        return JSON.stringify({
          success: true,
          screenshot: `[base64 image, ${(screenshot as string).length} chars]`,
          screenshot_base64: screenshot,
          url: p.url(),
        });
      }

      case 'click': {
        const selector = args.selector as string;
        if (!selector) return JSON.stringify({ error: 'selector required' });
        await p.waitForSelector(selector, { timeout: 5000 });
        await p.click(selector);
        return JSON.stringify({ success: true, clicked: selector });
      }

      case 'type': {
        const selector = args.selector as string;
        const text = args.text as string;
        if (!selector || text === undefined) return JSON.stringify({ error: 'selector and text required' });
        await p.waitForSelector(selector, { timeout: 5000 });
        await p.type(selector, text);
        return JSON.stringify({ success: true, typed: text.slice(0, 50) });
      }

      case 'evaluate': {
        const script = args.script as string;
        if (!script) return JSON.stringify({ error: 'script required' });
        const result = await p.evaluate(script);
        return JSON.stringify({ success: true, result });
      }

      case 'extract': {
        const extractType = (args.extract_type as string) || 'text';
        let data: unknown;

        switch (extractType) {
          case 'text':
            data = await p.evaluate(() => document.body.innerText.slice(0, 10000));
            break;
          case 'html':
            data = await p.evaluate(() => document.body.innerHTML.slice(0, 10000));
            break;
          case 'links':
            data = await p.evaluate(() =>
              Array.from(document.querySelectorAll('a[href]'))
                .slice(0, 50)
                .map((a) => ({ text: a.textContent?.trim(), href: (a as HTMLAnchorElement).href }))
            );
            break;
          case 'tables':
            data = await p.evaluate(() =>
              Array.from(document.querySelectorAll('table'))
                .slice(0, 5)
                .map((t) => t.outerHTML.slice(0, 2000))
            );
            break;
        }

        return JSON.stringify({ success: true, type: extractType, data });
      }

      case 'scroll': {
        const dir = (args.scroll_direction as string) || 'down';
        const amt = (args.scroll_amount as number) || 300;
        await p.evaluate(
          (d, a) => {
            const x = d === 'left' ? -a : d === 'right' ? a : 0;
            const y = d === 'up' ? -a : d === 'down' ? a : 0;
            window.scrollBy(x, y);
          },
          dir,
          amt
        );
        return JSON.stringify({ success: true, scrolled: dir, amount: amt });
      }

      case 'hover': {
        const selector = args.selector as string;
        if (!selector) return JSON.stringify({ error: 'selector required' });
        await p.waitForSelector(selector, { timeout: 5000 });
        await p.hover(selector);
        return JSON.stringify({ success: true, hovered: selector });
      }

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  }
}

// Notification (uses terminal-notifier or osascript as fallback)
async function handleNotify(args: Record<string, unknown>): Promise<string> {
  const title = args.title as string;
  const body = (args.body as string) || '';

  // Escape AppleScript special characters to prevent command injection
  const escapeAppleScript = (str: string): string => {
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  };

  try {
    // Try terminal-notifier first (brew install terminal-notifier)
    const result = await new Promise<string>((resolve) => {
      const child = spawn('terminal-notifier', ['-title', title, '-message', body, '-sound', 'default']);
      child.on('error', () => {
        // Fall back to osascript - use escaped strings to prevent injection
        const safeBody = escapeAppleScript(body);
        const safeTitle = escapeAppleScript(title);
        const osa = spawn('osascript', ['-e', `display notification "${safeBody}" with title "${safeTitle}"`]);
        osa.on('close', () => resolve(JSON.stringify({ success: true, method: 'osascript' })));
        osa.on('error', () => resolve(JSON.stringify({ error: 'No notification method available' })));
      });
      child.on('close', () => resolve(JSON.stringify({ success: true, method: 'terminal-notifier' })));
    });
    return result;
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  }
}

// PTY execution
async function handlePtyExec(args: Record<string, unknown>): Promise<string> {
  const command = args.command as string;
  const cwd = (args.cwd as string) || process.cwd();
  const timeout = (args.timeout as number) || 60000;

  return new Promise((resolve) => {
    let output = '';
    const shell = os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash';
    const shellArgs = os.platform() === 'win32' ? ['/c', command] : ['-c', command];

    const child = spawn(shell, shellArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

    const timeoutId = setTimeout(() => {
      child.kill();
      resolve(JSON.stringify({ success: false, error: 'Timeout', output }));
    }, timeout);

    child.stdout?.on('data', (d) => (output += d.toString()));
    child.stderr?.on('data', (d) => (output += d.toString()));

    child.on('close', (code) => {
      clearTimeout(timeoutId);
      resolve(JSON.stringify({ success: code === 0, exitCode: code, output }));
    });

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      resolve(JSON.stringify({ success: false, error: err.message }));
    });
  });
}

// Handle tool calls
async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  console.error(`[MCP] Tool call: ${name}`, JSON.stringify(args).slice(0, 200));

  switch (name) {
    case 'browser':
      return handleBrowser(args);
    case 'notify':
      return handleNotify(args);
    case 'pty_exec':
      return handlePtyExec(args);
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// MCP protocol handler
async function handleRequest(request: MCPRequest): Promise<MCPResponse> {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'pocket-agent-browser', version: '1.0.0' },
        },
      };

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

    case 'tools/call': {
      const { name, arguments: args } = params as { name: string; arguments: Record<string, unknown> };
      const result = await handleToolCall(name, args || {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result }] } };
    }

    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// Main loop
const rl = createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  try {
    const request = JSON.parse(line) as MCPRequest;
    const response = await handleRequest(request);
    console.log(JSON.stringify(response));
  } catch (error) {
    console.error('[MCP] Parse error:', error);
  }
});

console.error('[MCP Browser] Server started');
