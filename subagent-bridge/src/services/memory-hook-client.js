import { createMemoryHook } from "./memory-hook.js";
import { normalizeMemoryHookSessionId } from "./memory-hook-identity.js";

export const memoryHookClientNames = Object.freeze(["generic", "claude", "codex"]);
export const memoryHookClientMaxQueryChars = 512;
export const memoryHookClientMaxInputBytes = 1048576;

export function parsePromptFromHookInput(rawInput) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawInput || ""));
  } catch {
    return "";
  }
  if (!parsed || typeof parsed.prompt !== "string") return "";
  return parsed.prompt.replace(/\s+/g, " ").trim().slice(0, memoryHookClientMaxQueryChars);
}

export function parseSessionIdFromHookInput(rawInput) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawInput || ""));
  } catch {
    return "";
  }
  for (const key of ["session_id", "sessionId", "sessionID"]) {
    const sessionId = normalizeMemoryHookSessionId(parsed?.[key]);
    if (sessionId) return sessionId;
  }
  return "";
}

export function formatMemoryHookClientOutput(client, context) {
  if (typeof context !== "string" || context.length === 0) return "";
  if (client === "claude" || client === "codex") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: context
      }
    });
  }
  return context;
}

async function readStreamLimited(stream, maxBytes = memoryHookClientMaxInputBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > maxBytes) break;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeOutput(output, formatted) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const errorListener = (error) => {
      if (settled) {
        if (typeof output?.off === "function") output.off("error", errorListener);
        return;
      }
      finish(error);
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (!error && typeof output?.off === "function") output.off("error", errorListener);
      if (error && typeof output?.off === "function") setImmediate(() => output.off("error", errorListener));
      if (error) reject(error);
      else resolve();
    };
    try {
      if (typeof output?.once === "function") output.once("error", errorListener);
      const result = output.write(formatted, finish);
      if (result && typeof result.then === "function") result.then(() => finish(), finish);
      else if (output.write.length < 2) finish();
    } catch (error) {
      finish(error);
    }
  });
}

function notifyContextInjected(onContextInjected, payload) {
  if (typeof onContextInjected !== "function") return;
  setImmediate(() => {
    try {
      const result = onContextInjected(payload);
      if (result && typeof result.then === "function") result.catch(() => {});
    } catch {
    }
  });
}

export async function runMemoryHookClient({ client = "generic", input = process.stdin, output = process.stdout, hook, onContextInjected, now = () => performance.now() } = {}) {
  if (!memoryHookClientNames.includes(client)) return { delivered: false };
  try {
    const rawInput = await readStreamLimited(input);
    const query = parsePromptFromHookInput(rawInput);
    const sessionId = parseSessionIdFromHookInput(rawInput);
    if (!query) return { delivered: false };
    const runHook = hook || createMemoryHook();
    const startedAt = now();
    const context = await runHook({ query });
    const durationMs = Math.max(0, Math.round(now() - startedAt));
    const formatted = formatMemoryHookClientOutput(client, typeof context === "string" ? context : "");
    if (!formatted) return { delivered: false };
    await writeOutput(output, formatted);
    if (sessionId) notifyContextInjected(onContextInjected, { sessionId, durationMs });
    return { delivered: true };
  } catch {
    return { delivered: false };
  }
}
