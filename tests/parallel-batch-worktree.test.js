import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGitWorktreeBatchManager } from "../subagent-bridge/src/services/git-worktree-batch.js";

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function createRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-worktree-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  git(root, ["init", "-q", "repo"]);
  git(repo, ["config", "user.email", "bridge@example.invalid"]);
  git(repo, ["config", "user.name", "Bridge Test"]);
  fs.writeFileSync(path.join(repo, "src", "a.txt"), "alpha\n", "utf8");
  fs.writeFileSync(path.join(repo, "src", "b.txt"), "beta\n", "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "initial"]);
  return { root, repo, baseCommit: git(repo, ["rev-parse", "HEAD"]).trim() };
}

function createManager(root, repo, verificationCommands = [], overrides = {}) {
  const manager = createGitWorktreeBatchManager({
    sourceWorkspace: repo,
    worktreeRoot: path.join(root, "worktrees"),
    verificationCommands,
    ...overrides
  });
  manager.recoverPendingPromotions();
  return manager;
}

test("V2-WORKTREE: clean source gate rejects a dirty repository", (t) => {
  const { root, repo } = createRepository(t);
  const manager = createManager(root, repo, ["git diff --check"]);
  assert.deepEqual(manager.assertCleanSource().ok, true);
  fs.writeFileSync(path.join(repo, "src", "c.txt"), "gamma\n", "utf8");
  const dirty = manager.assertCleanSource();
  assert.equal(dirty.ok, false);
  assert.equal(dirty.reason, "source_workspace_dirty");
});

test("V2-WORKTREE: source root rebinding blocks edit admission", (t) => {
  const { root, repo } = createRepository(t);
  const manager = createManager(root, repo);
  const movedWorkspace = `${repo}-original`;
  const replacementWorkspace = path.join(root, "replacement-workspace");
  fs.mkdirSync(replacementWorkspace);
  fs.renameSync(repo, movedWorkspace);
  try {
    fs.symlinkSync(replacementWorkspace, repo, process.platform === "win32" ? "junction" : "dir");
  } catch {
    fs.renameSync(movedWorkspace, repo);
    t.skip("directory symlink creation is unavailable");
  }
  const result = manager.assertCleanSource();
  assert.deepEqual(result, { ok: false, reason: "source_workspace_rebound" });
});

test("V2-WORKTREE: task worktree isolates changes and enforces path ownership", (t) => {
  const { root, repo, baseCommit } = createRepository(t);
  const manager = createManager(root, repo, ["git diff --check"]);
  const batchId = "a".repeat(32);
  const created = manager.createTaskWorktree({ batchId, taskId: "task-one", baseCommit });
  assert.equal(created.ok, true);
  assert.equal(fs.lstatSync(path.join(created.worktreePath, ".git")).isFile(), true);
  fs.writeFileSync(path.join(created.worktreePath, "src", "a.txt"), "edited by worker\n", "utf8");
  const allowed = manager.collectTaskDiff({ worktreePath: created.worktreePath, allowedPaths: ["src/a.txt"], prohibitedPaths: [] });
  assert.equal(allowed.ok, true);
  const verification = manager.runVerification(created.worktreePath, ["git diff --check"]);
  assert.equal(verification.ok, true, JSON.stringify(verification));
  assert.deepEqual(allowed.filesChanged, ["src/a.txt"]);
  assert.match(allowed.diffHash, /^[a-f0-9]{64}$/);
  const prohibited = manager.collectTaskDiff({ worktreePath: created.worktreePath, allowedPaths: ["src/a.txt"], prohibitedPaths: ["src/a.txt"] });
  assert.equal(prohibited.ok, false);
  assert.equal(prohibited.reason, "prohibited_path_touched");
  const notAllowed = manager.collectTaskDiff({ worktreePath: created.worktreePath, allowedPaths: ["src/b.txt"], prohibitedPaths: [] });
  assert.equal(notAllowed.ok, false);
  assert.equal(notAllowed.reason, "path_not_allowed");
  manager.cleanupTaskWorktree({ batchId, taskId: "task-one" });
  assert.equal(fs.existsSync(created.worktreePath), false);
});

test("V2-WORKTREE: task diff limits are enforced at the host collector", (t) => {
  const { root, repo, baseCommit } = createRepository(t);
  const manager = createManager(root, repo);
  const created = manager.createTaskWorktree({ batchId: "b".repeat(32), taskId: "task-one", baseCommit });
  fs.writeFileSync(path.join(created.worktreePath, "src", "a.txt"), "a sufficiently long replacement\n", "utf8");
  fs.writeFileSync(path.join(created.worktreePath, "src", "b.txt"), "another replacement\n", "utf8");
  assert.equal(manager.collectTaskDiff({ worktreePath: created.worktreePath, maxFilesChanged: 1 }).reason, "max_files_exceeded");
  assert.equal(manager.collectTaskDiff({ worktreePath: created.worktreePath, maxFileBytes: 8 }).reason, "file_size_exceeded");
  assert.equal(manager.collectTaskDiff({ worktreePath: created.worktreePath, maxTotalDiffBytes: 1 }).reason, "diff_size_exceeded");
  manager.cleanupTaskWorktree({ batchId: "b".repeat(32), taskId: "task-one" });
});

