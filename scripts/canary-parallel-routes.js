import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { loadAgentsConfig, loadConfiguration } from "../subagent-bridge/src/config.js";
import { buildParallelWorkerInlineConfiguration } from "../subagent-bridge/src/adapters/opencode-adapter.js";
import { appendParallelBatchMetric } from "../subagent-bridge/src/metrics.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configuration = loadConfiguration({ configurationPath: path.join(projectRoot, "config", "policy.json") });
const agents = loadAgentsConfig({ agentsPath: path.join(projectRoot, "config", "agents.json") });
const openCodeModel = process.env.CANARY_OPENCODE_MODEL || "deepseek/deepseek-flash";
const openCodeCap = Number.parseInt(process.env.CANARY_OPENCODE_CAP || "64", 10);
const openCodeSteps = Number.parseInt(process.env.CANARY_OPENCODE_STEPS || "2", 10);
const codexModel = process.env.CANARY_CODEX_MODEL || null;
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-canary-"));

function record(report) {
  void appendParallelBatchMetric(configuration, {
    recordType: "parallel_route_canary",
    recordedAt: new Date().toISOString(),
    backend: report.backend,
    canaryStatus: report.status,
    canaryName: report.canaryName,
    durationMs: report.durationMs,
    roundTripCount: report.roundTripCount ?? 0,
    maxObservedTokens: report.maxObservedTokens ?? undefined,
    costUnknown: true,
    isProviderInvoice: false
  }).catch(() => {});
}

