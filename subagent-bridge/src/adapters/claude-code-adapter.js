import fs from "node:fs";
import path from "node:path";
import { loadSkills, loadTextFile } from "../config.js";
import { createProviderEnvironment, runProcess, createExecutionHandle } from "../services/execution-service.js";
import { createAdapter } from "./agent-adapter-base.js";
import {
  createSuccessSubagentResult,
  createFailureSubagentResult,
  subagentResultSchema
} from "../schemas/core-schemas.js";
import { prependExecutionMetadata } from "../services/execution-metadata.js";

const activeExecutionHandles = new Map();

const CLAUDE_MODEL_MAP = {
  sonnet: "sonnet",
  opus: "opus",
  haiku: "haiku"
};

const READONLY_TOOLS = "Read,Glob,Grep";
const EDIT_TOOLS = "Read,Glob,Grep,Edit";

function createClaudeEnvironment(configuration) {
  return {
    ...createProviderEnvironment("claude_code"),
    CLAUDE_CODE_EFFORT_LEVEL: configuration?.claude_code?.effortLevel || process.env.CLAUDE_CODE_EFFORT_LEVEL || "high"
  };
}

function resolveModel(alias) {
  if (!alias || typeof alias !== "string") {
    return { valid: false, error: "model alias must be a non-empty string" };
  }
  if (CLAUDE_MODEL_MAP[alias]) {
    return { valid: true, model: CLAUDE_MODEL_MAP[alias] };
  }
  return { valid: false, error: `unsupported claude model alias: ${alias}` };
}

function buildEncapsulatedPrompt(request, guidance = {}) {
  const skillSections = (guidance.skills || []).flatMap((skill) => [
    `Etkin skill: ${skill.name}`,
    skill.content
  ]);
  const prompt = [
    request.mode === "edit"
      ? "Orkestratör, OpenCode oturumunda aktif kullanılan ana modeldir. Sen yalnız trusted workspace içinde değişiklik uygulayabilen Claude Code uzman subagent'sin."
      : "Orkestratör, OpenCode oturumunda aktif kullanılan ana modeldir. Sen salt okunur Claude Code uzman subagent'sin.",
    "Ortak başlangıç kuralları:",
    guidance.agentRules || "",
    "Subagent çalışma sınırları:",
    guidance.subagentRules || "",
    ...(skillSections.length > 0
      ? ["Aşağıdaki uzman skill talimatlarını analiz sınırları içinde uygula:", ...skillSections]
      : []),
    `Görev kimliği: ${request.executionId}`,
    `Amaç: ${request.prompt}`,
    "Kabul kriterleri:",
    ...(request.acceptanceCriteria || ["Görevi tamamla"]).map((criterion, index) => `${index + 1}. ${criterion}`),
    request.mode === "edit"
      ? "İstenen değişiklikleri uygula, doğrulama sonucunu yapılandırılmış biçimde döndür ve nihai kararı ana orkestratöre bırak."
      : "Kararı ana orkestratöre bırak ve yalnızca yapılandırılmış danışmanlık sonucu üret."
  ].join("\n");
  return prependExecutionMetadata(prompt, {
    backend: "claude_code",
    requestedModel: request.model || "sonnet",
    resolvedModel: guidance.resolvedModel || null,
    mode: request.mode
  });
}

function resolveClaudeResultModel(jsonOutput) {
  if (typeof jsonOutput?.model === "string" && jsonOutput.model.trim()) return jsonOutput.model.trim();
  if (!jsonOutput?.modelUsage || typeof jsonOutput.modelUsage !== "object" || Array.isArray(jsonOutput.modelUsage)) return null;
  const models = Object.keys(jsonOutput.modelUsage).filter((model) => model.trim());
  return models.length === 1 ? models[0] : null;
}

