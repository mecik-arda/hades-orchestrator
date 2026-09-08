import { createProviderEnvironment, runProcess, createExecutionHandle } from "../services/execution-service.js";
import { createAdapter } from "./agent-adapter-base.js";
import { createSuccessSubagentResult, createFailureSubagentResult } from "../schemas/core-schemas.js";
import { prependExecutionMetadata } from "../services/execution-metadata.js";

const OPENCODE_MODEL_MAP = {
  deepseek: "deepseek/deepseek-chat",
  deepseek_pro: "deepseek/deepseek-v4-pro",
  kimi_k2_5_instruct: "moonshot/kimi-k2.5-instruct",
  kimi_k2_thinking: "moonshot/kimi-k2-thinking",
  qwen3_coder_480b: "alibaba/qwen3-coder-480b-a35b",
  qwen3_coder_plus: "alibaba/qwen3-coder-plus",
  qwen3_coder_30b: "alibaba/qwen3-coder-30b-a3b"
};

const ANTIGRAVITY_MODEL_ALIASES = new Set(["gemini", "gemini_pro", "gemini_flash", "gemini_flash_3_7", "gemini_flash_3_8", "claude_sonnet"]);

const activeExecutionHandles = new Map();

function resolveModel(alias, allowedModels) {
  if (!alias || typeof alias !== "string") {
    return { valid: false, error: "model alias must be a non-empty string" };
  }
  const normalizedAlias = alias.trim();
  if (ANTIGRAVITY_MODEL_ALIASES.has(normalizedAlias) || /^google\/gemini([_-]|$)/i.test(normalizedAlias) || /^gemini([_-]|$)/i.test(normalizedAlias)) {
    return { valid: false, error: "Gemini models must be routed through AntigravityAdapter" };
  }
  const model = alias.includes("/") ? alias : OPENCODE_MODEL_MAP[alias] || alias;
  if (Array.isArray(allowedModels) && !allowedModels.includes(model)) {
    return { valid: false, error: "OpenCode model is not allowed by policy" };
  }
  return { valid: true, model };
}

function parseOpenCodeOutput(stdout) {
  if (!stdout || !stdout.trim()) {
    return { ok: false, error: "empty output", text: null, usage: null };
  }

  const lines = stdout.trim().split("\n").filter(line => line.trim());
  let textContent = "";
  let finalUsage = null;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "text" && event.part?.text) {
        textContent += (textContent ? "\n" : "") + event.part.text;
      }
      if (event.type === "step_finish" && event.part?.tokens) {
        finalUsage = {
          tokens: event.part.tokens,
          cost: event.part.cost
        };
      }
    } catch {
    }
  }

  if (!textContent && !finalUsage) {
    return { ok: false, error: "no usable output", text: null, usage: null };
  }

  return { ok: true, text: textContent || null, usage: finalUsage };
}

function classifyOpenCodeError(error, exitCode, stdout, stderr) {
  if (error) {
    const message = String(error.message || error).toLocaleLowerCase("en-US");

    if (/timed out|timeout|zaman aşımı/i.test(message)) {
      return { valid: false, errorClass: "timeout", reason: "execution timed out" };
    }
    if (/enoent|not found|does not exist|command not found/i.test(message)) {
      return { valid: false, errorClass: "executable_missing", reason: "opencode executable not found" };
    }
    return { valid: false, errorClass: "process_error", reason: message || "process error" };
  }

  if (exitCode !== null && exitCode !== 0) {
    const output = `${stderr || ""} ${stdout || ""}`.toLocaleLowerCase("en-US");
    if (/auth|login|credential|unauthorized|api.key/i.test(output)) {
      return { valid: false, errorClass: "auth_invalid", reason: "authentication failure" };
    }
    if (/rate.limit|429|quota/i.test(output)) {
      return { valid: false, errorClass: "rate_limited", reason: "provider rate limited" };
    }
    return { valid: false, errorClass: "non_zero_exit", reason: `process exited with code ${exitCode}` };
  }

  return { valid: true };
}

function isOpenCodeRateLimitMessage(value) {
  return /quota exceeded|rate limit|429|too many requests/i.test(value);
}

function isOpenCodeModelAccessDeniedMessage(value) {
  return /subscription plan does not yet include access|plan does not include access|model access (?:is )?not included/i.test(value);
}

function buildOpenCodeArgs(request, configuration, model) {
  const args = [
    ...(configuration?.opencode?.execArgs || []),
    "run",
    "--print-logs",
    "--format", "json",
    "-m", model,
    "--dir", request.workspace,
    "--agent", request.mode === "read_only"
      ? (request.caller === "deepseek_opencode" ? configuration?.opencode?.deepSeekReadOnlyAgent || "plan" : "plan")
      : (["deepseek_edit", "deepseek_edit_pilot"].includes(request.caller)
        ? configuration?.opencode?.deepSeekEditAgent || "deepseek-edit"
        : ["glm_edit", "glm_edit_pilot"].includes(request.caller)
          ? configuration?.opencode?.glmEditAgent || "glm-edit"
          : ["kimi_edit", "kimi_edit_pilot"].includes(request.caller)
            ? configuration?.opencode?.kimiEditAgent || "kimi-edit"
            : ["qwen_edit", "qwen_edit_pilot"].includes(request.caller)
              ? configuration?.opencode?.qwenEditAgent || "qwen-edit"
          : configuration?.opencode?.editAgent || "build"),
    prependExecutionMetadata(request.prompt, {
      backend: "opencode",
      requestedModel: request.model,
      resolvedModel: model,
      mode: request.mode
    })
  ];
  return args;
}

