import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  failureStageValues,
  outputSizeBucketValues,
  processSignalValues,
  providerCodeValues,
  retryDecisionValues,
  retryStopReasonValues
} from "./schemas/core-schemas.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const tokenSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const nullableTokenSchema = tokenSchema.nullable();
const finiteNonnegativeSchema = z.number().finite().nonnegative();
const backendSchema = z.enum(["antigravity", "claude_code", "codex", "deepseek", "glm", "kimi", "opencode", "qwen"]);
const modeSchema = z.enum(["read_only", "edit"]);
const outcomeSchema = z.enum(["completed", "failed"]);
const roleSchema = z.enum(["analyst", "researcher", "reviewer", "planner"]);
const usageSchema = z.object({
  durationMs: finiteNonnegativeSchema.optional().nullable(),
  apiDurationMs: finiteNonnegativeSchema.optional().nullable(),
  turns: z.number().int().nonnegative().optional().nullable(),
  totalCostUsd: finiteNonnegativeSchema.optional().nullable()
}).strict();
const attemptSchema = z.object({
  number: z.number().int().positive().optional(),
  failureClass: nullableTokenSchema.optional(),
  exitCode: z.number().int().optional().nullable(),
  durationMs: finiteNonnegativeSchema.optional().nullable(),
  apiDurationMs: finiteNonnegativeSchema.optional().nullable(),
  turns: z.number().int().nonnegative().optional().nullable(),
  totalCostUsd: finiteNonnegativeSchema.optional().nullable(),
  retryDelayMs: finiteNonnegativeSchema.optional().nullable()
}).strict();
const executionSchema = z.object({
  recordedAt: z.string().datetime(),
  backend: backendSchema,
  modelHash: hashSchema,
  executionIdHash: hashSchema,
  workspaceHash: hashSchema,
  mode: modeSchema,
  profile: tokenSchema.optional().nullable(),
  outcomeStatus: outcomeSchema,
  failureClass: nullableTokenSchema,
  usage: usageSchema,
  attempts: z.array(attemptSchema).max(100),
  retries: z.number().int().nonnegative(),
  queueWaitMs: finiteNonnegativeSchema,
  cacheHit: z.boolean()
}).strict();
const attemptSchemaV2 = z.object({
  number: z.number().int().positive().optional(),
  failureClass: nullableTokenSchema.optional(),
  failureStage: z.enum(failureStageValues).nullable().optional(),
  providerCode: z.enum(providerCodeValues).nullable().optional(),
  exitCode: z.number().int().optional().nullable(),
  signal: z.enum(processSignalValues).nullable().optional(),
  retryDecision: z.enum(retryDecisionValues).optional(),
  retryStopReason: z.enum(retryStopReasonValues).nullable().optional(),
  settingsLockWaitMs: finiteNonnegativeSchema.optional().nullable(),
  providerExecutionMs: finiteNonnegativeSchema.optional().nullable(),
  stdoutBucket: z.enum(outputSizeBucketValues).optional().nullable(),
  stderrBucket: z.enum(outputSizeBucketValues).optional().nullable(),
  durationMs: finiteNonnegativeSchema.optional().nullable(),
  totalCostUsd: finiteNonnegativeSchema.optional().nullable()
}).strict();
const executionSchemaV2 = z.object({
  schemaVersion: z.literal(2),
  recordedAt: z.string().datetime(),
  backend: backendSchema,
  modelHash: hashSchema,
  executionIdHash: hashSchema,
  workspaceHash: hashSchema,
  mode: modeSchema,
  profile: tokenSchema.optional().nullable(),
  outcomeStatus: outcomeSchema,
  failureClass: nullableTokenSchema,
  failureStage: z.enum(failureStageValues).nullable(),
  providerCode: z.enum(providerCodeValues).nullable(),
  retryStopReason: z.enum(retryStopReasonValues).nullable(),
  usage: usageSchema,
  attempts: z.array(attemptSchemaV2).max(100),
  retries: z.number().int().nonnegative(),
  queueWaitMs: finiteNonnegativeSchema,
  cacheHit: z.boolean()
}).strict();
const legacySchema = z.object({
  recordedAt: z.string().datetime(),
  backend: z.literal("deepseek").optional(),
  runIdHash: hashSchema,
  taskIdHash: hashSchema,
  agent: z.literal("deepseek"),
  role: roleSchema,
  modelHash: hashSchema,
  outcomeStatus: outcomeSchema,
  failureClass: nullableTokenSchema,
  usage: usageSchema,
  attempts: z.array(attemptSchema).max(100)
}).strict();
const routingFeedbackSchema = z.object({
  recordType: z.literal("routing_feedback"),
  recordedAt: z.string().datetime(),
  backend: z.literal("routing-evaluation"),
  executionIdHash: hashSchema,
  outcome: z.enum(["useful", "partial", "not_useful"])
}).strict();
const directEditFeedbackSchema = z.object({
  recordType: z.literal("direct_edit_feedback"),
  recordedAt: z.string().datetime(),
  backend: z.literal("direct-edit-baseline"),
  executionIdHash: hashSchema,
  outcome: z.enum(["accepted", "minor_fix", "reverted", "security_concern"])
}).strict();