function classifyClaudeError(error, exitCode, stdout, stderr, jsonOutput) {
  if (jsonOutput && jsonOutput.is_error) {
    const result = String(jsonOutput.result || "").toLocaleLowerCase("en-US");

    if (/not logged in|please run.*login|authentication failed|invalid.*api.?key|unauthorized/i.test(result)) {
      return { valid: false, errorClass: "auth_invalid", reason: "claude code authentication required" };
    }

    if (/rate limit|429|too many requests|quota/i.test(result)) {
      return { valid: false, errorClass: "rate_limited", reason: "provider rate limited" };
    }

    if (/budget|max.budget|cost.*exceed/i.test(result)) {
      return { valid: false, errorClass: "budget_exceeded", reason: "budget exceeded" };
    }

    if (/max.*turns|turn.*limit|iteration.*limit/i.test(result)) {
      return { valid: false, errorClass: "max_turns_exceeded", reason: "maximum turns exceeded" };
    }

    if (/permission|access denied|forbidden/i.test(result)) {
      return { valid: false, errorClass: "permission_denied", reason: "permission denied" };
    }

    if (jsonOutput.terminal_reason === "api_error" && !error && exitCode === 0) {
      return { valid: false, errorClass: "provider_temporary_error", reason: jsonOutput.result || "api error" };
    }

    if (!jsonOutput.result) {
      return { valid: false, errorClass: "process_error", reason: "empty result" };
    }
  }

  if (error) {
    const message = String(error.message || error).toLocaleLowerCase("en-US");

    if (/timed out|timeout|zaman aşımı/i.test(message)) {
      return { valid: false, errorClass: "timeout", reason: "execution timed out" };
    }

    if (/enoent|not found|does not exist|command not found/i.test(message)) {
      return { valid: false, errorClass: "executable_missing", reason: "claude executable not found" };
    }

    return { valid: false, errorClass: "process_error", reason: message || "process error" };
  }

  if (exitCode !== null && exitCode !== 0) {
    return { valid: false, errorClass: "non_zero_exit", reason: `process exited with code ${exitCode}` };
  }

  return { valid: true };
}

function parseClaudeJson(stdout) {
  if (!stdout || !stdout.trim()) {
    return { ok: false, errorClass: "empty_output", json: null };
  }
  try {
    const json = JSON.parse(stdout.trim());
    return { ok: true, json };
  } catch {
    return { ok: false, errorClass: "malformed_output", json: null };
  }
}

function mapClaudeErrorToResult(errorClass, reason, backend, model, durationMs, retries, metrics = {}) {
  const base = {
    ok: false,
    backend,
    model,
    result: null,
    error: reason,
    reason,
    durationMs,
    metrics: { retries, ...metrics }
  };

  switch (errorClass) {
    case "timeout":
      return { ...base, retryable: false, timedOut: true, exitCode: null };
    case "auth_invalid":
      return { ...base, retryable: false, timedOut: false, exitCode: 1 };
    case "rate_limited":
      return { ...base, retryable: true, timedOut: false, exitCode: 1 };
    case "provider_temporary_error":
      return { ...base, retryable: true, timedOut: false, exitCode: 1 };
    case "budget_exceeded":
    case "max_turns_exceeded":
    case "permission_denied":
      return { ...base, retryable: false, timedOut: false, exitCode: 1 };
    case "executable_missing":
      return { ...base, retryable: false, timedOut: false, exitCode: null };
    case "non_zero_exit":
    case "process_error":
    case "malformed_output":
    case "empty_output":
    default:
      return { ...base, retryable: false, timedOut: false, exitCode: 1 };
  }
}