test("V2-WORKTREE: empty diff is reported as no_changes", (t) => {
  const { root, repo, baseCommit } = createRepository(t);
  const manager = createManager(root, repo);
  const batchId = "b".repeat(32);
  const created = manager.createTaskWorktree({ batchId, taskId: "task-two", baseCommit });
  const diff = manager.collectTaskDiff({ worktreePath: created.worktreePath, allowedPaths: ["src/a.txt"] });
  assert.equal(diff.ok, false);
  assert.equal(diff.reason, "no_changes");
  manager.cleanupTaskWorktree({ batchId, taskId: "task-two" });
});

test("V2-WORKTREE: arbitrary host verification commands never execute", (t) => {
  const { root, repo } = createRepository(t);
  let executions = 0;
  const manager = createManager(root, repo, ["node -e process.exit(0)"], {
    runVerificationCommand() {
      executions += 1;
      return "";
    }
  });
  const result = manager.runVerification(repo, ["node -e process.exit(0)"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "verification_command_unsafe");
  assert.equal(executions, 0);
});

test("V2-WORKTREE: integration applies task diffs and verification failures leave the source untouched", (t) => {
  const { root, repo, baseCommit } = createRepository(t);
  const manager = createManager(root, repo);
  const batchId = "c".repeat(32);
  const created = manager.createTaskWorktree({ batchId, taskId: "task-one", baseCommit });
  fs.writeFileSync(path.join(created.worktreePath, "src", "a.txt"), "integrated\n", "utf8");
  const diff = manager.collectTaskDiff({ worktreePath: created.worktreePath, allowedPaths: ["src/a.txt"] });
  manager.holdTaskDiff({ batchId, taskId: "task-one", diff: diff.diff, diffHash: diff.diffHash, filesChanged: diff.filesChanged, changes: diff.changes });
  manager.cleanupTaskWorktree({ batchId, taskId: "task-one" });
  const preparation = manager.prepareIntegration({ batchId, baseCommit, tasks: [{ taskId: "task-one", status: "completed" }] });
  assert.equal(preparation.ok, true);
  assert.deepEqual(preparation.filesChanged, ["src/a.txt"]);
  const repeatedPreparation = manager.prepareIntegration({ batchId, baseCommit, tasks: [{ taskId: "task-one", status: "completed" }] });
  assert.equal(repeatedPreparation.ok, false);
  assert.equal(repeatedPreparation.reason, "task_diff_missing");

  const failingManager = createGitWorktreeBatchManager({
    sourceWorkspace: repo,
    worktreeRoot: path.join(root, "worktrees"),
    verificationCommands: ["git rev-parse --verify missing-ref-xyz"]
  });
  failingManager.recoverPendingPromotions();
  const createdVerify = failingManager.createTaskWorktree({ batchId: "d".repeat(32), taskId: "task-one", baseCommit });
  fs.writeFileSync(path.join(createdVerify.worktreePath, "src", "a.txt"), "not-integrated\n", "utf8");
  const verifyDiff = failingManager.collectTaskDiff({ worktreePath: createdVerify.worktreePath, allowedPaths: ["src/a.txt"] });
  failingManager.holdTaskDiff({ batchId: "d".repeat(32), taskId: "task-one", diff: verifyDiff.diff, diffHash: verifyDiff.diffHash, filesChanged: verifyDiff.filesChanged, changes: verifyDiff.changes });
  failingManager.cleanupTaskWorktree({ batchId: "d".repeat(32), taskId: "task-one" });
  const failedPreparation = failingManager.prepareIntegration({ batchId: "d".repeat(32), baseCommit, tasks: [{ taskId: "task-one", status: "completed" }] });
  assert.equal(failedPreparation.ok, false);
  assert.equal(failedPreparation.reason, "verification_command_unsafe");
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "alpha\n");
});

test("V2-WORKTREE: integration preview and approval hash include created files", (t) => {
  const { root, repo, baseCommit } = createRepository(t);
  const manager = createManager(root, repo);
  const batchId = "6".repeat(32);
  const created = manager.createTaskWorktree({ batchId, taskId: "task-one", baseCommit });
  fs.writeFileSync(path.join(created.worktreePath, "src", "a.txt"), "mixed edit\n", "utf8");
  fs.writeFileSync(path.join(created.worktreePath, "src", "new.txt"), "new file\n", "utf8");
  const diff = manager.collectTaskDiff({ worktreePath: created.worktreePath, allowedPaths: ["src/a.txt", "src/new.txt"] });
  assert.equal(diff.ok, true, JSON.stringify(diff));
  assert.match(diff.diff, /new file mode/);
  assert.match(diff.diff, /\+new file/);
  manager.holdTaskDiff({ batchId, taskId: "task-one", diff: diff.diff, diffHash: diff.diffHash, filesChanged: diff.filesChanged, changes: diff.changes });
  manager.cleanupTaskWorktree({ batchId, taskId: "task-one" });

  const prepared = manager.prepareIntegration({ batchId, baseCommit, tasks: [{ taskId: "task-one", status: "completed" }] });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.deepEqual(prepared.filesChanged, ["src/a.txt", "src/new.txt"]);
  assert.match(prepared.diff, /new file mode/);
  assert.match(prepared.diff, /\+new file/);
  assert.match(prepared.diffHash, /^[a-f0-9]{64}$/);

  const approval = "a".repeat(64);
  const applied = manager.applyIntegration({
    batchId,
    approvalRef: approval,
    expectedDiffHash: prepared.diffHash,
    manifest: {
      baseCommit,
      integration: {
        diffHash: prepared.diffHash,
        diffPreviewHash: prepared.diffPreviewHash,
        changePayloadHash: prepared.changePayloadHash,
        approvalRef: approval,
        baseCommit,
        sourceFileStates: prepared.sourceFileStates,
        filesChanged: prepared.filesChanged,
        changes: prepared.changes
      }
    }
  });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "mixed edit\n");
  assert.equal(fs.readFileSync(path.join(repo, "src", "new.txt"), "utf8"), "new file\n");
});

