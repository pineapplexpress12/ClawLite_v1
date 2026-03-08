import { createApproval } from '../db/approvals.js';
import { transitionNodeStatus } from '../db/nodes.js';
import { graphEvents, type ApprovalResolution } from '../core/events.js';
import { logger } from '../core/logger.js';

export interface ApprovalRequest {
  nodeId: string;
  actionType: string;
  title: string;
  preview: string;
  payload: Record<string, unknown>;
}

/**
 * Create a pending approval and wait for resolution via events.
 * Returns a promise that resolves when the user approves/rejects.
 */
export async function requestApproval(request: ApprovalRequest): Promise<ApprovalResolution> {
  const approvalId = createApproval({
    nodeId: request.nodeId,
    actionType: request.actionType,
    title: request.title,
    preview: request.preview,
    payload: request.payload,
  });

  // Set node to waiting_approval
  transitionNodeStatus(request.nodeId, 'waiting_approval');

  logger.info('Approval requested', { nodeId: request.nodeId, approvalId, actionType: request.actionType });

  // Wait for approval resolution event
  return new Promise<ApprovalResolution>((resolve) => {
    graphEvents.onApprovalResolved(request.nodeId, (resolution) => {
      logger.info('Approval resolved', { nodeId: request.nodeId, status: resolution.status });
      resolve(resolution);
    });
  });
}

/**
 * Resolve a pending approval (called by channel adapters when user clicks approve/reject).
 */
export function resolveApproval(nodeId: string, resolution: ApprovalResolution): void {
  graphEvents.emitApprovalResolved(nodeId, resolution);
}