export function createOpenCodeAdapter(configuration) {
  const adapter = createAdapter("opencode", {
    canRead: true,
    canWrite: true,
    supportsSandbox: true,
    supportsModelSelection: true
  });

  return {
    ...adapter,

    async healthCheck() {
      try {
        const executable = configuration?.opencode?.executable || "opencode";
        const execArgs = configuration?.opencode?.execArgs || [];
        const args = [...execArgs, "--version"];
        const result = await runProcess(
          executable,
          args,
          { timeoutMs: 15000, maxOutputBytes: 65536, env: createProviderEnvironment("opencode") }
        );
        return {
          installed: result.code === 0,
          version: result.stdout.trim() || result.stderr.trim() || null,
          authValid: result.code === 0,
          executable
        };
      } catch (error) {
        return {
          installed: false,
          version: null,
          authValid: false,
          executable: configuration?.opencode?.executable || "opencode",
          error: error.message
        };
      }
    },

    async execute(request) {
      const startedAt = Date.now();
      const model = resolveModel(request.model, configuration?.opencode?.allowedModels);
      if (!model.valid) {
        return createFailureSubagentResult("opencode", request.model || "unknown", {
          error: model.error,
          durationMs: Date.now() - startedAt,
          retryable: false,
          exitCode: 1
        });
      }

      const timeoutMs = request.timeoutMs || configuration?.opencode?.timeoutMs || 900000;
      const executable = configuration?.opencode?.executable || "opencode";
      const execArgs = configuration?.opencode?.execArgs || [];
      const args = buildOpenCodeArgs(request, configuration, model.model);

      const handle = createExecutionHandle(request.executionId);
      activeExecutionHandles.set(request.executionId, handle);
      let rateLimitDetected = false;
      let modelAccessDeniedDetected = false;

      try {
        const processResult = await runProcess(
          executable,
          args,
          {
            cwd: request.workspace,
            timeoutMs,
            maxOutputBytes: configuration?.opencode?.maxOutputBytes || 8388608,
            env: createProviderEnvironment("opencode"),
            abortController: handle.abortController,
            onSpawn: (child) => handle.attachChild(child),
            onStderr(chunk) {
              const output = chunk.toString("utf8");
              if (isOpenCodeRateLimitMessage(output)) {
                rateLimitDetected = true;
                handle.cancel();
              } else if (isOpenCodeModelAccessDeniedMessage(output)) {
                modelAccessDeniedDetected = true;
                handle.cancel();
              }
            }
          }
        );

        activeExecutionHandles.delete(request.executionId);

        if (rateLimitDetected || modelAccessDeniedDetected) {
          return createFailureSubagentResult("opencode", model.model, {
            error: modelAccessDeniedDetected ? "current subscription does not include access to the requested model" : "provider rate limited",
            retryable: rateLimitDetected && !modelAccessDeniedDetected,
            timedOut: false,
            exitCode: 1,
            durationMs: Date.now() - startedAt,
            reason: modelAccessDeniedDetected ? "model_access_denied" : "rate_limited"
          });
        }

        const parsed = parseOpenCodeOutput(processResult.stdout);
        if (!parsed.ok) {
          return createFailureSubagentResult("opencode", model.model, {
            error: parsed.error,
            durationMs: Date.now() - startedAt,
            exitCode: processResult.code || 1
          });
        }

        return createSuccessSubagentResult("opencode", model.model, {
          result: parsed.text || "",
          durationMs: Date.now() - startedAt,
          metrics: {
            totalCostUsd: Number.isFinite(parsed.usage?.cost) ? parsed.usage.cost : null
          },
          artifacts: parsed.usage ? {
            summary: JSON.stringify(parsed.usage)
          } : undefined
        });
      } catch (error) {
        activeExecutionHandles.delete(request.executionId);

        if (rateLimitDetected) {
          return createFailureSubagentResult("opencode", model.model, {
            error: "provider rate limited",
            retryable: true,
            timedOut: false,
            exitCode: 1,
            durationMs: Date.now() - startedAt,
            reason: "rate_limited"
          });
        }


        if (modelAccessDeniedDetected) {
          return createFailureSubagentResult("opencode", model.model, {
            error: "current subscription does not include access to the requested model",
            retryable: false,
            timedOut: false,
            exitCode: 1,
            durationMs: Date.now() - startedAt,
            reason: "model_access_denied"
          });
        }

        const aborted = error.name === "AbortError" || handle.abortController.signal.aborted;
        if (aborted) {
          return createFailureSubagentResult("opencode", model.model, {
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
          return createFailureSubagentResult("opencode", model.model, {
            error: "execution timed out",
            retryable: false,
            timedOut: true,
            exitCode: null,
            durationMs: Date.now() - startedAt
          });
        }

        const classification = classifyOpenCodeError(error, null, "", "");
        return createFailureSubagentResult("opencode", model.model, {
          error: classification.reason || error.message,
          retryable: classification.errorClass === "rate_limited" || classification.errorClass === "provider_temporary_error",
          timedOut: false,
          exitCode: 1,
          durationMs: Date.now() - startedAt
        });
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

export { OPENCODE_MODEL_MAP, resolveModel, parseOpenCodeOutput, classifyOpenCodeError, isOpenCodeRateLimitMessage, isOpenCodeModelAccessDeniedMessage, buildOpenCodeArgs };