function isPathInside(candidatePath, rootPath) {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function selectMetricFiles(metricsDirectory, limits) {
  if (!fs.existsSync(metricsDirectory)) return { files: [], truncated: false };
  const rootStatus = fs.lstatSync(metricsDirectory);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) return { files: [], truncated: false };
  const canonicalRoot = fs.realpathSync(metricsDirectory);
  const candidates = [];
  for (const entry of fs.readdirSync(metricsDirectory, { withFileTypes: true })) {
    if (!/-runs(?:-[a-zA-Z0-9-]+)?\.jsonl$/.test(entry.name) || entry.isSymbolicLink()) continue;
    const filePath = path.join(metricsDirectory, entry.name);
    try {
      const status = fs.lstatSync(filePath);
      if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) continue;
      const realPath = fs.realpathSync(filePath);
      if (!isPathInside(realPath, canonicalRoot)) continue;
      candidates.push({ filePath: realPath, mtimeMs: status.mtimeMs, size: status.size });
    } catch {
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath));
  const files = [];
  let totalBytes = 0;
  let truncated = candidates.length > limits.maxFiles;
  for (const candidate of candidates) {
    if (files.length >= limits.maxFiles || totalBytes + candidate.size > limits.maxBytes) {
      truncated = true;
      break;
    }
    files.push(candidate);
    totalBytes += candidate.size;
  }
  return { files, truncated };
}

function scanMetricFiles(selection, visit, countInvalid = true) {
  let invalidRecordCount = 0;
  for (const candidate of selection.files) {
    try {
      const status = fs.lstatSync(candidate.filePath);
      if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 || status.size !== candidate.size) {
        if (countInvalid) invalidRecordCount += 1;
        continue;
      }
      for (const line of fs.readFileSync(candidate.filePath, "utf8").split("\n")) {
        if (!line) continue;
        try {
          visit(JSON.parse(line));
        } catch {
          if (countInvalid) invalidRecordCount += 1;
        }
      }
    } catch {
      if (countInvalid) invalidRecordCount += 1;
    }
  }
  return invalidRecordCount;
}

function lastAttemptDiagnosis(attempts, fallback = {}) {
  const lastAttempt = Array.isArray(attempts) && attempts.length > 0 ? attempts.at(-1) : null;
  if (!lastAttempt) {
    return {
      failureStage: fallback.failureStage ?? null,
      providerCode: fallback.providerCode ?? null,
      retryStopReason: fallback.retryStopReason ?? null,
      exitCode: null,
      signal: null
    };
  }
  return {
    failureStage: lastAttempt.failureStage ?? null,
    providerCode: lastAttempt.providerCode ?? null,
    retryStopReason: lastAttempt.retryStopReason ?? null,
    exitCode: lastAttempt.exitCode ?? null,
    signal: lastAttempt.signal ?? null
  };
}

