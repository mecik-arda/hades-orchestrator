import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyMemoryMutationRecovery,
  applyMemoryVaultRepair,
  planMemoryMutationRecovery,
  planMemoryVaultRepair,
  promotePersistentMemory,
  storePersistentMemory
} from "../subagent-bridge/src/memory.js";

function createConfiguration(vaultRootPath) {
  return {
    statePaths: {
      logs: path.join(vaultRootPath, ".runtime", "logs"),
      state: path.join(vaultRootPath, ".runtime", "state")
    },
    memory: {
      enabled: true,
      vaultRootPath,
      allowedWriteFolders: ["00_Inbox", "03_Resources"],
      ignoredDirectories: ["05_Attachments", "node_modules"],
      maxIndexedFiles: 100,
      maxSearchResults: 10,
      maxSearchFileBytes: 131072,
      maxExcerptCharacters: 300,
      maxReadBytes: 262144,
      maxWriteBytes: 65536,
      auditMaxBytes: 1048576,
      reviewDefaults: {
        sourceStalenessDays: 365,
        maxDuplicateGroups: 20,
        maxReadBytesPerFile: 32768
      }
    }
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function journalDirectory(configuration) {
  return path.join(configuration.statePaths.state, "memory-mutations");
}

function journalFiles(configuration) {
  const directory = journalDirectory(configuration);
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((entry) => entry.endsWith(".json")) : [];
}

function auditRecords(configuration) {
  const auditPath = path.join(configuration.statePaths.logs, "audit", "memory-events.jsonl");
  if (!fs.existsSync(auditPath)) return [];
  return fs.readFileSync(auditPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function writeIntent(configuration, intent) {
  const directory = journalDirectory(configuration);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${intent.journalId}.json`), JSON.stringify(intent), "utf8");
}

function withPatchedJournalRead(journalPath, transform, callback) {
  const originalReadFileSync = fs.readFileSync;
  const targetPath = path.resolve(journalPath);
  const readCounts = new Map();
  fs.readFileSync = function patchedReadFileSync(filePath, ...rest) {
    if (typeof filePath === "string" && path.resolve(filePath) === targetPath) {
      const count = (readCounts.get(targetPath) || 0) + 1;
      readCounts.set(targetPath, count);
      if (count === 2) return transform();
    }
    return originalReadFileSync.call(fs, filePath, ...rest);
  };
  let result;
  try {
    result = callback();
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(readCounts.get(targetPath) || 0, 2);
  return result;
}

function createNoteInput(overrides = {}) {
  return {
    relativePath: "03_Resources/Recovery.md",
    title: "Recovery Notu",
    content: "Kurtarma testi icin guvenli icerik.",
    sources: [],
    tags: [],
    confidence: "high",
    verificationStatus: "verified",
    taskId: "recovery-test",
    stage: "published",
    ...overrides
  };
}

test("REC-01: audit yazılamazsa niyet kalır, kurtarma tekrar oynatır ve idempotenttir", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-store-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  const auditDirectory = path.join(configuration.statePaths.logs, "audit");
  fs.mkdirSync(path.dirname(auditDirectory), { recursive: true });
  fs.writeFileSync(auditDirectory, "blocked", "utf8");
  const stored = storePersistentMemory(configuration, createNoteInput());
  assert.equal(stored.mutationCompleted, true);
  assert.equal(stored.auditWritten, false);
  assert.equal(stored.audit.reason, "audit_pending_recovery");
  assert.equal(journalFiles(configuration).length, 1);
  fs.rmSync(auditDirectory, { force: true });
  const recovery = applyMemoryMutationRecovery(configuration);
  assert.equal(recovery.applied, true);
  assert.equal(recovery.appliedCount, 1);
  assert.equal(recovery.appliedItems[0].action, "replay_audit");
  assert.equal(journalFiles(configuration).length, 0);
  const records = auditRecords(configuration);
  assert.equal(records.filter((record) => record.event === "ADD").length, 1);
  const second = applyMemoryMutationRecovery(configuration);
  assert.equal(second.appliedCount, 0);
  assert.equal(auditRecords(configuration).filter((record) => record.event === "ADD").length, 1);
});

test("REC-02: uygulanmamış niyet atılır, audit yazılmaz", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-discard-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  const stored = storePersistentMemory(configuration, createNoteInput());
  const currentContent = fs.readFileSync(path.join(vaultRootPath, "03_Resources", "Recovery.md"), "utf8");
  const relativePath = "03_Resources/Recovery.md";
  const journalId = sha256(relativePath);
  writeIntent(configuration, {
    journalId,
    kind: "store",
    event: "UPDATE",
    noteIdHash: journalId,
    relativePath,
    oldSha256: sha256(currentContent),
    newSha256: sha256("uygulanmamis icerik")
  });
  const recovery = applyMemoryMutationRecovery(configuration);
  assert.equal(recovery.applied, true);
  assert.equal(recovery.appliedItems[0].action, "discard");
  assert.equal(journalFiles(configuration).length, 0);
  assert.equal(fs.readFileSync(path.join(vaultRootPath, relativePath), "utf8"), currentContent);
  assert.equal(auditRecords(configuration).filter((record) => record.event === "UPDATE").length, 0);
  assert.equal(stored.sha256, sha256(currentContent));
});

test("REC-03: eşleşmeyen niyet unresolved kalır ve raporlanır", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-unresolved-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  storePersistentMemory(configuration, createNoteInput());
  const relativePath = "03_Resources/Recovery.md";
  const journalId = sha256(relativePath);
  writeIntent(configuration, {
    journalId,
    kind: "store",
    event: "UPDATE",
    noteIdHash: journalId,
    relativePath,
    oldSha256: sha256("baska icerik"),
    newSha256: sha256("daha baska icerik")
  });
  const plan = planMemoryMutationRecovery(configuration);
  assert.equal(plan.unresolvedCount, 1);
  assert.equal(plan.items[0].reason, "note_hash_mismatch");
  const recovery = applyMemoryMutationRecovery(configuration);
  assert.equal(recovery.applied, false);
  assert.equal(recovery.unresolvedCount, 1);
  assert.equal(journalFiles(configuration).length, 1);
});

test("REC-04: yarım kalan promote tamamlanır, audit yazılır ve idempotent olur", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-promote-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  const draft = storePersistentMemory(configuration, createNoteInput({
    relativePath: "00_Inbox/Taslak.md",
    title: "Taslak Not",
    stage: "draft"
  }));
  assert.equal(draft.created, true);
  const sourcePath = path.join(vaultRootPath, "00_Inbox", "Taslak.md");
  const sourceContent = fs.readFileSync(sourcePath, "utf8");
  const targetRelativePath = "03_Resources/Taslak.md";
  const targetPath = path.join(vaultRootPath, "03_Resources", "Taslak.md");
  const publishedContent = sourceContent.replace(/^stage:\s*.+$/m, "stage: published");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, publishedContent, "utf8");
  const noteIdHash = sha256("00_Inbox/Taslak.md:03_Resources/Taslak.md");
  writeIntent(configuration, {
    journalId: noteIdHash,
    kind: "promote",
    event: "PROMOTE",
    noteIdHash,
    sourceRelativePath: "00_Inbox/Taslak.md",
    targetRelativePath,
    oldSha256: sha256(sourceContent),
    newSha256: sha256(publishedContent),
    auditMeta: { confidence: "high", verificationStatus: "verified" }
  });
  const plan = planMemoryVaultRepair(configuration, { kind: "promote-reconcile" });
  assert.equal(plan.completePromoteCount, 1);
  const recovery = applyMemoryVaultRepair(configuration, { kind: "promote-reconcile" });
  assert.equal(recovery.applied, true);
  assert.equal(recovery.appliedItems[0].action, "complete_promote");
  assert.equal(fs.existsSync(sourcePath), false);
  assert.equal(fs.existsSync(targetPath), true);
  assert.equal(journalFiles(configuration).length, 0);
  const promoteRecords = auditRecords(configuration).filter((record) => record.event === "PROMOTE");
  assert.equal(promoteRecords.length, 1);
  assert.equal(promoteRecords[0].newSha256, sha256(publishedContent));
  const second = applyMemoryVaultRepair(configuration, { kind: "promote-reconcile" });
  assert.equal(second.applied, true);
  assert.equal(second.appliedCount, 0);
  assert.equal(auditRecords(configuration).filter((record) => record.event === "PROMOTE").length, 1);
});

test("REC-05: uygulanmamış promote niyeti atılır, kaynak korunur", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-promote-skip-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  storePersistentMemory(configuration, createNoteInput({
    relativePath: "00_Inbox/Taslak.md",
    title: "Taslak Not",
    stage: "draft"
  }));
  const sourceContent = fs.readFileSync(path.join(vaultRootPath, "00_Inbox", "Taslak.md"), "utf8");
  const noteIdHash = sha256("00_Inbox/Taslak.md:03_Resources/Taslak.md");
  writeIntent(configuration, {
    journalId: noteIdHash,
    kind: "promote",
    event: "PROMOTE",
    noteIdHash,
    sourceRelativePath: "00_Inbox/Taslak.md",
    targetRelativePath: "03_Resources/Taslak.md",
    oldSha256: sha256(sourceContent),
    newSha256: sha256("hedef hic yazilmadi")
  });
  const recovery = applyMemoryMutationRecovery(configuration);
  assert.equal(recovery.applied, true);
  assert.equal(recovery.appliedItems[0].action, "discard");
  assert.equal(fs.existsSync(path.join(vaultRootPath, "00_Inbox", "Taslak.md")), true);
  assert.equal(fs.existsSync(path.join(vaultRootPath, "03_Resources", "Taslak.md")), false);
  assert.equal(auditRecords(configuration).filter((record) => record.event === "PROMOTE").length, 0);
});

test("REC-06: promote ve store niyeti gerçek akışta journal ile yazılır", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-flow-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  const stored = storePersistentMemory(configuration, createNoteInput({
    relativePath: "00_Inbox/Akış.md",
    title: "Akış Notu",
    stage: "draft"
  }));
  assert.equal(stored.auditWritten, true);
  assert.equal(journalFiles(configuration).length, 0);
  const sourcePath = path.join(vaultRootPath, "00_Inbox", "Akış.md");
  const promoted = promotePersistentMemory(configuration, {
    sourceRelativePath: "00_Inbox/Akış.md",
    targetRelativePath: "03_Resources/Akış.md",
    expectedSourceSha256: sha256(fs.readFileSync(sourcePath, "utf8"))
  });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.auditWritten, true);
  assert.equal(journalFiles(configuration).length, 0);
  assert.equal(fs.existsSync(sourcePath), false);
  assert.equal(auditRecords(configuration).filter((record) => record.event === "PROMOTE").length, 1);
});

test("REC-07: audit zaten yazılmışsa replay mükerrer kayıt üretmez", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-replay-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  storePersistentMemory(configuration, createNoteInput());
  const relativePath = "03_Resources/Recovery.md";
  const content = fs.readFileSync(path.join(vaultRootPath, relativePath), "utf8");
  const journalId = sha256(relativePath);
  writeIntent(configuration, {
    journalId,
    kind: "store",
    event: "ADD",
    noteIdHash: journalId,
    relativePath,
    oldSha256: null,
    newSha256: sha256(content)
  });
  const before = auditRecords(configuration).length;
  const recovery = applyMemoryMutationRecovery(configuration);
  assert.equal(recovery.applied, true);
  assert.equal(recovery.appliedItems[0].action, "replay_audit");
  assert.equal(journalFiles(configuration).length, 0);
  assert.equal(auditRecords(configuration).length, before);
});

test("REC-08: çözülemeyen niyet üzerine yeni niyet yazılmaz ve mutasyon reddedilir", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-no-overwrite-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  storePersistentMemory(configuration, createNoteInput());
  const relativePath = "03_Resources/Recovery.md";
  const journalId = sha256(relativePath);
  const unresolvedIntent = {
    journalId,
    kind: "store",
    event: "UPDATE",
    noteIdHash: journalId,
    relativePath,
    oldSha256: sha256("harici eski icerik"),
    newSha256: sha256("harici yeni icerik")
  };
  writeIntent(configuration, unresolvedIntent);
  const notePath = path.join(vaultRootPath, relativePath);
  const contentBefore = fs.readFileSync(notePath, "utf8");
  const expectedSha256 = sha256(contentBefore);
  assert.throws(
    () => storePersistentMemory(configuration, createNoteInput({ content: "Ikinci surum icerigi.", expectedSha256 })),
    /çözülmemiş mutasyon günlüğü/
  );
  assert.equal(fs.readFileSync(notePath, "utf8"), contentBefore);
  const files = journalFiles(configuration);
  assert.equal(files.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(journalDirectory(configuration), files[0]), "utf8")), unresolvedIntent);
  const plan = planMemoryMutationRecovery(configuration);
  assert.equal(plan.unresolvedCount, 1);
});

test("REC-09: çoklu onarım ortasında çökme sonrası kurtarma dosyaları ayrı ayrı uzlaştırır", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-partial-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  storePersistentMemory(configuration, createNoteInput({ relativePath: "03_Resources/Bir.md", title: "Bir" }));
  storePersistentMemory(configuration, createNoteInput({ relativePath: "03_Resources/Iki.md", title: "Iki" }));
  const firstPath = path.join(vaultRootPath, "03_Resources", "Bir.md");
  const secondPath = path.join(vaultRootPath, "03_Resources", "Iki.md");
  const firstOld = fs.readFileSync(firstPath, "utf8");
  const secondOld = fs.readFileSync(secondPath, "utf8");
  const firstNew = `${firstOld}\nonarim sonrasi icerik\n`;
  fs.writeFileSync(firstPath, firstNew, "utf8");
  const firstId = sha256("03_Resources/Bir.md");
  const secondId = sha256("03_Resources/Iki.md");
  writeIntent(configuration, {
    journalId: firstId,
    kind: "repair",
    event: "UPDATE",
    noteIdHash: firstId,
    relativePath: "03_Resources/Bir.md",
    oldSha256: sha256(firstOld),
    newSha256: sha256(firstNew)
  });
  writeIntent(configuration, {
    journalId: secondId,
    kind: "repair",
    event: "UPDATE",
    noteIdHash: secondId,
    relativePath: "03_Resources/Iki.md",
    oldSha256: sha256(secondOld),
    newSha256: sha256(`${secondOld}yazilmamis`)
  });
  const recovery = applyMemoryMutationRecovery(configuration);
  assert.equal(recovery.applied, true);
  const actions = Object.fromEntries(recovery.appliedItems.map((item) => [item.journalId, item.action]));
  assert.equal(actions[firstId], "replay_audit");
  assert.equal(actions[secondId], "discard");
  assert.equal(journalFiles(configuration).length, 0);
  assert.equal(fs.readFileSync(secondPath, "utf8"), secondOld);
});

test("REC-10: kaynak silinmiş yarım promote audit replay ile kapanır", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-promote-only-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  storePersistentMemory(configuration, createNoteInput({
    relativePath: "00_Inbox/Taslak.md",
    title: "Taslak Not",
    stage: "draft"
  }));
  const sourcePath = path.join(vaultRootPath, "00_Inbox", "Taslak.md");
  const sourceContent = fs.readFileSync(sourcePath, "utf8");
  const targetRelativePath = "03_Resources/Taslak.md";
  const targetPath = path.join(vaultRootPath, "03_Resources", "Taslak.md");
  const publishedContent = sourceContent.replace(/^stage:\s*.+$/m, "stage: published");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, publishedContent, "utf8");
  fs.rmSync(sourcePath);
  const noteIdHash = sha256("00_Inbox/Taslak.md:03_Resources/Taslak.md");
  writeIntent(configuration, {
    journalId: noteIdHash,
    kind: "promote",
    event: "PROMOTE",
    noteIdHash,
    sourceRelativePath: "00_Inbox/Taslak.md",
    targetRelativePath,
    oldSha256: sha256(sourceContent),
    newSha256: sha256(publishedContent)
  });
  const recovery = applyMemoryMutationRecovery(configuration);
  assert.equal(recovery.applied, true);
  assert.equal(recovery.appliedItems[0].action, "replay_audit");
  assert.equal(journalFiles(configuration).length, 0);
  assert.equal(auditRecords(configuration).filter((record) => record.event === "PROMOTE").length, 1);
  assert.equal(fs.existsSync(targetPath), true);
});

test("REC-11: mutasyon günlüğü yazılamazsa mağaza mutasyonu reddeder", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-journal-blocked-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  fs.mkdirSync(configuration.statePaths.state, { recursive: true });
  fs.writeFileSync(journalDirectory(configuration), "engel", "utf8");
  const notePath = path.join(vaultRootPath, "03_Resources", "Recovery.md");
  assert.throws(
    () => storePersistentMemory(configuration, createNoteInput()),
    /hafıza mutasyon günlüğü yazılamadı/
  );
  assert.equal(fs.existsSync(notePath), false);
});

test("REC-12: audit yazılamazsa kurtarma niyeti korur ve sonra tamamlar", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-audit-blocked-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  storePersistentMemory(configuration, createNoteInput());
  const relativePath = "03_Resources/Recovery.md";
  const notePath = path.join(vaultRootPath, relativePath);
  const noteContent = fs.readFileSync(notePath, "utf8");
  const journalId = sha256(relativePath);
  writeIntent(configuration, {
    journalId,
    kind: "store",
    event: "UPDATE",
    noteIdHash: journalId,
    relativePath,
    oldSha256: null,
    newSha256: sha256(noteContent)
  });
  const auditDirectory = path.join(configuration.statePaths.logs, "audit");
  fs.rmSync(auditDirectory, { recursive: true, force: true });
  fs.writeFileSync(auditDirectory, "engel", "utf8");
  const blocked = applyMemoryMutationRecovery(configuration);
  assert.equal(blocked.applied, false);
  assert.equal(blocked.unresolvedCount, 1);
  assert.equal(journalFiles(configuration).length, 1);
  fs.rmSync(auditDirectory, { force: true });
  const recovered = applyMemoryMutationRecovery(configuration);
  assert.equal(recovered.applied, true);
  assert.equal(recovered.appliedItems[0].action, "replay_audit");
  assert.equal(journalFiles(configuration).length, 0);
  assert.equal(auditRecords(configuration).filter((record) => record.event === "UPDATE").length, 1);
});

test("REC-13: onarım günlüğü yazılamazsa onarım uygulanmaz", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-repair-blocked-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  const relativePath = "03_Resources/Onarim.md";
  const notePath = path.join(vaultRootPath, relativePath);
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  const noteContent = [
    "---",
    "title: \"Onarim Notu\"",
    "created: \"2026-09-01T00:00:00.000Z\"",
    "updated: \"2026-09-01T00:00:00.000Z\"",
    "confidence: high",
    "verification: verified",
    "memory_type: semantic",
    "stage: published",
    "---",
    "",
    "Onarim testi icerigi.",
    ""
  ].join("\n");
  fs.writeFileSync(notePath, noteContent, "utf8");
  fs.mkdirSync(configuration.statePaths.state, { recursive: true });
  fs.writeFileSync(journalDirectory(configuration), "engel", "utf8");
  const result = applyMemoryVaultRepair(configuration, { kind: "vault-schema" });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "journal_unavailable");
  assert.equal(fs.readFileSync(notePath, "utf8"), noteContent);
});

test("REC-14: eşzamanlı kurtarma süreçleri niyeti bir kez kapatır", async (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-concurrent-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  storePersistentMemory(configuration, createNoteInput());
  const relativePath = "03_Resources/Recovery.md";
  const noteContent = fs.readFileSync(path.join(vaultRootPath, relativePath), "utf8");
  const journalId = sha256(relativePath);
  writeIntent(configuration, {
    journalId,
    kind: "store",
    event: "UPDATE",
    noteIdHash: journalId,
    relativePath,
    oldSha256: null,
    newSha256: sha256(noteContent)
  });
  const moduleUrl = new URL("../subagent-bridge/src/memory.js", import.meta.url).href;
  const source = `import { applyMemoryMutationRecovery } from ${JSON.stringify(moduleUrl)}; const configuration = ${JSON.stringify(configuration)}; const result = applyMemoryMutationRecovery(configuration); process.stdout.write(JSON.stringify({ applied: result.applied }));`;
  const runRecovery = () => new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`recovery process exited with ${code}: ${stderr.trim()}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`recovery process returned invalid output: ${stdout}`));
      }
    });
  });
  const results = await Promise.all([runRecovery(), runRecovery(), runRecovery()]);
  assert.equal(results.some((result) => result.applied === true), true);
  assert.equal(journalFiles(configuration).length, 0);
  assert.equal(auditRecords(configuration).filter((record) => record.event === "UPDATE").length, 1);
  const followUp = applyMemoryMutationRecovery(configuration);
  assert.equal(followUp.applied, true);
  assert.equal(followUp.appliedCount, 0);
});