function parseOpenCodeEvents(output) {
  return output.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function runOpenCodeInvocation({ workspace, prompt, cap, steps }) {
  const configPath = path.join(temporaryRoot, `opencode-worker-${crypto.randomUUID()}.json`);
  fs.writeFileSync(configPath, buildParallelWorkerInlineConfiguration("read_only", steps), "utf8");
  const startedAt = Date.now();
  const result = spawnSync(agents.agents.opencode.executable, [
    "run",
    "--print-logs",
    "--format", "json",
    "-m", openCodeModel,
    "--dir", workspace,
    "--agent", "parallel-readonly",
    prompt
  ], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 600000,
    windowsHide: true,
    env: {
      ...process.env,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_CONFIG: configPath,
      OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(cap)
    }
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const events = parseOpenCodeEvents(output);
  const loopSteps = [...output.matchAll(/message=loop .*?step=(\d+)/g)].map((match) => Number(match[1]));
  const usageRecords = events.filter((event) => event.type === "step_finish" && event.part?.tokens);
  const generations = usageRecords.flatMap((event) => {
    const outputTokens = Number.isFinite(event.part.tokens.output) ? event.part.tokens.output : null;
    const reasoningTokens = Number.isFinite(event.part.tokens.reasoning) ? event.part.tokens.reasoning : 0;
    return outputTokens === null ? [] : [outputTokens + reasoningTokens];
  });
  return {
    exitCode: result.status,
    signal: result.signal || null,
    error: result.error?.message || null,
    durationMs: Date.now() - startedAt,
    stepStarts: events.filter((event) => event.type === "step_start").length,
    loopSteps,
    toolUses: events.filter((event) => event.type === "tool_use"),
    texts: events.filter((event) => event.type === "text").map((event) => event.part?.text || ""),
    maxGenerationTokens: generations.length > 0 ? Math.max(...generations) : null,
    usageObserved: generations.length > 0,
    output
  };
}

function runOpenCodeCanary() {
  if (process.env.CANARY_SKIP_OPENCODE === "1") return { backend: "opencode", canaryName: "output-cap-steps", status: "skipped", accepted: null };
  const workspace = path.join(temporaryRoot, "opencode-workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "README.md"), "parallel canary marker\n", "utf8");
  const readPrompt = [
    "Call the read tool on README.md.",
    "Then call the read tool on README.md again.",
    "Then call the read tool on README.md a third time.",
    "Then return exactly one JSON object and nothing else:",
    '{"status":"ok","summary":"done","action_required":"none"}'
  ].join("\n");
  const capRun = runOpenCodeInvocation({
    workspace,
    cap: openCodeCap,
    steps: 3,
    prompt: `Return exactly one JSON object and nothing else: {"status":"ok","summary":"${"canary ".repeat(60).trim()}","action_required":"none"}`
  });
  const capHonored = capRun.usageObserved && capRun.maxGenerationTokens > 0 && capRun.maxGenerationTokens <= openCodeCap;
  const stepsRun = runOpenCodeInvocation({ workspace, cap: 512, steps: 1, prompt: readPrompt });
  const maxLoopStep = stepsRun.loopSteps.length > 0 ? Math.max(...stepsRun.loopSteps) : null;
  const stepsHonored = maxLoopStep !== null && maxLoopStep <= 1;
  const bashRun = runOpenCodeInvocation({
    workspace,
    cap: 256,
    steps: 3,
    prompt: 'Run this exact bash command and report its raw output: node -e "console.log(\'canary-bash\')"'
  });
  const bashCompleted = bashRun.toolUses.some((event) => event.part?.tool === "bash" && event.part?.state?.status === "completed");
  const bashDenied = !bashCompleted;
  const accepted = capHonored && stepsHonored && bashDenied;
  return {
    backend: "opencode",
    canaryName: "output-cap-steps-bash",
    status: accepted ? "accepted" : "rejected",
    accepted,
    model: openCodeModel,
    cap: openCodeCap,
    steps: openCodeSteps,
    exitCode: capRun.exitCode,
    durationMs: capRun.durationMs + stepsRun.durationMs + bashRun.durationMs,
    usageObserved: capRun.usageObserved,
    maxObservedTokens: capRun.maxGenerationTokens,
    maxGenerationTokens: capRun.maxGenerationTokens,
    capHonored,
    stepStarts: stepsRun.stepStarts,
    maxLoopStep,
    stepsHonored,
    bashDenied,
    signal: capRun.signal,
    error: capRun.error
  };
}

function runCodexCanary() {
  if (process.env.CANARY_SKIP_CODEX === "1") return { backend: "codex", canaryName: "network-off", status: "skipped", accepted: null };
  const repo = path.join(temporaryRoot, "codex-repo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "canary@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Canary"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "codex canary marker\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "canary"], { cwd: repo });
  const refsBefore = execFileSync("git", ["for-each-ref", "--format=%(refname):%(objectname)"], { cwd: repo, encoding: "utf8" }).trim();
  const args = [
    "exec",
    "--sandbox", "workspace-write",
    "-c", "sandbox_workspace_write.network_access=false",
    ...(codexModel ? ["-m", codexModel] : []),
    "Run exactly this shell command and report its raw output and exit code: git ls-remote https://github.com/openai/codex.git HEAD . Do not modify any files. Then reply with exactly one JSON object: {\"status\":\"ok\",\"summary\":\"network probe done\",\"action_required\":\"none\"}"
  ];
  const startedAt = Date.now();
  const result = spawnSync(agents.agents.codex.executable, args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 600000,
    windowsHide: true,
    env: { ...process.env }
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const remoteResolved = /[0-9a-f]{40}\s+HEAD/m.test(output);
  const networkDenied = !remoteResolved;
  const refsAfter = execFileSync("git", ["for-each-ref", "--format=%(refname):%(objectname)"], { cwd: repo, encoding: "utf8" }).trim();
  const refsChanged = refsAfter !== refsBefore;
  const accepted = result.status === 0 && networkDenied && !refsChanged;
  return {
    backend: "codex",
    canaryName: "network-off",
    status: accepted ? "accepted" : "rejected",
    accepted,
    model: codexModel || "default",
    exitCode: result.status,
    durationMs: Date.now() - startedAt,
    networkDenied,
    remoteResolved,
    refsChanged,
    signal: result.signal || null,
    error: result.error?.message || null,
    outputTail: output.slice(-1200)
  };
}

try {
  const reports = [runOpenCodeCanary(), runCodexCanary()].map((report) => {
    record(report);
    return report;
  });
  console.log(JSON.stringify({ canary: "parallel-routes", reports }, null, 2));
  if (reports.some((report) => report.status === "rejected")) process.exitCode = 1;
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
