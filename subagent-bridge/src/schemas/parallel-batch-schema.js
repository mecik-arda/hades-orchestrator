import { z } from "zod";

export const parallelBatchSchemaVersion = 1;

export const parallelBatchPlanStatusValues = ["planned", "claimed", "expired"];
export const parallelBatchStatusValues = [
  "created",
  "planned",
  "queued",
  "running",
  "cancel_requested",
  "cancelling",
  "result_ready",
  "blocked",
  "integrating",
  "ready_for_approval",
  "integrated",
  "failed",
  "cancelled",
  "unknown"
];
export const parallelTaskStatusValues = [
  "queued",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "unknown"
];
export const parallelSummaryStatusValues = ["full", "summary_truncated", "schema_invalid", "output_limit", "not_available"];
export const parallelActionRequiredValues = ["none", "needs_approval", "needs_more_detail", "blocked"];
export const parallelTaskRoleValues = ["analyst", "researcher", "reviewer", "planner", "implementer"];

const relativePathSchema = z.string().min(1).max(500).refine((value) => {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
  const segments = normalized.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}, "path must be a normalized relative path without traversal");

const taskIdSchema = z.string().min(3).max(64).regex(/^[a-z0-9][a-z0-9_-]{2,63}$/);
const resourceClaimSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);

export const parallelTaskContractSchema = z.object({
  taskId: taskIdSchema,
  role: z.enum(parallelTaskRoleValues),
  mode: z.enum(["read_only", "edit"]).default("read_only"),
  target: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(160).optional(),
  profile: z.string().min(1).max(64).optional(),
  objective: z.string().min(1).max(12000),
  files: z.array(relativePathSchema).max(100).default([]),
  readablePaths: z.array(relativePathSchema).max(50).default([]),
  contextFiles: z.array(relativePathSchema).max(100).default([]),
  allowedPaths: z.array(relativePathSchema).max(100).default([]),
  prohibitedPaths: z.array(relativePathSchema).max(100).default([]),
  acceptanceCriteria: z.array(z.string().min(1).max(4000)).max(50).default([]),
  verificationCommands: z.array(z.string().min(1).max(200)).max(20).default([]),
  stopConditions: z.array(z.string().min(1).max(1000)).max(20).default([]),
  resourceClaims: z.array(resourceClaimSchema).max(20).default([]),
  maxFilesChanged: z.number().int().min(1).max(100).optional(),
  maxFileBytes: z.number().int().min(1).max(524288).optional(),
  maxTotalDiffBytes: z.number().int().min(1).max(2097152).optional(),
  maxInputBytes: z.number().int().min(1).max(8388608).optional(),
  maxOutputBytes: z.number().int().min(1024).max(8388608).optional(),
  maxInputTokens: z.number().int().min(1).max(1000000).optional(),
  maxOutputTokens: z.number().int().min(1).max(32768).optional(),
  dependsOn: z.array(taskIdSchema).max(100).default([]),
  timeoutSeconds: z.number().int().min(10).max(1200).optional()
}).strict().superRefine((value, context) => {
  if (value.taskId === "integration") context.addIssue({ code: z.ZodIssueCode.custom, path: ["taskId"], message: "task id is reserved for the combined integration diff" });
  if (value.mode === "read_only") {
    if (value.files.length > 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: "read-only tasks cannot declare editable files" });
    if (value.allowedPaths.length > 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["allowedPaths"], message: "read-only tasks cannot declare allowed edit paths" });
    if (value.prohibitedPaths.length > 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["prohibitedPaths"], message: "read-only tasks cannot declare prohibited edit paths" });
    if (value.readablePaths.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["readablePaths"], message: "read-only tasks require at least one readable path" });
  } else {
    if (value.files.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: "edit tasks require selected files" });
    if (value.acceptanceCriteria.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["acceptanceCriteria"], message: "edit tasks require acceptance criteria" });
    if (value.verificationCommands.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["verificationCommands"], message: "edit tasks require host-allowlisted verification commands" });
  }
  if (new Set(value.resourceClaims.map((claim) => claim.toLocaleLowerCase("en-US"))).size !== value.resourceClaims.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["resourceClaims"], message: "resource claims must be unique" });
  }
  if (!value.target && !value.profile) context.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: "task requires a target or profile" });
  if (value.target && value.profile) context.addIssue({ code: z.ZodIssueCode.custom, path: ["profile"], message: "task cannot combine target and profile" });
});

export const prepareParallelBatchRequestSchema = z.object({
  objective: z.string().min(1).max(12000),
  batchMaxReservedCostUsd: z.number().positive().max(1000),
  maxWorkers: z.number().int().min(1).max(5).optional(),
  tasks: z.array(parallelTaskContractSchema).min(1).max(5)
}).strict();

