import { loadConfiguration } from "../subagent-bridge/src/config.js";
import { pruneMemoryAuditFiles } from "../subagent-bridge/src/memory.js";

const configuration = loadConfiguration();
const deletedFiles = pruneMemoryAuditFiles(configuration);
console.log(JSON.stringify({ deletedFiles }, null, 2));
