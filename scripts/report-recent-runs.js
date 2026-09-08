import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfiguration } from "../subagent-bridge/src/config.js";
import { parseRecentRunsArguments, readRecentRuns } from "../subagent-bridge/src/recent-runs.js";

export function reportRecentRuns(configuration, argumentsList = []) {
  return readRecentRuns(configuration, parseRecentRunsArguments(argumentsList));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(reportRecentRuns(loadConfiguration(), process.argv.slice(2)), null, 2));
}