test("V2-WORKTREE: verification-created and verification-mutated files block integration", (t) => {
  const { root, repo, baseCommit } = createRepository(t);
  const batchId = "5".repeat(32);
  const manager = createGitWorktreeBatchManager({
    sourceWorkspace: repo,
    worktreeRoot: path.join(root, "worktrees"),
    verificationCommands: ["git diff --check"],
    runVerificationCommand(workspace) {
      fs.writeFileSync(path.join(workspace, "verification-output.txt"), "generated\n", "utf8");
      return "";
    }
  });
  manager.recoverPendingPromotions();
  const created = manager.createTaskWorktree({ batchId, taskId: "task-one", baseCommit });
  fs.writeFileSync(path.join(created.worktreePath, "src", "a.txt"), "owned edit\n", "utf8");
  const diff = manager.collectTaskDiff({ worktreePath: created.worktreePath, allowedPaths: ["src/a.txt"] });
  manager.holdTaskDiff({ batchId, taskId: "task-one", diff: diff.diff, diffHash: diff.diffHash, filesChanged: diff.filesChanged, changes: diff.changes });
  manager.cleanupTaskWorktree({ batchId, taskId: "task-one" });

  const prepared = manager.prepareIntegration({ batchId, baseCommit, tasks: [{ taskId: "task-one", status: "completed" }] });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.reason, "verification_created_unowned_files");
  assert.deepEqual(prepared.filesChanged, ["verification-output.txt"]);
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "alpha\n");
});

test("V2-WORKTREE: worker attributes cannot invoke configured Git filters during collection or verification", (t) => {
  const { root, repo, baseCommit } = createRepository(t);
  const filterScript = path.join(root, "filter.js");
  const filterSentinel = path.join(root, "filter-invoked");
  fs.writeFileSync(filterScript, "const fs=require('node:fs');const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>{fs.writeFileSync(process.argv[2],'invoked');process.stdout.write(Buffer.concat(chunks));});\n", "utf8");
  const filterCommand = `"${process.execPath}" "${filterScript}" "${filterSentinel}"`;
  git(repo, ["config", "filter.worker.clean", filterCommand]);
  git(repo, ["config", "filter.worker.smudge", filterCommand]);
  const manager = createManager(root, repo, ["git diff --check"]);
  const batchId = "3".repeat(32);
  const created = manager.createTaskWorktree({ batchId, taskId: "task-one", baseCommit });
  fs.writeFileSync(path.join(created.worktreePath, "src", ".gitattributes"), "filtered.txt filter=worker\n", "utf8");
  fs.writeFileSync(path.join(created.worktreePath, "src", "filtered.txt"), "filtered content\n", "utf8");
  const diff = manager.collectTaskDiff({ worktreePath: created.worktreePath, allowedPaths: ["src/.gitattributes", "src/filtered.txt"] });
  assert.equal(diff.ok, true, JSON.stringify(diff));
  assert.equal(fs.existsSync(filterSentinel), false);
  manager.holdTaskDiff({ batchId, taskId: "task-one", diff: diff.diff, diffHash: diff.diffHash, filesChanged: diff.filesChanged, changes: diff.changes });
  manager.cleanupTaskWorktree({ batchId, taskId: "task-one" });
  const prepared = manager.prepareIntegration({ batchId, baseCommit, tasks: [{ taskId: "task-one", status: "completed" }] });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.reason, "verification_filter_config_unsupported");
  assert.equal(fs.existsSync(filterSentinel), false);
});

test("V2-WORKTREE: bridge-owned Git operations disable repository hooks", { skip: process.platform === "win32" }, (t) => {
  const { root, repo, baseCommit } = createRepository(t);
  const hooksPath = path.join(root, "malicious-hooks");
  const hookMarker = path.join(root, "hook-invoked");
  fs.mkdirSync(hooksPath);
  const hookBody = `#!/bin/sh\nprintf invoked > '${hookMarker}'\n`;
  fs.writeFileSync(path.join(hooksPath, "post-checkout"), hookBody, "utf8");
  fs.writeFileSync(path.join(hooksPath, "post-index-change"), hookBody, "utf8");
  fs.chmodSync(path.join(hooksPath, "post-checkout"), 0o755);
  fs.chmodSync(path.join(hooksPath, "post-index-change"), 0o755);
  git(repo, ["config", "core.hooksPath", hooksPath]);

  const manager = createManager(root, repo, ["git diff --check"]);
  const batchId = "2".repeat(32);
  const created = manager.createTaskWorktree({ batchId, taskId: "task-one", baseCommit });
  assert.equal(created.ok, true, JSON.stringify(created));
  fs.writeFileSync(path.join(created.worktreePath, "src", "new.txt"), "hook-free\n", "utf8");
  const diff = manager.collectTaskDiff({ worktreePath: created.worktreePath, allowedPaths: ["src/new.txt"] });
  assert.equal(diff.ok, true, JSON.stringify(diff));
  manager.holdTaskDiff({ batchId, taskId: "task-one", diff: diff.diff, diffHash: diff.diffHash, filesChanged: diff.filesChanged, changes: diff.changes });
  manager.cleanupTaskWorktree({ batchId, taskId: "task-one" });
  const prepared = manager.prepareIntegration({ batchId, baseCommit, tasks: [{ taskId: "task-one", status: "completed" }] });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(fs.existsSync(hookMarker), false);
});

