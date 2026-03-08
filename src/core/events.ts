import { EventEmitter } from 'node:events';

/**
 * Progress event emitted during job execution.
 * Channels listen to these to send real-time updates to users.
 */
export interface ProgressEvent {
  type:
    | 'node_started'
    | 'node_completed'
    | 'node_failed'
    | 'approval_needed'
    | 'circuit_breaker'
    | 'job_completed'
    | 'job_failed';
  nodeTitle?: string;
  agentName?: string;
  summary?: string;
  reason?: string;
  approvalId?: string;
  preview?: string;
  willRetry?: boolean;
  artifactId?: string;
}

/**
 * Approval resolution payload.
 */
export interface ApprovalResolution {
  approvalId: string;
  status: 'approved' | 'rejected';
  payload?: Record<string, unknown>;
}

/**
 * Shared event emitter for graph execution, approvals, and progress.
 *
 * Event patterns:
 *   node:completed:{jobId}    — a node finished successfully
 *   node:failed:{jobId}       — a node failed
 *   approval:resolved:{nodeId} — user approved/rejected an action
 *   progress:{jobId}          — progress update for channel listeners
 */
class GraphEvents extends EventEmitter {
  constructor() {
    super();
    // Allow many listeners (one per active job/channel combo)
    this.setMaxListeners(100);
  }

  emitNodeCompleted(jobId: string, nodeId: string): void {
    this.emit(`node:completed:${jobId}`, nodeId);
  }

  emitNodeFailed(jobId: string, nodeId: string): void {
    this.emit(`node:failed:${jobId}`, nodeId);
  }

  emitApprovalResolved(nodeId: string, resolution: ApprovalResolution): void {
    this.emit(`approval:resolved:${nodeId}`, resolution);
  }

  emitProgress(jobId: string, event: ProgressEvent): void {
    this.emit(`progress:${jobId}`, event);
  }

  onNodeCompleted(jobId: string, listener: (nodeId: string) => void): void {
    this.on(`node:completed:${jobId}`, listener);
  }

  onNodeFailed(jobId: string, listener: (nodeId: string) => void): void {
    this.on(`node:failed:${jobId}`, listener);
  }

  onApprovalResolved(nodeId: string, listener: (resolution: ApprovalResolution) => void): void {
    this.on(`approval:resolved:${nodeId}`, listener);
  }

  onProgress(jobId: string, listener: (event: ProgressEvent) => void): void {
    this.on(`progress:${jobId}`, listener);
  }

  /** Remove all listeners for a completed/failed job. */
  cleanupJob(jobId: string): void {
    this.removeAllListeners(`node:completed:${jobId}`);
    this.removeAllListeners(`node:failed:${jobId}`);
    this.removeAllListeners(`progress:${jobId}`);
  }
}

/** Singleton graph event emitter. */
export const graphEvents = new GraphEvents();
