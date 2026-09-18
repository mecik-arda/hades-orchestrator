import { loadConfiguration } from "../subagent-bridge/src/config.js";
import {
  classifyLegacyDirectEditFeedback,
  directEditDispositions,
  listDirectEditDispositions,
  listPendingDirectEditFeedback,
  recordDirectEditDisposition
} from "../subagent-bridge/src/metrics.js";

const configuration = loadConfiguration();
const [command = "list", ...rest] = process.argv.slice(2);
const options = Object.fromEntries(rest
  .filter((argument) => argument.startsWith("--"))
  .map((argument) => {
    const separatorIndex = argument.indexOf("=");
    return separatorIndex === -1
      ? [argument.slice(2), "true"]
      : [argument.slice(2, separatorIndex), argument.slice(separatorIndex + 1)];
  }));
const positionals = rest.filter((argument) => !argument.startsWith("--"));

if (command === "list") {
  const pending = listPendingDirectEditFeedback(configuration);
  const dispositions = listDirectEditDispositions(configuration);
  const ineligibleCount = dispositions.count - dispositions.counts.eligible_real_user;
  console.log(JSON.stringify({
    pendingCount: pending.length,
    ineligibleCount,
    dispositionCount: dispositions.count,
    dispositionCounts: dispositions.counts,
    availableDispositions: directEditDispositions,
    pendingFeedbackIds: pending.slice(0, 20).map((entry) => entry.feedbackId)
  }, null, 2));
} else if (command === "dispose") {
  const [disposition, feedbackId] = positionals;
  console.log(JSON.stringify(await recordDirectEditDisposition(configuration, feedbackId, disposition, options.reason || "unspecified"), null, 2));
} else if (command === "classify-legacy") {
  if (!options.before) throw new Error("--before=<ISO-8601> is required");
  const result = await classifyLegacyDirectEditFeedback(configuration, {
    before: options.before,
    disposition: options.disposition || "indeterminate_legacy",
    reason: options.reason || "provenance_unverifiable_legacy"
  });
  console.log(JSON.stringify(result, null, 2));
} else {
  throw new Error("unsupported command; use list, dispose <disposition> <feedbackId> --reason=... or classify-legacy --before=<ISO> [--disposition=...] [--reason=...]");
}
