export function queryFromParts(parts, maxCharacters = 512) {
  const textParts = (Array.isArray(parts) ? parts : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string" && part.synthetic !== true)
    .map((part) => part.text);
  return textParts.join(" ").replace(/\s+/g, " ").trim().slice(0, maxCharacters);
}

export function createSecondBrainMemoryPlugin({ runHook, onContextInjected, maxSessionQueries = 50 } = {}) {
  const latestQueries = new Map();
  return {
    "chat.message": async (input, output) => {
      if (!input?.sessionID) return;
      const query = queryFromParts(output?.parts);
      if (!query) return;
      latestQueries.delete(input.sessionID);
      latestQueries.set(input.sessionID, { query, startedAt: Date.now() });
      while (latestQueries.size > maxSessionQueries) {
        latestQueries.delete(latestQueries.keys().next().value);
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input?.sessionID;
      if (!sessionID || typeof runHook !== "function") return;
      const queryState = latestQueries.get(sessionID);
      if (!queryState || !Array.isArray(output?.system)) return;
      const context = await runHook({ query: queryState.query });
      if (typeof context === "string" && context.length > 0 && !output.system.includes(context)) {
        output.system.push(context);
        setImmediate(() => {
          try {
            const result = onContextInjected?.({ sessionId: sessionID, durationMs: Date.now() - queryState.startedAt });
            if (result && typeof result.then === "function") result.catch(() => {});
          } catch {
          }
        });
      }
    }
  };
}
