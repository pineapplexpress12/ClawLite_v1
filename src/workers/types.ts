import type { ToolContext, WorkerResult } from '../tools/sdk/types.js';
import type { NodeRow } from '../db/nodes.js';

/**
 * A stateless worker agent that executes specific node types.
 */
export interface WorkerAgent {
  name: string;
  supportedNodeTypes: string[];
  execute(node: NodeRow, ctx: ToolContext): Promise<WorkerResult>;
}

export type { WorkerResult, ToolContext };
