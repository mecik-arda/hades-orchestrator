import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const batchIdPattern = /^[a-f0-9]{16,64}$/;
const inheritedEnvironmentNames = [
  "APPDATA",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "ProgramData",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
  "ORCHESTRATOR_CONFIG"
];

function inheritedEnvironment(source) {
  return Object.fromEntries(inheritedEnvironmentNames
    .filter((name) => source[name] !== undefined)
    .map((name) => [name, source[name]]));
}

function resolveWindowsTerminal() {
  try {
    return execFileSync("where.exe", ["wt.exe"], { encoding: "utf8", timeout: 2000, windowsHide: true })
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find(Boolean) || null;
  } catch {
    return null;
  }
}

function resolvePrimaryScreenBounds(powershellExecutable) {
  const command = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $area=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; [Console]::WriteLine($area.Left.ToString() + ',' + $area.Top.ToString() + ',' + $area.Right.ToString() + ',' + $area.Bottom.ToString())";
  try {
    const values = execFileSync(powershellExecutable, ["-NoLogo", "-NoProfile", "-Command", command], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true
    }).trim().split(",").map(Number);
    if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return null;
    return { left: values[0], top: values[1], right: values[2], bottom: values[3] };
  } catch {
    return null;
  }
}

function floatingWindowPosition(bounds) {
  if (!bounds) return null;
  const left = Math.max(bounds.left + 12, bounds.right - 460);
  const top = Math.min(bounds.bottom - 420, bounds.top + 64);
  return `${left},${Math.max(bounds.top + 12, top)}`;
}

function launch(executable, args, options, spawnProcess) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(executable, args, options);
    } catch {
      resolve({ opened: false, reason: "spawn_failed" });
      return;
    }
    child.once("error", () => resolve({ opened: false, reason: "spawn_failed" }));
    child.once("spawn", () => {
      child.unref?.();
      resolve({ opened: true });
    });
  });
}

export function createParallelDashboardLauncher({
  enabled = false,
  platform = process.platform,
  packageRoot,
  stateDirectory,
  nodeExecutable = process.execPath,
  powershellExecutable,
  terminalPathResolver = resolveWindowsTerminal,
  screenBoundsResolver = resolvePrimaryScreenBounds,
  spawnProcess = spawn,
  environment = process.env
} = {}) {
  const root = packageRoot ? path.resolve(packageRoot) : null;
  const state = stateDirectory ? path.resolve(stateDirectory) : null;
  const scriptPath = root ? path.join(root, "scripts", "watch-parallel-batch.js") : null;
  const wrapperPath = root ? path.join(root, "scripts", "watch-parallel-batch.ps1") : null;
  const powershell = powershellExecutable || path.join(environment.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

  async function open(batchId) {
    if (!enabled) return { opened: false, reason: "disabled" };
    if (platform !== "win32") return { opened: false, reason: "unsupported_platform" };
    if (!batchIdPattern.test(batchId)) return { opened: false, reason: "invalid_batch_id" };
    if (!root || !state || !scriptPath || !wrapperPath) return { opened: false, reason: "launcher_configuration_missing" };
    if (!fs.existsSync(scriptPath) || !fs.existsSync(wrapperPath)) return { opened: false, reason: "watcher_script_missing" };
    const launchOptions = {
      cwd: root,
      env: inheritedEnvironment(environment),
      detached: true,
      windowsHide: false,
      shell: false,
      stdio: "ignore"
    };
    const terminal = terminalPathResolver();
    const wrapperArguments = [
      powershell,
      "-NoLogo",
      "-NoProfile",
      "-NoExit",
      "-File", wrapperPath,
      "-BatchId", batchId,
      "-NodeExecutable", nodeExecutable,
      "-WatcherScript", scriptPath,
      "-StateDirectory", state
    ];
    if (terminal) {
      const position = floatingWindowPosition(screenBoundsResolver(powershell));
      const result = await launch(terminal, [
        "-w", "new",
        ...(position ? ["--pos", position] : []),
        "--size", "46,26",
        "new-tab",
        "--title", `V2 Batch ${batchId.slice(0, 8)}`,
        "--startingDirectory", root,
        nodeExecutable,
        scriptPath,
        batchId,
        "--state-directory", state
      ], launchOptions, spawnProcess);
      if (result.opened) return { opened: true, mode: "windows_terminal_window" };
    }
    const fallback = await launch(powershell, wrapperArguments.slice(1), launchOptions, spawnProcess);
    return fallback.opened
      ? { opened: true, mode: "powershell_window" }
      : { opened: false, reason: fallback.reason || "launch_failed" };
  }

  return { open };
}
