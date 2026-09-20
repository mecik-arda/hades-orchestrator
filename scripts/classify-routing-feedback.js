import { loadConfiguration } from "../subagent-bridge/src/config.js";
import { listRoutingCandidates, recordRoutingDisposition, routingDispositions } from "../subagent-bridge/src/metrics.js";

const configuration = loadConfiguration();
const [command, feedbackId, disposition, reason = "unspecified"] = process.argv.slice(2);

if (!command || command === "list") {
  console.log(JSON.stringify({ pendingCount: listRoutingCandidates(configuration).length, pending: listRoutingCandidates(configuration) }, null, 2));
} else if (command === "classify") {
  if (!feedbackId || !disposition) throw new Error(`feedback ID and disposition are required; use one of: ${routingDispositions.join(", ")}`);
  console.log(JSON.stringify(await recordRoutingDisposition(configuration, feedbackId, disposition, reason), null, 2));
} else {
  throw new Error("unsupported command; use list or classify <feedback-id> <disposition> [reason]");
}
