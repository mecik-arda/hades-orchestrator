import { loadConfiguration } from "../subagent-bridge/src/config.js";
import { recordMemoryHookHistoricalAttribution } from "../subagent-bridge/src/metrics.js";

const argumentsByName = new Map();
for (const argument of process.argv.slice(2)) {
  const separator = argument.indexOf("=");
  if (!argument.startsWith("--") || separator < 3) continue;
  const name = argument.slice(2, separator);
  if (["session-id", "confirm-session-id", "cohort", "basis"].includes(name) && !argumentsByName.has(name)) {
    argumentsByName.set(name, argument.slice(separator + 1));
  }
}

const sessionId = argumentsByName.get("session-id");
const confirmationSessionId = argumentsByName.get("confirm-session-id");
const projectCohort = argumentsByName.get("cohort");
const attributionBasis = argumentsByName.get("basis");

if (process.argv.slice(2).length !== 4 || !sessionId || !confirmationSessionId || !projectCohort || !attributionBasis) {
  process.exitCode = 1;
  console.log(JSON.stringify({ recorded: false, reason: "session_confirmation_required" }));
} else {
  try {
    const result = await recordMemoryHookHistoricalAttribution(loadConfiguration(), {
      client: "opencode",
      sessionId,
      confirmationSessionId,
      expectedSessionIdHash: process.env.SUBAGENT_MEMORY_HOOK_EXPECTED_SESSION_HASH,
      projectCohort,
      attributionBasis
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    const allowedReasons = new Set([
      "historical attribution client is not authorized",
      "historical attribution cohort and basis are not authorized",
      "historical attribution session confirmation mismatch",
      "historical attribution authorization unavailable",
      "historical attribution session is not authorized",
      "historical attribution session not found",
      "historical attribution session is not legacy",
      "historical attribution session is not eligible",
      "historical attribution outcome is not authorized",
      "historical attribution conflicts with existing attribution"
    ]);
    const reason = allowedReasons.has(error?.message) ? error.message : "historical_attribution_failed";
    process.exitCode = 1;
    console.log(JSON.stringify({ recorded: false, reason }));
  }
}
