import { createDefaultStatePaths } from "../subagent-bridge/src/config.js";
import { applyRuntimeStateMigration, planRuntimeStateMigration } from "../subagent-bridge/src/runtime-state-migration.js";

const stateRoot = createDefaultStatePaths().state;
const apply = process.argv.includes("--apply");
const result = apply
  ? applyRuntimeStateMigration({ stateRoot })
  : planRuntimeStateMigration({ stateRoot });
console.log(JSON.stringify(result, null, 2));
