import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfiguration } from "../subagent-bridge/src/config.js";
import { getPersonalBridgeLayout } from "../subagent-bridge/src/personal-layout.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.resolve(scriptDirectory, "..", "config", "policy.json");
const layout = getPersonalBridgeLayout();
const configurationPath = process.env.ORCHESTRATOR_CONFIG || layout.configPath;
const backupDirectory = path.join(path.dirname(configurationPath), "backups");
const current = JSON.parse(fs.readFileSync(configurationPath, "utf8"));
const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
const candidate = {
  ...current,
  kimi: template.kimi,
  qwen: template.qwen,
  reliability: template.reliability,
  orchestration: {
    ...current.orchestration,
    taskProfiles: template.orchestration.taskProfiles
  }
};
const validation = validateConfiguration(candidate);
if (!validation.success) throw new Error(`provider routing configuration is invalid: ${validation.error.issues.map((issue) => issue.message).join("; ")}`);
fs.mkdirSync(backupDirectory, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupName = `config-${timestamp}.json`;
fs.copyFileSync(configurationPath, path.join(backupDirectory, backupName), fs.constants.COPYFILE_EXCL);
const temporaryPath = `${configurationPath}.${process.pid}.tmp`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(candidate, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
fs.renameSync(temporaryPath, configurationPath);
console.log(JSON.stringify({ applied: true, backup: backupName, profiles: Object.keys(candidate.orchestration.taskProfiles) }, null, 2));
