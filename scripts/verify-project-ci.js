import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfiguration, loadAgentsConfig } from "../subagent-bridge/src/config.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const configurationPath = path.join(projectRoot, "config", "policy.json");
const agentsPath = path.join(projectRoot, "config", "agents.json");
const configuration = loadConfiguration({ configurationPath });
loadAgentsConfig({ agentsPath });

const requiredFiles = [
  ".codex/config.toml",
  "AGENTS.md",
  "CLAUDE.md",
  "config/agent-rules.md",
  "config/agents.json",
  "config/deepseek-subagent-rules.md",
  "config/policy.json",
  "scripts/apply-agent-modes.js",
  "scripts/accept-glm-edit.js",
  "scripts/accept-glm-read-only.js",
  "scripts/pilot-glm-edit.js",
  "scripts/accept-deepseek-edit.js",
  "scripts/pilot-deepseek-edit.js",
  "scripts/manage-project-logs.js",
  "scripts/report-recent-runs.js",
  "subagent-bridge/src/project-runs.js",
  "subagent-bridge/src/recent-runs.js",
  "subagent-bridge/src/glm.js",
  "subagent-bridge/src/services/disposable-workspace.js",
  "subagent-bridge/src/server.js"
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
  const codexHash = codexExists ? crypto.createHash("sha256").update(fs.readFileSync(codexSkillPath)).digest("hex") : null;
  const claudeHash = claudeExists ? crypto.createHash("sha256").update(fs.readFileSync(claudeSkillPath)).digest("hex") : null;
  return { skill: skillName, synchronized: codexHash !== null && codexHash === claudeHash };
});

const report = {
  node: process.version,
  configurationVersion: configuration.configurationVersion,
  files: fileChecks,
  skills: skillChecks
};

console.log(JSON.stringify(report, null, 2));

if (!fileChecks.every((item) => item.ok) || !skillChecks.every((item) => item.synchronized)) process.exitCode = 1;
