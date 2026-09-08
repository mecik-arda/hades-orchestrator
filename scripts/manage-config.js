import fs from "node:fs";
import path from "node:path";
import { loadConfiguration } from "../subagent-bridge/src/config.js";
import { getPersonalBridgeLayout } from "../subagent-bridge/src/personal-layout.js";

const action = process.argv[2];
const layout = getPersonalBridgeLayout();
const configurationPath = process.env.ORCHESTRATOR_CONFIG || layout.configPath;
const backupDirectory = path.join(path.dirname(configurationPath), "backups");

if (action === "backup") {
  loadConfiguration({ configurationPath });
  fs.mkdirSync(backupDirectory, { recursive: true });
  const name = `config-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const backupPath = path.join(backupDirectory, name);
  fs.copyFileSync(configurationPath, backupPath, fs.constants.COPYFILE_EXCL);
  console.log(JSON.stringify({ action, backup: name }, null, 2));
} else if (action === "rollback") {
  const name = process.argv[3];
  if (!name || path.basename(name) !== name || !/^config-[0-9T-]+Z\.json$/.test(name)) {
    throw new Error("rollback requires a backup file name created by config:backup");
  }
  const backupPath = path.join(backupDirectory, name);
  if (!fs.existsSync(backupPath)) throw new Error("requested backup does not exist");
  loadConfiguration({ configurationPath: backupPath });
  const temporaryPath = `${configurationPath}.${process.pid}.tmp`;
  fs.copyFileSync(backupPath, temporaryPath);
  fs.renameSync(temporaryPath, configurationPath);
  console.log(JSON.stringify({ action, restored: name }, null, 2));
} else {
  throw new Error("use config:backup or config:rollback <backup-file>");
}
