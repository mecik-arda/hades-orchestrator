import { z } from "zod";

const taskClassSchema = z.enum(["candidate_generation", "sourced_analysis", "strict_schema", "controlled_edit_readiness", "critical_review"]);
const candidateSchema = z.enum(["gemini_flash", "deepseek_pro", "luna", "terra", "sol"]);
const failureClassSchema = z.enum(["none", "schema_failure", "source_mismatch", "timeout", "permission_denied", "rate_limited", "process_error"]);

const taskCandidatePolicy = {
  candidate_generation: ["gemini_flash"],
  sourced_analysis: ["deepseek_pro"],
  strict_schema: ["deepseek_pro"],
  controlled_edit_readiness: ["luna", "terra"],
  critical_review: ["sol"]
};

const liveTaskCandidatePolicy = {
  candidate_generation: ["gemini_flash"],
  sourced_analysis: ["deepseek_pro"],
  strict_schema: ["deepseek_pro"],
  controlled_edit_readiness: ["deepseek_pro", "luna", "terra"],
  critical_review: ["sol"]
};

const liveCandidateTargets = {
  gemini_flash: "gemini_flash",
  deepseek_pro: "opencode",
  luna: "codex",
  terra: "codex",
  sol: "codex"
};

export const liveCandidateRuntimeModels = {
  gemini_flash: "gemini_flash",
  deepseek_pro: "deepseek/deepseek-v4-pro",
  luna: "gpt-5.6-luna",
  terra: "gpt-5.6-terra",
  sol: "gpt-5.6-sol"
};

export const liveCandidateModels = {
  gemini_flash: "gemini-3.8-flash-high",
  deepseek_pro: "deepseek/deepseek-v4-pro",
  luna: "gpt-5.6-luna",
  terra: "gpt-5.6-terra",
  sol: "gpt-5.6-sol"
};

const modelFitRunSchema = z.object({
  repetition: z.number().int().positive(),
  schemaPass: z.boolean(),
  sourceAccuracy: z.number().finite().min(0).max(1),
  failureClass: failureClassSchema,
  failureClassificationCorrect: z.boolean(),
  editReady: z.boolean().optional(),
  durationMs: z.number().finite().nonnegative(),
  costUsd: z.number().finite().nonnegative().nullable(),
  costObservation: z.enum(["observed", "partial", "not_observable"]).optional()
}).strict();

const modelFitTaskSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
  taskClass: taskClassSchema,
  candidate: candidateSchema,
  repetitions: z.array(modelFitRunSchema).min(1)
}).strict();

const modelFitThresholdsSchema = z.object({
  schemaPassRate: z.number().finite().min(0).max(1),
  sourceAccuracy: z.number().finite().min(0).max(1),
  failureClassificationAccuracy: z.number().finite().min(0).max(1),
  maxP95DurationMs: z.number().finite().nonnegative(),
  maxAverageCostUsd: z.number().finite().nonnegative(),
  editReadinessRate: z.number().finite().min(0).max(1)
}).strict();

