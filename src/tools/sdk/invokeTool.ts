import { getTool } from './registry.js';
import type { ToolContext } from './types.js';

function summarize(data: unknown): unknown {
  const str = JSON.stringify(data);
  if (str.length > 500) {
    return str.slice(0, 500) + '...(truncated)';
  }
  return data;
}

/**
 * Mandatory tool invocation pipeline:
 * 1. Validate params (Zod)
 * 2. Budget check
 * 3. Permission check
 * 4. Dry run interception
 * 5. Execute handler
 * 6. Ledger logging
 */
export async function invokeTool(
  name: string,
  params: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  const tool = getTool(name);
  if (!tool) {
    throw new Error(`Unknown tool: "${name}"`);
  }

  const startedAt = Date.now();

  // STEP 1: Validate params with Zod
  const parsed = tool.schema.safeParse(params);
  if (!parsed.success) {
    ctx.ledger.log({
      tool: name,
      action: 'validate',
      status: 'error',
      errorMessage: parsed.error.message,
      startedAt,
      endedAt: Date.now(),
    });
    throw new Error(`Tool params validation failed for "${name}": ${parsed.error.message}`);
  }

  // STEP 2: Budget check
  if (ctx.budget.remainingToolCalls <= 0) {
    ctx.ledger.log({
      tool: name,
      action: 'budget',
      status: 'blocked',
      errorMessage: 'Tool call limit reached',
      startedAt,
      endedAt: Date.now(),
    });
    return { status: 'blocked', reason: 'budget_exceeded' };
  }

  // STEP 3: Permission check
  for (const perm of tool.permissions) {
    if (!ctx.policy.allowPermissions.includes(perm)) {
      ctx.ledger.log({
        tool: name,
        action: 'permission',
        status: 'blocked',
        errorMessage: `Missing permission: ${perm}`,
        startedAt,
        endedAt: Date.now(),
      });
      return { status: 'blocked', reason: 'permission_denied', missingPermission: perm };
    }
  }

  // STEP 4: Dry run interception
  if (ctx.dryRun) {
    const mockResult = tool.mockHandler
      ? await tool.mockHandler(parsed.data, ctx)
      : { status: 'dry_run', tool: name, params: parsed.data };

    ctx.ledger.log({
      tool: name,
      action: 'invoke',
      status: 'dry_run',
      inputSummary: summarize(parsed.data),
      outputSummary: summarize(mockResult),
      startedAt,
      endedAt: Date.now(),
    });

    return mockResult;
  }

  // STEP 5: Execute handler
  try {
    const result = await tool.handler(parsed.data, ctx);

    // STEP 6: Ledger logging (success)
    ctx.ledger.log({
      tool: name,
      action: 'invoke',
      status: 'success',
      inputSummary: summarize(parsed.data),
      outputSummary: summarize(result),
      startedAt,
      endedAt: Date.now(),
    });

    return result;
  } catch (err) {
    // Ledger logging (error)
    ctx.ledger.log({
      tool: name,
      action: 'invoke',
      status: 'error',
      errorMessage: (err as Error).message,
      startedAt,
      endedAt: Date.now(),
    });
    throw err;
  }
}
