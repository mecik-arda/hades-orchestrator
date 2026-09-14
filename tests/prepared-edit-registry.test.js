import assert from "node:assert/strict";
import test from "node:test";
import { createPreparedEditRegistry } from "../subagent-bridge/src/services/prepared-edit-registry.js";

const hash = (character) => character.repeat(64);

function record(overrides = {}) {
  return {
    executionIdHash: hash("a"),
    changeSetHash: hash("b"),
    approvalClass: "multiple_files",
    workspaceHash: hash("c"),
    sourceStateHash: hash("d"),
    changedPaths: ["src/value.txt"],
    sourceStateEntries: [{ relativePath: "src/value.txt", state: "present", sha256: hash("e") }],
    changes: [{ relativePath: "src/value.txt", changeType: "modified", diff: "safe diff", content: Buffer.from("after\n", "utf8") }],
    filesChanged: ["src/value.txt"],
    diff: "safe diff",
    backend: "opencode",
    model: "deepseek/deepseek-v4-pro",
    requestedModel: "deepseek_pro",
    resolvedModel: "deepseek/deepseek-v4-pro",
    providerLabel: "DeepSeek",
    ...overrides
  };
}

function binding(overrides = {}) {
  return {
    executionIdHash: hash("a"),
    changeSetHash: hash("b"),
    approvalClass: "multiple_files",
    workspaceHash: hash("c"),
    sourceStateHash: hash("d"),
    ...overrides
  };
}

test("WP5B-REGISTRY-01: kayıt tek kullanımlıktır ve projeksiyon içerik taşımaz", () => {
  const registry = createPreparedEditRegistry();
  const stored = registry.store(record());
  assert.match(stored.approvalRequestId, /^[a-f0-9]{64}$/);
  const peeked = registry.peek(stored.approvalRequestId);
  assert.equal(peeked.changeSetHash, hash("b"));
  assert.equal(peeked.changes, undefined);
  assert.equal(peeked.diff, undefined);
  assert.equal(JSON.stringify(peeked).includes("after"), false);
  const consumed = registry.consume(stored.approvalRequestId, binding());
  assert.equal(consumed.changes[0].content.toString("utf8"), "after\n");
  assert.equal(consumed.sourceStateEntries[0].sha256, hash("e"));
  assert.equal(registry.consume(stored.approvalRequestId, binding()), null);
  registry.settle(stored.approvalRequestId);
  assert.equal(registry.peek(stored.approvalRequestId), null);
  assert.deepEqual(registry.stats(), { entries: 0, totalBytes: 0 });
});

test("WP5B-REGISTRY-02: bilinmeyen kimlik ve yanlış binding reddedilir, doğru binding kaydı korur", () => {
  const registry = createPreparedEditRegistry();
  const stored = registry.store(record());
  assert.equal(registry.peek("f".repeat(64)), null);
  assert.equal(registry.consume("f".repeat(64), binding()), null);
  assert.equal(registry.consume(stored.approvalRequestId, binding({ changeSetHash: hash("9") })), null);
  assert.equal(registry.consume(stored.approvalRequestId, binding({ approvalClass: "new_file" })), null);
  assert.equal(registry.consume(stored.approvalRequestId, binding({ workspaceHash: hash("9") })), null);
  assert.equal(registry.consume(stored.approvalRequestId, binding({ sourceStateHash: hash("9") })), null);
  assert.notEqual(registry.peek(stored.approvalRequestId), null);
  assert.notEqual(registry.consume(stored.approvalRequestId, binding()), null);
});

test("WP5B-REGISTRY-03: son kullanma süresi enjekte edilen saatle uygulanır", () => {
  let currentTime = 1000;
  const registry = createPreparedEditRegistry({ ttlMs: 1000, now: () => currentTime });
  const stored = registry.store(record());
  currentTime = 1999;
  assert.notEqual(registry.peek(stored.approvalRequestId), null);
  currentTime = 2000;
  assert.equal(registry.peek(stored.approvalRequestId), null);
});

