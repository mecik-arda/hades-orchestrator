import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadSkills, requireGitRepository, validateWorkspace } from "./config.js";
import { createFailureResult, parseDeepSeekEnvelope } from "./result.js";
import { createOpenCodeAdapter } from "./adapters/opencode-adapter.js";
import { createProviderEnvironment, runProcess } from "./services/execution-service.js";

function createRunId() {
  return crypto.randomUUID();
}

export function resolveDeepSeekModel(configuration, model = "deepseek_pro") {
  if (model === "deepseek_pro") return configuration.deepseek.openCodeModel;
  if (model === "deepseek_flash") return configuration.deepseek.openCodeFlashModel;
  throw new Error(`Desteklenmeyen DeepSeek modeli: ${model}`);
}

export function buildDeepSeekPrompt(input, guidance) {
  const skillSections = guidance.skills.flatMap((skill) => [
    `Etkin skill: ${skill.name}`,
    skill.content
  ]);
  return [
    `Görev: ${input.objective}`,
    ...(skillSections.length > 0
      ? ["Aşağıdaki uzman skill talimatlarını analiz sınırları içinde uygula:", ...skillSections]
      : []),
    `İncelenecek dosyalar: ${input.files.length > 0 ? input.files.join(", ") : "Yok"}`,
    `Ek bağlam dosyaları: ${input.contextFiles.length > 0 ? input.contextFiles.join(", ") : "Yok"}`,
    "Kabul kriterleri:",
    ...input.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "Dosya değiştirme veya komut çalıştırma. Do not modify files or run commands.",
    "Return only valid JSON. Use double-quoted keys and string values. Do not use Markdown, code fences, prose outside JSON, JavaScript object syntax, or YAML.",
    "Return every required key exactly once: status, summary, findings, proposed_steps, risks, questions, requires_human_approval.",
    "Each findings item must contain exactly title, evidence, impact, recommendation, confidence. confidence must be high, medium, or low. Never use key/value findings. Use findings: [] when there is no verified finding.",
    "The result must conform to this example shape: {\"status\":\"completed\",\"summary\":\"short summary\",\"findings\":[],\"proposed_steps\":[],\"risks\":[],\"questions\":[],\"requires_human_approval\":false}."
  ].join("\n");
}

export function buildDeepSeekSchemaRepairPrompt(input, guidance) {
  return [
    buildDeepSeekPrompt(input, guidance),
    "Your previous response failed the required JSON schema validation.",
    "Return the complete replacement response now as exactly one JSON object.",
    "Do not add explanation, markdown, a code fence, or any key outside the required schema.",
    "Every array field must be present, even when empty. requires_human_approval must be a JSON boolean."
  ].join("\n");
}

export function buildDeepSeekEditPrompt(input) {
  return [
    `Görev: ${input.objective}`,
    `Düzenlenebilecek dosyalar: ${input.files.join(", ")}`,
    `Ek bağlam dosyaları: ${input.contextFiles.length > 0 ? input.contextFiles.join(", ") : "Yok"}`,
    "Kabul kriterleri:",
    ...input.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "Yalnız mevcut disposable workspace içindeki dosyaları oku ve düzenle.",
    "Shell, task, ağ, dış dizin, secret veya başka subagent kullanma.",
    "İstenen değişiklikleri uygula ve kısa bir tamamlanma özeti döndür."
  ].join("\n");
}

export function normalizeOpenCodeDeepSeekResult(value) {
  return parseDeepSeekEnvelope(value);
}

export function hasExactModelId(models, modelId) {
  const modelIds = new Set((models.match(/[a-z0-9._-]+\/[a-z0-9._-]+/gi) || []).map((value) => value.toLocaleLowerCase("en-US")));
  return modelIds.has(modelId.toLocaleLowerCase("en-US"));
}

export async function checkDeepSeek(configuration) {
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
  return {
    available: health.installed && health.authValid,
    executable: health.executable,
    version: health.version,
    model: configuration.deepseek.openCodeModel,
    flashModel: configuration.deepseek.openCodeFlashModel,
    proModelAvailable: hasExactModelId(models, configuration.deepseek.openCodeModel),
    flashModelAvailable: hasExactModelId(models, configuration.deepseek.openCodeFlashModel),
    exitCode: health.installed ? 0 : 1
  };
}

export function createDeepSeekRuntimeRequest(configuration, input, trustedWorkspace, abortSignal) {
  const workspace = configuration.allowedRoots
    ? validateWorkspace(trustedWorkspace, configuration.allowedRoots, configuration.deepseek.deniedRootPaths)
    : trustedWorkspace;
  if (configuration.deepseek.requireGitRepository) requireGitRepository(workspace);
  const guidance = {
    skills: input.skills?.length > 0 ? loadSkills(configuration, input.skills) : []
  };
  return {
    target: "opencode",
    prompt: buildDeepSeekPrompt(input, guidance),
    model: resolveDeepSeekModel(configuration, input.model),
    mode: "read_only",
    trustedWorkspace: workspace,
    caller: "deepseek_opencode",
    delegationDepth: 0,
    timeoutMs: configuration.deepseek.timeoutMs,
    abortSignal,
    resultValidator: normalizeOpenCodeDeepSeekResult,
    schemaRepairPrompt: buildDeepSeekSchemaRepairPrompt(input, guidance),
    maxSchemaRepairAttempts: configuration.reliability?.maxSchemaRepairAttempts
  };
}

export function createDeepSeekCheckpoint(input, runtimeResult) {
  const normalized = runtimeResult.ok
    ? normalizeOpenCodeDeepSeekResult(runtimeResult.result)
    : { ok: false, errorClass: runtimeResult.reason || "process_exit" };
  const result = normalized.ok
    ? normalized.result
    : createFailureResult(`structured output validation failed: ${normalized.errorClass}`);
  const failureClass = normalized.ok ? (runtimeResult.ok ? null : runtimeResult.reason || "process_exit") : normalized.errorClass;
  return {
    runId: createRunId(),
    taskId: input.taskId,
    agent: "deepseek",
    role: input.role,
    model: runtimeResult.model,
    requestedModel: input.model || "deepseek_pro",
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

export function createDeepSeekEditCheckpoint(input, editResult) {
  return {
    runId: createRunId(),
    taskId: input.taskId,
    agent: "deepseek",
    role: input.role,
    model: editResult.model,
    requestedModel: editResult.requestedModel || input.model || "deepseek_pro",
    resolvedModel: editResult.resolvedModel || editResult.model,
    accessMode: editResult.accessMode,
    exitCode: editResult.status === "completed" ? 0 : 1,
    completedAt: new Date().toISOString(),
    failureClass: editResult.failureClass,
    attempts: [],
    usage: {
      durationMs: null,
      apiDurationMs: null,
      turns: null,
      totalCostUsd: null
    },
    result: {
      status: editResult.status,
      requires_human_approval: false
    }
  };
}

export function writeDeepSeekCheckpoint(configuration, checkpoint) {
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
