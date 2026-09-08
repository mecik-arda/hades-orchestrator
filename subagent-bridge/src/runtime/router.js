const ANTIGRAVITY_TARGETS = new Set(["gemini_pro", "gemini_flash", "gemini_flash_3_7", "gemini_flash_3_8", "claude_sonnet"]);

function requireModel(model, target) {
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new Error(`model is required for target '${target}'`);
  }
  return model.trim();
}

function rejectOpenCodeGemini(model) {
  const normalized = model.toLocaleLowerCase("en-US");
  if (/^gemini([_-]|$)/.test(normalized) || /^google\/gemini([_-]|$)/.test(normalized)) {
    throw new Error("Gemini models must be routed through Antigravity");
  }
}

export function resolveRuntimeRoute({ target, model, profile }, configuration = {}) {
  if (target === "profile") {
    const selectedProfile = configuration.orchestration?.taskProfiles?.[profile];
    if (!selectedProfile) {
      throw new Error(`unsupported task profile: ${profile || "unknown"}`);
    }
    return resolveRuntimeRoute({ target: selectedProfile.target, model: selectedProfile.model }, configuration);
  }
  if (ANTIGRAVITY_TARGETS.has(target)) {
    return { backend: "antigravity", model: target };
  }
  if (target === "antigravity") {
    const selectedModel = requireModel(model, target);
    if (!ANTIGRAVITY_TARGETS.has(selectedModel)) {
      throw new Error(`unsupported Antigravity model: ${selectedModel}`);
    }
    return { backend: "antigravity", model: selectedModel };
  }
  if (target === "codex") {
    return { backend: "codex", model: model?.trim() || "default" };
  }
  if (target === "native_claude" || target === "claude_code") {
    return { backend: "claude_code", model: model?.trim() || "sonnet" };
  }
  if (target === "glm") {
    const selectedModel = model?.trim() || "glm_5_2";
    return { backend: "opencode", model: selectedModel, glm: true };
  }
  if (target === "kimi") {
    return { backend: "opencode", model: model?.trim() || "kimi_k2_5_instruct", catalogProvider: "kimi" };
  }
  if (target === "qwen") {
    return { backend: "opencode", model: model?.trim() || "qwen3_coder_480b", catalogProvider: "qwen" };
  }
  if (target === "opencode") {
    const selectedModel = requireModel(model, target);
    rejectOpenCodeGemini(selectedModel);
    return { backend: "opencode", model: selectedModel };
  }
  throw new Error(`unsupported runtime target: ${target}`);
}