test("WP5B-REGISTRY-04: registry örnekleri birbirinden yalıtılmıştır", () => {
  const first = createPreparedEditRegistry();
  const second = createPreparedEditRegistry();
  const stored = first.store(record());
  assert.equal(second.peek(stored.approvalRequestId), null);
  assert.equal(second.consume(stored.approvalRequestId, binding()), null);
  assert.notEqual(first.peek(stored.approvalRequestId), null);
});

test("WP5B-REGISTRY-05: kapasite ve boyut sınırları uygulanır", () => {
  const single = createPreparedEditRegistry({ maxEntries: 1 });
  const first = single.store(record());
  const second = single.store(record({ executionIdHash: hash("1") }));
  assert.equal(single.peek(first.approvalRequestId), null);
  assert.notEqual(single.peek(second.approvalRequestId), null);

  const bounded = createPreparedEditRegistry({ maxTotalBytes: 1024 });
  assert.throws(() => bounded.store(record({ changes: [{ relativePath: "src/value.txt", changeType: "modified", diff: "safe diff", content: Buffer.alloc(2048, 1) }] })), /storage limit/);
});

test("WP5B-REGISTRY-06: geçersiz kayıt ve sınıf dışı onay reddedilir", () => {
  const registry = createPreparedEditRegistry();
  assert.throws(() => registry.store(record({ approvalClass: "policy_config" })), /not approvable/);
  assert.throws(() => registry.store(record({ changeSetHash: "kısa" })), /invalid prepared edit/);
  assert.throws(() => registry.store(record({ changedPaths: ["../escape.txt"], sourceStateEntries: [{ relativePath: "../escape.txt", state: "absent" }], changes: [{ relativePath: "../escape.txt", changeType: "created", diff: "d", content: Buffer.from("x") }], filesChanged: ["../escape.txt"] })), /invalid prepared edit path/);
  assert.throws(() => registry.store(record({ changes: [] })), /requires changes/);
  assert.throws(() => registry.store(record({ sourceStateEntries: [] })), /source state/);
});

test("WP5B-REGISTRY-07: invalidate bekleyen kaydı kaldırır ve tüketilmiş kayda dokunmaz", () => {
  const registry = createPreparedEditRegistry();
  const first = registry.store(record());
  registry.invalidate(first.approvalRequestId);
  assert.equal(registry.peek(first.approvalRequestId), null);
  const second = registry.store(record());
  assert.notEqual(registry.consume(second.approvalRequestId, binding()), null);
  registry.invalidate(second.approvalRequestId);
  assert.equal(registry.stats().entries, 1);
});

test("WP5B-REGISTRY-08: saklanan içerik defensive-copy edilir", () => {
  const registry = createPreparedEditRegistry();
  const sourceContent = Buffer.from("after\n", "utf8");
  const input = record({ changes: [{ relativePath: "src/value.txt", changeType: "modified", diff: "safe diff", content: sourceContent }] });
  const stored = registry.store(input);
  sourceContent.write("tampered", 0, "utf8");
  input.changes[0].content = Buffer.from("mutated\n", "utf8");
  const consumed = registry.consume(stored.approvalRequestId, binding());
  assert.equal(consumed.changes[0].content.toString("utf8"), "after\n");
});

test("WP5B-REGISTRY-09: release uygulanan kaydı beklemeye döndürür", () => {
  const registry = createPreparedEditRegistry();
  const stored = registry.store(record());
  assert.notEqual(registry.consume(stored.approvalRequestId, binding()), null);
  registry.release(stored.approvalRequestId);
  assert.notEqual(registry.peek(stored.approvalRequestId), null);
  assert.notEqual(registry.consume(stored.approvalRequestId, binding()), null);
  registry.settle(stored.approvalRequestId);
  assert.equal(registry.peek(stored.approvalRequestId), null);
});
