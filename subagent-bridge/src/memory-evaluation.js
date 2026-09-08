import { performance } from "node:perf_hooks";
import { z } from "zod";
import { searchPersistentMemory } from "./memory.js";

const evaluationCategorySchema = z.enum(["single-hop", "temporal-ordering", "knowledge-update", "contradiction", "partial-match", "negative-query", "related-note"]);

export const evaluationCaseSchema = z.object({
  id: z.string().min(1).max(100),
  category: evaluationCategorySchema,
  query: z.string().min(2).max(500),
  qrels: z.record(z.string(), z.number().min(0).max(3)),
  fixedTime: z.string().datetime().optional(),
  includeExpired: z.boolean().optional()
}).strict();

export const evaluationDocumentSchema = z.object({
  relativePath: z.string().min(3),
  content: z.string().min(1),
  created: z.string().datetime().optional(),
  updated: z.string().datetime().optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  verification: z.enum(["user-provided", "verified", "provisional"]).optional(),
  reviewAfter: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
  stage: z.enum(["draft", "published"]).optional(),
  memoryType: z.enum(["semantic", "episodic", "procedural", "preference", "decision"]).optional(),
  tags: z.array(z.string().min(1)).optional()
}).strict();

export const evaluationDatasetSchema = z.object({
  documents: z.array(evaluationDocumentSchema).min(1),
  cases: z.array(evaluationCaseSchema).min(1)
}).strict();

function round(value) {
  return Number(value.toFixed(4));
}

function discountedCumulativeGain(relevances) {
  return relevances.reduce((total, relevance, index) => total + ((2 ** relevance) - 1) / Math.log2(index + 2), 0);
}

function defaultRetriever(configuration, query, limit, options) {
  return searchPersistentMemory(configuration, {
    query,
    limit,
    includeExpired: options.includeExpired,
    now: options.now
  });
}

export function validateMemoryEvaluationDataset(value) {
  return evaluationDatasetSchema.safeParse(value);
}

export function evaluateMemoryRetrieval(configuration, evaluationCases, options = {}) {
  const parsedCases = z.array(evaluationCaseSchema).parse(evaluationCases);
  const cutoffs = [...new Set(options.cutoffs || [1, 3, 5])].sort((left, right) => left - right);
  const maximumCutoff = Math.max(...cutoffs);
  const retriever = options.retriever || defaultRetriever;
  const strategy = options.strategy || "keyword";
  const caseResults = parsedCases.map((evaluationCase) => {
    const fixedTime = evaluationCase.fixedTime || options.fixedTime;
    const now = fixedTime ? Date.parse(fixedTime) : Date.now();
    const startedAt = performance.now();
    const result = retriever(configuration, evaluationCase.query, maximumCutoff, {
      includeExpired: evaluationCase.includeExpired === true,
      now
    });
    const latencyMs = performance.now() - startedAt;
    const qrels = new Map(Object.entries(evaluationCase.qrels));
    const relevantPaths = new Set([...qrels].filter(([, relevance]) => relevance >= 2).map(([relativePath]) => relativePath));
    const actualRanking = result.matches.map((match) => match.relativePath);
    const cutoffResults = Object.fromEntries(cutoffs.map((cutoff) => {
      const selected = result.matches.slice(0, cutoff);
      const relevant = selected.filter((match) => relevantPaths.has(match.relativePath)).length;
      const actualRelevances = selected.map((match) => qrels.get(match.relativePath) || 0);
      while (actualRelevances.length < cutoff) actualRelevances.push(0);
      const idealRelevances = [...qrels.values()].sort((left, right) => right - left).slice(0, cutoff);
      while (idealRelevances.length < cutoff) idealRelevances.push(0);
      const idealGain = discountedCumulativeGain(idealRelevances);
      return [cutoff, {
        precision: round(relevant / cutoff),
        recall: relevantPaths.size > 0 ? round(relevant / relevantPaths.size) : 1,
        ndcg: idealGain > 0 ? round(discountedCumulativeGain(actualRelevances) / idealGain) : 1
      }];
    }));
    const firstRelevantIndex = result.matches.findIndex((match) => relevantPaths.has(match.relativePath));
    const returnedCharacters = result.matches.reduce((total, match) => total + match.excerpt.length, 0);
    return {
      id: evaluationCase.id,
      category: evaluationCase.category,
      query: evaluationCase.query,
      expectedQrels: evaluationCase.qrels,
      actualRanking,
      expectedCount: relevantPaths.size,
      returnedCount: result.matches.length,
      abstentionCorrect: relevantPaths.size === 0 ? result.matches.length === 0 : null,
      reciprocalRank: firstRelevantIndex >= 0 ? round(1 / (firstRelevantIndex + 1)) : 0,
      latencyMs: round(latencyMs),
      estimatedContextTokens: Math.ceil(returnedCharacters / 4),
      cutoffs: cutoffResults
    };
  });
  const retrievalCases = caseResults.filter((result) => result.expectedCount > 0);
  const abstentionCases = caseResults.filter((result) => result.expectedCount === 0);
  const aggregateCutoffs = Object.fromEntries(cutoffs.map((cutoff) => [cutoff, {
    precision: round(retrievalCases.reduce((total, result) => total + result.cutoffs[cutoff].precision, 0) / Math.max(1, retrievalCases.length)),
    recall: round(retrievalCases.reduce((total, result) => total + result.cutoffs[cutoff].recall, 0) / Math.max(1, retrievalCases.length)),
    ndcg: round(retrievalCases.reduce((total, result) => total + result.cutoffs[cutoff].ndcg, 0) / Math.max(1, retrievalCases.length))
  }]));
  const failures = caseResults.filter((result) => {
    if (result.expectedCount === 0) return result.abstentionCorrect === false;
    return result.cutoffs[maximumCutoff].recall < 1;
  }).map((result) => ({
    id: result.id,
    query: result.query,
    expectedQrels: result.expectedQrels,
    actualRanking: result.actualRanking,
    reason: result.expectedCount === 0 ? "unexpected_match" : "relevant_document_missing"
  }));
  const mrr = round(retrievalCases.reduce((total, result) => total + result.reciprocalRank, 0) / Math.max(1, retrievalCases.length));
  return {
    evaluatedAt: new Date().toISOString(),
    strategy,
    caseCount: caseResults.length,
    retrievalCaseCount: retrievalCases.length,
    abstentionCaseCount: abstentionCases.length,
    averageLatencyMs: round(caseResults.reduce((total, result) => total + result.latencyMs, 0) / Math.max(1, caseResults.length)),
    averageEstimatedContextTokens: round(caseResults.reduce((total, result) => total + result.estimatedContextTokens, 0) / Math.max(1, caseResults.length)),
    abstentionAccuracy: round(abstentionCases.filter((result) => result.abstentionCorrect).length / Math.max(1, abstentionCases.length)),
    mrr,
    aggregateNdcg: aggregateCutoffs[maximumCutoff].ndcg,
    cutoffs: aggregateCutoffs,
    failures,
    cases: caseResults
  };
}
