import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfiguration } from "../subagent-bridge/src/config.js";
import { evaluateMemoryRetrieval, validateMemoryEvaluationDataset } from "../subagent-bridge/src/memory-evaluation.js";
import { appendRedactedRunMetric } from "../subagent-bridge/src/metrics.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const rawDataset = JSON.parse(fs.readFileSync(path.join(projectRoot, "config", "memory-evaluation.json"), "utf8"));
const datasetValidation = validateMemoryEvaluationDataset(rawDataset);
if (!datasetValidation.success) {
  throw new Error(`Invalid memory evaluation dataset: ${datasetValidation.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
}
const dataset = datasetValidation.data;
const configuration = loadConfiguration();
const temporaryVault = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-memory-evaluation-"));

try {
  for (const document of dataset.documents) {
    const documentPath = path.join(temporaryVault, document.relativePath);
    fs.mkdirSync(path.dirname(documentPath), { recursive: true });
    const frontmatterLines = [
      "---",
      ...(document.created ? [`created: ${JSON.stringify(document.created)}`] : []),
      ...(document.updated ? [`updated: ${JSON.stringify(document.updated)}`] : []),
      ...(document.confidence ? [`confidence: ${JSON.stringify(document.confidence)}`] : []),
      ...(document.verification ? [`verification: ${JSON.stringify(document.verification)}`] : []),
      ...(document.reviewAfter ? [`review_after: ${JSON.stringify(document.reviewAfter)}`] : []),
      ...(document.validUntil ? [`valid_until: ${JSON.stringify(document.validUntil)}`] : []),
      ...(document.stage ? [`stage: ${JSON.stringify(document.stage)}`] : []),
      ...(document.memoryType ? [`memory_type: ${JSON.stringify(document.memoryType)}`] : []),
      ...(document.tags?.length ? ["tags:", ...document.tags.map((tag) => `  - ${JSON.stringify(tag)}`)] : []),
      "---",
      ""
    ];
    const frontmatter = frontmatterLines.length > 3 ? `${frontmatterLines.join("\n")}\n` : "";
    fs.writeFileSync(documentPath, `${frontmatter}${document.content}\n`, "utf8");
  }
  const evaluationConfiguration = {
    ...configuration,
    memory: {
      ...configuration.memory,
      vaultRootPath: temporaryVault,
      maxSearchResults: 20
    }
  };
  const report = evaluateMemoryRetrieval(evaluationConfiguration, dataset.cases, { fixedTime: "2026-08-11T00:00:00.000Z" });
  await appendRedactedRunMetric(configuration, {
    recordedAt: report.evaluatedAt,
    backend: "memory-evaluation",
    outcomeStatus: "completed",
    failureClass: null,
    usage: {
      durationMs: Math.round(report.averageLatencyMs * report.caseCount),
      totalCostUsd: 0
    },
    evaluation: {
      caseCount: report.caseCount,
      abstentionAccuracy: report.abstentionAccuracy,
      averageEstimatedContextTokens: report.averageEstimatedContextTokens,
      mrr: report.mrr,
      aggregateNdcg: report.aggregateNdcg,
      cutoffs: report.cutoffs
    },
    attempts: []
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  fs.rmSync(temporaryVault, { recursive: true, force: true });
}
