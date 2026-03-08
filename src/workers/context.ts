import type { ToolContext } from '../tools/sdk/types.js';
import type { JobRow } from '../db/jobs.js';
import type { NodeRow } from '../db/nodes.js';
import { insertLedgerEntry } from '../db/ledger.js';
import { createApproval } from '../db/approvals.js';
import { storeTextArtifact, storeFileArtifact } from '../db/artifacts.js';
import { createSecretsAccessor } from '../core/secrets.js';

/**
 * Build a ToolContext for a worker executing a node.
 */
export function buildToolContext(job: JobRow, node: NodeRow): ToolContext {
  const toolPermissions: string[] = JSON.parse(node.tool_permissions);
  const elapsedMs = Date.now() - job.created_at;

  return {
    jobId: job.id,
    nodeId: node.id,
    agentName: node.assigned_agent,
    dryRun: job.dry_run === 1,

    budget: {
      remainingToolCalls: Math.max(0, 200 - job.total_llm_calls),
      remainingTimeMs: Math.max(0, job.budget_time_ms - elapsedMs),
    },

    policy: {
      allowPermissions: toolPermissions,
    },

    ledger: {
      log: (entry) => {
        insertLedgerEntry({
          agent: node.assigned_agent,
          tool: entry.tool,
          action: entry.action,
          status: entry.status,
          params: entry.inputSummary,
          result: entry.outputSummary,
          metadata: {
            jobId: job.id,
            nodeId: node.id,
            errorMessage: entry.errorMessage,
          },
        });
      },
    },

    approvals: {
      request: async (payload) => {
        const approvalId = createApproval({
          nodeId: node.id,
          actionType: payload.actionType,
          title: payload.title,
          preview: payload.preview,
          payload: payload.data as Record<string, unknown>,
        });
        return { approvalId };
      },
    },

    artifacts: {
      writeText: async (params) => {
        const id = storeTextArtifact({
          jobId: job.id,
          nodeId: node.id,
          type: params.type,
          title: params.title,
          content: params.content,
        });
        return { artifactId: id };
      },
      writeFile: async (params) => {
        const id = storeFileArtifact({
          jobId: job.id,
          nodeId: node.id,
          type: params.type,
          title: params.title,
          filePath: params.path,
          fileSize: params.bytes.length,
          mimeType: 'application/octet-stream',
        });
        return { artifactId: id };
      },
    },

    secrets: createSecretsAccessor(),
  };
}
