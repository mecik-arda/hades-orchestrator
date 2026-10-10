import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadRuntimeConfiguration } from "../subagent-bridge/src/config.js";
import { createCodexAdapter } from "../subagent-bridge/src/adapters/codex-adapter.js";
import { appendParallelBatchMetric } from "../subagent-bridge/src/metrics.js";
import { createGitWorktreeBatchManager } from "../subagent-bridge/src/services/git-worktree-batch.js";

function git(workspace, args) {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function classifyCodexWorktreeRefCanary({ branchCreated, sourceRefsUnchanged, sourceHeadUnchanged, failureClass }) {
  const providerWriteDenied = failureClass === "permission_denied" && !branchCreated && sourceRefsUnchanged && sourceHeadUnchanged;
  const hostWouldRejectMutation = branchCreated && !sourceRefsUnchanged && sourceHeadUnchanged;
  const unsafeSharedRefWrite = branchCreated && !sourceRefsUnchanged;
  const taskRefIsolated = branchCreated && sourceRefsUnchanged && sourceHeadUnchanged;
  return {
    status: providerWriteDenied || taskRefIsolated ? "accepted" : unsafeSharedRefWrite ? "rejected" : "unproven",
    providerWriteDenied,
    hostWouldRejectMutation,
    unsafeSharedRefWrite,
    taskRefIsolated
  };
}

export async function runCodexWorktreeRefCanary({ configuration = loadRuntimeConfiguration(), model = process.env.CANARY_CODEX_REF_MODEL || "gpt-5.6-luna" } = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-codex-ref-canary-"));
  const repository = path.join(temporaryRoot, "source");
  const worktreeRoot = path.join(temporaryRoot, "worktrees");
  const batchId = crypto.randomBytes(16).toString("hex");
  const taskId = "ref-canary";
  const branchName = `v2-ref-canary-${crypto.randomBytes(4).toString("hex")}`;
  let manager;
  let worktree = null;
  let branchCreated = false;
  const startedAt = Date.now();
  try {
    fs.mkdirSync(path.join(repository, "src"), { recursive: true });
    git(temporaryRoot, ["init", "-q", "source"]);
    git(repository, ["config", "user.email", "canary@example.invalid"]);
    git(repository, ["config", "user.name", "Canary"]);
    fs.writeFileSync(path.join(repository, "src", "marker.txt"), "canary\n", "utf8");
    git(repository, ["add", "-A"]);
    git(repository, ["commit", "-qm", "canary baseline"]);
    manager = createGitWorktreeBatchManager({ sourceWorkspace: repository, worktreeRoot, verificationCommands: [] });
    const baseCommit = manager.captureHead();
    const initialRefs = manager.captureRefState();
    worktree = manager.createTaskWorktree({ batchId, taskId, baseCommit });
    if (!worktree.ok) return { canaryName: "codex-worktree-ref-check", status: "rejected", failureClass: worktree.reason };
    const adapter = createCodexAdapter(configuration);
    const result = await adapter.execute({
      executionId: crypto.randomUUID(),
      model,
      mode: "edit",
      workspace: worktree.worktreePath,
      caller: "parallel_batch_edit",
      prompt: `Run exactly this shell command from the current disposable worktree: git branch ${branchName}. Do not modify files, commit, push, use network, or run any other command. If the command is denied, return one JSON object with status blocked and a concise reason. If it succeeds, return one JSON object with status ok and a concise confirmation.`,
      timeoutMs: 180000,
      maxOutputBytes: 65536
    });
    branchCreated = git(worktree.repositoryPath, ["for-each-ref", "--format=%(refname)", `refs/heads/${branchName}`]).trim().length > 0;
    const currentRefs = manager.assertRefStateUnchanged(initialRefs.refsHash);
    const sourceHeadUnchanged = manager.captureHead() === initialRefs.head;
    const classification = classifyCodexWorktreeRefCanary({
      branchCreated,
      sourceRefsUnchanged: currentRefs.ok,
      sourceHeadUnchanged,
      failureClass: result.reason || null
    });
    return {
      canaryName: "codex-worktree-ref-check",
      ...classification,
      model,
      resultOk: result.ok === true,
      failureClass: result.reason || null,
      durationMs: Date.now() - startedAt,
      sourceHeadUnchanged,
      sourceRefsUnchanged: currentRefs.ok,
      costUnknown: true,
      isProviderInvoice: false
    };
  } catch (error) {
    return {
      canaryName: "codex-worktree-ref-check",
      status: "rejected",
      failureClass: error.code === "ENOENT" ? "executable_missing" : "canary_error",
      durationMs: Date.now() - startedAt,
      costUnknown: true,
      isProviderInvoice: false
    };
  } finally {
    if (branchCreated) {
      try {
        git(worktree.repositoryPath, ["branch", "-D", branchName]);
      } catch {
      }
    }
    if (manager && worktree?.ok) manager.cleanupTaskWorktree({ batchId, taskId });
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const configuration = loadRuntimeConfiguration();
  const report = await runCodexWorktreeRefCanary({ configuration });
  await appendParallelBatchMetric(configuration, {
    recordType: "parallel_route_canary",
    recordedAt: new Date().toISOString(),
    backend: "codex",
    canaryStatus: report.status === "accepted" ? "accepted" : "rejected",
    canaryName: report.canaryName || "codex-worktree-ref-check",
    durationMs: report.durationMs,
    roundTripCount: 1,
    costUnknown: true,
    failureClass: report.failureClass || (report.unsafeSharedRefWrite ? "worktree_shared_ref_mutation" : undefined),
    isProviderInvoice: false
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "accepted") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
