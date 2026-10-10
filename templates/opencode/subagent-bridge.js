import { tool } from "@opencode-ai/plugin";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureRuntimeDirectories, loadRuntimeConfiguration, validateWorkspace } from "__BRIDGE_ROOT__/subagent-bridge/src/config.js";
import { getPersonalBridgeLayout } from "__BRIDGE_ROOT__/subagent-bridge/src/personal-layout.js";
import { createBridgeRuntime } from "__BRIDGE_ROOT__/subagent-bridge/src/runtime/bridge-runtime.js";

const layout = getPersonalBridgeLayout();
const configuration = loadRuntimeConfiguration({
  configurationPath: layout.configPath,
  agentsPath: layout.agentsPath,
  statePaths: {
    logs: layout.logs,
    state: layout.state,
    cache: layout.cache
  }
});
ensureRuntimeDirectories(configuration);
const runtime = createBridgeRuntime({ configuration });

function resolveTrustedWorkspace(context) {
  if (context.worktree && fs.existsSync(path.join(context.worktree, ".git"))) {
    return { source: "worktree", workspace: context.worktree };
  }
  if (context.directory) {
    return { source: "directory", workspace: context.directory };
  }
  throw new Error("OpenCode session workspace is unavailable");
}

function resolveReadOnlyWorkspace(workspace, context) {
  if (!workspace) return resolveTrustedWorkspace(context);
  return {
    source: "explicit",
    workspace: validateWorkspace(workspace, configuration.allowedRoots, configuration.deepseek.deniedRootPaths)
  };
}

function createReadOnlyTool(target) {
  return tool({
    description: `Delegates a read-only task to the canonical ${target} subagent. An optional workspace must be inside an allowed root and is read-only.`,
    args: {
      prompt: tool.schema.string().min(1).max(60000),
      workspace: tool.schema.string().min(1).optional()
    },
    async execute(args, context) {
      const trustedContext = resolveReadOnlyWorkspace(args.workspace, context);
      const result = await runtime.run({
        target,
        prompt: args.prompt,
        mode: "read_only",
        trustedWorkspace: trustedContext.workspace,
        caller: "opencode_v1_global_tool",
        delegationDepth: 0
      });
      return JSON.stringify(result);
    }
  });
}

function createCodexModelReadOnlyTool(model, label) {
  return tool({
    description: `Delegates a read-only task to ${label} through the canonical subagent bridge. An optional workspace must be inside an allowed root and is read-only.`,
    args: {
      prompt: tool.schema.string().min(1).max(60000),
      workspace: tool.schema.string().min(1).optional()
    },
    async execute(args, context) {
      const trustedContext = resolveReadOnlyWorkspace(args.workspace, context);
      const result = await runtime.run({
        target: "codex",
        prompt: args.prompt,
        model,
        mode: "read_only",
        trustedWorkspace: trustedContext.workspace,
        caller: "opencode_v1_global_tool",
        delegationDepth: 0
      });
      return JSON.stringify(result);
    }
  });
}

function createCodexEditTool(profile, model, label) {
  return tool({
    description: `Delegates a controlled workspace-write edit to ${label} through the canonical subagent bridge. Selected files and acceptance criteria are required.`,
    args: {
      prompt: tool.schema.string().min(1).max(60000),
      files: tool.schema.array(tool.schema.string().min(1)).min(1),
      contextFiles: tool.schema.array(tool.schema.string().min(1)).optional(),
      acceptanceCriteria: tool.schema.array(tool.schema.string().min(1)).min(1)
    },
    async execute(args, context) {
      const trustedContext = resolveTrustedWorkspace(context);
      const result = await runtime.runProfileEdit({
        profile,
        taskId: crypto.randomUUID(),
        role: "implementer",
        mode: "edit",
        model,
        objective: args.prompt,
        prompt: args.prompt,
        files: args.files,
        contextFiles: args.contextFiles || [],
        acceptanceCriteria: args.acceptanceCriteria
      }, trustedContext.workspace);
      return JSON.stringify(result);
    }
  });
}

function createDeepSeekReadOnlyTool(model) {
  return tool({
    description: `Delegates a read-only task to DeepSeek ${model === "deepseek_pro" ? "Pro" : "Flash"}. An optional workspace must be inside an allowed root and is read-only.`,
    args: {
      prompt: tool.schema.string().min(1).max(12000),
      workspace: tool.schema.string().min(1).optional()
    },
    async execute(args, context) {
      const trustedContext = resolveReadOnlyWorkspace(args.workspace, context);
      const result = await runtime.runDeepSeek({
        taskId: crypto.randomUUID(),
        role: "analyst",
        model,
        objective: args.prompt,
        workspace: trustedContext.workspace,
        files: [],
        contextFiles: [],
        skills: [],
        acceptanceCriteria: ["Return valid structured output"]
      }, trustedContext.workspace);
      return JSON.stringify(result);
    }
  });
}