function normalizeRun(record) {
  if (record?.schemaVersion === 2) {
    const executionV2 = executionSchemaV2.safeParse(record);
    if (!executionV2.success) return null;
    const value = executionV2.data;
    const diagnosis = lastAttemptDiagnosis(value.attempts, value);
    const lastAttempt = Array.isArray(value.attempts) && value.attempts.length > 0 ? value.attempts.at(-1) : null;
    return {
      kind: "execution",
      identity: value.executionIdHash,
      recordedAt: value.recordedAt,
      fullHash: value.executionIdHash,
      profile: value.profile || null,
      role: null,
      backend: value.backend,
      modelHash: value.modelHash,
      mode: value.mode,
      outcomeStatus: value.outcomeStatus,
      failureClass: lastAttempt ? lastAttempt.failureClass : value.failureClass,
      failureStage: diagnosis.failureStage,
      providerCode: diagnosis.providerCode,
      retryStopReason: diagnosis.retryStopReason,
      exitCode: diagnosis.exitCode,
      signal: diagnosis.signal,
      durationMs: value.usage.durationMs ?? null,
      reportedCostUsd: value.usage.totalCostUsd ?? null,
      cacheHit: value.cacheHit,
      retries: lastAttempt ? Math.max(0, value.attempts.length - 1) : value.retries
    };
  }
  const execution = executionSchema.safeParse(record);
  if (execution.success) {
    const value = execution.data;
    return {
      kind: "execution",
      identity: value.executionIdHash,
      recordedAt: value.recordedAt,
      fullHash: value.executionIdHash,
      profile: value.profile || null,
      role: null,
      backend: value.backend,
      modelHash: value.modelHash,
      mode: value.mode,
      outcomeStatus: value.outcomeStatus,
      failureClass: value.failureClass,
      failureStage: null,
      providerCode: null,
      retryStopReason: null,
      exitCode: null,
      signal: null,
      durationMs: value.usage.durationMs ?? null,
      reportedCostUsd: value.usage.totalCostUsd ?? null,
      cacheHit: value.cacheHit,
      retries: value.retries
    };
  }
  const legacy = legacySchema.safeParse(record);
  if (!legacy.success) return null;
  const value = legacy.data;
  return {
    kind: "legacy",
    identity: value.runIdHash,
    recordedAt: value.recordedAt,
    fullHash: value.runIdHash,
    profile: null,
    role: value.role,
    backend: "deepseek",
    modelHash: value.modelHash,
    mode: "not_applicable",
    outcomeStatus: value.outcomeStatus,
    failureClass: value.failureClass,
    failureStage: null,
    providerCode: null,
    retryStopReason: null,
    exitCode: null,
    signal: null,
    durationMs: value.usage.durationMs ?? null,
    reportedCostUsd: value.usage.totalCostUsd ?? null,
    cacheHit: false,
    retries: Math.max(0, value.attempts.length - 1)
  };
}

function uniquePrefixes(hashes) {
  const result = new Map();
  for (const hash of hashes) {
    let length = 12;
    while (length < hash.length && hashes.some((candidate) => candidate !== hash && candidate.startsWith(hash.slice(0, length)))) length += 1;
    result.set(hash, hash.slice(0, length));
  }
  return result;
}

function modelDisplay(run, configuration) {
  const configuredModel = run.profile ? configuration.orchestration?.taskProfiles?.[run.profile]?.model : null;
  if (configuredModel && crypto.createHash("sha256").update(configuredModel).digest("hex") === run.modelHash) return configuredModel;
  return run.modelHash ? run.modelHash.slice(0, 12) : "unknown";
}

