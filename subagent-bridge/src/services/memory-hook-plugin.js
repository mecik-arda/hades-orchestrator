import crypto from "node:crypto";
import { normalizeMemoryHookSessionId } from "./memory-hook-identity.js";

function diagnosticSessionIdHash(sessionId) {
  const normalizedSessionId = normalizeMemoryHookSessionId(sessionId);
  return normalizedSessionId ? crypto.createHash("sha256").update(normalizedSessionId).digest("hex") : null;
}

export function queryFromParts(parts, maxCharacters = 512) {
  const textParts = (Array.isArray(parts) ? parts : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string" && part.synthetic !== true)
    .map((part) => part.text);
  return textParts.join(" ").replace(/\s+/g, " ").trim().slice(0, maxCharacters);
}

export function createSecondBrainMemoryPlugin({ runHook, onContextInjected, onDiagnostic, projectCohort = "unassigned", maxSessionQueries = 50, now = () => performance.now() } = {}) {
  const latestQueries = new Map();
  const reportStatus = async (status, sessionID) => {
    try {
      await onDiagnostic?.({ status, sessionIdHash: diagnosticSessionIdHash(sessionID) });
    } catch {
    }
  };
  return {
    "chat.message": async (input, output) => {
      if (!input?.sessionID) {
        await reportStatus("chat_message_missing_session");
        return;
      }
      const query = queryFromParts(output?.parts);
      if (!query) {
        await reportStatus("chat_message_empty_query", input.sessionID);
        return;
      }
      latestQueries.delete(input.sessionID);
      latestQueries.set(input.sessionID, { query });
      while (latestQueries.size > maxSessionQueries) {
        latestQueries.delete(latestQueries.keys().next().value);
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input?.sessionID;
      if (!sessionID) {
        await reportStatus("system_transform_missing_session");
        return;
      }
      if (typeof runHook !== "function") {
        await reportStatus("system_transform_hook_unavailable", sessionID);
        return;
      }
      const queryState = latestQueries.get(sessionID);
      if (!queryState) {
        await reportStatus("system_transform_query_missing", sessionID);
        return;
      }
      if (!Array.isArray(output?.system)) {
        await reportStatus("system_transform_output_unavailable", sessionID);
        return;
      }
      const startedAt = now();
      let context;
      try {
        context = await runHook({ query: queryState.query });
      } catch {
        await reportStatus("memory_context_error", sessionID);
        return;
      }
      const durationMs = Math.max(0, Math.round(now() - startedAt));
      if (typeof context !== "string" || context.length === 0) {
        await reportStatus("memory_context_unavailable", sessionID);
        return;
      }
      const sessionIdHash = diagnosticSessionIdHash(sessionID);
      await reportStatus("memory_context_available", sessionID);
      if (!output.system.includes(context)) output.system.push(context);
      try {
        await onContextInjected?.({ sessionId: sessionID, sessionIdHash, durationMs, projectCohort });
      } catch {
      }
    }
  };
}
