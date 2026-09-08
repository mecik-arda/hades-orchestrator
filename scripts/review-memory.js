import { loadConfiguration } from "../subagent-bridge/src/config.js";
import { reviewPersistentMemory } from "../subagent-bridge/src/memory.js";

const configuration = loadConfiguration();
console.log(JSON.stringify(reviewPersistentMemory(configuration), null, 2));