test("REC-15: bozuk journal tarama hatası olarak raporlanır ve dosya korunur", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-corrupt-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  const relativePath = "03_Resources/Recovery.md";
  const journalId = sha256(relativePath);
  const directory = journalDirectory(configuration);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${journalId}.json`), "{bozuk", "utf8");
  const recovery = applyMemoryMutationRecovery(configuration);
  assert.equal(recovery.applied, false);
  assert.equal(recovery.reason, "journal_scan_error");
  assert.equal(journalFiles(configuration).length, 1);
  const plan = planMemoryMutationRecovery(configuration);
  assert.equal(plan.error, true);
  assert.equal(plan.journalCount, 0);
});

test("REC-16: journal okunamazsa read_failed olarak raporlanır ve dosya korunur", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-read-failed-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  const relativePath = "03_Resources/Recovery.md";
  const journalId = sha256(relativePath);
  const intent = {
    journalId,
    kind: "store",
    event: "UPDATE",
    noteIdHash: journalId,
    relativePath,
    oldSha256: sha256("eski icerik"),
    newSha256: sha256("yeni icerik")
  };
  writeIntent(configuration, intent);
  const journalPath = path.join(journalDirectory(configuration), `${journalId}.json`);
  const recovery = withPatchedJournalRead(journalPath, () => {
    const error = new Error("journal okunamadi");
    error.code = "EACCES";
    throw error;
  }, () => applyMemoryMutationRecovery(configuration));
  assert.equal(recovery.applied, false);
  assert.equal(recovery.unresolvedCount, 1);
  assert.equal(recovery.unresolved[0].reason, "journal_read_failed");
  assert.equal(recovery.appliedCount, 0);
  assert.equal(recovery.appliedItems.length, 0);
  assert.equal(fs.readFileSync(journalPath, "utf8"), JSON.stringify(intent));
  assert.equal(journalFiles(configuration).length, 1);
});

test("REC-17: bozuk journal içeriği invalid olarak raporlanır ve dosya korunur", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-invalid-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  const relativePath = "03_Resources/Recovery.md";
  const journalId = sha256(relativePath);
  const intent = {
    journalId,
    kind: "store",
    event: "UPDATE",
    noteIdHash: journalId,
    relativePath,
    oldSha256: sha256("eski icerik"),
    newSha256: sha256("yeni icerik")
  };
  writeIntent(configuration, intent);
  const journalPath = path.join(journalDirectory(configuration), `${journalId}.json`);
  const recovery = withPatchedJournalRead(journalPath, () => "{bozuk", () => applyMemoryMutationRecovery(configuration));
  assert.equal(recovery.applied, false);
  assert.equal(recovery.unresolvedCount, 1);
  assert.equal(recovery.unresolved[0].reason, "journal_invalid");
  assert.equal(recovery.appliedCount, 0);
  assert.equal(recovery.appliedItems.length, 0);
  assert.equal(fs.readFileSync(journalPath, "utf8"), JSON.stringify(intent));
  assert.equal(journalFiles(configuration).length, 1);
});

test("REC-18: değişen journal nesli regenerated olarak raporlanır ve dosya korunur", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-regenerated-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  const relativePath = "03_Resources/Recovery.md";
  const journalId = sha256(relativePath);
  const intent = {
    journalId,
    kind: "store",
    event: "UPDATE",
    noteIdHash: journalId,
    relativePath,
    oldSha256: sha256("eski icerik"),
    newSha256: sha256("yeni icerik")
  };
  writeIntent(configuration, intent);
  const journalPath = path.join(journalDirectory(configuration), `${journalId}.json`);
  const regeneratedJournalId = sha256("baska journal");
  const recovery = withPatchedJournalRead(journalPath, () => JSON.stringify({
    journalId: regeneratedJournalId,
    kind: "store",
    event: "UPDATE",
    noteIdHash: regeneratedJournalId,
    relativePath,
    oldSha256: sha256("eski icerik"),
    newSha256: sha256("yeni icerik")
  }), () => applyMemoryMutationRecovery(configuration));
  assert.equal(recovery.applied, false);
  assert.equal(recovery.unresolvedCount, 1);
  assert.equal(recovery.unresolved[0].reason, "journal_regenerated");
  assert.equal(recovery.appliedCount, 0);
  assert.equal(recovery.appliedItems.length, 0);
  assert.equal(fs.readFileSync(journalPath, "utf8"), JSON.stringify(intent));
  assert.equal(journalFiles(configuration).length, 1);
});

test("REC-19: dosya adıyla eşleşmeyen artık niyet fail-closed taranır ve dosya korunur", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-orphan-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  const relativePath = "03_Resources/Recovery.md";
  const journalId = sha256(relativePath);
  const directory = journalDirectory(configuration);
  fs.mkdirSync(directory, { recursive: true });
  const orphanPath = path.join(directory, "orphan.json");
  fs.writeFileSync(orphanPath, JSON.stringify({
    journalId,
    kind: "store",
    event: "UPDATE",
    noteIdHash: journalId,
    relativePath,
    oldSha256: sha256("eski icerik"),
    newSha256: sha256("yeni icerik")
  }), "utf8");
  const plan = planMemoryMutationRecovery(configuration);
  assert.equal(plan.error, true);
  assert.equal(plan.journalCount, 0);
  const recovery = applyMemoryMutationRecovery(configuration);
  assert.equal(recovery.applied, false);
  assert.equal(recovery.reason, "journal_scan_error");
  assert.equal(recovery.appliedCount, 0);
  assert.equal(recovery.unresolvedCount, 0);
  assert.equal(fs.existsSync(orphanPath), true);
  assert.equal(journalFiles(configuration).length, 1);
  assert.deepEqual(plan.items, []);
  assert.equal(recovery.appliedItems.length, 0);
  assert.equal(recovery.unresolved.length, 0);
});

test("REC-20: ikinci okumada silinen journal eksik olarak taranır ve dosya diskte kalmaz", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-vanish-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  const relativePath = "03_Resources/Recovery.md";
  const journalId = sha256(relativePath);
  const intent = {
    journalId,
    kind: "store",
    event: "UPDATE",
    noteIdHash: journalId,
    relativePath,
    oldSha256: sha256("eski icerik"),
    newSha256: sha256("yeni icerik")
  };
  writeIntent(configuration, intent);
  const journalPath = path.join(journalDirectory(configuration), `${journalId}.json`);
  const recovery = withPatchedJournalRead(journalPath, () => {
    fs.rmSync(journalPath);
    const error = new Error("journal artik yok");
    error.code = "ENOENT";
    throw error;
  }, () => applyMemoryMutationRecovery(configuration));
  assert.equal(recovery.applied, true);
  assert.equal(recovery.appliedCount, 0);
  assert.equal(recovery.unresolvedCount, 0);
  assert.equal(fs.existsSync(journalPath), false);
  assert.equal(journalFiles(configuration).length, 0);
});

test("REC-21: karma journal dizininde tarama hatası tüm mutasyonları fail-closed durdurur", (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-recovery-mixed-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  const relativePath = "03_Resources/Recovery.md";
  const journalId = sha256(relativePath);
  writeIntent(configuration, {
    journalId,
    kind: "store",
    event: "UPDATE",
    noteIdHash: journalId,
    relativePath,
    oldSha256: sha256("eski icerik"),
    newSha256: sha256("yeni icerik")
  });
  const orphanJournalId = sha256("baska not");
  const directory = journalDirectory(configuration);
  fs.writeFileSync(path.join(directory, "orphan.json"), JSON.stringify({
    journalId: orphanJournalId,
    kind: "store",
    event: "UPDATE",
    noteIdHash: orphanJournalId,
    relativePath,
    oldSha256: sha256("eski icerik"),
    newSha256: sha256("yeni icerik")
  }), "utf8");
  const plan = planMemoryMutationRecovery(configuration);
  assert.equal(plan.error, true);
  assert.equal(plan.journalCount, 1);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].reason, "note_missing");
  const recovery = applyMemoryMutationRecovery(configuration);
  assert.equal(recovery.applied, false);
  assert.equal(recovery.reason, "journal_scan_error");
  assert.equal(recovery.appliedCount, 0);
  assert.equal(recovery.unresolvedCount, 0);
  assert.equal(journalFiles(configuration).length, 2);
  assert.equal(auditRecords(configuration).length, 0);
});