test("V2-WORKTREE: source status and integration checkout disable repository fsmonitor and filters", { skip: process.platform === "win32" }, (t) => {
  const { root, repo, baseCommit: initialCommit } = createRepository(t);
  const hookMarker = path.join(root, "source-git-hook-invoked");
  const filterScript = path.join(root, "source-filter.sh");
  const filterBody = `#!/bin/sh\nprintf invoked > '${hookMarker}'\ncat\n`;
  fs.writeFileSync(filterScript, filterBody, "utf8");
  fs.chmodSync(filterScript, 0o755);
  const monitorMarker = path.join(root, "source-fsmonitor-invoked");
  const monitorScript = path.join(root, "source-fsmonitor.sh");
  fs.writeFileSync(monitorScript, `#!/bin/sh\nprintf invoked > '${monitorMarker}'\nprintf token\n`, "utf8");
  fs.chmodSync(monitorScript, 0o755);
  fs.writeFileSync(path.join(repo, ".gitattributes"), "*.txt filter=sentinel\n", "utf8");
  git(repo, ["add", ".gitattributes"]);
  git(repo, ["commit", "-qm", "add filter attributes"]);
  const baseCommit = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["config", "filter.sentinel.smudge", filterScript]);
  git(repo, ["config", "filter.sentinel.required", "true"]);
  git(repo, ["config", "core.fsmonitor", monitorScript]);
  const manager = createManager(root, repo);
  assert.equal(manager.assertCleanSource().ok, true);
  const batchId = "6".repeat(32);
  manager.holdTaskDiff({
    batchId,
    taskId: "task-one",
    changes: [{ relativePath: "src/a.txt", mode: "replace", fileMode: "100644", contentBase64: Buffer.from("integrated\n").toString("base64"), changeType: "modified" }]
  });
  const prepared = manager.prepareIntegration({ batchId, baseCommit, tasks: [{ taskId: "task-one", status: "completed" }] });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.reason, "verification_filter_config_unsupported");
  assert.equal(fs.existsSync(hookMarker), false);
  assert.equal(fs.existsSync(monitorMarker), false);
  assert.notEqual(baseCommit, initialCommit);
});

test("V2-WORKTREE: promotion and rollback retain executable mode on POSIX", { skip: process.platform === "win32" }, (t) => {
  const { root, repo } = createRepository(t);
  const scriptPath = path.join(repo, "src", "run.sh");
  fs.writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(scriptPath, 0o755);
  git(repo, ["add", "src/run.sh"]);
  git(repo, ["commit", "-qm", "add executable script"]);
  const baseCommit = git(repo, ["rev-parse", "HEAD"]).trim();
  const manager = createManager(root, repo);
  const batchId = "4".repeat(32);
  const created = manager.createTaskWorktree({ batchId, taskId: "task-one", baseCommit });
  fs.writeFileSync(path.join(created.worktreePath, "src", "run.sh"), "#!/bin/sh\nexit 1\n", "utf8");
  fs.chmodSync(path.join(created.worktreePath, "src", "run.sh"), 0o755);
  const diff = manager.collectTaskDiff({ worktreePath: created.worktreePath, allowedPaths: ["src/run.sh"] });
  assert.equal(diff.ok, true, JSON.stringify(diff));
  assert.equal(diff.changes[0].fileMode, "100755");
  manager.holdTaskDiff({ batchId, taskId: "task-one", diff: diff.diff, diffHash: diff.diffHash, filesChanged: diff.filesChanged, changes: diff.changes });
  manager.cleanupTaskWorktree({ batchId, taskId: "task-one" });
  const prepared = manager.prepareIntegration({ batchId, baseCommit, tasks: [{ taskId: "task-one", status: "completed" }] });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const approval = "b".repeat(64);
  const manifest = { baseCommit, integration: { diffHash: prepared.diffHash, diffPreviewHash: prepared.diffPreviewHash, changePayloadHash: prepared.changePayloadHash, approvalRef: approval, baseCommit, sourceFileStates: prepared.sourceFileStates, filesChanged: prepared.filesChanged, changes: prepared.changes } };
  const applied = manager.applyIntegration({ batchId, approvalRef: approval, expectedDiffHash: prepared.diffHash, manifest });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(fs.statSync(scriptPath).mode & 0o111, 0o111);
});

test("V2-WORKTREE: approval preview includes executable mode changes when core.fileMode is disabled", { skip: process.platform === "win32" }, (t) => {
  const { root, repo, baseCommit } = createRepository(t);
  git(repo, ["config", "core.fileMode", "false"]);
  const manager = createManager(root, repo);
  const batchId = "5".repeat(32);
  manager.holdTaskDiff({
    batchId,
    taskId: "task-one",
    changes: [{ relativePath: "src/a.txt", mode: "replace", fileMode: "100755", contentBase64: Buffer.from("#!/bin/sh\nexit 0\n").toString("base64"), changeType: "modified" }]
  });
  const prepared = manager.prepareIntegration({ batchId, baseCommit, tasks: [{ taskId: "task-one", status: "completed" }] });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.match(prepared.diff, /old mode 100644/);
  assert.match(prepared.diff, /new mode 100755/);
});

