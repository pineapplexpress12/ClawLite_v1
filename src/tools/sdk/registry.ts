import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getClawliteHome } from '../../db/connection.js';
import { logger } from '../../core/logger.js';
import type { ToolDefinition, ToolRisk } from './types.js';

interface ToolInfo {
  name: string;
  description: string;
  permissions: string[];
  risk: ToolRisk;
}

const tools = new Map<string, ToolDefinition>();

export function registerTool(tool: ToolDefinition): void {
  if (tools.has(tool.name)) {
    throw new Error(`Tool name collision: "${tool.name}" is already registered`);
  }
  tools.set(tool.name, tool);
  logger.info(`Registered tool: ${tool.name}`, { version: tool.version, risk: tool.risk });
}

export function getTool(name: string): ToolDefinition | undefined {
  return tools.get(name);
}

export function listTools(): ToolInfo[] {
  return Array.from(tools.values()).map(t => ({
    name: t.name,
    description: t.description,
    permissions: t.permissions,
    risk: t.risk,
  }));
}

export function hasTools(): boolean {
  return tools.size > 0;
}

export function clearTools(): void {
  tools.clear();
}

/**
 * Auto-scan and register tools from builtin/ and custom/ directories.
 */
export async function autoDiscoverTools(): Promise<void> {
  const builtinDir = join(import.meta.dirname ?? '', '../../tools/builtin');
  const customDir = join(getClawliteHome(), 'tools', 'custom');

  await scanDirectory(builtinDir);
  if (existsSync(customDir)) {
    await scanDirectory(customDir);
  }
}

async function scanDirectory(dir: string): Promise<void> {
  if (!existsSync(dir)) return;

  const files = readdirSync(dir).filter(f => f.endsWith('.tool.ts') || f.endsWith('.tool.js'));

  for (const file of files) {
    try {
      const mod = await import(join(dir, file));
      // Find the exported ToolDefinition (first export with name + handler)
      for (const key of Object.keys(mod)) {
        const val = mod[key];
        if (val && typeof val === 'object' && 'name' in val && 'handler' in val && 'schema' in val) {
          registerTool(val as ToolDefinition);
          break;
        }
      }
    } catch (err) {
      logger.warn(`Failed to load tool from ${file}: ${(err as Error).message}`);
    }
  }
}
