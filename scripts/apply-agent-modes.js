import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgentsConfig } from "../subagent-bridge/src/config.js";
import { getPersonalBridgeLayout } from "../subagent-bridge/src/personal-layout.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.resolve(scriptDirectory, "..", "config", "agents.json");
const layout = getPersonalBridgeLayout();
const agentsPath = process.env.SUBAGENT_BRIDGE_AGENTS_CONFIG || layout.agentsPath;
const backupDirectory = path.join(path.dirname(agentsPath), "backups");
const action = process.argv[2] || "apply";

if (action === "rollback") {
  const backupName = process.argv[3];
  if (!backupName || path.basename(backupName) !== backupName || !/^agents-[0-9T-]+Z\.json$/.test(backupName)) {
    throw new Error("rollback requires a backup file name created by config:apply-agent-modes");
  }
  const backupPath = path.join(backupDirectory, backupName);
  if (!fs.existsSync(backupPath)) throw new Error("requested agent mode backup does not exist");
  const backup = fs.readFileSync(backupPath, "utf8");
  const validation = validateAgentsConfig(JSON.parse(backup));
  if (!validation.success) throw new Error("requested agent mode backup is invalid");
  const temporaryPath = `${agentsPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, backup, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporaryPath, agentsPath);
  console.log(JSON.stringify({ restored: backupName }, null, 2));
  process.exit(0);
}

if (action !== "apply") throw new Error("use config:apply-agent-modes or config:rollback-agent-modes -- <backup-file>");
const current = JSON.parse(fs.readFileSync(agentsPath, "utf8"));
const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
const agents = {};

for (const [backend, currentAgent] of Object.entries(current.agents || {})) {
  const templateAgent = template.agents?.[backend];
  if (!templateAgent) {
    agents[backend] = currentAgent;
    continue;
  }
  const candidate = {
    ...currentAgent,
    defaultMode: templateAgent.defaultMode,
    allowedModes: templateAgent.allowedModes
  };
  delete candidate.mode;
  if (templateAgent.deepSeekReadOnlyAgent) candidate.deepSeekReadOnlyAgent = templateAgent.deepSeekReadOnlyAgent;
  if (templateAgent.deepSeekEditAgent) candidate.deepSeekEditAgent = templateAgent.deepSeekEditAgent;
  if (templateAgent.glmEditAgent) candidate.glmEditAgent = templateAgent.glmEditAgent;
  if (templateAgent.kimiEditAgent) candidate.kimiEditAgent = templateAgent.kimiEditAgent;
  if (templateAgent.qwenEditAgent) candidate.qwenEditAgent = templateAgent.qwenEditAgent;
  if (templateAgent.editAgent) candidate.editAgent = templateAgent.editAgent;
  if (templateAgent.allowedModels) candidate.allowedModels = [...new Set([...(currentAgent.allowedModels || []), ...templateAgent.allowedModels])];
  agents[backend] = candidate;
}

const candidate = { agents };
const validation = validateAgentsConfig(candidate);
if (!validation.success) throw new Error(`agent mode configuration is invalid: ${validation.error.issues.map((issue) => issue.message).join("; ")}`);
fs.mkdirSync(backupDirectory, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupName = `agents-${timestamp}.json`;
fs.copyFileSync(agentsPath, path.join(backupDirectory, backupName), fs.constants.COPYFILE_EXCL);
const temporaryPath = `${agentsPath}.${process.pid}.tmp`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(candidate, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
fs.renameSync(temporaryPath, agentsPath);
console.log(JSON.stringify({
  applied: true,
  backup: backupName,
  modePolicies: Object.fromEntries(Object.entries(agents).map(([backend, agent]) => [backend, {
    defaultMode: agent.defaultMode,
    allowedModes: agent.allowedModes
  }]))
}, null, 2));