test("V2-WORKTREE: source ref changes are detected before integration", (t) => {
  const { root, repo, baseCommit } = createRepository(t);
  const manager = createManager(root, repo);
  const refState = manager.captureRefState();
  assert.equal(manager.assertRefStateUnchanged(refState.refsHash).ok, true);
  git(repo, ["branch", "unexpected-branch", baseCommit]);
  const changed = manager.assertRefStateUnchanged(refState.refsHash);
  assert.equal(changed.ok, false);
  assert.equal(changed.reason, "source_ref_changed");
  const preparation = manager.prepareIntegration({ batchId: "f".repeat(32), baseCommit, tasks: [], expectedRefHash: refState.refsHash });
  assert.equal(preparation.ok, false);
  assert.equal(preparation.reason, "source_ref_changed");
});

test("V2-WORKTREE: integration approval verifies diff hash and source HEAD before promotion", (t) => {
  const { root, repo, baseCommit } = createRepository(t);
  const manager = createManager(root, repo);
  const batchId = "e".repeat(32);
  const created = manager.createTaskWorktree({ batchId, taskId: "task-one", baseCommit });
  fs.writeFileSync(path.join(created.worktreePath, "src", "a.txt"), "promoted\n", "utf8");
  const diff = manager.collectTaskDiff({ worktreePath: created.worktreePath, allowedPaths: ["src/a.txt"] });
  manager.holdTaskDiff({ batchId, taskId: "task-one", diff: diff.diff, diffHash: diff.diffHash, filesChanged: diff.filesChanged, changes: diff.changes });
  manager.cleanupTaskWorktree({ batchId, taskId: "task-one" });
  const preparation = manager.prepareIntegration({ batchId, baseCommit, tasks: [{ taskId: "task-one", status: "completed" }] });
  assert.equal(preparation.ok, true);
  const manifest = {
    baseCommit,
    integration: {
      diffHash: preparation.diffHash,
      diffPreviewHash: preparation.diffPreviewHash,
      changePayloadHash: preparation.changePayloadHash,
      approvalRef: "f".repeat(64),
      baseCommit,
      sourceFileStates: preparation.sourceFileStates,
      filesChanged: preparation.filesChanged,
      changes: preparation.changes
    }
  };
  const tamperedManifest = structuredClone(manifest);
  tamperedManifest.integration.changes[0].contentBase64 = Buffer.from("unapproved content\n").toString("base64");
  const tamperedPayload = manager.applyIntegration({ batchId, approvalRef: manifest.integration.approvalRef, expectedDiffHash: preparation.diffHash, manifest: tamperedManifest });
  assert.equal(tamperedPayload.ok, false);
  assert.equal(tamperedPayload.reason, "integration_payload_hash_mismatch");
  const wrongHash = manager.applyIntegration({ batchId, approvalRef: manifest.integration.approvalRef, expectedDiffHash: "0".repeat(64), manifest });
  assert.equal(wrongHash.ok, false);
  assert.equal(wrongHash.reason, "integration_hash_mismatch");
  const wrongRef = manager.applyIntegration({ batchId, approvalRef: "1".repeat(64), expectedDiffHash: preparation.diffHash, manifest });
  assert.equal(wrongRef.ok, false);
  assert.equal(wrongRef.reason, "approval_ref_mismatch");

  git(repo, ["commit", "--allow-empty", "-qm", "drift"]);
  const drifted = manager.applyIntegration({ batchId, approvalRef: manifest.integration.approvalRef, expectedDiffHash: preparation.diffHash, manifest });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.reason, "source_head_changed");
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "alpha\n");

  git(repo, ["reset", "--hard", baseCommit]);
  fs.writeFileSync(path.join(repo, "src", "a.txt"), "user edit after approval preview\n", "utf8");
  const fileDrifted = manager.applyIntegration({ batchId, approvalRef: manifest.integration.approvalRef, expectedDiffHash: preparation.diffHash, manifest });
  assert.equal(fileDrifted.ok, false);
  assert.equal(fileDrifted.reason, "source_file_state_changed");
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "user edit after approval preview\n");
  fs.writeFileSync(path.join(repo, "src", "a.txt"), "alpha\n", "utf8");
  const applied = manager.applyIntegration({ batchId, approvalRef: manifest.integration.approvalRef, expectedDiffHash: preparation.diffHash, manifest });
  assert.equal(applied.ok, true);
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8").replaceAll("\r\n", "\n"), "promoted\n");
  assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), baseCommit);
});

