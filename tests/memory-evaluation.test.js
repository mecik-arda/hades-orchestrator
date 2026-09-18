import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateMemoryRetrieval, validateMemoryEvaluationDataset } from "../subagent-bridge/src/memory-evaluation.js";

test("hafıza retrieval değerlendirmesi precision recall abstention ve bütçe ölçer", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-memory-eval-test-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(vaultRootPath, "Karar.md"), "Gemini yalnız Antigravity üzerinden çalışır.\n", "utf8");
  const configuration = {
    memory: {
      enabled: true,
      vaultRootPath,
      ignoredDirectories: [],
      maxIndexedFiles: 100,
      maxSearchResults: 10,
      maxSearchFileBytes: 131072,
      maxExcerptCharacters: 300
    }
  };
  const report = evaluateMemoryRetrieval(configuration, [
    { id: "routing", category: "single-hop", query: "Gemini Antigravity", qrels: { "Karar.md": 3 } },
    { id: "abstain", category: "negative-query", query: "eşleşmeyen benzersiz sorgu", qrels: {} }
  ], { cutoffs: [1, 3] });
  assert.equal(report.cutoffs[1].precision, 1);
  assert.equal(report.cutoffs[1].recall, 1);
  assert.equal(report.cutoffs[3].precision, 0.3333);
  assert.equal(report.cutoffs[3].ndcg, 1);
  assert.equal(report.mrr, 1);
  assert.equal(report.strategy, "keyword");
  assert.equal(report.abstentionAccuracy, 1);
  assert.equal(report.averageEstimatedContextTokens > 0, true);
});

test("hafıza retrieval evaluator özel stratejiyi aynı qrels ile çalıştırır", () => {
  let observedLimit = null;
  const report = evaluateMemoryRetrieval({}, [{
    id: "strategy",
    category: "single-hop",
    query: "özel strateji",
    qrels: { "Beklenen.md": 3 }
  }], {
    cutoffs: [1],
    strategy: "test-retriever",
    retriever: (_configuration, _query, limit) => {
      observedLimit = limit;
      return { matches: [{ relativePath: "Beklenen.md", excerpt: "eşleşme" }] };
    }
  });
  assert.equal(observedLimit, 1);
  assert.equal(report.strategy, "test-retriever");
  assert.equal(report.aggregateNdcg, 1);
});

test("Faz 1A: 25 vaka kategori dağılımı, şema doğrulaması ve başarı eşikleri karşılanır", (context) => {
  const rawDataset = JSON.parse(fs.readFileSync(path.resolve("config/memory-evaluation.json"), "utf8"));
  const validation = validateMemoryEvaluationDataset(rawDataset);
  assert.equal(validation.success, true);
  const dataset = validation.data;
  assert.equal(dataset.cases.length, 25);
  const categoryCounts = {};
  for (const evaluationCase of dataset.cases) categoryCounts[evaluationCase.category] = (categoryCounts[evaluationCase.category] || 0) + 1;
  assert.deepEqual(categoryCounts, {
    "single-hop": 5,
    "temporal-ordering": 4,
    "knowledge-update": 4,
    "contradiction": 3,
    "partial-match": 3,
    "negative-query": 3,
    "related-note": 3
  });
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-memory-eval-dataset-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  for (const document of dataset.documents) {
    const documentPath = path.join(vaultRootPath, document.relativePath);
    fs.mkdirSync(path.dirname(documentPath), { recursive: true });
    const frontmatterLines = ["---"];
    for (const [field, value] of [["created", document.created], ["updated", document.updated], ["confidence", document.confidence], ["verification", document.verification], ["review_after", document.reviewAfter], ["valid_until", document.validUntil], ["stage", document.stage], ["memory_type", document.memoryType]]) {
      if (value) frontmatterLines.push(`${field}: ${JSON.stringify(value)}`);
    }
    if (document.tags?.length) frontmatterLines.push("tags:", ...document.tags.map((tag) => `  - ${JSON.stringify(tag)}`));
    frontmatterLines.push("---", "");
    const frontmatter = frontmatterLines.length > 3 ? `${frontmatterLines.join("\n")}\n` : "";
    fs.writeFileSync(documentPath, `${frontmatter}${document.content}\n`, "utf8");
  }
  const configuration = {
    memory: {
      enabled: true,
      vaultRootPath,
      ignoredDirectories: [],
      maxIndexedFiles: 5000,
      maxSearchResults: 10,
      maxSearchFileBytes: 131072,
      maxExcerptCharacters: 300
    }
  };
  const report = evaluateMemoryRetrieval(configuration, dataset.cases, { cutoffs: [1, 3, 5] });
  assert.ok(report.cutoffs[1].precision >= 0.85, `precision@1=${report.cutoffs[1].precision}`);
  assert.ok(report.cutoffs[5].recall >= 0.90, `recall@5=${report.cutoffs[5].recall}`);
  assert.ok(report.cutoffs[5].ndcg >= 0.80, `ndcg@5=${report.cutoffs[5].ndcg}`);
});
