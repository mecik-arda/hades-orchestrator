import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadRuntimeConfiguration } from "../subagent-bridge/src/config.js";
import { checkDeepSeek } from "../subagent-bridge/src/deepseek.js";
import { checkPersistentMemory } from "../subagent-bridge/src/memory.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const configuration = loadRuntimeConfiguration();
const requiredFiles = [
  ".codex/config.toml",
  "AGENTS.md",
  "CLAUDE.md",
  "config/agent-rules.md",
  "config/agents.json",
  "config/deepseek-subagent-rules.md",
  "config/policy.json",
  "config/memory-evaluation.json",
  "scripts/evaluate-memory.js",
  "scripts/apply-agent-modes.js",
  "scripts/accept-glm-edit.js",
  "scripts/accept-glm-read-only.js",
  "scripts/pilot-glm-edit.js",
  "scripts/accept-deepseek-edit.js",
  "scripts/pilot-deepseek-edit.js",
  "scripts/manage-project-logs.js",
  "scripts/review-memory.js",
  "scripts/report-recent-runs.js",
  "scripts/prune-memory-audit.js",
  "subagent-bridge/src/memory-evaluation.js",
  "subagent-bridge/src/glm.js",
  "subagent-bridge/src/memory.js",
  "subagent-bridge/src/metrics.js",
  "subagent-bridge/src/project-runs.js",
  "subagent-bridge/src/recent-runs.js",
  "subagent-bridge/src/result.js",
  "subagent-bridge/src/retry.js",
  "subagent-bridge/src/services/disposable-workspace.js",
  "subagent-bridge/src/server.js",
  "subagent-bridge/schemas/deepseek-result.schema.json"
];

const fileChecks = requiredFiles.map((relativePath) => ({
  component: relativePath,
  ok: fs.existsSync(path.join(projectRoot, relativePath))
}));

const skillChecks = configuration.skills.allowed.map((skillName) => {
  const codexSkillPath = path.join(projectRoot, ".agents", "skills", skillName, "SKILL.md");
  const claudeSkillPath = path.join(projectRoot, ".claude", "skills", skillName, "SKILL.md");
  const codexExists = fs.existsSync(codexSkillPath);
  const claudeExists = fs.existsSync(claudeSkillPath);
  const codexHash = codexExists
    ? crypto.createHash("sha256").update(fs.readFileSync(codexSkillPath)).digest("hex")
    : null;
  const claudeHash = claudeExists
    ? crypto.createHash("sha256").update(fs.readFileSync(claudeSkillPath)).digest("hex")
    : null;
  return {
    skill: skillName,
    codexExists,
    claudeExists,
    synchronized: codexHash !== null && codexHash === claudeHash
  };
});

const codexCheck = configuration.codex
  ? spawnSync(configuration.codex.executable, ["--version"], {
    encoding: "utf8",
    windowsHide: true
  })
  : { status: 1, stdout: "", stderr: "Codex configuration unavailable" };
const deepSeekCheck = await checkDeepSeek(configuration);
const memoryCheck = checkPersistentMemory(configuration);

const report = {
  projectRoot,
  node: process.version,
  files: fileChecks,
  skills: skillChecks,
  codex: {
    ok: codexCheck.status === 0,
    version: (codexCheck.stdout || codexCheck.stderr || "").trim(),
    model: "gpt-5.6-sol",
    role: "lead"
  },
  deepSeek: {
    ok: deepSeekCheck.available,
    version: deepSeekCheck.version,
    model: deepSeekCheck.model,
    role: "read-edit-subagent"
  },
  memory: memoryCheck
};

console.log(JSON.stringify(report, null, 2));

const validFiles = fileChecks.every((item) => item.ok);
const validSkills = skillChecks.every((item) => item.codexExists && item.claudeExists && item.synchronized);
if (!validFiles || !validSkills || !report.codex.ok || !report.deepSeek.ok || !memoryCheck.readable || !memoryCheck.writable) {
  process.exitCode = 1;
}
