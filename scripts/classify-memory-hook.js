import { loadConfiguration } from "../subagent-bridge/src/config.js";
import { memoryHookDispositions, memoryHookFeedbackClients, recordMemoryHookDisposition } from "../subagent-bridge/src/metrics.js";

const configuration = loadConfiguration();
const [disposition, ...argumentsList] = process.argv.slice(2);

function optionValue(name) {
  const prefix = `--${name}=`;
  const argument = argumentsList.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
}

if (!memoryHookDispositions.includes(disposition)) throw new Error(`unsupported disposition; use one of: ${memoryHookDispositions.join(", ")}`);
const client = optionValue("client") || "generic";
const sessionId = optionValue("session-id");
const reason = optionValue("reason") || "operator_review";
if (!sessionId) throw new Error("--session-id is required");
if (!memoryHookFeedbackClients.includes(client)) throw new Error(`unsupported memory hook client; use one of: ${memoryHookFeedbackClients.join(", ")}`);
console.log(JSON.stringify(await recordMemoryHookDisposition(configuration, { client, disposition, reason, sessionId }), null, 2));
