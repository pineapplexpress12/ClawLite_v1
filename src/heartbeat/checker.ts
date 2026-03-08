import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getClawliteHome } from '../db/connection.js';
import { getConfig } from '../core/config.js';
import { complete } from '../llm/provider.js';
import { getDailyBudget } from '../db/dailyBudget.js';
import { incrementDailyTokens } from '../db/dailyBudget.js';
import { getTemplate, getAllTemplates } from '../planner/templates.js';
import { buildTaskGraph } from '../planner/buildTaskGraph.js';
import { executeJob } from '../executor/executeJob.js';
import { logger } from '../core/logger.js';

interface HeartbeatResult {
  action: 'none' | 'trigger';
  templateId?: string;
  slots?: Record<string, unknown>;
  reason?: string;
}

/**
 * Read the HEARTBEAT.md checklist from the workspace.
 */
function readHeartbeatChecklist(): string | null {
  const path = join(getClawliteHome(), 'HEARTBEAT.md');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

/**
 * Get a summary of available templates for the LLM prompt.
 */
function getTemplateSummary(): string {
  const templates = getAllTemplates();
  return templates.map(t => `- ${t.id}: ${t.description}`).join('\n');
}

/**
 * Get the current day of week as a string.
 */
function getDayOfWeek(): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()]!;
}

/**
 * Run a single heartbeat check.
 * Reads HEARTBEAT.md, makes a single fast-tier LLM call,
 * and triggers a template job if the LLM determines action is needed.
 */
export async function runHeartbeatCheck(): Promise<HeartbeatResult> {
  const config = getConfig();

  // Budget check — heartbeat is NOT exempt
  const budget = getDailyBudget();
  const estimatedTokens = 500;
  if (budget.tokens_consumed + estimatedTokens > config.budgets.dailyTokens) {
    logger.info('Heartbeat skipped: daily budget exhausted');
    return { action: 'none', reason: 'budget_exhausted' };
  }

  const checklist = readHeartbeatChecklist();
  if (!checklist || !checklist.trim()) {
    logger.info('Heartbeat skipped: no checklist');
    return { action: 'none', reason: 'no_checklist' };
  }

  const templateSummary = getTemplateSummary();

  const result = await complete({
    model: 'fast',
    messages: [
      {
        role: 'system',
        content: 'You are a condition checker. Given the checklist below, determine if any condition requires action RIGHT NOW. Respond with JSON only.',
      },
      {
        role: 'user',
        content: `Current time: ${new Date().toISOString()}\nDay: ${getDayOfWeek()}\n\nChecklist:\n${checklist}\n\nAvailable templates:\n${templateSummary}\n\nRespond: { "action": "none" } or { "action": "trigger", "templateId": "...", "slots": {...}, "reason": "..." }`,
      },
    ],
    format: 'json',
  });

  // Record token usage
  incrementDailyTokens(result.usage.total_tokens);

  const parsed = result.parsed as HeartbeatResult | undefined;
  if (!parsed || parsed.action !== 'trigger' || !parsed.templateId) {
    logger.info('Heartbeat: no action needed');
    return { action: 'none' };
  }

  // Find the template
  const template = getTemplate(parsed.templateId);
  if (!template) {
    logger.warn('Heartbeat wanted template but it does not exist', { templateId: parsed.templateId });
    return { action: 'none', reason: `template_not_found: ${parsed.templateId}` };
  }

  // Create and execute the job
  const { jobId } = buildTaskGraph({
    template,
    slots: parsed.slots ?? {},
    triggerType: 'heartbeat',
    channel: 'system',
    chatId: 'heartbeat',
    dryRun: false,
  });

  // Fire and forget
  executeJob(jobId).catch(err => {
    logger.error('Heartbeat job execution failed', { jobId, error: (err as Error).message });
  });

  logger.info('Heartbeat triggered job', { jobId, reason: parsed.reason });
  return { action: 'trigger', templateId: parsed.templateId, slots: parsed.slots, reason: parsed.reason };
}
