import { loadRuntimeConfiguration } from "../subagent-bridge/src/config.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";

const runtime = createBridgeRuntime({ configuration: loadRuntimeConfiguration() });
const result = await runtime.runDeepSeek({
  taskId: "orchestrator-improvement-review",
  role: "reviewer",
  model: "deepseek_pro",
  objective: "Orkestrasyon projesinin mimarisini incele. Doğrudan OpenCode DeepSeek Pro/Flash provider yolu, provider güvenilirliği ve maliyeti, cross-process workspace coordination, telemetry, structured result normalization, test/acceptance kapsaması ve bakım yükü için yalnız yüksek etkili uygulanabilir önerileri kritik, yüksek ve orta önceliklerle sırala. Her öneriyi ilgili dosya veya doğrulanabilir kanıtla destekle. Silent provider fallback önerme.",
  workspace: process.cwd(),
  files: [
    "subagent-bridge/src/deepseek.js",
    "subagent-bridge/src/adapters/opencode-adapter.js",
    "subagent-bridge/src/runtime/bridge-runtime.js",
    "subagent-bridge/src/services/workspace-coordinator.js",
    "subagent-bridge/src/services/read-only-cache.js",
    "subagent-bridge/src/metrics.js",
    "subagent-bridge/src/services/reliability-budget.js",
    "config/policy.json",
    "scripts/pilot-mcp.js",
    "scripts/report-metrics.js"
  ],
  contextFiles: ["AGENTS.md", "package.json", "tests/reliability.test.js", "tests/optimization.test.js", "tests/faz-p0-runtime.test.js"],
  skills: ["kod-denetleyicisi"],
  acceptanceCriteria: [
    "Öneriler doğrudan gözlenen koda dayanmalı.",
    "Secret veya ham workspace içeriği rapora dahil edilmemeli.",
    "Yalnız uygulanabilir, önceliklendirilmiş öneriler dönmeli."
  ]
}, process.cwd());
console.log(JSON.stringify(result.result, null, 2));
