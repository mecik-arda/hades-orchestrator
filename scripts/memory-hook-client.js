import { appendFileSync, statSync, truncateSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const clientArgument = process.argv.find((argument) => argument.startsWith("--client="));
const requestedClient = clientArgument ? clientArgument.slice("--client=".length) : "generic";
const diagnosticPath = path.join(os.tmpdir(), "subagent-memory-hook-error.log");
const diagnosticMaxBytes = 65536;

function recordDiagnostic(error) {
  try {
    const rawMessage = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
    const message = rawMessage.replace(/[A-Za-z]:\\[^\s"']+/g, "<path>").replace(/\s+/g, " ").slice(0, 300);
    try {
      if (statSync(diagnosticPath).size > diagnosticMaxBytes) truncateSync(diagnosticPath, 0);
    } catch {
    }
    appendFileSync(diagnosticPath, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
  }
}

try {
  const { memoryHookClientNames, runMemoryHookClient } = await import("../subagent-bridge/src/services/memory-hook-client.js");
  const { loadConfiguration } = await import("../subagent-bridge/src/config.js");
  const { recordMemoryHookSession } = await import("../subagent-bridge/src/metrics.js");
  const client = memoryHookClientNames.includes(requestedClient) ? requestedClient : "generic";
  await runMemoryHookClient({
    client,
    onContextInjected: async ({ sessionId, durationMs }) => {
      try {
        await recordMemoryHookSession(loadConfiguration(), { client, sessionId, durationMs });
      } catch {
      }
    }
  });
} catch (error) {
  recordDiagnostic(error);
}
