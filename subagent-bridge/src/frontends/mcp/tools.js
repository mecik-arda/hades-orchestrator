import crypto from "node:crypto";
import { z } from "zod";
import { validateWorkspace } from "../../config.js";

const modeSchema = z.enum(["read_only", "edit"]).default("read_only");
const timeoutSecondsSchema = z.number().int().min(10).max(1200).optional();
const profileSchema = z.string().min(1).max(64);

export const publicToolSchemas = {
  runAntigravity: z.object({
    prompt: z.string().min(1).max(60000),
    model: z.enum(["gemini_pro", "gemini_flash", "gemini_flash_3_7", "gemini_flash_3_8", "claude_sonnet"]),
    mode: modeSchema,
    timeout_seconds: timeoutSecondsSchema,
    workspace: z.string().min(1).optional()
  }).strict(),
  runClaudeCode: z.object({
    prompt: z.string().min(1).max(60000),
    model: z.string().min(1).optional(),
    mode: modeSchema,
    timeout_seconds: timeoutSecondsSchema
  }).strict(),
  runOpenCode: z.object({
    prompt: z.string().min(1).max(60000),
    model: z.string().min(1),
    mode: modeSchema,
    timeout_seconds: timeoutSecondsSchema
  }).strict(),
  runCodex: z.object({
    prompt: z.string().min(1).max(60000),
    model: z.string().min(1).optional(),
    mode: modeSchema,
    timeout_seconds: timeoutSecondsSchema
  }).strict(),
  runProfile: z.object({
    prompt: z.string().min(1).max(60000),
    profile: profileSchema,
    taskId: z.string().min(1).max(120).optional(),
    files: z.array(z.string().min(1).max(500)).max(100).default([]),
    contextFiles: z.array(z.string().min(1).max(500)).max(100).default([]),
    acceptanceCriteria: z.array(z.string().min(1).max(4000)).max(50).default([]),
    timeout_seconds: timeoutSecondsSchema
  }).strict(),
  runDeepSeek: z.object({
    taskId: z.string().min(1).max(120),
    role: z.enum(["analyst", "researcher", "reviewer", "planner", "implementer"]),
    model: z.enum(["deepseek_pro", "deepseek_flash"]).default("deepseek_pro"),
    mode: modeSchema,
    objective: z.string().min(1).max(12000),
    workspace: z.string().min(1),
    files: z.array(z.string()).max(200).default([]),
    contextFiles: z.array(z.string()).max(100).default([]),
    skills: z.array(z.enum(["commit-at", "guvenlik-ve-sertlestirme", "kod-denetleyicisi", "otomatik-dokumantasyon", "veri-seti-analizcisi"])).max(5).default([]),
    acceptanceCriteria: z.array(z.string()).min(1).max(50)
  }).strict(),
  runDeepSeekEditPilot: z.object({
    taskId: z.string().min(1).max(120),
    model: z.enum(["deepseek_pro", "deepseek_flash"]).default("deepseek_pro"),
    objective: z.string().min(1).max(12000),
    files: z.array(z.string().min(1).max(500)).min(1).max(100),
    contextFiles: z.array(z.string().min(1).max(500)).max(100).default([]),
    acceptanceCriteria: z.array(z.string()).min(1).max(50),
    timeout_seconds: timeoutSecondsSchema
  }).strict(),
  runGlm: z.object({
    taskId: z.string().min(1).max(120),
    role: z.enum(["analyst", "researcher", "reviewer", "planner", "implementer"]),
    model: z.enum(["glm_5_2", "glm_5_2_highspeed", "glm_5_3", "glm_5_3_flash"]).default("glm_5_2"),
    mode: modeSchema,
    objective: z.string().min(1).max(12000),
    files: z.array(z.string()).max(200).default([]),
    contextFiles: z.array(z.string()).max(100).default([]),
    acceptanceCriteria: z.array(z.string()).min(1).max(50),
    timeout_seconds: timeoutSecondsSchema
  }).strict(),
  runGlmEditPilot: z.object({
    taskId: z.string().min(1).max(120),
    model: z.enum(["glm_5_2", "glm_5_2_highspeed", "glm_5_3", "glm_5_3_flash"]).default("glm_5_2"),
    objective: z.string().min(1).max(12000),
    files: z.array(z.string().min(1).max(500)).min(1).max(100),
    contextFiles: z.array(z.string().min(1).max(500)).max(100).default([]),
    acceptanceCriteria: z.array(z.string()).min(1).max(50),
    timeout_seconds: timeoutSecondsSchema
  }).strict(),
  runCatalogProvider: z.object({
    taskId: z.string().min(1).max(120),
    role: z.enum(["analyst", "reviewer", "planner", "implementer"]),
    model: z.string().min(1).max(120),
    mode: modeSchema,
    objective: z.string().min(1).max(12000),
    files: z.array(z.string()).max(200).default([]),
    contextFiles: z.array(z.string()).max(100).default([]),
    acceptanceCriteria: z.array(z.string()).min(1).max(50),
    timeout_seconds: timeoutSecondsSchema
  }).strict()
};

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`invalid public tool arguments: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return result.data;
}

function toMcpResult(result) {
  return {
    isError: result.ok === false,
    content: [{ type: "text", text: result.ok === false ? result.error : JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
}

function createRuntimeRequest(input, target, trustedWorkspace, caller, abortSignal) {
  return {
    target,
    prompt: input.prompt,
    model: input.model,
    mode: input.mode,
    trustedWorkspace,
    caller,
    delegationDepth: 0,
    timeoutMs: input.timeout_seconds ? input.timeout_seconds * 1000 : undefined,
    profile: input.profile,
    abortSignal
  };
}

function resolveAntigravityWorkspace(input, trustedWorkspace, configuration) {
  if (!input.workspace) return trustedWorkspace;
  if (input.mode !== "read_only") {
    throw new Error("external workspace is only available in read_only mode");
  }
  return validateWorkspace(
    input.workspace,
    configuration.allowedRoots || [],
    configuration.workspacePolicy?.antigravityDeniedRootPaths || []
  );
}

function requireImplementerEdit(input) {
  if (input.mode === "edit" && input.role !== "implementer") throw new Error("edit mode requires implementer role");
  if (input.mode === "edit" && input.files.length === 0) throw new Error("edit mode requires selected target files");
}

export function createMcpToolHandlers({ runtime, trustedWorkspace, caller = "openCode", configuration = {} }) {
  return {
    async runAntigravity(input, context = {}) {
      const parsed = parse(publicToolSchemas.runAntigravity, input);
      const workspace = resolveAntigravityWorkspace(parsed, trustedWorkspace, configuration);
      return toMcpResult(await runtime.run(createRuntimeRequest(parsed, parsed.model, workspace, caller, context.signal)));
    },
    async runClaudeCode(input, context = {}) {
      const parsed = parse(publicToolSchemas.runClaudeCode, input);
      return toMcpResult(await runtime.run(createRuntimeRequest(parsed, "native_claude", trustedWorkspace, caller, context.signal)));
    },
    async runOpenCode(input, context = {}) {
      const parsed = parse(publicToolSchemas.runOpenCode, input);
      return toMcpResult(await runtime.run(createRuntimeRequest(parsed, "opencode", trustedWorkspace, caller, context.signal)));
    },
    async runCodex(input, context = {}) {
      const parsed = parse(publicToolSchemas.runCodex, input);
      return toMcpResult(await runtime.run(createRuntimeRequest(parsed, "codex", trustedWorkspace, caller, context.signal)));
    },
    async runProfile(input, context = {}) {
      const parsed = parse(publicToolSchemas.runProfile, input);
      const profile = configuration.orchestration?.taskProfiles?.[parsed.profile];
      if (!profile) throw new Error(`unsupported task profile: ${parsed.profile}`);
      if (profile.mode === "edit") {
        requireImplementerEdit({ ...parsed, mode: "edit", role: "implementer" });
        const result = await runtime.runProfileEdit({ ...parsed, objective: parsed.prompt, role: "implementer", mode: "edit", model: profile.model }, trustedWorkspace, context.signal);
        return { isError: result.status !== "completed", content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
      }
      if (profile.target === "glm") {
        const glmInput = {
          taskId: parsed.taskId || crypto.randomUUID(),
          role: profile.mode === "edit" ? "implementer" : "analyst",
          model: profile.model,
          mode: profile.mode,
          objective: parsed.prompt,
          files: parsed.files,
          contextFiles: parsed.contextFiles,
          acceptanceCriteria: parsed.acceptanceCriteria.length > 0 ? parsed.acceptanceCriteria : ["Return a concise, evidence-based result."]
        };
        requireImplementerEdit(glmInput);
        const result = await runtime.runGlm(glmInput, trustedWorkspace, context.signal);
        return {
          isError: result.status ? result.status !== "completed" : result.ok === false,
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      }
      const mode = profile.mode;
      return toMcpResult(await runtime.run(createRuntimeRequest({ ...parsed, mode }, "profile", trustedWorkspace, caller, context.signal)));
    },
    async runDeepSeek(input, context = {}) {
      const parsed = parse(publicToolSchemas.runDeepSeek, input);
      requireImplementerEdit(parsed);
      const result = await runtime.runDeepSeek(parsed, trustedWorkspace, context.signal);
      return {
        isError: result.status ? result.status !== "completed" : result.ok === false,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result
      };
    },
    async runDeepSeekEditPilot(input, context = {}) {
      const parsed = parse(publicToolSchemas.runDeepSeekEditPilot, input);
      const result = await runtime.runDeepSeekEditPilot(parsed, trustedWorkspace, context.signal);
      return {
        isError: result.status !== "completed",
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result
      };
    },
    async runGlm(input, context = {}) {
      const parsed = parse(publicToolSchemas.runGlm, input);
      requireImplementerEdit(parsed);
      const result = await runtime.runGlm(parsed, trustedWorkspace, context.signal);
      return {
        isError: result.status ? result.status !== "completed" : result.ok === false,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result
      };
    },
    async runGlmEditPilot(input, context = {}) {
      const parsed = parse(publicToolSchemas.runGlmEditPilot, input);
      const result = await runtime.runGlmEditPilot(parsed, trustedWorkspace, context.signal);
      return {
        isError: result.status !== "completed",
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result
      };
    },
    async runKimi(input, context = {}) {
      const parsed = parse(publicToolSchemas.runCatalogProvider, input);
      requireImplementerEdit(parsed);
      const result = await runtime.runCatalogProvider("kimi", parsed, trustedWorkspace, context.signal);
      return { isError: result.status ? result.status !== "completed" : result.ok === false, content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },
    async runQwen(input, context = {}) {
      const parsed = parse(publicToolSchemas.runCatalogProvider, input);
      requireImplementerEdit(parsed);
      const result = await runtime.runCatalogProvider("qwen", parsed, trustedWorkspace, context.signal);
      return { isError: result.status ? result.status !== "completed" : result.ok === false, content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    }
  };
}
