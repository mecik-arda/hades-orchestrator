import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateWorkspace } from "./config.js";
import { createFailureResult, parseDeepSeekEnvelope } from "./result.js";
import { createOpenCodeAdapter } from "./adapters/opencode-adapter.js";
import { createProviderEnvironment, runProcess } from "./services/execution-service.js";

export const GLM_MODEL_MAP = Object.freeze({
  glm_5_2: "zai-coding-plan/glm-5.2",
  glm_5_2_highspeed: "zai-coding-plan/glm-5.2-highspeed",
  glm_5_3: "zai-coding-plan/glm-5.3",
  glm_5_3_flash: "zai-coding-plan/glm-5.3-flash"
});

export function resolveGlmModel(configuration, model = "glm_5_2") {
  if (model === "glm_5_2") return configuration.glm?.openCodeModel || GLM_MODEL_MAP.glm_5_2;
  if (model === "glm_5_2_highspeed") return configuration.glm?.openCodeHighSpeedModel || GLM_MODEL_MAP.glm_5_2_highspeed;
  if (model === "glm_5_3") return configuration.glm?.openCode53Model || GLM_MODEL_MAP.glm_5_3;
  if (model === "glm_5_3_flash") return configuration.glm?.openCode53FlashModel || GLM_MODEL_MAP.glm_5_3_flash;
  throw new Error(`Desteklenmeyen GLM modeli: ${model}`);
}

export function buildGlmReadOnlyPrompt(input) {
  return [
    `Görev: ${input.objective}`,
    `İncelenecek dosyalar: ${input.files.length > 0 ? input.files.join(", ") : "Yok"}`,
    `Ek bağlam dosyaları: ${input.contextFiles.length > 0 ? input.contextFiles.join(", ") : "Yok"}`,
    "Kabul kriterleri:",
    ...input.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "Dosya değiştirme, shell veya başka subagent kullanma.",
    "CRITICAL JSON RULES: Return exactly one JSON object starting with { and ending with }. No backtick fences, no markdown, no explanatory text before or after the JSON. Every key and string value must use double quotes. No trailing commas. No single quotes. No unquoted keys. No comments. No JavaScript syntax.",
    "Required keys (every one must be present, even if empty): status, summary, findings, proposed_steps, risks, questions, requires_human_approval.",
    "status must be one of: completed, needs_context, blocked, failed. requires_human_approval must be a boolean (true or false, not a string). findings must be an array of objects with exactly: title, evidence, impact, recommendation, confidence. confidence must be exactly: high, medium, or low. If no findings, use [].",
    "Valid example: {\"status\":\"completed\",\"summary\":\"short summary\",\"findings\":[],\"proposed_steps\":[],\"risks\":[],\"questions\":[],\"requires_human_approval\":false}"
  ].join("\n");
}

export function buildGlmSchemaRepairPrompt(input) {
  return [
    "Görev: " + input.objective,
    "Your previous JSON response was invalid. Common causes: trailing commas, unquoted keys, single quotes, backtick fences, explanatory text outside JSON.",
    "Return exactly one JSON object now. Start with { and end with }. No markdown, no code fences, no text before or after.",
    "All required keys must be present: status, summary, findings, proposed_steps, risks, questions, requires_human_approval.",
    "requires_human_approval must be a JSON boolean (true or false, not a string).",
    "Example: {\"status\":\"completed\",\"summary\":\"fixed\",\"findings\":[{\"title\":\"t\",\"evidence\":\"e\",\"impact\":\"i\",\"recommendation\":\"r\",\"confidence\":\"high\"}],\"proposed_steps\":[],\"risks\":[],\"questions\":[],\"requires_human_approval\":false}"
  ].join("\n");
}

export function buildGlmProfileReadOnlyPrompt(prompt) {
  return buildGlmReadOnlyPrompt({
    objective: prompt,
    files: [],
    contextFiles: [],
    acceptanceCriteria: ["Return a concise, evidence-based result."]
  });
}

export function buildGlmEditPrompt(input) {
  return [
    `Görev: ${input.objective}`,
    `Düzenlenebilecek dosyalar: ${input.files.join(", ")}`,
    `Ek bağlam dosyaları: ${input.contextFiles.length > 0 ? input.contextFiles.join(", ") : "Yok"}`,
    "Kabul kriterleri:",
    ...input.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "Yalnız mevcut disposable workspace içindeki seçilmiş hedef dosyaları düzenle.",
    "Shell, task, ağ, dış dizin, secret veya başka subagent kullanma.",
    "İstenen değişiklikleri uygula ve kısa bir tamamlanma özeti döndür."
  ].join("\n");
}

export function normalizeOpenCodeGlmResult(value) {
  return parseDeepSeekEnvelope(value);
}

function hasExactModelId(models, modelId) {
  const modelIds = new Set((models.match(/[a-z0-9._-]+\/[a-z0-9._-]+/gi) || []).map((value) => value.toLocaleLowerCase("en-US")));
  return modelIds.has(modelId.toLocaleLowerCase("en-US"));
}

