/**
 * Tool configurations for the agent
 *
 * Available capabilities:
 * - File/Terminal: Built-in with claude_code preset
 * - Browser: Three-tier system (HTTP, Electron, CDP)
 * - Desktop: Anthropic computer use tool (Docker recommended)
 *
 * Custom tools use SDK MCP servers (in-process) via createSdkMcpServer()
 */

import { execSync } from 'child_process';
import { getBrowserToolDefinition, handleBrowserTool } from '../browser';
import { getMemoryTools } from './memory-tools';
import { getSchedulerTools } from './scheduler-tools';
import { getCalendarTools } from './calendar-tools';
import { getTaskTools } from './task-tools';
import {
  getNotifyToolDefinition,
  handleNotifyTool,
  getPtyExecToolDefinition,
  handlePtyExecTool,
} from './macos';

export { setMemoryManager } from './memory-tools';
export { getSchedulerTools } from './scheduler-tools';
export { getCalendarTools } from './calendar-tools';
export { getTaskTools } from './task-tools';
export { showNotification, execWithPty } from './macos';

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ToolsConfig {
  mcpServers: Record<string, MCPServerConfig>;
  computerUse: {
    enabled: boolean;
    dockerized: boolean;
    displaySize?: { width: number; height: number };
  };
  browser: {
    enabled: boolean;
    cdpUrl?: string; // Default: http://localhost:9222
  };
}

/**
 * Default tools configuration
 */
export function getDefaultToolsConfig(): ToolsConfig {
  return {
    mcpServers: {},
    computerUse: {
      enabled: false,
      dockerized: true,
      displaySize: { width: 1920, height: 1080 },
    },
    browser: {
      enabled: true,
      cdpUrl: 'http://localhost:9222',
    },
  };
}

/**
 * Build MCP server configurations (for child process MCP servers)
 */
export function buildMCPServers(config: ToolsConfig): Record<string, MCPServerConfig> {
  const servers: Record<string, MCPServerConfig> = {};

  // Computer use server (for desktop automation) - runs as child process
  if (config.computerUse.enabled) {
    if (config.computerUse.dockerized) {
      servers['computer'] = {
        command: 'docker',
        args: [
          'run',
          '-i',
          '--rm',
          '-e',
          `DISPLAY_WIDTH=${config.computerUse.displaySize?.width || 1920}`,
          '-e',
          `DISPLAY_HEIGHT=${config.computerUse.displaySize?.height || 1080}`,
          'ghcr.io/anthropics/anthropic-quickstarts:computer-use-demo-latest',
        ],
      };
    } else {
      servers['computer'] = {
        command: 'npx',
        args: ['-y', '@anthropic-ai/computer-use-server'],
      };
    }
  }

  // Merge with any custom servers
  return { ...servers, ...config.mcpServers };
}

/**
 * Build SDK MCP servers (in-process tools)
 * These run in the same process as the agent, so they can access Electron APIs
 */
