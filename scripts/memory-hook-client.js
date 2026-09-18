import { memoryHookClientNames, runMemoryHookClient } from "../subagent-bridge/src/services/memory-hook-client.js";

const clientArgument = process.argv.find((argument) => argument.startsWith("--client="));
const requestedClient = clientArgument ? clientArgument.slice("--client=".length) : "generic";
const client = memoryHookClientNames.includes(requestedClient) ? requestedClient : "generic";

try {
  await runMemoryHookClient({ client });
} catch {
}
