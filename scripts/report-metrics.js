import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfiguration } from "../subagent-bridge/src/config.js";
import { getCostBudgetSnapshot, pruneMetricFiles, summarizeMemoryHookFeedback } from "../subagent-bridge/src/metrics.js";
import { summarizeSlo } from "../subagent-bridge/src/services/slo-service.js";

function readMetricFile(metricsPath) {
  return fs.readFileSync(metricsPath, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

export function summarizeMetrics(records, sloPolicy) {
  const slo = summarizeSlo(records, sloPolicy);
  const healthRecords = records.filter((record) => record.recordType === "health_snapshot").sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt)).slice(-100);
  const liveObservationRecords = records.filter((record) => record.recordType === "live_observation").sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));
  const modelFitRecords = records.filter((record) => record.recordType === "model_fit_evaluation").sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));
  const directEditFeedback = new Map(records
    .filter((record) => record.recordType === "direct_edit_feedback" && record.executionIdHash)
    .map((record) => [record.executionIdHash, record.outcome]));
  const directEditDispositionByExecution = new Map(records
    .filter((record) => record.recordType === "direct_edit_disposition" && record.executionIdHash)
    .map((record) => [record.executionIdHash, record.disposition]));
  const routingFeedback = new Map(records
    .filter((record) => record.recordType === "routing_feedback" && record.executionIdHash)
    .map((record) => [record.executionIdHash, record.outcome]));
  const routingDisposition = new Map(records
    .filter((record) => record.recordType === "routing_disposition" && record.executionIdHash)
    .map((record) => [record.executionIdHash, record.disposition]));
  const legacyRoutingFeedback = records.filter((record) => record.recordType === "routing_feedback" && record.executionIdHash && !routingDisposition.has(record.executionIdHash)).length;
  const memoryHookRecords = records.filter((record) => ["memory_hook_session", "memory_hook_disposition", "memory_hook_feedback"].includes(record.recordType));
  records = records.filter((record) => !record.recordType);
  const editRecords = records.filter((record) => record.mode === "edit" && record.outcomeStatus === "completed" && record.executionIdHash);
  const summarizeDirectEditRuns = (runs) => {
    const outcomes = { accepted: 0, minor_fix: 0, reverted: 0, security_concern: 0 };
    const dispositionCounts = {};
    let eligibleEditRuns = 0;
    let conflictingLabeledRuns = 0;
    for (const record of runs) {
      const disposition = directEditDispositionByExecution.get(record.executionIdHash);
      if (disposition) dispositionCounts[disposition] = (dispositionCounts[disposition] || 0) + 1;
      const eligible = !disposition || disposition === "eligible_real_user";
      const outcome = directEditFeedback.get(record.executionIdHash);
      if (!eligible) {
        if (outcome in outcomes) conflictingLabeledRuns += 1;
        continue;
      }
      eligibleEditRuns += 1;
      if (outcome in outcomes) outcomes[outcome] += 1;
    }
    const labeledEditRuns = Object.values(outcomes).reduce((total, count) => total + count, 0);
    const interventionCount = outcomes.minor_fix + outcomes.reverted + outcomes.security_concern;
    return {
      totalEditRuns: runs.length,
      eligibleEditRuns,
      ineligibleEditRuns: runs.length - eligibleEditRuns,
      labeledEditRuns,
      conflictingLabeledRuns,
      pendingFeedback: eligibleEditRuns - labeledEditRuns,
      dispositionCounts,
      outcomes,
      interventionRate: labeledEditRuns > 0 ? Number((interventionCount / labeledEditRuns).toFixed(4)) : null,
      rollbackOrSecurityRate: labeledEditRuns > 0 ? Number(((outcomes.reverted + outcomes.security_concern) / labeledEditRuns).toFixed(4)) : null,
      decisionReady: labeledEditRuns >= 30
    };
  };
  const directEditByBackend = {};
  const directEditByProfile = {};
  for (const record of editRecords) {
    const backend = record.backend || "unknown";
    (directEditByBackend[backend] ||= []).push(record);
    if (record.profile) (directEditByProfile[record.profile] ||= []).push(record);
  }
  const directEditBaseline = {
    ...summarizeDirectEditRuns(editRecords),
    byBackend: Object.fromEntries(Object.entries(directEditByBackend).map(([backend, runs]) => [backend, summarizeDirectEditRuns(runs)])),
    byProfile: Object.fromEntries(Object.entries(directEditByProfile).map(([profile, runs]) => [profile, summarizeDirectEditRuns(runs)]))
  };
  const routingByProfile = {};
  for (const record of records.filter((entry) => entry.profile && entry.executionIdHash && entry.mode === "read_only" && entry.outcomeStatus === "completed" && routingDisposition.get(entry.executionIdHash) === "eligible_real_user")) {
    const aggregate = routingByProfile[record.profile] ||= { runs: 0, labeledRuns: 0, useful: 0, partial: 0, notUseful: 0, totalDurationMs: 0, totalCostUsd: 0, knownCostRuns: 0, unknownCostRuns: 0 };
    aggregate.runs += 1;
    aggregate.totalDurationMs += record.usage?.durationMs || 0;
    if (Number.isFinite(record.usage?.totalCostUsd)) {
      aggregate.totalCostUsd += record.usage.totalCostUsd;
      aggregate.knownCostRuns += 1;
    } else {
      aggregate.unknownCostRuns += 1;
    }
    const outcome = routingFeedback.get(record.executionIdHash);
    if (outcome === "useful") aggregate.useful += 1;
    if (outcome === "partial") aggregate.partial += 1;
    if (outcome === "not_useful") aggregate.notUseful += 1;
    if (outcome) aggregate.labeledRuns += 1;
  }
  for (const aggregate of Object.values(routingByProfile)) {
    aggregate.pendingFeedback = aggregate.runs - aggregate.labeledRuns;
    aggregate.usefulRate = aggregate.labeledRuns > 0 ? Number((aggregate.useful / aggregate.labeledRuns).toFixed(4)) : null;
    aggregate.averageDurationMs = aggregate.runs > 0 ? Math.round(aggregate.totalDurationMs / aggregate.runs) : 0;
    aggregate.totalCostUsd = Number(aggregate.totalCostUsd.toFixed(6));
    aggregate.costMeasurement = {
      measurementStatus: (aggregate.knownCostRuns + aggregate.unknownCostRuns) === 0 ? "no_data" : (aggregate.unknownCostRuns > 0 ? "not_observable" : "observed"),
      observedCostUsd: aggregate.totalCostUsd,
      knownCostRuns: aggregate.knownCostRuns,
      unknownCostRuns: aggregate.unknownCostRuns,
      costCoverageRatio: (aggregate.knownCostRuns + aggregate.unknownCostRuns) === 0 ? 1 : Number((aggregate.knownCostRuns / (aggregate.knownCostRuns + aggregate.unknownCostRuns)).toFixed(4))
    };
    delete aggregate.knownCostRuns;
    delete aggregate.unknownCostRuns;
    aggregate.decisionReady = aggregate.labeledRuns >= 15;
    delete aggregate.totalDurationMs;
  }
  const durations = records.map((record) => record.usage?.durationMs).filter(Number.isFinite).sort((left, right) => left - right);
  const percentile = (fraction) => durations.length === 0 ? 0 : durations[Math.min(durations.length - 1, Math.ceil(durations.length * fraction) - 1)];
  const byBackend = {};
  for (const record of records) {
    const backend = record.backend || "unknown";
    const aggregate = byBackend[backend] ||= { runs: 0, completed: 0, failed: 0, totalDurationMs: 0, cacheHits: 0, retries: 0 };
    aggregate.runs += 1;
    aggregate[record.outcomeStatus === "completed" ? "completed" : "failed"] += 1;
    aggregate.totalDurationMs += record.usage?.durationMs || 0;
    aggregate.cacheHits += record.cacheHit === true ? 1 : 0;
    aggregate.retries += record.retries ?? Math.max(0, (record.attempts?.length ?? 1) - 1);
  }
  for (const aggregate of Object.values(byBackend)) {
    aggregate.averageDurationMs = aggregate.runs > 0 ? Math.round(aggregate.totalDurationMs / aggregate.runs) : 0;
    delete aggregate.totalDurationMs;
  }
  const summary = records.reduce((aggregate, record) => {
    aggregate.runCount += 1;
    aggregate.totalDurationMs += record.usage?.durationMs || 0;
    if (Number.isFinite(record.usage?.totalCostUsd)) {
      aggregate.totalCostUsd += record.usage.totalCostUsd;
      aggregate.knownCostRuns += 1;
    } else {
      aggregate.unknownCostRuns += 1;
    }
    aggregate.totalAttempts += record.attempts?.length ?? 1;
    aggregate.outcomes[record.outcomeStatus] = (aggregate.outcomes[record.outcomeStatus] || 0) + 1;
    if (record.failureClass) {
      aggregate.failureClasses[record.failureClass] = (aggregate.failureClasses[record.failureClass] || 0) + 1;
    }
    return aggregate;
  }, {
  runCount: 0,
  totalDurationMs: 0,
  totalCostUsd: 0,
  knownCostRuns: 0,
  unknownCostRuns: 0,
  totalAttempts: 0,
  outcomes: {},
  failureClasses: {}
  });
  const healthByAdapter = {};
  for (const record of healthRecords) {
    for (const [adapterId, health] of Object.entries(record.adapters || {})) {
      const aggregate = healthByAdapter[adapterId] ||= { observations: 0, available: 0, lastObservedAt: null, lastStatus: "unavailable" };
      const available = health.installed === true && health.authValid !== false && !health.error;
      aggregate.observations += 1;
      aggregate.available += available ? 1 : 0;
      aggregate.lastObservedAt = record.recordedAt;
      aggregate.lastStatus = available ? "available" : "unavailable";
    }
  }
  for (const aggregate of Object.values(healthByAdapter)) {
    aggregate.availabilityRate = aggregate.observations > 0 ? Number((aggregate.available / aggregate.observations).toFixed(4)) : 0;
  }
  const liveObservations = {};
  for (const record of liveObservationRecords) {
    const model = record.model || "unknown";
    const aggregate = liveObservations[model] ||= {
      observationCount: 0,
      lastObservedAt: null,
      modelAccess: "not_probed",
      toolFreeResponse: "not_probed",
      workspaceRead: "not_probed",
      webRead: "not_probed",
      failureClass: null
    };
    aggregate.observationCount += 1;
    aggregate.lastObservedAt = record.recordedAt;
    for (const capability of ["modelAccess", "toolFreeResponse", "workspaceRead", "webRead"]) {
      if (record.capabilities && typeof record.capabilities[capability] === "string") aggregate[capability] = record.capabilities[capability];
    }
    aggregate.failureClass = record.failureClass ?? null;
  }
  const modelFitByTaskClass = {};
  for (const record of modelFitRecords) {
    const taskClass = record.taskClass || "unknown_task_class";
    const aggregate = modelFitByTaskClass[taskClass] ||= { observationCount: 0, candidates: {} };
    aggregate.observationCount += 1;
    const candidate = aggregate.candidates[record.modelHash] ||= { observationCount: 0, lastObservedAt: null, evidenceType: "synthetic_fixture", promotionEligible: false, coverageComplete: false, thresholdsPassed: 0, lastRepetitionCount: 0 };
    candidate.observationCount += 1;
    candidate.lastObservedAt = record.recordedAt;
    candidate.evidenceType = record.evidenceType === "live_observation" ? "live_observation" : candidate.evidenceType;
    candidate.promotionEligible = record.promotionEligible === true;
    candidate.coverageComplete = record.coverageComplete === true;
    candidate.thresholdsPassed += record.thresholdsPassed === true ? 1 : 0;
    candidate.lastRepetitionCount = record.repetitionCount;
  }
  const routingEvaluation = { byProfile: routingByProfile };
  if (legacyRoutingFeedback > 0) routingEvaluation.legacyLabeledRuns = legacyRoutingFeedback;
  return {
    runCount: summary.runCount,
    averageDurationMs: summary.runCount > 0 ? Math.round(summary.totalDurationMs / summary.runCount) : 0,
    p50DurationMs: percentile(0.5),
    p95DurationMs: percentile(0.95),
    totalCostUsd: Number(summary.totalCostUsd.toFixed(6)),
    costMeasurement: {
      measurementStatus: (summary.knownCostRuns + summary.unknownCostRuns) === 0 ? "no_data" : (summary.unknownCostRuns > 0 ? "not_observable" : "observed"),
      observedCostUsd: Number(summary.totalCostUsd.toFixed(6)),
      knownCostRuns: summary.knownCostRuns,
      unknownCostRuns: summary.unknownCostRuns,
      costCoverageRatio: (summary.knownCostRuns + summary.unknownCostRuns) === 0 ? 1 : Number((summary.knownCostRuns / (summary.knownCostRuns + summary.unknownCostRuns)).toFixed(4))
    },
    averageAttempts: summary.runCount > 0 ? Number((summary.totalAttempts / summary.runCount).toFixed(2)) : 0,
    outcomes: summary.outcomes,
    failureClasses: summary.failureClasses,
    byBackend,
    health: {
      observationCount: healthRecords.length,
      byAdapter: healthByAdapter
    },
    liveObservations,
    modelFitEvaluation: {
      observationCount: modelFitRecords.length,
      byTaskClass: modelFitByTaskClass
    },
    directEditBaseline,
    routingEvaluation,
    memoryHookPilot: summarizeMemoryHookFeedback(memoryHookRecords),
    slo
  };
}

export function readMetricsDirectory(directory) {
  return fs.existsSync(directory)
    ? fs.readdirSync(directory)
      .filter((entry) => /-runs(?:-[^.]+)?\.jsonl$/i.test(entry))
      .flatMap((entry) => readMetricFile(path.join(directory, entry)))
    : [];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configuration = loadConfiguration();
  const metricsDirectory = path.join(configuration.statePaths.logs, "metrics");
  const budget = await getCostBudgetSnapshot(configuration);
  if (process.argv.includes("--budget-only")) {
    console.log(JSON.stringify(budget, null, 2));
    process.exit(0);
  }
  const prunedFiles = process.argv.includes("--prune") ? pruneMetricFiles(configuration) : 0;
  const records = readMetricsDirectory(metricsDirectory);
  console.log(JSON.stringify({ ...summarizeMetrics(records, configuration.orchestration?.slo), budget, metricsDirectory, prunedFiles }, null, 2));
}
