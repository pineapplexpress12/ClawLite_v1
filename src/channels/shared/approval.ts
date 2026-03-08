import { resolveApproval } from '../../executor/approvalHandler.js';
import { getApproval, updateApprovalStatus } from '../../db/approvals.js';
import { transitionNodeStatus } from '../../db/nodes.js';
import { logger } from '../../core/logger.js';
import type { ApprovalAction } from '../types.js';

/**
 * Handle an approval callback from a channel adapter.
 * Resolves the approval in the executor, which resumes the waiting node.
 */
export async function handleApprovalCallback(action: ApprovalAction): Promise<void> {
  const approval = getApproval(action.approvalId);
  if (!approval) {
    logger.warn('Approval not found', { approvalId: action.approvalId });
    return;
  }

  if (approval.status !== 'pending') {
    logger.warn('Approval already resolved', { approvalId: action.approvalId, status: approval.status });
    return;
  }

  const status = action.action === 'approve' ? 'approved' : 'rejected';
  updateApprovalStatus(action.approvalId, status);

  if (action.action === 'reject') {
    transitionNodeStatus(approval.node_id, 'cancelled');
  }

  resolveApproval(approval.node_id, {
    approvalId: action.approvalId,
    status,
    payload: action.payload,
  });
}
