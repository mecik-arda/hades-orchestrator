import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loadConfiguration } from "../subagent-bridge/src/config.js";
import { clearProjectMirror, disableProjectMirror, enableProjectMirror, getProjectMirrorStatus, isGitWorkspace, readProjectMirror } from "../subagent-bridge/src/project-runs.js";

async function confirm(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("interactive approval requires a terminal");
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(`${question} [y/N] `)).trim().toLocaleLowerCase("en-US") === "y";
  } finally {
    terminal.close();
  }
}

export async function manageProjectLogs(configuration, workspace, argumentsList) {
  const [command, ...rest] = argumentsList;
  if (!command || rest.some((argument) => argument !== "--confirm") || rest.filter((argument) => argument === "--confirm").length > 1) {
    throw new Error("use enable, disable, status, view, or clear --confirm");
  }
  if (command === "enable") {
    if (rest.length > 0) throw new Error("enable does not accept arguments");
    const gitWorkspace = isGitWorkspace(workspace);
    const approved = await confirm(gitWorkspace ? "Enable project mirror and add .hades/ to .gitignore?" : "Enable project mirror in this non-Git workspace?");
    if (!approved) return { enabled: false, cancelled: true };
    return enableProjectMirror(configuration, workspace, gitWorkspace ? { gitIgnore: approved } : { nonGitWrite: approved });
  }
  if (command === "disable" && rest.length === 0) return disableProjectMirror(configuration, workspace);
  if (command === "status" && rest.length === 0) return getProjectMirrorStatus(configuration, workspace);
  if (command === "view" && rest.length === 0) return readProjectMirror(configuration, workspace);
  if (command === "clear" && rest.length === 1 && rest[0] === "--confirm") return clearProjectMirror(configuration, workspace, true);
  throw new Error("use enable, disable, status, view, or clear --confirm");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = fs.realpathSync(process.cwd());
  console.log(JSON.stringify(await manageProjectLogs(loadConfiguration(), workspace, process.argv.slice(2)), null, 2));
}
