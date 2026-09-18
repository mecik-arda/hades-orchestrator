import { loadConfiguration } from "../subagent-bridge/src/config.js";
import { applyMemoryVaultRepair, memoryRepairKinds, planMemoryVaultRepair } from "../subagent-bridge/src/memory.js";

const configuration = loadConfiguration();
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const force = args.includes("--force");
const kindArgument = args.find((argument) => argument.startsWith("--kind="));
const kind = kindArgument ? kindArgument.slice("--kind=".length) : "vault-schema";
const relativePaths = args
  .filter((argument) => argument.startsWith("--path="))
  .map((argument) => argument.slice("--path=".length));

try {
  const plan = planMemoryVaultRepair(configuration, { kind });
  const result = apply
    ? applyMemoryVaultRepair(configuration, { kind, relativePaths, force })
    : plan;
  console.log(JSON.stringify(result, null, 2));
  if (apply && result.applied !== true) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({
    error: "repair_failed",
    message: error.message,
    supportedKinds: memoryRepairKinds
  }, null, 2));
  process.exitCode = 1;
}