export async function buildSdkMcpServers(
  config: ToolsConfig
): Promise<Record<string, unknown> | null> {
  // Dynamically import SDK to avoid CommonJS issues
  // Using Function constructor for dynamic ESM imports in CommonJS context
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dynamicImport = new Function('specifier', 'return import(specifier)') as <T = any>(
    specifier: string
  ) => Promise<T>;

  try {
    const sdk = await dynamicImport<typeof import('@anthropic-ai/claude-agent-sdk')>('@anthropic-ai/claude-agent-sdk');
    const { createSdkMcpServer, tool } = sdk;
    const zodModule = await dynamicImport<typeof import('zod')>('zod');
    const { z } = zodModule;

    const tools = [];

    // Browser tool (if enabled)
    if (config.browser.enabled) {
      const browserTool = tool(
        'browser',
        getBrowserToolDefinition().description,
        {
          action: z.enum([
            'navigate',
            'screenshot',
            'click',
            'type',
            'evaluate',
            'extract',
            'scroll',
            'hover',
            'download',
            'upload',
            'tabs_list',
            'tabs_open',
            'tabs_close',
            'tabs_focus',
          ]),
          url: z.string().optional(),
          selector: z.string().optional(),
          text: z.string().optional(),
          script: z.string().optional(),
          extract_type: z.enum(['text', 'html', 'links', 'tables', 'structured']).optional(),
          scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
          scroll_amount: z.number().optional(),
          download_path: z.string().optional(),
          file_path: z.string().optional(),
          tab_id: z.string().optional(),
          requires_auth: z.boolean().optional(),
          tier: z.enum(['electron', 'cdp']).optional(),
          wait_for: z.union([z.string(), z.number()]).optional(),
        },
        async (args) => {
          const result = await handleBrowserTool(args);
          return { content: [{ type: 'text', text: result }] };
        }
      );
      tools.push(browserTool);
    }

    // Notify tool
    const notifyTool = tool(
      'notify',
      getNotifyToolDefinition().description,
      {
        title: z.string(),
        body: z.string().optional(),
        subtitle: z.string().optional(),
        silent: z.boolean().optional(),
        urgency: z.enum(['low', 'normal', 'critical']).optional(),
      },
      async (args) => {
        const result = await handleNotifyTool(args);
        return { content: [{ type: 'text', text: result }] };
      }
    );
    tools.push(notifyTool);

    // PTY exec tool
    const ptyExecTool = tool(
      'pty_exec',
      getPtyExecToolDefinition().description,
      {
        command: z.string(),
        args: z.array(z.string()).optional(),
        cwd: z.string().optional(),
        timeout: z.number().optional(),
      },
      async (args) => {
        const result = await handlePtyExecTool(args);
        return { content: [{ type: 'text', text: result }] };
      }
    );
    tools.push(ptyExecTool);

    // Memory tools
    const memoryTools = getMemoryTools();
    for (const memTool of memoryTools) {
      const sdkTool = tool(
        memTool.name,
        memTool.description,
        // Convert JSON schema to Zod (simplified - assumes string fields)
        Object.fromEntries(
          Object.entries(memTool.input_schema.properties || {}).map(([key, value]: [string, unknown]) => {
            const prop = value as { type?: string };
            if (prop.type === 'string') return [key, z.string().optional()];
            if (prop.type === 'number') return [key, z.number().optional()];
            return [key, z.any().optional()];
          })
        ),
        async (args) => {
          const result = await memTool.handler(args);
          return { content: [{ type: 'text', text: result }] };
        }
      );
      tools.push(sdkTool);
    }

    // Scheduler tools
    const schedulerTools = getSchedulerTools();
    for (const schedTool of schedulerTools) {
      const sdkTool = tool(
        schedTool.name,
        schedTool.description,
        Object.fromEntries(
          Object.entries(schedTool.input_schema.properties || {}).map(([key, value]: [string, unknown]) => {
            const prop = value as { type?: string };
            if (prop.type === 'string') return [key, z.string().optional()];
            if (prop.type === 'number') return [key, z.number().optional()];
            if (prop.type === 'boolean') return [key, z.boolean().optional()];
            return [key, z.any().optional()];
          })
        ),
        async (args) => {
          const result = await schedTool.handler(args);
          return { content: [{ type: 'text', text: result }] };
        }
      );
      tools.push(sdkTool);
    }

    // Calendar tools
    const calendarTools = getCalendarTools();
    for (const calTool of calendarTools) {
      const sdkTool = tool(
        calTool.name,
        calTool.description,
        Object.fromEntries(
          Object.entries(calTool.input_schema.properties || {}).map(([key, value]: [string, unknown]) => {
            const prop = value as { type?: string };
            if (prop.type === 'string') return [key, z.string().optional()];
            if (prop.type === 'number') return [key, z.number().optional()];
            return [key, z.any().optional()];
          })
        ),
        async (args) => {
          const result = await calTool.handler(args);
          return { content: [{ type: 'text', text: result }] };
        }
      );
      tools.push(sdkTool);
    }

    // Task tools
    const taskTools = getTaskTools();
    for (const taskTool of taskTools) {
      const sdkTool = tool(
        taskTool.name,
        taskTool.description,
        Object.fromEntries(
          Object.entries(taskTool.input_schema.properties || {}).map(([key, value]: [string, unknown]) => {
            const prop = value as { type?: string };
            if (prop.type === 'string') return [key, z.string().optional()];
            if (prop.type === 'number') return [key, z.number().optional()];
            return [key, z.any().optional()];
          })
        ),
        async (args) => {
          const result = await taskTool.handler(args);
          return { content: [{ type: 'text', text: result }] };
        }
      );
      tools.push(sdkTool);
    }

    // Create the SDK MCP server
    const server = createSdkMcpServer({
      name: 'pocket-agent-tools',
      version: '1.0.0',
      tools,
    });

    return { 'pocket-agent': server };
  } catch (error) {
    console.error('[Tools] Failed to build SDK MCP servers:', error);
    return null;
  }
}

/**
 * Get computer use tool definition for direct API use
 */
export function getComputerUseTool(displaySize: { width: number; height: number }) {
  return {
    type: 'computer_20241022' as const,
    name: 'computer',
    display_width_px: displaySize.width,
    display_height_px: displaySize.height,
  };
}

/**
 * Get custom tools for the agent
 */
export function getCustomTools(config: ToolsConfig): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: (input: unknown) => Promise<string>;
}> {
  const tools: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
    handler: (input: unknown) => Promise<string>;
  }> = [];

  // Memory tools (always enabled)
  const memoryTools = getMemoryTools();
  for (const tool of memoryTools) {
    tools.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Record<string, unknown>,
      handler: tool.handler,
    });
  }

  // Browser tool
  if (config.browser.enabled) {
    const browserDef = getBrowserToolDefinition();
    tools.push({
      name: browserDef.name,
      description: browserDef.description,
      input_schema: browserDef.input_schema as Record<string, unknown>,
      handler: handleBrowserTool,
    });
  }

  // Scheduler tools (always enabled - scheduler availability checked at runtime)
  const schedulerTools = getSchedulerTools();
  for (const tool of schedulerTools) {
    tools.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Record<string, unknown>,
      handler: tool.handler,
    });
  }

  // macOS tools (notifications and PTY exec)
  const notifyDef = getNotifyToolDefinition();
  tools.push({
    name: notifyDef.name,
    description: notifyDef.description,
    input_schema: notifyDef.input_schema as Record<string, unknown>,
    handler: handleNotifyTool,
  });

  const ptyExecDef = getPtyExecToolDefinition();
  tools.push({
    name: ptyExecDef.name,
    description: ptyExecDef.description,
    input_schema: ptyExecDef.input_schema as Record<string, unknown>,
    handler: handlePtyExecTool,
  });

  // Calendar tools
  const calendarTools = getCalendarTools();
  for (const tool of calendarTools) {
    tools.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Record<string, unknown>,
      handler: tool.handler,
    });
  }

  // Task tools
  const taskTools = getTaskTools();
  for (const tool of taskTools) {
    tools.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Record<string, unknown>,
      handler: tool.handler,
    });
  }

  return tools;
}

/**
 * Validate that required environment variables are set
 */
export function validateToolsConfig(config: ToolsConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (config.computerUse.enabled && config.computerUse.dockerized) {
    // Check if Docker is available
    try {
      execSync('docker --version', { stdio: 'ignore' });
    } catch {
      errors.push('Docker not available (required for safe computer use)');
    }
  }

  return { valid: errors.length === 0, errors };
}
