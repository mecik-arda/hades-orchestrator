import path from "node:path";
import { loadConfiguration } from "../subagent-bridge/src/config.js";
import { memoryHookFeedbackClients, memoryHookFeedbackOutcomes, recordMemoryHookFeedback, summarizeMemoryHookFeedback } from "../subagent-bridge/src/metrics.js";
import { readMetricsDirectory } from "./report-metrics.js";

const configuration = loadConfiguration();
const [command, ...argumentsList] = process.argv.slice(2);

function optionValue(name) {
  const prefix = `--${name}=`;
  const argument = argumentsList.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
}

if (!command || command === "list") {
  const metricsDirectory = path.join(configuration.statePaths.logs, "metrics");
  console.log(JSON.stringify(summarizeMemoryHookFeedback(readMetricsDirectory(metricsDirectory)), null, 2));
} else if (memoryHookFeedbackOutcomes.includes(command)) {
  const client = optionValue("client") || "generic";
  const sessionId = optionValue("session-id");
  if (!sessionId) throw new Error("--session-id is required for a real hook session");
  if (!memoryHookFeedbackClients.includes(client)) throw new Error(`unsupported memory hook client; use one of: ${memoryHookFeedbackClients.join(", ")}`);
  console.log(JSON.stringify(await recordMemoryHookFeedback(configuration, { client, outcome: command, sessionId }), null, 2));
} else {
  throw new Error(`unsupported command; use list or one of: ${memoryHookFeedbackOutcomes.join(", ")}`);
}
