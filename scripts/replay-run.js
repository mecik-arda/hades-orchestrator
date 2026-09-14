import path from "node:path";
import { loadConfiguration } from "../subagent-bridge/src/config.js";
import { projectRunManifest, selectReplayRecord } from "../subagent-bridge/src/replay.js";
import { readMetricsDirectory } from "./report-metrics.js";

const executionHashArgument = process.argv.find((argument) => argument.startsWith("--execution-hash="));
const executionIdHash = executionHashArgument ? executionHashArgument.split("=", 2)[1] : null;
const useLatest = process.argv.includes("--latest") || !executionIdHash;
const configuration = loadConfiguration();
const metricsDirectory = path.join(configuration.statePaths.logs, "metrics");
const records = readMetricsDirectory(metricsDirectory);
const selected = selectReplayRecord(records, { executionIdHash, latest: useLatest });
if (!selected) {
  console.error(JSON.stringify({ replay: true, providerCalls: 0, selected: false, reason: executionIdHash ? "execution hash not found" : "no manifest records" }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    replay: true,
    providerCalls: 0,
    selected: true,
    selector: executionIdHash ? "execution_hash" : "latest",
    manifest: projectRunManifest(selected)
  }, null, 2));
}
