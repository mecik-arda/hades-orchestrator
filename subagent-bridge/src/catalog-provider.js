import { createProviderEnvironment, runProcess } from "./services/execution-service.js";

export const KIMI_MODEL_MAP = Object.freeze({
  kimi_k2_5_instruct: "moonshot/kimi-k2.5-instruct",
  kimi_k2_thinking: "moonshot/kimi-k2-thinking"
});

export const QWEN_MODEL_MAP = Object.freeze({
  qwen3_coder_480b: "alibaba/qwen3-coder-480b-a35b",
  qwen3_coder_plus: "alibaba/qwen3-coder-plus",
  qwen3_coder_30b: "alibaba/qwen3-coder-30b-a3b"
});

const PROVIDERS = Object.freeze({
  kimi: { models: KIMI_MODEL_MAP, defaultModel: "kimi_k2_5_instruct" },
  qwen: { models: QWEN_MODEL_MAP, defaultModel: "qwen3_coder_480b" }
});

export function resolveCatalogModel(configuration, provider, model) {
  const definition = PROVIDERS[provider];
  if (!definition) throw new Error(`unsupported catalog provider: ${provider}`);
  const requestedModel = model || definition.defaultModel;
  const configuredModels = configuration[provider]?.models || definition.models;
  const resolvedModel = configuredModels[requestedModel];
  if (!resolvedModel) throw new Error(`unsupported ${provider} model: ${requestedModel}`);
  return resolvedModel;
}

function exactModelIds(output) {
  return new Set(String(output || "").split(/\r?\n/).map((value) => value.trim().toLocaleLowerCase("en-US")).filter(Boolean));
}

export async function checkCatalogProvider(configuration, provider) {
  const definition = PROVIDERS[provider];
  if (!definition) throw new Error(`unsupported catalog provider: ${provider}`);
  const executable = configuration.opencode?.executable || "opencode";
  const execArgs = configuration.opencode?.execArgs || [];
  let version = null;
  let installed = false;
  let modelsOutput = "";
  try {
    const versionResult = await runProcess(executable, [...execArgs, "--version"], {
      timeoutMs: 15000,
      maxOutputBytes: 65536,
      env: createProviderEnvironment("opencode")
    });
    installed = versionResult.code === 0;
    version = versionResult.stdout.trim() || versionResult.stderr.trim() || null;
    if (installed) {
      const modelsResult = await runProcess(executable, [...execArgs, "models"], {
        timeoutMs: 30000,
        maxOutputBytes: 1048576,
        env: createProviderEnvironment("opencode")
      });
      if (modelsResult.code === 0) modelsOutput = modelsResult.stdout;
    }
  } catch {
  }
  const availableModels = exactModelIds(modelsOutput);
  const configuredModels = configuration[provider]?.models || definition.models;
  const models = Object.entries(configuredModels).map(([requestedModel, resolvedModel]) => ({
    requestedModel,
    resolvedModel,
    available: availableModels.has(resolvedModel.toLocaleLowerCase("en-US"))
  }));
  return {
    available: installed && models.some((entry) => entry.available),
    installed,
    authValid: installed,
    version,
    models,
    exitCode: installed ? 0 : 1
  };
}

export function buildCatalogReadOnlyPrompt(input, provider) {
  return [
    `Provider: ${provider}`,
    `Görev: ${input.objective}`,
    `İncelenecek dosyalar: ${input.files.length > 0 ? input.files.join(", ") : "Yok"}`,
    `Ek bağlam dosyaları: ${input.contextFiles.length > 0 ? input.contextFiles.join(", ") : "Yok"}`,
    "Kabul kriterleri:",
    ...input.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "Dosya değiştirme, shell çalıştırma, secret okuma veya başka subagent kullanma.",
    "Kanıta dayalı, kısa bir analiz döndür."
  ].join("\n");
}

export function buildCatalogEditPrompt(input, provider) {
  return [
    `Provider: ${provider}`,
    `Görev: ${input.objective}`,
    `Düzenlenebilecek dosyalar: ${input.files.join(", ")}`,
    `Ek bağlam dosyaları: ${input.contextFiles.length > 0 ? input.contextFiles.join(", ") : "Yok"}`,
    "Kabul kriterleri:",
    ...input.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "Yalnız disposable workspace içindeki seçilmiş hedef dosyaları düzenle.",
    "Shell, task, ağ, dış dizin, secret veya başka subagent kullanma."
  ].join("\n");
}