const modelFitDatasetSchema = z.object({
  schemaVersion: z.literal(1),
  fixtureVersion: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  minimumRepetitions: z.number().int().min(3).max(100),
  thresholds: modelFitThresholdsSchema,
  tasks: z.array(modelFitTaskSchema).min(1)
}).strict().superRefine((dataset, context) => {
  const taskIds = new Set();
  const groups = new Set();
  for (const [taskIndex, task] of dataset.tasks.entries()) {
    if (taskIds.has(task.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", taskIndex, "id"], message: "duplicate task id" });
    taskIds.add(task.id);
    if (!taskCandidatePolicy[task.taskClass].includes(task.candidate)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", taskIndex, "candidate"], message: "candidate is not allowed for task class" });
    }
    const group = `${task.taskClass}:${task.candidate}`;
    if (groups.has(group)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", taskIndex], message: "duplicate task class and candidate group" });
    groups.add(group);
    if (task.repetitions.length < dataset.minimumRepetitions) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", taskIndex, "repetitions"], message: "minimum repetitions not met" });
    }
    if (new Set(task.repetitions.map((run) => run.repetition)).size !== task.repetitions.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", taskIndex, "repetitions"], message: "repetition ids must be unique" });
    }
    if (task.taskClass === "controlled_edit_readiness") {
      for (const [runIndex, run] of task.repetitions.entries()) {
        if (typeof run.editReady !== "boolean") context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", taskIndex, "repetitions", runIndex, "editReady"], message: "edit readiness is required" });
      }
    } else if (task.repetitions.some((run) => Object.hasOwn(run, "editReady"))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", taskIndex, "repetitions"], message: "edit readiness is only valid for controlled edit tasks" });
    }
  }
  for (const taskClass of Object.keys(taskCandidatePolicy)) {
    if (!dataset.tasks.some((task) => task.taskClass === taskClass)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks"], message: `missing task class: ${taskClass}` });
    for (const candidate of taskCandidatePolicy[taskClass]) {
      if (!dataset.tasks.some((task) => task.taskClass === taskClass && task.candidate === candidate)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks"], message: `missing candidate group: ${taskClass}:${candidate}` });
    }
  }
});

function round(value) {
  return Number(value.toFixed(4));
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] || 0;
}

function evaluateGroup(taskClass, candidate, runs, thresholds) {
  const schemaPassRate = runs.filter((run) => run.schemaPass).length / runs.length;
  const sourceAccuracy = runs.reduce((total, run) => total + run.sourceAccuracy, 0) / runs.length;
  const failureClassificationAccuracy = runs.filter((run) => run.failureClassificationCorrect).length / runs.length;
  const averageDurationMs = runs.reduce((total, run) => total + run.durationMs, 0) / runs.length;
  const p95DurationMs = percentile(runs.map((run) => run.durationMs), 0.95);
  const observedCosts = runs.map((run) => run.costUsd).filter(Number.isFinite);
  const declaredPartial = runs.some((run) => run.costObservation === "partial");
  const costObservation = declaredPartial
    ? "partial"
    : observedCosts.length === runs.length
      ? "observed"
      : observedCosts.length === 0
        ? "not_observable"
        : "partial";
  const averageCostUsd = observedCosts.length > 0 ? observedCosts.reduce((total, cost) => total + cost, 0) / observedCosts.length : null;
  const editReadinessRate = taskClass === "controlled_edit_readiness"
    ? runs.filter((run) => run.editReady).length / runs.length
    : null;
  const checks = {
    schemaPassRate: schemaPassRate >= thresholds.schemaPassRate,
    sourceAccuracy: sourceAccuracy >= thresholds.sourceAccuracy,
    failureClassificationAccuracy: failureClassificationAccuracy >= thresholds.failureClassificationAccuracy,
    p95DurationMs: p95DurationMs <= thresholds.maxP95DurationMs,
    averageCostUsd: costObservation === "observed" ? averageCostUsd <= thresholds.maxAverageCostUsd : null,
    editReadinessRate: editReadinessRate === null || editReadinessRate >= thresholds.editReadinessRate
  };
  return {
    taskClass,
    candidate,
    repetitionCount: runs.length,
    schemaPassRate: round(schemaPassRate),
    sourceAccuracy: round(sourceAccuracy),
    failureClassificationAccuracy: round(failureClassificationAccuracy),
    editReadinessRate: editReadinessRate === null ? null : round(editReadinessRate),
    averageDurationMs: Math.round(averageDurationMs),
    p95DurationMs: Math.round(p95DurationMs),
    averageCostUsd: averageCostUsd === null ? null : round(averageCostUsd),
    costObservation,
    checks,
    thresholdsPassed: Object.values(checks).every((value) => value !== false)
  };
}

export function validateModelFitEvaluationDataset(value) {
  return modelFitDatasetSchema.safeParse(value);
}

function matchesJsonContract(output, expected) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const requiredKeys = expected.jsonKeys || [];
  if (!requiredKeys.every((key) => Object.hasOwn(parsed, key))) return false;
  const shape = expected.jsonShape || {};
  const shapeMatches = Object.entries(shape).every(([key, type]) => {
    const value = parsed[key];
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  });
  if (!shapeMatches) return false;
  const exact = expected.jsonExact || {};
  if (!Object.entries(exact).every(([key, value]) => Object.is(parsed[key], value))) return false;
  if (expected.allowExtraKeys !== true) {
    const allowedKeys = new Set([...requiredKeys, ...Object.keys(exact)]);
    if (!Object.keys(parsed).every((key) => allowedKeys.has(key))) return false;
  }
  return true;
}

function normalizeLiveFailureClass(value) {
  return failureClassSchema.safeParse(value).success ? value : "process_error";
}

const liveTaskSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
  taskClass: taskClassSchema,
  candidate: candidateSchema,
  target: z.string().min(1).max(64),
  model: z.string().min(1).max(120).optional(),
  profile: z.string().min(1).max(64).optional(),
  prompt: z.string().min(1).max(20000),
  expected: z.object({
    json: z.boolean().optional(),
    jsonKeys: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
    jsonShape: z.record(z.enum(["string", "number", "boolean", "array", "object", "null"])).optional(),
    jsonExact: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    allowExtraKeys: z.boolean().optional(),
    sourceMarker: z.string().min(1).max(200).optional(),
    failureClass: failureClassSchema.optional()
  }).strict().optional(),
  edit: z.object({
    files: z.array(z.string().min(1).max(500)).min(1).max(100),
    contextFiles: z.array(z.string().min(1).max(500)).max(100).default([]),
    acceptanceCriteria: z.array(z.string().min(1).max(4000)).min(1).max(50)
  }).strict().optional()
}).strict();

