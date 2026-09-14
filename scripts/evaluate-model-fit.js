import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeConfiguration } from "../subagent-bridge/src/config.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";
import { evaluateModelFit, liveCandidateModels, runLiveModelFitEvaluation, validateLiveModelFitDataset, validateModelFitEvaluationDataset } from "../subagent-bridge/src/model-fit-evaluation.js";
import { appendRedactedRunMetric } from "../subagent-bridge/src/metrics.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const configuration = loadRuntimeConfiguration();

function classifyLiveFailure(result) {
  const reason = typeof result?.reason === "string" ? result.reason : (typeof result?.failureClass === "string" ? result.failureClass : "");
  if (reason === "schema_invalid" || reason === "output_parse_invalid") return "schema_failure";
  if (["timeout", "permission_denied", "rate_limited"].includes(reason)) return reason;
  return "process_error";
}

async function writeModelFitMetrics(report) {
  for (const candidate of report.candidates) {
    await appendRedactedRunMetric(configuration, {
      recordType: "model_fit_evaluation",
      recordedAt: report.evaluatedAt,
      backend: "model-fit-evaluation",
      evidenceType: report.evidenceType,
      promotionEligible: report.promotionEligible,
      coverageComplete: report.coverageComplete === true,
      identityAssurance: candidate.identityAssurance === "configured" ? "configured" : "unresolved",
      fixtureVersion: report.fixtureVersion,
      taskClass: candidate.taskClass,
      modelHash: hash(candidate.boundModel || candidate.candidate),
      repetitionCount: candidate.repetitionCount,
      schemaPassRate: candidate.schemaPassRate,
      sourceAccuracy: candidate.sourceAccuracy,
      failureClassificationAccuracy: candidate.failureClassificationAccuracy,
      editReadinessRate: candidate.editReadinessRate,
      averageDurationMs: candidate.averageDurationMs,
      p95DurationMs: candidate.p95DurationMs,
      averageCostUsd: candidate.averageCostUsd,
      thresholdsPassed: candidate.thresholdsPassed
    });
  }
}

const liveIndex = process.argv.indexOf("--live");
if (liveIndex >= 0) {
  const datasetPath = process.argv[liveIndex + 1];
  if (!datasetPath) throw new Error("--live requires a dataset path");
  const dataset = JSON.parse(fs.readFileSync(path.resolve(projectRoot, datasetPath), "utf8"));
  const validation = validateLiveModelFitDataset(dataset);
  if (!validation.success) throw new Error(`Invalid live model fit evaluation dataset: ${validation.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const runtime = createBridgeRuntime({ configuration });
  const runCodexEditPilot = async (task, pilotInput) => {
    const profile = configuration.orchestration?.taskProfiles?.[task.profile];
    const profileBound = profile && profile.target === task.target && profile.mode === "edit" && profile.model === task.model;
    if (!profileBound) {
      return { status: "failed", resolvedModel: null, failureClass: "process_error", filesChanged: [], cleanupCompleted: true, applied: false, preview: true };
    }
    return runtime.runProfileEditPilot({ ...pilotInput, profile: task.profile, model: task.model, role: "implementer", mode: "edit" }, projectRoot);
  };
  const executeTask = async ({ task }) => {
    if (task.taskClass === "controlled_edit_readiness") {
      const startedAt = Date.now();
      const pilotInput = {
        taskId: `model-fit-live-${task.id}`,
        objective: task.prompt,
        files: task.edit.files,
        contextFiles: task.edit.contextFiles,
        acceptanceCriteria: task.edit.acceptanceCriteria
      };
      const result = task.candidate === "deepseek_pro"
        ? await runtime.runDeepSeekEditPilot({ ...pilotInput, model: task.candidate }, projectRoot)
        : await runCodexEditPilot(task, pilotInput);
      const modelBound = result.resolvedModel === liveCandidateModels[task.candidate];
      const editCostUsd = Number.isFinite(result.metrics?.totalCostUsd) && result.metrics.totalCostUsd >= 0 ? result.metrics.totalCostUsd : null;
      return {
        output: "",
        resolvedModel: typeof result.resolvedModel === "string" ? result.resolvedModel : null,
        failureClass: result.status === "completed" ? (modelBound ? "none" : "process_error") : classifyLiveFailure(result),
        durationMs: Date.now() - startedAt,
        costUsd: editCostUsd,
        costObservation: editCostUsd === null ? "not_observable" : "observed",
        editReady: modelBound && result.status === "completed" && result.cleanupCompleted === true && Array.isArray(result.filesChanged) && result.filesChanged.length > 0
      };
    }
    const result = await runtime.run({
      target: task.target,
      model: task.model,
      prompt: task.prompt,
      mode: "read_only",
      trustedWorkspace: projectRoot,
      caller: "model_fit_live",
      delegationDepth: 0
    });
    const modelBound = result.resolvedModel === liveCandidateModels[task.candidate];
    const readCostUsd = Number.isFinite(result.metrics?.totalCostUsd) && result.metrics.totalCostUsd >= 0 ? result.metrics.totalCostUsd : null;
    return {
      output: modelBound && typeof result.result === "string" ? result.result : "",
      resolvedModel: typeof result.resolvedModel === "string" ? result.resolvedModel : null,
      failureClass: result.ok ? (modelBound ? "none" : "process_error") : classifyLiveFailure(result),
      durationMs: result.durationMs,
      costUsd: readCostUsd,
      costObservation: readCostUsd === null ? "not_observable" : "observed",
      editReady: modelBound && result.ok === true
    };
  };
  const report = await runLiveModelFitEvaluation({ dataset, executeTask });
  await writeModelFitMetrics(report);
  console.log(JSON.stringify(report, null, 2));
} else {
  const dataset = JSON.parse(fs.readFileSync(path.join(projectRoot, "config", "model-fit-evaluation.json"), "utf8"));
  const validation = validateModelFitEvaluationDataset(dataset);
  if (!validation.success) throw new Error(`Invalid model fit evaluation dataset: ${validation.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const report = evaluateModelFit(dataset);
  await writeModelFitMetrics(report);
  console.log(JSON.stringify(report, null, 2));
}
