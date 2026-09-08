import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { buildOpenCodeArgs, resolveModel } from "../subagent-bridge/src/adapters/opencode-adapter.js";
import { KIMI_MODEL_MAP, QWEN_MODEL_MAP, resolveCatalogModel } from "../subagent-bridge/src/catalog-provider.js";
import { createMcpToolHandlers, publicToolSchemas } from "../subagent-bridge/src/frontends/mcp/tools.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";
import { resolveRuntimeRoute } from "../subagent-bridge/src/runtime/router.js";
import { validateControlledEditResult, validateSubagentResult } from "../subagent-bridge/src/schemas/core-schemas.js";

const configuration = {
  kimi: { models: KIMI_MODEL_MAP },
  qwen: { models: QWEN_MODEL_MAP }
};

test("CATALOG-01: Kimi ve Qwen aliasları exact model kimliklerine çözülür", () => {
  assert.equal(resolveCatalogModel(configuration, "kimi", "kimi_k2_thinking"), "moonshot/kimi-k2-thinking");
  assert.equal(resolveCatalogModel(configuration, "qwen", "qwen3_coder_plus"), "alibaba/qwen3-coder-plus");
  assert.throws(() => resolveCatalogModel(configuration, "kimi", "unknown"), /unsupported kimi model/);
});

test("CATALOG-02: OpenCode whitelist katalog dışı modeli provider öncesi reddeder", () => {
  const allowedModels = ["moonshot/kimi-k2.5-instruct", "alibaba/qwen3-coder-plus"];
  assert.deepEqual(resolveModel("kimi_k2_5_instruct", allowedModels), { valid: true, model: "moonshot/kimi-k2.5-instruct" });
  assert.equal(resolveModel("qwen3_coder_480b", allowedModels).valid, false);
});

test("CATALOG-03: router Kimi ve Qwen'i OpenCode backendine yönlendirir", () => {
  assert.deepEqual(resolveRuntimeRoute({ target: "kimi" }), { backend: "opencode", model: "kimi_k2_5_instruct", catalogProvider: "kimi" });
  assert.deepEqual(resolveRuntimeRoute({ target: "qwen", model: "qwen3_coder_plus" }), { backend: "opencode", model: "qwen3_coder_plus", catalogProvider: "qwen" });
});

test("CATALOG-04: kontrollü edit caller doğru agentı seçer", () => {
  const kimiArgs = buildOpenCodeArgs({ mode: "edit", caller: "kimi_edit", workspace: "C:\\workspace", prompt: "apply" }, { opencode: { kimiEditAgent: "kimi-edit" } }, "moonshot/kimi-k2.5-instruct");
  const qwenArgs = buildOpenCodeArgs({ mode: "edit", caller: "qwen_edit_pilot", workspace: "C:\\workspace", prompt: "apply" }, { opencode: { qwenEditAgent: "qwen-edit" } }, "alibaba/qwen3-coder-plus");
  assert.equal(kimiArgs[kimiArgs.indexOf("--agent") + 1], "kimi-edit");
  assert.equal(qwenArgs[qwenArgs.indexOf("--agent") + 1], "qwen-edit");
});

test("CATALOG-05: public araç şeması edit için implementer ve dosya ister", async () => {
  const base = { taskId: "catalog", role: "implementer", model: "kimi_k2_5_instruct", mode: "edit", objective: "change", files: ["src/value.txt"], acceptanceCriteria: ["changed"] };
  assert.equal(publicToolSchemas.runCatalogProvider.safeParse(base).success, true);
  const handlers = createMcpToolHandlers({ runtime: { runCatalogProvider: async () => ({ status: "completed" }) }, trustedWorkspace: "C:\\workspace" });
  await assert.rejects(() => handlers.runKimi({ ...base, role: "analyst" }), /implementer role/);
  await assert.rejects(() => handlers.runQwen({ ...base, files: [] }), /selected target files/);
});

test("CATALOG-06: katalogda olmayan model edit'i provider başlamadan model_unavailable döner", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-unavailable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "src", "value.txt");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "before\n", "utf8");
  let executions = 0;
  const adapter = createAdapter("opencode", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async () => {
    executions += 1;
    return { ok: false, backend: "opencode", model: "x", result: null, error: "unexpected", retryable: false, timedOut: false, exitCode: 1, durationMs: 1, metrics: { retries: 0 } };
  };
  const runtimeConfig = {
    allowedRoots: [root],
    statePaths: { logs: path.join(root, "logs"), state: path.join(root, "state"), cache: path.join(root, "cache") },
    observability: { maxMetricFileBytes: 1048576, maxMetricRetentionDays: 30 },
    reliability: { maxAttempts: 2, maxSchemaRepairAttempts: 0, baseRetryDelayMs: 1, maxRetryDelayMs: 2, maxTotalDurationMs: 60000, maxRetryCostUsd: 1, maxRetryCostReserveUsd: 0.1, maxUnknownAttemptCostUsd: 0.1 },
    orchestration: { taskProfiles: {}, scheduler: { maxQueuedPerWorkspace: 10, staleLockMs: 60000, leaseHeartbeatMs: 1000 }, readOnlyCache: { enabled: false, ttlMs: 1000, maxEntryBytes: 1024 } },
    kimi: { models: KIMI_MODEL_MAP, timeoutMs: 30000 },
    qwen: { models: QWEN_MODEL_MAP, timeoutMs: 30000 },
    opencode: { timeoutMs: 30000, allowedModes: ["read_only", "edit"], allowedModels: [], kimiEditAgent: "kimi-edit", qwenEditAgent: "qwen-edit" }
  };
  const runtime = createBridgeRuntime({ configuration: runtimeConfig, adapters: { opencode: adapter }, sleep: async () => {} });
  const result = await runtime.runCatalogProvider("kimi", { taskId: "catalog-unavailable", role: "implementer", model: "kimi_k2_5_instruct", mode: "edit", objective: "change", files: ["src/value.txt"], contextFiles: [], acceptanceCriteria: ["changed"] }, root);
  assert.equal(result.status, "failed");
  assert.equal(result.failureClass, "model_unavailable");
  assert.equal(validateControlledEditResult(result).success, true);
  assert.equal(executions, 0);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "before\n");
  const readOnlyResult = await runtime.runCatalogProvider("qwen", { taskId: "catalog-unavailable-read", role: "analyst", model: "qwen3_coder_plus", mode: "read_only", objective: "inspect", files: [], contextFiles: [], acceptanceCriteria: ["inspected"] }, root);
  assert.equal(readOnlyResult.ok, false);
  assert.equal(readOnlyResult.reason, "model_unavailable");
  assert.equal(validateSubagentResult(readOnlyResult).success, true);
});

test("CATALOG-07: tüm Kimi ve Qwen aliasları exact allowlist kimliğine çözülür", () => {
  for (const [alias, model] of Object.entries(KIMI_MODEL_MAP)) assert.equal(resolveCatalogModel(configuration, "kimi", alias), model);
  for (const [alias, model] of Object.entries(QWEN_MODEL_MAP)) assert.equal(resolveCatalogModel(configuration, "qwen", alias), model);
  assert.throws(() => resolveCatalogModel(configuration, "qwen", "unknown"), /unsupported qwen model/);
});