test("V2-WORKTREE: promotion rejects a junction or symlink parent escape", (t) => {
  const { root, repo, baseCommit } = createRepository(t);
  const manager = createManager(root, repo);
  const batchId = "c".repeat(32);
  const created = manager.createTaskWorktree({ batchId, taskId: "task-one", baseCommit });
  fs.writeFileSync(path.join(created.worktreePath, "src", "a.txt"), "promoted\n", "utf8");
  const diff = manager.collectTaskDiff({ worktreePath: created.worktreePath, allowedPaths: ["src/a.txt"] });
  manager.holdTaskDiff({ batchId, taskId: "task-one", diff: diff.diff, diffHash: diff.diffHash, filesChanged: diff.filesChanged, changes: diff.changes });
  manager.cleanupTaskWorktree({ batchId, taskId: "task-one" });
  const preparation = manager.prepareIntegration({ batchId, baseCommit, tasks: [{ taskId: "task-one", status: "completed" }] });
  assert.equal(preparation.ok, true);
  const outsideDirectory = path.join(root, "outside");
  fs.mkdirSync(outsideDirectory, { recursive: true });
  fs.writeFileSync(path.join(outsideDirectory, "a.txt"), "outside-original\n", "utf8");
  fs.rmSync(path.join(repo, "src"), { recursive: true, force: true });
  fs.symlinkSync(outsideDirectory, path.join(repo, "src"), process.platform === "win32" ? "junction" : "dir");
  const result = manager.applyIntegration({
    batchId,
    approvalRef: "d".repeat(64),
    expectedDiffHash: preparation.diffHash,
    manifest: {
      baseCommit,
      integration: {
        diffHash: preparation.diffHash,
        diffPreviewHash: preparation.diffPreviewHash,
        changePayloadHash: preparation.changePayloadHash,
        approvalRef: "d".repeat(64),
        baseCommit,
        sourceFileStates: preparation.sourceFileStates,
        filesChanged: preparation.filesChanged,
        changes: preparation.changes
      }
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "source_state_rejected");
  assert.equal(fs.readFileSync(path.join(outsideDirectory, "a.txt"), "utf8"), "outside-original\n");
});

test("V2-WORKTREE: rollback failures are returned explicitly", (t) => {
  const { root, repo, baseCommit } = createRepository(t);
  const worktreeRoot = path.join(root, "worktrees");
  let renameCalls = 0;
  const manager = createManager(root, repo, [], {
    renamePromotionFile(source, target) {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error("injected replacement failure");
      fs.renameSync(source, target);
    },
    restorePromotionFile() {
      throw new Error("injected rollback failure");
    }
  });
  const batchId = "9".repeat(32);
  const created = manager.createTaskWorktree({ batchId, taskId: "task-one", baseCommit });
  fs.writeFileSync(path.join(created.worktreePath, "src", "a.txt"), "edited a\n", "utf8");
  fs.writeFileSync(path.join(created.worktreePath, "src", "b.txt"), "edited b\n", "utf8");
  const diff = manager.collectTaskDiff({ worktreePath: created.worktreePath, allowedPaths: ["src/a.txt", "src/b.txt"] });
  assert.equal(diff.ok, true);
  manager.holdTaskDiff({ batchId, taskId: "task-one", diff: diff.diff, diffHash: diff.diffHash, filesChanged: diff.filesChanged, changes: diff.changes });
  manager.cleanupTaskWorktree({ batchId, taskId: "task-one" });
  const preparation = manager.prepareIntegration({ batchId, baseCommit, tasks: [{ taskId: "task-one", status: "completed" }] });
  assert.equal(preparation.ok, true);
  const result = manager.applyIntegration({
    batchId,
    approvalRef: "a".repeat(64),
    expectedDiffHash: preparation.diffHash,
    manifest: {
      batchId,
      baseCommit,
      integration: {
        diffHash: preparation.diffHash,
        diffPreviewHash: preparation.diffPreviewHash,
        changePayloadHash: preparation.changePayloadHash,
        approvalRef: "a".repeat(64),
        baseCommit,
        sourceFileStates: preparation.sourceFileStates,
        filesChanged: preparation.filesChanged,
        changes: preparation.changes
      }
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "promotion_rollback_failed");
  assert.match(result.message, /recovery/);
  const recoveryManager = createGitWorktreeBatchManager({ sourceWorkspace: repo, worktreeRoot });
  assert.deepEqual(recoveryManager.promotionRecoveryStatus(), { ok: false, reason: "promotion_recovery_required" });
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8").replaceAll("\r\n", "\n"), "edited a\n");
  assert.equal(recoveryManager.recoverPendingPromotions().ok, true);
  assert.deepEqual(recoveryManager.promotionRecoveryStatus(), { ok: true, reason: null });
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "alpha\n");
  assert.equal(fs.readFileSync(path.join(repo, "src", "b.txt"), "utf8"), "beta\n");
});

test("V2-WORKTREE: promotion stops and recovers after its workspace lock fence is lost", (t) => {
  const { root, repo, baseCommit } = createRepository(t);
  let ownerHeld = true;
  let failAfterWrite = false;
  const manager = createManager(root, repo, [], {
    writePromotionFile(filePath, content, options) {
      fs.writeFileSync(filePath, content, options);
      ownerHeld = false;
      if (failAfterWrite) throw new Error("injected write failure after ownership loss");
    }
  });
  const batchId = "0".repeat(32);
  const created = manager.createTaskWorktree({ batchId, taskId: "task-one", baseCommit });
  fs.writeFileSync(path.join(created.worktreePath, "src", "a.txt"), "edited a\n", "utf8");
  fs.writeFileSync(path.join(created.worktreePath, "src", "b.txt"), "edited b\n", "utf8");
  const diff = manager.collectTaskDiff({ worktreePath: created.worktreePath, allowedPaths: ["src/a.txt", "src/b.txt"] });
  manager.holdTaskDiff({ batchId, taskId: "task-one", changes: diff.changes });
  manager.cleanupTaskWorktree({ batchId, taskId: "task-one" });
  const prepared = manager.prepareIntegration({ batchId, baseCommit, tasks: [{ taskId: "task-one", status: "completed" }] });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const approval = "e".repeat(64);
  const result = manager.applyIntegration({
    batchId,
    approvalRef: approval,
    expectedDiffHash: prepared.diffHash,
    manifest: {
      baseCommit,
      integration: {
        diffHash: prepared.diffHash,
        diffPreviewHash: prepared.diffPreviewHash,
        changePayloadHash: prepared.changePayloadHash,
        approvalRef: approval,
        baseCommit,
        sourceFileStates: prepared.sourceFileStates,
        filesChanged: prepared.filesChanged,
        changes: prepared.changes
      }
    },
    assertLockOwner() {
      return ownerHeld;
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "workspace_lock_lost");
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "alpha\n");
  assert.equal(fs.readFileSync(path.join(repo, "src", "b.txt"), "utf8"), "beta\n");
  assert.equal(manager.recoverPendingPromotions().ok, true);
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "alpha\n");
  assert.equal(fs.readFileSync(path.join(repo, "src", "b.txt"), "utf8"), "beta\n");
  ownerHeld = true;
  failAfterWrite = true;
  const secondBatchId = "7".repeat(32);
  const secondTask = manager.createTaskWorktree({ batchId: secondBatchId, taskId: "task-two", baseCommit });
  fs.writeFileSync(path.join(secondTask.worktreePath, "src", "a.txt"), "failed promotion\n", "utf8");
  const secondDiff = manager.collectTaskDiff({ worktreePath: secondTask.worktreePath, allowedPaths: ["src/a.txt"] });
  manager.holdTaskDiff({ batchId: secondBatchId, taskId: "task-two", changes: secondDiff.changes });
  manager.cleanupTaskWorktree({ batchId: secondBatchId, taskId: "task-two" });
  const secondPrepared = manager.prepareIntegration({ batchId: secondBatchId, baseCommit, tasks: [{ taskId: "task-two", status: "completed" }] });
  assert.equal(secondPrepared.ok, true, JSON.stringify(secondPrepared));
  const secondResult = manager.applyIntegration({
    batchId: secondBatchId,
    approvalRef: "f".repeat(64),
    expectedDiffHash: secondPrepared.diffHash,
    manifest: { baseCommit, integration: { ...secondPrepared, baseCommit, approvalRef: "f".repeat(64) } },
    assertLockOwner: () => ownerHeld
  });
  assert.equal(secondResult.ok, false);
  assert.equal(secondResult.reason, "promotion_rollback_failed");
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "alpha\n");
  failAfterWrite = false;
  assert.equal(manager.recoverPendingPromotions().ok, true);
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "alpha\n");
});

test("V2-WORKTREE: promotion recovery stops between files when its workspace lock is replaced", (t) => {
  const { root, repo, baseCommit } = createRepository(t);
  let ownerHeld = true;
  let promotingRenames = 0;
  let recovering = false;
  let recoveryRenames = 0;
  const manager = createManager(root, repo, [], {
    renamePromotionFile(sourcePath, targetPath) {
      fs.renameSync(sourcePath, targetPath);
      if (recovering) {
        recoveryRenames += 1;
        if (recoveryRenames === 1) ownerHeld = false;
      } else {
        promotingRenames += 1;
        if (promotingRenames === 2) ownerHeld = false;
      }
    }
  });
  const batchId = "1".repeat(32);
  const created = manager.createTaskWorktree({ batchId, taskId: "task-one", baseCommit });
  fs.writeFileSync(path.join(created.worktreePath, "src", "a.txt"), "edited a\n", "utf8");
  fs.writeFileSync(path.join(created.worktreePath, "src", "b.txt"), "edited b\n", "utf8");
  const diff = manager.collectTaskDiff({ worktreePath: created.worktreePath, allowedPaths: ["src/a.txt", "src/b.txt"] });
  manager.holdTaskDiff({ batchId, taskId: "task-one", changes: diff.changes });
  manager.cleanupTaskWorktree({ batchId, taskId: "task-one" });
  const prepared = manager.prepareIntegration({ batchId, baseCommit, tasks: [{ taskId: "task-one", status: "completed" }] });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const approvalRef = "a".repeat(64);
  const applied = manager.applyIntegration({
    batchId,
    approvalRef,
    expectedDiffHash: prepared.diffHash,
    manifest: { baseCommit, integration: { ...prepared, baseCommit, approvalRef } },
    assertLockOwner: () => ownerHeld
  });
  assert.equal(applied.ok, false);
  assert.equal(applied.reason, "workspace_lock_lost");
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "edited a\n");
  assert.equal(fs.readFileSync(path.join(repo, "src", "b.txt"), "utf8"), "edited b\n");
  ownerHeld = true;
  recovering = true;
  const interruptedRecovery = manager.recoverPendingPromotions({ assertLockOwner: () => ownerHeld });
  assert.equal(interruptedRecovery.ok, false);
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "edited a\n");
  assert.equal(fs.readFileSync(path.join(repo, "src", "b.txt"), "utf8"), "beta\n");
  assert.equal(manager.recoverPendingPromotions().ok, true);
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "alpha\n");
  assert.equal(fs.readFileSync(path.join(repo, "src", "b.txt"), "utf8"), "beta\n");
});

