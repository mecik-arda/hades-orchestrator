import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRuntimeDirectories, loadRuntimeConfiguration } from "../subagent-bridge/src/config.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const configuration = loadRuntimeConfiguration();
ensureRuntimeDirectories(configuration);
const runtime = createBridgeRuntime({ configuration });
const result = await runtime.runGlmEditPilot({
  taskId: "glm-edit-disposable-pilot",
  model: "glm_5_2",
  objective: "Add an exported subtract(left, right) function without changing the existing sum function.",
  files: ["pilot-workspace/src/sum.js"],
  contextFiles: [],
  acceptanceCriteria: [
    "Keep the existing sum function unchanged.",
    "Add an exported subtract function that returns left minus right.",
    "Do not use shell commands or access external directories."
  ],
  timeout_seconds: 300
}, projectRoot);
console.log(JSON.stringify(result, null, 2));
if (result.status !== "completed" || !result.cleanupCompleted || !result.filesChanged.includes("pilot-workspace/src/sum.js")) process.exitCode = 1;
