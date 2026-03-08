import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getClawliteHome } from '../db/connection.js';
import { registerTemplate, type GraphTemplate, type TemplateNodeDef, type SlotDef } from './templates.js';
import { logger } from '../core/logger.js';

/**
 * Load YAML templates from .clawlite/templates/.
 * Uses simple YAML parsing (JSON-compatible subset).
 */
export function loadYamlTemplates(): number {
  const dir = join(getClawliteHome(), 'templates');
  if (!existsSync(dir)) return 0;

  const files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json'));
  let loaded = 0;

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8');
      const parsed = JSON.parse(content) as GraphTemplate;

      // Basic validation
      if (!parsed.id || !parsed.name || !Array.isArray(parsed.nodes)) {
        logger.warn(`Invalid template in ${file}: missing id, name, or nodes`);
        continue;
      }

      registerTemplate(parsed);
      loaded++;
      logger.info(`Loaded template: ${parsed.id} from ${file}`);
    } catch (err) {
      logger.warn(`Failed to load template ${file}: ${(err as Error).message}`);
    }
  }

  return loaded;
}