export const liveModelFitDatasetSchema = z.object({
  schemaVersion: z.literal(1),
  fixtureVersion: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  minimumRepetitions: z.number().int().min(3).max(100),
  thresholds: modelFitThresholdsSchema,
  tasks: z.array(liveTaskSchema).min(1)
}).strict().superRefine((dataset, context) => {
  for (const [index, task] of dataset.tasks.entries()) {
    if (!liveTaskCandidatePolicy[task.taskClass].includes(task.candidate)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "candidate"], message: "candidate is not allowed for live task class" });
    }
    if (liveCandidateTargets[task.candidate] !== task.target) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "target"], message: "candidate target binding does not match" });
    }
    const exactModel = liveCandidateRuntimeModels[task.candidate];
    if (task.model === undefined || task.model !== exactModel) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "model"], message: "candidate model binding does not match" });
    }
    if (task.taskClass === "candidate_generation" && !(task.expected?.jsonKeys || []).includes("candidates")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "expected", "jsonKeys"], message: "candidate generation requires a candidates key" });
    }
    if (task.taskClass === "sourced_analysis" && task.expected?.sourceMarker === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "expected", "sourceMarker"], message: "sourced analysis requires a source marker" });
    }
    if (task.taskClass === "strict_schema") {
      const jsonKeys = task.expected?.jsonKeys || [];
      const jsonShape = task.expected?.jsonShape || {};
      if (task.expected?.json !== true || jsonKeys.length === 0) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "expected", "jsonKeys"], message: "strict schema requires expected json keys" });
      } else if (!jsonKeys.every((key) => Object.hasOwn(jsonShape, key))) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "expected", "jsonShape"], message: "strict schema requires a shape for every json key" });
      }
    }
    if (task.taskClass === "controlled_edit_readiness" && task.edit === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "edit"], message: "controlled edit readiness requires an edit contract" });
    }
    if (task.taskClass === "controlled_edit_readiness" && task.candidate === "deepseek_pro" && task.profile !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "profile"], message: "deepseek edit readiness does not use a profile" });
    }
    if (task.taskClass === "controlled_edit_readiness" && (task.candidate === "luna" || task.candidate === "terra") && task.profile === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "profile"], message: "codex edit readiness requires a profile" });
    }
    if (task.taskClass !== "controlled_edit_readiness" && task.profile !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "profile"], message: "profile is only valid for controlled edit tasks" });
    }
    if (task.taskClass !== "controlled_edit_readiness" && task.edit !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "edit"], message: "edit contract is only valid for controlled edit tasks" });
    }
  }
});

export function validateLiveModelFitDataset(value) {
  return liveModelFitDatasetSchema.safeParse(value);
}