export const startParallelBatchRequestSchema = z.object({
  planId: z.string().regex(/^[a-f0-9]{16,64}$/),
  planHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export const getParallelBatchRequestSchema = z.object({
  batchId: z.string().regex(/^[a-f0-9]{16,64}$/)
}).strict();

export const getParallelTaskDetailRequestSchema = z.object({
  batchId: z.string().regex(/^[a-f0-9]{16,64}$/),
  taskId: taskIdSchema,
  detailRef: z.string().regex(/^[a-f0-9]{64}$/),
  cursor: z.number().int().min(0).default(0),
  maxBytes: z.number().int().min(256).max(65536).default(16384)
}).strict();

export const cancelParallelBatchRequestSchema = z.object({
  batchId: z.string().regex(/^[a-f0-9]{16,64}$/)
}).strict();

export const approveParallelIntegrationRequestSchema = z.object({
  batchId: z.string().regex(/^[a-f0-9]{16,64}$/),
  approvalRef: z.string().regex(/^[a-f0-9]{64}$/),
  expectedDiffHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export const parallelWorkerSummarySchema = z.object({
  status: z.enum(["ok", "blocked", "failed"]),
  summary: z.string().min(1).max(16384),
  action_required: z.enum(parallelActionRequiredValues).default("none")
}).strict();

export const parallelTaskVerificationSchema = z.object({
  commandHash: z.string().regex(/^[a-f0-9]{64}$/),
  exitCode: z.number().int().nullable(),
  outputBytes: z.number().int().min(0)
}).strict();

export const parallelRiskLevelValues = ["low_impact", "new_file", "multiple_files", "policy_config", "external_service", "irreversible"];

export const parallelTaskSummarySchema = z.object({
  taskId: taskIdSchema,
  status: z.enum(parallelTaskStatusValues),
  summary: z.string().max(4096).nullable(),
  summaryStatus: z.enum(parallelSummaryStatusValues),
  actionRequired: z.enum(parallelActionRequiredValues),
  filesChanged: z.array(z.string().min(1).max(500)).max(200),
  verification: z.array(parallelTaskVerificationSchema).max(20),
  riskLevel: z.enum(parallelRiskLevelValues).nullable(),
  detailRef: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  failureClass: z.string().min(1).max(64).nullable(),
  durationMs: z.number().int().min(0),
  costUsd: z.number().min(0).nullable()
}).strict();

export const parallelBatchBudgetSchema = z.object({
  capUsd: z.number().min(0),
  reservedUsd: z.number().min(0),
  settledKnownUsd: z.number().min(0),
  unknownReservedUsd: z.number().min(0),
  refundedUsd: z.number().min(0),
  remainingUsd: z.number().min(0),
  isProviderInvoice: z.literal(false)
}).strict();

export const parallelBatchProgressSchema = z.object({
  percentage: z.number().int().min(0).max(100),
  resolvedCount: z.number().int().min(0).max(5),
  totalCount: z.number().int().min(1).max(5),
  runningCount: z.number().int().min(0).max(5),
  queuedCount: z.number().int().min(0).max(5),
  blockedCount: z.number().int().min(0).max(5),
  cancelledCount: z.number().int().min(0).max(5)
}).strict();

export const parallelBatchApprovalSchema = z.object({
  approvalRef: z.string().regex(/^[a-f0-9]{64}$/),
  diffHash: z.string().regex(/^[a-f0-9]{64}$/),
  detailRef: z.string().regex(/^[a-f0-9]{64}$/),
  filesChanged: z.array(z.string().min(1).max(500)).max(200)
}).strict();

export const parallelBatchSummarySchema = z.object({
  schemaVersion: z.literal(parallelBatchSchemaVersion),
  batchId: z.string().regex(/^[a-f0-9]{16,64}$/).nullable(),
  planId: z.string().regex(/^[a-f0-9]{16,64}$/),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum([...parallelBatchPlanStatusValues, ...parallelBatchStatusValues]),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  taskCount: z.number().int().min(1).max(5),
  completedCount: z.number().int().min(0).max(5),
  failedCount: z.number().int().min(0).max(5),
  unknownCount: z.number().int().min(0).max(5),
  tasks: z.array(parallelTaskSummarySchema),
  progress: parallelBatchProgressSchema,
  budget: parallelBatchBudgetSchema,
  approvalRequired: z.boolean(),
  approval: parallelBatchApprovalSchema.nullable(),
  message: z.string().max(2048).nullable(),
  contentBytes: z.number().int().min(0)
}).strict();

export const parallelTaskDetailPageSchema = z.object({
  schemaVersion: z.literal(parallelBatchSchemaVersion),
  batchId: z.string().regex(/^[a-f0-9]{16,64}$/),
  taskId: taskIdSchema,
  detailRef: z.string().regex(/^[a-f0-9]{64}$/),
  cursor: z.number().int().min(0),
  nextCursor: z.number().int().min(0).nullable(),
  totalBytes: z.number().int().min(0),
  content: z.string(),
  expiresAt: z.string().datetime().nullable(),
  redactionsApplied: z.number().int().min(0)
}).strict();

export function computeParallelTaskContractHash(contract) {
  return JSON.stringify(contract);
}

export function validateParallelTaskContract(value) {
  return parallelTaskContractSchema.safeParse(value);
}

export function validatePrepareParallelBatchRequest(value) {
  return prepareParallelBatchRequestSchema.safeParse(value);
}

export function validateParallelBatchSummary(value) {
  return parallelBatchSummarySchema.safeParse(value);
}

export function validateParallelWorkerSummary(value) {
  return parallelWorkerSummarySchema.safeParse(value);
}