test("V2-WORKTREE: startup recovery restores a partial promotion after process termination", (t) => {
  const { root, repo, baseCommit } = createRepository(t);
  const worktreeRoot = path.join(root, "worktrees");
  const batchId = "8".repeat(32);
  const managerModule = new URL("../subagent-bridge/src/services/git-worktree-batch.js", import.meta.url).href;
  const childScript = [
    `import { createGitWorktreeBatchManager } from ${JSON.stringify(managerModule)};`,
    `import fs from "node:fs";`,
    `import path from "node:path";`,
    `const [sourceWorkspace, worktreeRoot, batchId, baseCommit] = process.argv.slice(1);`,
    `let renameCount = 0;`,
    `const manager = createGitWorktreeBatchManager({ sourceWorkspace, worktreeRoot, renamePromotionFile(source, target) { fs.renameSync(source, target); renameCount += 1; if (renameCount === 1) process.exit(77); } });`,
    `manager.recoverPendingPromotions();`,
    `const task = manager.createTaskWorktree({ batchId, taskId: "task-one", baseCommit });`,
    `if (!task.ok) process.exit(71);`,
    `fs.writeFileSync(path.join(task.worktreePath, "src", "a.txt"), "edited a\\n", "utf8");`,
    `fs.writeFileSync(path.join(task.worktreePath, "src", "b.txt"), "edited b\\n", "utf8");`,
    `const diff = manager.collectTaskDiff({ worktreePath: task.worktreePath, allowedPaths: ["src/a.txt", "src/b.txt"] });`,
    `if (!diff.ok) process.exit(72);`,
    `manager.holdTaskDiff({ batchId, taskId: "task-one", diff: diff.diff, diffHash: diff.diffHash, filesChanged: diff.filesChanged, changes: diff.changes });`,
    `manager.cleanupTaskWorktree({ batchId, taskId: "task-one" });`,
    `const prepared = manager.prepareIntegration({ batchId, baseCommit, tasks: [{ taskId: "task-one", status: "completed" }] });`,
    `if (!prepared.ok) process.exit(73);`,
    `manager.applyIntegration({ batchId, approvalRef: "a".repeat(64), expectedDiffHash: prepared.diffHash, manifest: { batchId, baseCommit, integration: { diffHash: prepared.diffHash, diffPreviewHash: prepared.diffPreviewHash, changePayloadHash: prepared.changePayloadHash, approvalRef: "a".repeat(64), baseCommit, sourceRefHash: null, sourceFileStates: prepared.sourceFileStates, filesChanged: prepared.filesChanged, changes: prepared.changes } } });`,
    `process.exit(74);`
  ].join("\n");
  let childFailure;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", childScript, repo, worktreeRoot, batchId, baseCommit], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
  } catch (error) {
    childFailure = error;
  }
  assert.equal(childFailure?.status, 77);
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8").replaceAll("\r\n", "\n"), "edited a\n");
  assert.equal(fs.readFileSync(path.join(repo, "src", "b.txt"), "utf8"), "beta\n");
  const recoveryManager = createManager(root, repo);
  assert.deepEqual(recoveryManager.promotionRecoveryStatus(), { ok: true, reason: null });
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "alpha\n");
  assert.equal(fs.readFileSync(path.join(repo, "src", "b.txt"), "utf8"), "beta\n");
});

