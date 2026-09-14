import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateChangeSetHash,
  classifyChangeSet,
  isOrchestratorApprovableClass,
  isPolicyConfigPath
} from "../subagent-bridge/src/services/approval-boundary.js";

function change(relativePath, changeType = "modified") {
  return { relativePath, changeType, diff: `${relativePath}:${changeType}` };
}

test("WP5 sınıflandırıcı yüksek etki sınıflarını düşük etkiden ayırır", () => {
  assert.equal(classifyChangeSet([change("src/value.txt")]), "low_impact");
  assert.equal(classifyChangeSet([change("src/created.txt", "created")]), "new_file");
  assert.equal(classifyChangeSet([change("src/a.txt"), change("src/b.txt")]), "multiple_files");
  assert.equal(classifyChangeSet([change("config/policy.json")]), "policy_config");
  assert.equal(classifyChangeSet([change("src/value.txt", "deleted")]), "irreversible");
  assert.equal(classifyChangeSet([change("src/value.txt")], { externalService: true }), "external_service");
  assert.equal(classifyChangeSet([change("src/value.txt")], { irreversible: true }), "irreversible");
});

test("WP5-B sınıflandırıcı manifest, CI, ajan, MCP ve policy dosyalarını kapsar", () => {
  assert.equal(classifyChangeSet([change("manifest.json")]), "policy_config");
  assert.equal(classifyChangeSet([change("manifest-schema.json")]), "policy_config");
  assert.equal(classifyChangeSet([change(".github/workflows/ci.yml")]), "policy_config");
  assert.equal(classifyChangeSet([change(".agents/skills/deneme/SKILL.md")]), "policy_config");
  assert.equal(classifyChangeSet([change("agents/planner.json")]), "policy_config");
  assert.equal(classifyChangeSet([change("mcp.json")]), "policy_config");
  assert.equal(classifyChangeSet([change(".mcp.json")]), "policy_config");
  assert.equal(classifyChangeSet([change("AGENTS.md")]), "policy_config");
  assert.equal(classifyChangeSet([change(".opencode/agent/orchestrator.md")]), "policy_config");
  assert.equal(classifyChangeSet([change(".gitlab-ci.yml")]), "policy_config");
  assert.equal(classifyChangeSet([change("Jenkinsfile")]), "policy_config");
  assert.equal(classifyChangeSet([change("azure-pipelines.yml")]), "policy_config");
  assert.equal(classifyChangeSet([change(".circleci/config.yml")]), "policy_config");
  assert.equal(classifyChangeSet([change("package.json")]), "policy_config");
  assert.equal(classifyChangeSet([change("Cargo.toml")]), "policy_config");
  assert.equal(classifyChangeSet([change("pyproject.toml")]), "policy_config");
  assert.equal(classifyChangeSet([change("manifest.webmanifest")]), "policy_config");
  assert.equal(classifyChangeSet([change("requirements-dev.txt")]), "policy_config");
  assert.equal(classifyChangeSet([change("pnpm-lock.yaml")]), "policy_config");
  assert.equal(isPolicyConfigPath("src/utils/package.json"), true);
  assert.equal(isPolicyConfigPath("src/mcp-client.js"), false);
  assert.equal(isPolicyConfigPath("src/manifest.test.js"), false);
});

test("WP5-B yalnız yeni dosya ve çoklu dosya sınıfları orkestratör onayına açıktır", () => {
  assert.equal(isOrchestratorApprovableClass("new_file"), true);
  assert.equal(isOrchestratorApprovableClass("multiple_files"), true);
  assert.equal(isOrchestratorApprovableClass("low_impact"), false);
  assert.equal(isOrchestratorApprovableClass("policy_config"), false);
  assert.equal(isOrchestratorApprovableClass("external_service"), false);
  assert.equal(isOrchestratorApprovableClass("irreversible"), false);
});

test("WP5 change set hash sıralamadan bağımsızdır", () => {
  const left = [change("src/a.txt"), change("src/b.txt")];
  const right = [left[1], left[0]];
  assert.equal(calculateChangeSetHash(left), calculateChangeSetHash(right));
});

test("WP5-B change set hash içerik özetini bağlar ve sıralamadan bağımsızdır", () => {
  const left = { relativePath: "src/a.txt", changeType: "modified", diff: "d", contentSha256: "1".repeat(64) };
  const right = { ...left, contentSha256: "2".repeat(64) };
  assert.notEqual(calculateChangeSetHash([left]), calculateChangeSetHash([right]));
  const multi = [left, { relativePath: "src/b.txt", changeType: "created", diff: "e", contentSha256: "3".repeat(64) }];
  assert.equal(calculateChangeSetHash(multi), calculateChangeSetHash([...multi].reverse()));
});