export function readRecentRuns(configuration, options = {}) {
  const days = options.days ?? 7;
  const limit = options.limit ?? 20;
  const maxFiles = options.maxFiles ?? 64;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const now = options.now instanceof Date ? options.now : new Date();
  if (!Number.isInteger(days) || days < 1 || days > 45) throw new Error("days must be an integer between 1 and 45");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be an integer between 1 and 200");
  const metricsDirectory = options.metricsDirectory || path.join(configuration.statePaths.logs, "metrics");
  const selection = selectMetricFiles(metricsDirectory, { maxFiles, maxBytes });
  const periodStart = now.getTime() - days * 86400000;
  const runsByIdentity = new Map();
  const conflictingIdentities = new Set();
  let invalidRecordCount = scanMetricFiles(selection, (record) => {
    const run = normalizeRun(record);
    if (!run || Date.parse(run.recordedAt) < periodStart || Date.parse(run.recordedAt) > now.getTime()) return;
    const serialized = JSON.stringify(run);
    const existing = runsByIdentity.get(run.identity);
    if (existing && existing.serialized !== serialized) {
      conflictingIdentities.add(run.identity);
      runsByIdentity.delete(run.identity);
      return;
    }
    if (!existing && !conflictingIdentities.has(run.identity)) runsByIdentity.set(run.identity, { run, serialized });
  });
  const selectedRuns = [...runsByIdentity.values()].map((entry) => entry.run)
    .sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt))
    .slice(0, limit);
  const selectedExecutionHashes = new Set(selectedRuns.filter((run) => run.kind === "execution").map((run) => run.fullHash));
  const routingFeedback = new Map();
  const directEditFeedback = new Map();
  scanMetricFiles(selection, (record) => {
    const routing = routingFeedbackSchema.safeParse(record);
    if (routing.success && selectedExecutionHashes.has(routing.data.executionIdHash)) {
      const existing = routingFeedback.get(routing.data.executionIdHash);
      if (!existing || Date.parse(existing.recordedAt) < Date.parse(routing.data.recordedAt)) routingFeedback.set(routing.data.executionIdHash, routing.data);
      return;
    }
    const directEdit = directEditFeedbackSchema.safeParse(record);
    if (directEdit.success && selectedExecutionHashes.has(directEdit.data.executionIdHash)) {
      const existing = directEditFeedback.get(directEdit.data.executionIdHash);
      if (!existing || Date.parse(existing.recordedAt) < Date.parse(directEdit.data.recordedAt)) directEditFeedback.set(directEdit.data.executionIdHash, directEdit.data);
    }
  }, false);
  const prefixes = uniquePrefixes(selectedRuns.map((run) => run.fullHash));
  return {
    scope: "structural_metadata_only",
    integrity: "best_effort_not_cryptographically_verified",
    truncated: selection.truncated,
    conflictCount: conflictingIdentities.size,
    invalidRecordCount,
    runCount: selectedRuns.length,
    runs: selectedRuns.map((run) => ({
      recordedAt: run.recordedAt,
      feedbackId: prefixes.get(run.fullHash),
      profile: run.profile,
      role: run.role,
      backend: run.backend,
      modelDisplay: modelDisplay(run, configuration),
      mode: run.mode,
      outcomeStatus: run.outcomeStatus,
      failureClass: run.failureClass,
      failureStage: run.failureStage,
      providerCode: run.providerCode,
      retryStopReason: run.retryStopReason,
      exitCode: run.exitCode,
      signal: run.signal,
      durationMs: run.durationMs,
      reportedCostUsd: run.reportedCostUsd,
      cacheHit: run.cacheHit,
      retries: run.retries,
      feedback: run.kind === "legacy" ? { routing: "not_applicable", directEdit: "not_applicable" } : {
        routing: routingFeedback.get(run.fullHash)?.outcome || "pending",
        directEdit: directEditFeedback.get(run.fullHash)?.outcome || "pending"
      }
    }))
  };
}

export function parseRecentRunsArguments(argumentsList) {
  const options = {};
  for (const argument of argumentsList) {
    const match = /^--(days|limit)=([0-9]+)$/.exec(argument);
    if (!match || match[1] in options) throw new Error("supported arguments are unique --days=N and --limit=N values");
    options[match[1]] = Number(match[2]);
  }
  return options;
}