test("V2-WORKTREE: startup recovery preserves a committed promotion for manifest reconciliation", (t) => {
  const { root, repo, baseCommit } = createRepository(t);
  const manager = createManager(root, repo);
  const batchId = "7".repeat(32);
  const created = manager.createTaskWorktree({ batchId, taskId: "task-one", baseCommit });
  fs.writeFileSync(path.join(created.worktreePath, "src", "a.txt"), "promoted\n", "utf8");
  const diff = manager.collectTaskDiff({ worktreePath: created.worktreePath, allowedPaths: ["src/a.txt"] });
  manager.holdTaskDiff({ batchId, taskId: "task-one", diff: diff.diff, diffHash: diff.diffHash, filesChanged: diff.filesChanged, changes: diff.changes });
  manager.cleanupTaskWorktree({ batchId, taskId: "task-one" });
  const prepared = manager.prepareIntegration({ batchId, baseCommit, tasks: [{ taskId: "task-one", status: "completed" }] });
  assert.equal(prepared.ok, true);
  const applied = manager.applyIntegration({
    batchId,
    approvalRef: "a".repeat(64),
    expectedDiffHash: prepared.diffHash,
    manifest: {
      batchId,
      baseCommit,
      integration: {
        diffHash: prepared.diffHash,
        diffPreviewHash: prepared.diffPreviewHash,
        changePayloadHash: prepared.changePayloadHash,
        approvalRef: "a".repeat(64),
        baseCommit,
        sourceRefHash: null,
        sourceFileStates: prepared.sourceFileStates,
        filesChanged: prepared.filesChanged,
        changes: prepared.changes
      }
    }
  });
  assert.equal(applied.ok, true);
  const journalRoot = path.join(root, "worktrees", "promotion-journals");
  const workspaceJournalRoot = path.join(journalRoot, fs.readdirSync(journalRoot)[0]);
  fs.rmSync(path.join(workspaceJournalRoot, `${batchId}.json`));
  const recoveryManager = createManager(root, repo);
  assert.deepEqual(recoveryManager.recoveredCommittedPromotions(), [{ batchId, diffHash: prepared.diffHash }]);
  const commitMarkerPath = path.join(workspaceJournalRoot, `${batchId}.commit.json`);
  assert.equal(fs.existsSync(commitMarkerPath), true);
  assert.equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8").replaceAll("\r\n", "\n"), "promoted\n");
  assert.equal(recoveryManager.finalizePromotion(batchId).ok, true);
  assert.equal(fs.existsSync(commitMarkerPath), false);
  assert.deepEqual(recoveryManager.promotionRecoveryStatus(), { ok: true, reason: null });
});
