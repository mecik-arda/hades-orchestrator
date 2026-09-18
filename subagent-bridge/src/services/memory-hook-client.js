import { createMemoryHook } from "./memory-hook.js";

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

export async function runMemoryHookClient({ client = "generic", input = process.stdin, output = process.stdout, hook } = {}) {
  if (!memoryHookClientNames.includes(client)) return { delivered: false };
  try {
    const rawInput = await readStreamLimited(input);
    const query = parsePromptFromHookInput(rawInput);
    if (!query) return { delivered: false };
    const runHook = hook || createMemoryHook();
    const context = await runHook({ query });
    const formatted = formatMemoryHookClientOutput(client, typeof context === "string" ? context : "");
    if (!formatted) return { delivered: false };
    output.write(formatted);
    return { delivered: true };
  } catch {
    return { delivered: false };
  }
}