export async function runLiveModelFitEvaluation({ dataset, executeTask, evaluatedAt } = {}) {
  const parsed = liveModelFitDatasetSchema.parse(dataset);
  if (typeof executeTask !== "function") throw new Error("live model fit evaluation requires an executeTask function");
  const tasks = [];
  const resolvedModelsByGroup = new Map();
  for (const task of parsed.tasks) {
    const repetitions = [];
    const groupKey = `${task.taskClass}:${task.candidate}`;
    for (let repetition = 1; repetition <= parsed.minimumRepetitions; repetition += 1) {
      const execution = await executeTask({ task, repetition });
      const output = typeof execution?.output === "string" ? execution.output : "";
      const resolvedModel = typeof execution?.resolvedModel === "string" ? execution.resolvedModel : null;
      const modelVerified = resolvedModel === liveCandidateModels[task.candidate];
      const observedModels = resolvedModelsByGroup.get(groupKey) || new Set();
      observedModels.add(resolvedModel);
      resolvedModelsByGroup.set(groupKey, observedModels);
      const rawFailureClass = execution?.failureClass === undefined ? "none" : normalizeLiveFailureClass(execution.failureClass);
      const failureClass = modelVerified ? rawFailureClass : "process_error";
      const expected = task.expected || {};
      const editTask = task.taskClass === "controlled_edit_readiness";
      const contentPass = expected.json === true ? matchesJsonContract(output, expected) : output.trim().length > 0;
      const schemaPass = editTask ? modelVerified && execution?.editReady === true : modelVerified && contentPass;
      const sourceAccuracy = expected.sourceMarker === undefined ? 1 : (output.includes(expected.sourceMarker) ? 1 : 0);
      const runCostUsd = Number.isFinite(execution?.costUsd) && execution.costUsd >= 0 ? execution.costUsd : null;
      const run = {
        repetition,
        schemaPass,
        sourceAccuracy,
        failureClass,
        failureClassificationCorrect: modelVerified && (expected.failureClass === undefined ? true : expected.failureClass === failureClass),
        durationMs: Number.isFinite(execution?.durationMs) && execution.durationMs >= 0 ? execution.durationMs : 0,
        costUsd: runCostUsd,
        costObservation: runCostUsd === null ? "not_observable" : (execution?.costObservation === "partial" ? "partial" : "observed")
      };
      if (editTask) run.editReady = modelVerified && execution?.editReady === true;
      repetitions.push(run);
    }
    tasks.push({ id: task.id, taskClass: task.taskClass, candidate: task.candidate, repetitions });
  }
  const report = summarizeModelFitDataset({ ...parsed, tasks }, { evaluatedAt });
  const requiredGroups = Object.entries(liveTaskCandidatePolicy)
    .flatMap(([taskClass, candidates]) => candidates.map((candidate) => `${taskClass}:${candidate}`));
  const observedGroups = new Set(parsed.tasks.map((task) => `${task.taskClass}:${task.candidate}`));
  const coverageComplete = requiredGroups.every((group) => observedGroups.has(group));
  const candidates = report.candidates.map((candidate) => {
    const observed = resolvedModelsByGroup.get(`${candidate.taskClass}:${candidate.candidate}`);
    const observedSingle = observed && observed.size === 1 ? [...observed][0] : null;
    const boundModel = observedSingle === liveCandidateModels[candidate.candidate] ? observedSingle : null;
    return { ...candidate, boundModel, identityAssurance: boundModel === null ? "unresolved" : "configured" };
  });
  const modelsBound = candidates.every((candidate) => candidate.boundModel !== null);
  return {
    ...report,
    coverageComplete,
    modelsBound,
    evidenceType: "live_observation",
    promotionEligible: coverageComplete && modelsBound && report.decisionReady && report.runCount >= parsed.minimumRepetitions * parsed.tasks.length,
    candidates
  };
}

function summarizeModelFitDataset(dataset, options = {}) {
  const groups = new Map();
  for (const task of dataset.tasks) {
    const key = `${task.taskClass}:${task.candidate}`;
    const group = groups.get(key) || { taskClass: task.taskClass, candidate: task.candidate, runs: [] };
    group.runs.push(...task.repetitions);
    groups.set(key, group);
  }
  const candidates = [...groups.values()]
    .map((group) => evaluateGroup(group.taskClass, group.candidate, group.runs, dataset.thresholds))
    .sort((left, right) => `${left.taskClass}:${left.candidate}`.localeCompare(`${right.taskClass}:${right.candidate}`));
  const failures = [];
  for (const task of dataset.tasks) {
    for (const run of task.repetitions) {
      if (!run.schemaPass) failures.push({ taskId: task.id, candidate: task.candidate, repetition: run.repetition, reason: "schema_failure" });
      if (!run.failureClassificationCorrect) failures.push({ taskId: task.id, candidate: task.candidate, repetition: run.repetition, reason: "failure_classification_mismatch" });
    }
  }
  return {
    evaluatedAt: options.evaluatedAt || new Date().toISOString(),
    schemaVersion: dataset.schemaVersion,
    fixtureVersion: dataset.fixtureVersion,
    minimumRepetitions: dataset.minimumRepetitions,
    thresholds: dataset.thresholds,
    taskCount: dataset.tasks.length,
    runCount: dataset.tasks.reduce((total, task) => total + task.repetitions.length, 0),
    candidateCount: candidates.length,
    evidenceType: "synthetic_fixture",
    decisionReady: candidates.every((candidate) => candidate.thresholdsPassed),
    promotionEligible: false,
    candidates,
    failures
  };
}

export function evaluateModelFit(value, options = {}) {
  const dataset = modelFitDatasetSchema.parse(value);
  return summarizeModelFitDataset(dataset, options);
}