function createGlmReadOnlyTool(model) {
  const modelLabel = { glm_5_2: "5.2", glm_5_2_highspeed: "5.2 HighSpeed", glm_5_3: "5.3", glm_5_3_flash: "5.3 Flash" }[model];
  return tool({
    description: `Delegates a read-only task to GLM ${modelLabel}. An optional workspace must be inside an allowed root and is read-only.`,
    args: {
      prompt: tool.schema.string().min(1).max(12000),
      workspace: tool.schema.string().min(1).optional()
    },
    async execute(args, context) {
      const trustedContext = resolveReadOnlyWorkspace(args.workspace, context);
      const result = await runtime.runGlm({
        taskId: crypto.randomUUID(),
        role: "analyst",
        model,
        mode: "read_only",
        objective: args.prompt,
        files: [],
        contextFiles: [],
        acceptanceCriteria: ["Return a concise, factual response"]
      }, trustedContext.workspace);
      return JSON.stringify(result);
    }
  });
}

function createGlmEditTool(profile, model, label) {
  return tool({
    description: `Delegates a controlled workspace-write edit to GLM ${label} through the canonical subagent bridge. Selected files and acceptance criteria are required.`,
    args: {
      prompt: tool.schema.string().min(1).max(60000),
      files: tool.schema.array(tool.schema.string().min(1)).min(1),
      contextFiles: tool.schema.array(tool.schema.string().min(1)).optional(),
      acceptanceCriteria: tool.schema.array(tool.schema.string().min(1)).min(1)
    },
    async execute(args, context) {
      const trustedContext = resolveTrustedWorkspace(context);
      const result = await runtime.runProfileEdit({
        profile,
        taskId: crypto.randomUUID(),
        role: "implementer",
        mode: "edit",
        model,
        objective: args.prompt,
        prompt: args.prompt,
        files: args.files,
        contextFiles: args.contextFiles || [],
        acceptanceCriteria: args.acceptanceCriteria
      }, trustedContext.workspace);
      return JSON.stringify(result);
    }
  });
}

export const geminiPro = createReadOnlyTool("gemini_pro");
export const geminiFlash = createReadOnlyTool("gemini_flash");
export const geminiFlash37 = createReadOnlyTool("gemini_flash_3_7");
export const geminiFlash38 = createReadOnlyTool("gemini_flash_3_8");
export const claudeSonnet = createReadOnlyTool("claude_sonnet");
export const codex = createCodexModelReadOnlyTool("gpt-6.1-sol", "GPT-6.1 Sol (default codex subagent)");
export const codexLunaEdit = createCodexEditTool("luna_implementation", "gpt-5.6-luna", "GPT-5.6 Luna");
export const codexTerraEdit = createCodexEditTool("implementation", "gpt-5.6-terra", "GPT-5.6 Terra");
export const codexSolEdit = createCodexEditTool("critical_implementation", "gpt-5.6-sol", "GPT-5.6 Sol");
export const codexAstra = createCodexModelReadOnlyTool("gpt-6-astra", "GPT-6 Astra");
export const codexAstraEdit = createCodexEditTool("astra_implementation", "gpt-6-astra", "GPT-6 Astra");
export const codexLuna6 = createCodexModelReadOnlyTool("gpt-6-luna", "GPT-6 Luna");
export const codexLuna6Edit = createCodexEditTool("luna6_implementation", "gpt-6-luna", "GPT-6 Luna");
export const codexSol6 = createCodexModelReadOnlyTool("gpt-6-sol", "GPT-6 Sol");
export const codexSol6Edit = createCodexEditTool("sol6_implementation", "gpt-6-sol", "GPT-6 Sol");
export const codexSol61 = createCodexModelReadOnlyTool("gpt-6.1-sol", "GPT-6.1 Sol");
export const claudeCode = createReadOnlyTool("native_claude");
export const deepseekPro = createDeepSeekReadOnlyTool("deepseek_pro");
export const deepseekFlash = createDeepSeekReadOnlyTool("deepseek_flash");
export const glm52 = createGlmReadOnlyTool("glm_5_2");
export const glm52HighSpeed = createGlmReadOnlyTool("glm_5_2_highspeed");
export const glm53 = createGlmReadOnlyTool("glm_5_3");
export const glm53Flash = createGlmReadOnlyTool("glm_5_3_flash");
export const glm52Edit = createGlmEditTool("glm_implementation", "glm_5_2", "5.2");
export const glm53Edit = createGlmEditTool("glm53_implementation", "glm_5_3", "5.3");
export const glm53FlashEdit = createGlmEditTool("glm53_flash_implementation", "glm_5_3_flash", "5.3 Flash");
export const health = tool({
  description: "Reports canonical Subagent Bridge provider health without executing a subagent task.",
  args: {},
  async execute(args, context) {
    return JSON.stringify(await runtime.health());
  }
});
export const workspaceContext = tool({
  description: "Reports the trusted active OpenCode workspace source and a non-reversible runtime fingerprint without exposing the workspace path.",
  args: {},
  async execute(args, context) {
    const trustedContext = resolveTrustedWorkspace(context);
    return JSON.stringify({
      source: trustedContext.source,
      workspaceFingerprint: runtime.inspectTrustedWorkspace(trustedContext.workspace).fingerprint,
      worktreeFingerprint: context.worktree ? runtime.inspectTrustedWorkspace(context.worktree).fingerprint : null,
      directoryFingerprint: context.directory ? runtime.inspectTrustedWorkspace(context.directory).fingerprint : null
    });
  }
});
