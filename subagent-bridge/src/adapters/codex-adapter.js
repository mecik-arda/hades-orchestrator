import fs from "node:fs";
import path from "node:path";
import { createProviderEnvironment, runProcess, createExecutionHandle } from "../services/execution-service.js";
import { createAdapter } from "./agent-adapter-base.js";
import { createSuccessSubagentResult, createFailureSubagentResult } from "../schemas/core-schemas.js";
import { prependExecutionMetadata } from "../services/execution-metadata.js";

const activeExecutionHandles = new Map();
const FORBIDDEN_EXTERNAL_PROVIDER_MODEL_PATTERN = /^(?:google\/gemini-|deepseek\/)/i;

function resolveCodexModel(alias) {
  if (alias === "default") {
    return { valid: true, model: null };
  }
  if (!alias || typeof alias !== "string") {
    return { valid: false, error: "model alias must be a non-empty string" };
  }
  const model = alias.trim();
  if (!model) {
    return { valid: false, error: "model alias must be a non-empty string" };
  }
  if (FORBIDDEN_EXTERNAL_PROVIDER_MODEL_PATTERN.test(model)) {
    return { valid: false, error: "external provider model IDs are not supported by CodexAdapter" };
  }
  return { valid: true, model };
}

function classifyCodexError(error, exitCode, stdout, stderr) {
  if (error) {
    const message = String(error.message || error).toLocaleLowerCase("en-US");
    if (/timed out|timeout|zaman aşımı/i.test(message)) {
      return { valid: false, errorClass: "timeout", reason: "execution timed out" };
    }
    if (/enoent|not found|does not exist|command not found/i.test(message)) {
      return { valid: false, errorClass: "executable_missing", reason: "codex executable not found" };
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
    if (/invalid.*model|model.*not supported/i.test(output)) {
      return { valid: false, errorClass: "invalid_model", reason: "invalid model" };
    }
    if (/permission denied|sandbox (?:violation|denied)|approval required|not allowed/i.test(output)) {
      return { valid: false, errorClass: "permission_denied", reason: "permission denied" };
    }
    if (/not inside a trusted directory|skip-git-repo-check/i.test(output)) {
      return { valid: false, errorClass: "git_repository_required", reason: "Codex requires a Git repository" };
    }
    return { valid: false, errorClass: "non_zero_exit", reason: `process exited with code ${exitCode}` };
  }

  return { valid: true };
}

function parseCodexOutput(stdout) {
  if (!stdout || !stdout.trim()) {
    return { ok: false, error: "empty output", text: null };
  }
  return { ok: true, text: stdout.trim() };
}

function buildCodexArgs(request, configuration) {
  const model = resolveCodexModel(request.model || "default");
  if (!model.valid) {
    throw Object.assign(new Error(model.error), { failureClass: "invalid_model" });
  }
  const executable = configuration?.codex?.executable || "codex";
  const execArgs = configuration?.codex?.execArgs || [];
  const allowNonGitWorkspace = configuration?.codex?.allowNonGitWorkspace === true;
  const isGitWorkspace = typeof request.workspace === "string" && fs.existsSync(path.join(request.workspace, ".git"));
  return {
    executable,
    model: model.model,
    args: [
      ...execArgs,
      "exec",
      ...(allowNonGitWorkspace && !isGitWorkspace ? ["--skip-git-repo-check"] : []),
      ...(model.model ? ["--model", model.model] : []),
      "--sandbox", request.mode === "read_only" ? "read-only" : "workspace-write",
      prependExecutionMetadata(request.prompt, {
        backend: "codex",
        requestedModel: request.model || "default",
        resolvedModel: model.model,
        mode: request.mode
      })
    ]
  };
}

export function createCodexEnvironment(mode, source = process.env) {
  const environment = createProviderEnvironment("codex", source);
  if (mode !== "edit") return environment;
  const existingPytestOptions = String(source.PYTEST_ADDOPTS || "").trim();
  environment.PYTEST_ADDOPTS = [existingPytestOptions, "-p no:cacheprovider"].filter(Boolean).join(" ");
  environment.PYTHONDONTWRITEBYTECODE = "1";
  return environment;
}

export function createCodexAdapter(configuration) {
  const adapter = createAdapter("codex", {
    canRead: true,
    canWrite: true,
    supportsSandbox: true,
    supportsModelSelection: true
  });

  return {
    ...adapter,

    async healthCheck() {
      try {
        const executable = configuration?.codex?.executable || "codex";
        const execArgs = configuration?.codex?.execArgs || [];
        const args = [...execArgs, "--version"];
        const result = await runProcess(
          executable,
          args,
          { timeoutMs: 15000, maxOutputBytes: 65536, env: createProviderEnvironment("codex") }
        );
        let authValid = false;
        if (result.code === 0) {
          try {
            const authResult = await runProcess(
              executable,
              [...execArgs, "login", "status"],
              { timeoutMs: 15000, maxOutputBytes: 65536, env: createProviderEnvironment("codex") }
            );
            authValid = authResult.code === 0;
          } catch {
          }
        }
        return {
          installed: result.code === 0,
          version: result.stdout.trim() || result.stderr.trim() || null,
          authValid,
          executable
        };
      } catch (error) {
        return {
          installed: false,
          version: null,
          authValid: false,
          executable: configuration?.codex?.executable || "codex",
          error: error.message
        };
      }
    },

    async execute(request) {
      const startedAt = Date.now();
      const model = resolveCodexModel(request.model || "default");
      if (!model.valid) {
        return createFailureSubagentResult("codex", request.model || "unknown", {
          error: model.error,
          durationMs: Date.now() - startedAt,
          retryable: false,
          exitCode: 1
        });
      }
      const resultModel = model.model || "default";

      const timeoutMs = request.timeoutMs || configuration?.codex?.timeoutMs || 900000;
      const command = buildCodexArgs(request, configuration);

      const handle = createExecutionHandle(request.executionId);
      activeExecutionHandles.set(request.executionId, handle);

      try {
        const processResult = await runProcess(
            command.executable,
            command.args,
          {
            cwd: request.workspace,
            timeoutMs,
            maxOutputBytes: configuration?.codex?.maxOutputBytes || 8388608,
            env: createCodexEnvironment(request.mode),
            abortController: handle.abortController,
            onSpawn: (child) => handle.attachChild(child)
          }
        );

        activeExecutionHandles.delete(request.executionId);

        const classification = classifyCodexError(null, processResult.code, processResult.stdout, processResult.stderr);
        if (!classification.valid) {
          return createFailureSubagentResult("codex", resultModel, {
            error: classification.reason,
            retryable: classification.errorClass === "rate_limited",
            timedOut: false,
            exitCode: processResult.code ?? 1,
            durationMs: Date.now() - startedAt,
            reason: classification.errorClass
          });
        }

        const parsed = parseCodexOutput(processResult.stdout);
        if (!parsed.ok) {
          return createFailureSubagentResult("codex", resultModel, {
            error: parsed.error,
            durationMs: Date.now() - startedAt,
            exitCode: processResult.code || 1
          });
        }

        return createSuccessSubagentResult("codex", resultModel, {
          result: parsed.text || "",
          durationMs: Date.now() - startedAt
        });
      } catch (error) {
        activeExecutionHandles.delete(request.executionId);

        const aborted = error.name === "AbortError" || handle.abortController.signal.aborted;
        if (aborted) {
          return createFailureSubagentResult("codex", resultModel, {
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
          return createFailureSubagentResult("codex", resultModel, {
            error: "execution timed out",
            retryable: false,
            timedOut: true,
            exitCode: null,
            durationMs: Date.now() - startedAt
          });
        }

        const classification = classifyCodexError(error, null, "", "");
        return createFailureSubagentResult("codex", resultModel, {
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

export { resolveCodexModel, classifyCodexError, parseCodexOutput, buildCodexArgs };