export function createClaudeCodeAdapter(configuration) {
  const adapter = createAdapter("claude_code", {
    canRead: true,
    canWrite: true,
    supportsSandbox: false,
    supportsModelSelection: true
  });

  return {
    ...adapter,

    async healthCheck() {
      try {
        const executable = configuration?.claude_code?.executable || "claude";
        const execArgs = configuration?.claude_code?.execArgs || [];
        const result = await runProcess(
          executable,
          [...execArgs, "--version"],
          { timeoutMs: 30000, maxOutputBytes: 1048576, env: createProviderEnvironment("claude_code") }
        );
        return {
          installed: result.code === 0,
          version: result.stdout.trim() || result.stderr.trim() || null,
          authValid: Boolean(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY),
          executable
        };
      } catch (error) {
        return {
          installed: false,
          version: null,
          authValid: false,
          executable: configuration?.claude_code?.executable || "claude",
          error: error.message
        };
      }
    },

    async execute(request) {
      const startedAt = Date.now();
      const model = resolveModel(request.model || "sonnet");
      if (!model.valid) {
        return createFailureSubagentResult("claude_code", request.model || "unknown", {
          error: model.error,
          durationMs: Date.now() - startedAt,
          retryable: false,
          exitCode: 1
        });
      }

      const environment = createClaudeEnvironment(configuration);

      const guidance = {
        agentRules: configuration?.agentRulesPath ? loadTextFile(configuration.agentRulesPath) : "",
        subagentRules: configuration?.subagentRulesPath ? loadTextFile(configuration.subagentRulesPath) : "",
        skills: configuration?.skills?.rootPath ? loadSkills(configuration, request.skills || []) : [],
        resolvedModel: model.model
      };

      const prompt = buildEncapsulatedPrompt(request, guidance);
      const isReadOnly = request.mode === "read_only";
      const executable = configuration?.claude_code?.executable || "claude";
      const execArgs = configuration?.claude_code?.execArgs || [];
      const timeoutMs = request.timeoutMs || configuration?.claude_code?.timeoutMs || 900000;
      const maxTurns = configuration?.claude_code?.maxTurns || 8;

      const args = [
        ...execArgs,
        "-p",
        "--output-format", "json",
        "--model", model.model,
        "--max-turns", String(maxTurns),
        "--strict-mcp-config",
        "--no-session-persistence"
      ];

      if (isReadOnly) {
        args.push("--permission-mode", "plan");
      } else {
        args.push("--permission-mode", "acceptEdits");
      }

      const schemaPath = path.join(configuration?.packageRoot || ".", "subagent-bridge", "schemas", "deepseek-result.schema.json");
      try {
        if (fs.existsSync(schemaPath)) {
          const schema = JSON.stringify(JSON.parse(fs.readFileSync(schemaPath, "utf8")));
          args.push("--json-schema", schema);
        }
      } catch {
      }

      const tools = isReadOnly ? READONLY_TOOLS : EDIT_TOOLS;
      args.push("--tools", tools);

      const handle = createExecutionHandle(request.executionId);
      activeExecutionHandles.set(request.executionId, handle);

      try {
        const processResult = await runProcess(
          executable,
          args,
          {
            cwd: request.workspace,
            env: environment,
            stdin: prompt,
            timeoutMs,
            maxOutputBytes: configuration?.claude_code?.maxOutputBytes || 8388608,
            abortController: handle.abortController,
            onSpawn: (child) => handle.attachChild(child)
          }
        );

        activeExecutionHandles.delete(request.executionId);

        const parsed = parseClaudeJson(processResult.stdout);
        if (!parsed.ok) {
          return mapClaudeErrorToResult(
            parsed.errorClass, "claude output parse failed",
            "claude_code", model.model,
            Date.now() - startedAt, 0
          );
        }

        const classification = classifyClaudeError(
          null,
          processResult.code,
          processResult.stdout,
          processResult.stderr,
          parsed.json
        );

        if (!classification.valid) {
          return mapClaudeErrorToResult(
            classification.errorClass, classification.reason || "unknown error",
            "claude_code", model.model,
            Date.now() - startedAt, 0,
            { totalCostUsd: Number.isFinite(parsed.json?.total_cost_usd) ? parsed.json.total_cost_usd : null }
          );
        }

        return createSuccessSubagentResult("claude_code", model.model, {
          result: JSON.stringify(parsed.json),
          durationMs: Date.now() - startedAt,
          resolvedModel: resolveClaudeResultModel(parsed.json),
          metrics: {
            totalCostUsd: Number.isFinite(parsed.json?.total_cost_usd) ? parsed.json.total_cost_usd : null
          }
        });
      } catch (error) {
        activeExecutionHandles.delete(request.executionId);

        const aborted = error.name === "AbortError" || handle.abortController.signal.aborted;
        if (aborted) {
          return createFailureSubagentResult("claude_code", model.model, {
            error: "execution cancelled",
            retryable: false,
            timedOut: false,
            exitCode: null,
            durationMs: Date.now() - startedAt,
            reason: "cancelled"
          });
        }

        const isTimeout = /timed out|timeout/i.test(error.message || "");
        if (isTimeout) {
          return createFailureSubagentResult("claude_code", model.model, {
            error: "execution timed out",
            retryable: false,
            timedOut: true,
            exitCode: null,
            durationMs: Date.now() - startedAt
          });
        }

        const classification = classifyClaudeError(error, null, "", "");
        return mapClaudeErrorToResult(
          classification.errorClass, classification.reason || error.message,
          "claude_code", model.model,
          Date.now() - startedAt, 0
        );
      }
    },

    async cancel(executionId) {
      const handle = activeExecutionHandles.get(executionId);
      if (handle) {
        handle.cancel();
        activeExecutionHandles.delete(executionId);
      }
    }
  };
}

export { CLAUDE_MODEL_MAP, resolveModel, classifyClaudeError, parseClaudeJson, buildEncapsulatedPrompt, resolveClaudeResultModel };
