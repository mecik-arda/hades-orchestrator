import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";

const platformEnvironmentNames = ["APPDATA", "COMSPEC", "HOME", "LOCALAPPDATA", "NODE_PATH", "NVM_HOME", "NVM_SYMLINK", "PATH", "PATHEXT", "ProgramData", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "WINDIR"];
const providerEnvironmentNames = {
  antigravity: ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
  claude_code: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["CODEX_HOME", "OPENAI_API_KEY"],
  opencode: ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY"]
};

export function createProviderEnvironment(provider, source = process.env) {
  const names = new Set([...platformEnvironmentNames, ...(providerEnvironmentNames[provider] || [])]);
  const entries = [];
  for (const name of names) {
    if (source[name] !== undefined) entries.push([name, source[name]]);
  }
  return Object.fromEntries(entries);
}

export function createExecutionId() {
  return crypto.randomUUID();
}

export function runProcess(executable, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxOutputBytes = options.maxOutputBytes ?? 8388608;
  const abortController = options.abortController ?? new AbortController();

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env || createProviderEnvironment(options.provider),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      signal: abortController.signal,
      stdio: ["pipe", "pipe", "pipe"]
    });
    options.onSpawn?.(child);

    const stdoutChunks = [];
    const stderrChunks = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let forceTerminationTimer = null;

    const clearTimers = () => {
      clearTimeout(timer);
      if (forceTerminationTimer) clearTimeout(forceTerminationTimer);
    };

    const rejectAfterTermination = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      killProcessTree(child.pid);
      reject(error);
    };

    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        const timeoutError = new Error(`Process timed out after ${timeoutMs}ms`);
        const gracefulShutdownMs = options.gracefulShutdownMs ?? 0;
        if (gracefulShutdownMs > 0 && child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
          child.stdin.end();
          forceTerminationTimer = setTimeout(() => rejectAfterTermination(timeoutError), gracefulShutdownMs);
          forceTerminationTimer.unref?.();
        } else {
          rejectAfterTermination(timeoutError);
        }
      }
    }, timeoutMs);

    abortController.signal.addEventListener("abort", () => {
      if (!settled) {
        clearTimers();
      }
    }, { once: true });

    const collect = (chunks, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        if (!settled) {
          rejectAfterTermination(new Error(`Process output exceeded limit: ${maxOutputBytes} bytes`));
        }
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on("data", (chunk) => {
      collect(stdoutChunks, chunk);
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk) => {
      collect(stderrChunks, chunk);
      options.onStderr?.(chunk);
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimers();
        reject(timedOut ? new Error(`Process timed out after ${timeoutMs}ms`) : error);
      }
    });
    child.on("close", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimers();
        if (timedOut) {
          reject(new Error(`Process timed out after ${timeoutMs}ms`));
        } else {
          resolve({
            code,
            signal,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8")
          });
        }
      }
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    if (options.keepStdinOpen !== true) child.stdin.end();
  });
}

export function killProcessTree(pid) {
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
    } catch {
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
    }
  }
}

export function createExecutionHandle(executionId) {
  const abortController = new AbortController();
  let childProcess = null;
  let settled = false;

  return {
    executionId,
    abortController,
    attachChild(child) {
      childProcess = child;
    },
    cancel() {
      if (settled) return;
      settled = true;
      if (childProcess) {
        try {
          const pid = childProcess.pid;
          if (pid) killProcessTree(pid);
        } catch {
        }
      }
      abortController.abort();
    },
    isSettled() {
      return settled;
    }
  };
}