export async function checkGlm(configuration) {
  const health = await createOpenCodeAdapter(configuration).healthCheck();
  const executable = configuration.opencode?.executable || "opencode";
  const execArgs = configuration.opencode?.execArgs || [];
  let models = "";
  try {
    const result = await runProcess(executable, [...execArgs, "models"], {
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      env: createProviderEnvironment("opencode")
    });
    if (result.code === 0) models = result.stdout;
  } catch {
  }
  const model = resolveGlmModel(configuration, "glm_5_2");
  const highSpeedModel = resolveGlmModel(configuration, "glm_5_2_highspeed");
  const glm53Model = resolveGlmModel(configuration, "glm_5_3");
  const glm53FlashModel = resolveGlmModel(configuration, "glm_5_3_flash");
  return {
    available: health.installed && health.authValid,
    executable: health.executable,
    version: health.version,
    model,
    highSpeedModel,
    glm53Model,
    glm53FlashModel,
    modelAvailable: hasExactModelId(models, model),
    highSpeedModelAvailable: hasExactModelId(models, highSpeedModel),
    glm53ModelAvailable: hasExactModelId(models, glm53Model),
    glm53FlashModelAvailable: hasExactModelId(models, glm53FlashModel),
    exitCode: health.installed ? 0 : 1
  };
}

export function createGlmRuntimeRequest(configuration, input, trustedWorkspace, abortSignal) {
  const workspace = configuration.allowedRoots
    ? validateWorkspace(trustedWorkspace, configuration.allowedRoots, configuration.glm?.deniedRootPaths || [])
    : trustedWorkspace;
  return {
    target: "opencode",
    prompt: buildGlmReadOnlyPrompt(input),
    model: resolveGlmModel(configuration, input.model),
    mode: "read_only",
    trustedWorkspace: workspace,
    caller: "glm_opencode",
    delegationDepth: 0,
    metricBackend: "glm",
    timeoutMs: input.timeout_seconds ? input.timeout_seconds * 1000 : configuration.glm?.timeoutMs || configuration.opencode?.timeoutMs,
    abortSignal,
    resultValidator: normalizeOpenCodeGlmResult,
    schemaRepairPrompt: buildGlmSchemaRepairPrompt(input),
    maxSchemaRepairAttempts: configuration.reliability?.maxSchemaRepairAttempts
  };
}

export function createGlmCheckpoint(input, runtimeResult) {
  const normalized = runtimeResult.ok
    ? normalizeOpenCodeGlmResult(runtimeResult.result)
    : { ok: false, errorClass: runtimeResult.reason || "process_exit" };
  const result = normalized.ok
    ? normalized.result
    : createFailureResult(`structured output validation failed: ${normalized.errorClass}`);
  const failureClass = normalized.ok ? (runtimeResult.ok ? null : runtimeResult.reason || "process_exit") : normalized.errorClass;
  return {
    runId: crypto.randomUUID(),
    taskId: input.taskId,
    agent: "glm",
    role: input.role,
    model: runtimeResult.model,
    requestedModel: input.model || "glm_5_2",
    resolvedModel: runtimeResult.resolvedModel || runtimeResult.model,
    accessMode: "read_only",
    exitCode: normalized.ok && runtimeResult.ok ? runtimeResult.exitCode : 1,
    completedAt: new Date().toISOString(),
    failureClass,
    attempts: Array.isArray(runtimeResult.metrics?.attempts) && runtimeResult.metrics.attempts.length > 0
      ? runtimeResult.metrics.attempts.map((attempt) => ({
        number: attempt.number,
        failureClass: attempt.failureClass,
        exitCode: attempt.exitCode,
        durationMs: attempt.durationMs,
        apiDurationMs: null,
        turns: null,
        totalCostUsd: attempt.totalCostUsd ?? null,
        retryDelayMs: attempt.retryDelayMs ?? null
      }))
      : [{
        number: 1,
        failureClass,
        exitCode: runtimeResult.exitCode,
        durationMs: runtimeResult.durationMs,
        apiDurationMs: null,
        turns: null,
        totalCostUsd: runtimeResult.metrics?.totalCostUsd ?? null,
        retryDelayMs: null
      }],
    usage: {
      durationMs: runtimeResult.durationMs,
      apiDurationMs: null,
      turns: null,
      totalCostUsd: runtimeResult.metrics?.totalCostUsd ?? null
    },
    result
  };
}

export function writeGlmCheckpoint(configuration, checkpoint) {
  const runIdHash = crypto.createHash("sha256").update(checkpoint.runId).digest("hex");
  const checkpointPath = path.join(configuration.statePaths.state, "checkpoints", `${runIdHash}.json`);
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  const persistedCheckpoint = {
    runIdHash,
    agent: checkpoint.agent,
    role: checkpoint.role,
    model: checkpoint.model,
    requestedModel: checkpoint.requestedModel,
    resolvedModel: checkpoint.resolvedModel,
    accessMode: checkpoint.accessMode,
    exitCode: checkpoint.exitCode,
    completedAt: checkpoint.completedAt,
    failureClass: checkpoint.failureClass,
    attempts: checkpoint.attempts,
    usage: checkpoint.usage,
    result: {
      status: checkpoint.result.status,
      requires_human_approval: checkpoint.result.requires_human_approval
    }
  };
  fs.writeFileSync(checkpointPath, JSON.stringify(persistedCheckpoint, null, 2), "utf8");
  return checkpoint;
}
