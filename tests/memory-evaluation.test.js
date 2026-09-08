import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateMemoryRetrieval } from "../subagent-bridge/src/memory-evaluation.js";

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
