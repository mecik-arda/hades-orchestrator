import { loadConfiguration } from "../subagent-bridge/src/config.js";
import { directEditFeedbackOutcomes, listPendingDirectEditFeedback, recordDirectEditFeedback } from "../subagent-bridge/src/metrics.js";

const configuration = loadConfiguration();
const [command, feedbackId] = process.argv.slice(2);

if (!command || command === "list") {
  const pending = listPendingDirectEditFeedback(configuration);
  console.log(JSON.stringify({ pendingCount: pending.length, pending }, null, 2));
} else if (directEditFeedbackOutcomes.includes(command)) {
  const pending = listPendingDirectEditFeedback(configuration);
  const selectedFeedbackId = feedbackId || (pending.length === 1 ? pending[0].feedbackId : null);
  if (!selectedFeedbackId) throw new Error("feedback ID is required when pending edit count is not one");
  console.log(JSON.stringify(await recordDirectEditFeedback(configuration, selectedFeedbackId, command), null, 2));
} else {
  throw new Error(`unsupported command; use list or one of: ${directEditFeedbackOutcomes.join(", ")}`);
}
