import type { z } from 'zod';

export type ToolRisk = 'low' | 'medium' | 'high';

export interface RequiredSecret {
  envVar: string;
  description: string;
  helpUrl?: string;
}

export interface ToolDefinition<TParams extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  version: string;
  permissions: string[];
  risk: ToolRisk;
  requiredSecrets: RequiredSecret[];
  schema: TParams;
  jsonSchema?: Record<string, unknown>;
  handler: (params: z.infer<TParams>, ctx: ToolContext) => Promise<unknown>;
  mockHandler?: (params: z.infer<TParams>, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  jobId: string;
  nodeId: string;
  agentName: string;
  dryRun: boolean;

  budget: {
    remainingToolCalls: number;
    remainingTimeMs: number;
  };

  policy: {
    allowPermissions: string[];
    allowedDomains?: string[];
    requireApprovalFor?: string[];
  };

  ledger: {
    log: (entry: LedgerLogEntry) => void;
  };

  approvals: {
    request: (payload: ApprovalPayload) => Promise<{ approvalId: string }>;
  };

  artifacts: {
    writeText: (params: { type: string; title: string; content: string }) => Promise<{ artifactId: string }>;
    writeFile: (params: { type: string; title: string; path: string; bytes: Buffer }) => Promise<{ artifactId: string }>;
  };

  secrets: {
    get: (key: string) => string | undefined;
  };
}

export interface LedgerLogEntry {
  tool: string;
  action: string;
  status: 'success' | 'error' | 'blocked' | 'dry_run';
  inputSummary?: unknown;
  outputSummary?: unknown;
  errorMessage?: string;
  startedAt: number;
  endedAt: number;
  cost?: { tokens?: number; usd?: number };
  metadata?: Record<string, unknown>;
}

export interface ApprovalPayload {
  actionType: string;
  title: string;
  preview: string;
  data: unknown;
}

export interface WorkerResult {
  status: 'completed' | 'failed' | 'waiting_approval';
  output?: unknown;
  artifactIds?: string[];
  costTokens: number;
  error?: string;
  approvalId?: string;
}
