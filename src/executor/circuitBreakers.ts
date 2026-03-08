import { getConfig } from '../core/config.js';
import { getDailyBudget } from '../db/dailyBudget.js';
import { countNodes } from '../db/nodes.js';
import type { JobRow } from '../db/jobs.js';

export interface BreakerResult {
  ok: boolean;
  reason?: string;
}

/**
 * Check all circuit breakers before every node dispatch and LLM call.
 */
export function checkCircuitBreakers(
  job: JobRow,
  requiredTokens?: number,
): BreakerResult {
  const limits = getConfig().hardLimits;
  const budgets = getConfig().budgets;

  // 1. Daily budget check
  const daily = getDailyBudget();
  const dailyRemaining = budgets.dailyTokens - daily.tokens_consumed;

  // Check if 24h window has elapsed — if so, budget is effectively full
  const windowElapsed = Date.now() - daily.window_start > 24 * 60 * 60 * 1000;

  if (!windowElapsed && requiredTokens && dailyRemaining < requiredTokens) {
    return {
      ok: false,
      reason: `daily_budget_exhausted (need ${requiredTokens}, have ${dailyRemaining})`,
    };
  }

  // 2. Node count per job
  const nodeCount = countNodes(job.id);
  if (nodeCount > limits.maxNodesPerJob) {
    return { ok: false, reason: `max_nodes_exceeded (${nodeCount} > ${limits.maxNodesPerJob})` };
  }

  // 3. Total LLM calls
  if (job.total_llm_calls >= limits.maxTotalLLMCalls) {
    return { ok: false, reason: `max_llm_calls_exceeded (${job.total_llm_calls})` };
  }

  // 4. Job duration
  const elapsedMs = Date.now() - job.created_at;
  if (elapsedMs > limits.maxJobDurationMs) {
    return { ok: false, reason: `max_duration_exceeded (${elapsedMs}ms)` };
  }

  // 5. Total retries
  if (job.total_retries >= limits.maxRetriesTotalPerJob) {
    return { ok: false, reason: `max_retries_exceeded (${job.total_retries})` };
  }

  return { ok: true };
}

/**
 * Check daily budget only (for lightweight checks like heartbeat).
 */
export function checkDailyBudget(requiredTokens: number): BreakerResult {
  const budgets = getConfig().budgets;
  const daily = getDailyBudget();
  const remaining = budgets.dailyTokens - daily.tokens_consumed;

  const windowElapsed = Date.now() - daily.window_start > 24 * 60 * 60 * 1000;
  if (windowElapsed) {
    return { ok: true };
  }

  if (remaining < requiredTokens) {
    return { ok: false, reason: `daily_budget_exhausted (${remaining} remaining)` };
  }

  return { ok: true };
}
