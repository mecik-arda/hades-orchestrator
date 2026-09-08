import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfiguration, loadRuntimeConfiguration, validateWorkspace } from "../subagent-bridge/src/config.js";

test("izinli kök içindeki workspace kabul edilir", () => {
  const root = path.resolve("C:\\Users\\ornek\\Desktop\\Projeler");
  const workspace = path.join(root, "ornek-proje");
  assert.throws(() => validateWorkspace(workspace, [root]), /Workspace bulunamadı/);
});

test("izinli kök dışındaki workspace reddedilir", () => {
  assert.throws(
    () => validateWorkspace("C:\\Windows", ["C:\\Users\\ornek\\Desktop\\Projeler"]),
    /izinli köklerin dışında/
  );
});

test("korunan kök DeepSeek workspace olarak reddedilir", () => {
  const allowedRoot = "C:\\Users\\ornek\\Desktop\\Projeler";
  const memoryRoot = path.join(allowedRoot, "orkestrasyon", "memory");
  assert.throws(
    () => validateWorkspace(memoryRoot, [allowedRoot], [memoryRoot]),
    /korunan kökün içinde/
  );
});

test("Vault kökü boş DeepSeek deny listesinde bile zorunlu olarak reddedilir", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-config-"));
  const vaultRoot = path.join(root, "vault");
  const configurationPath = path.join(root, "policy.json");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(vaultRoot);
  const policy = JSON.parse(fs.readFileSync(path.resolve("config/policy.json"), "utf8"));
  policy.allowedRoots = [root];
  policy.deepseek.deniedRoots = [];
  policy.workspacePolicy.antigravityDeniedRoots = [];
  policy.memory.vaultRoot = vaultRoot;
  fs.writeFileSync(configurationPath, JSON.stringify(policy), "utf8");
  const configuration = loadConfiguration({ configurationPath });
  assert.deepEqual(configuration.deepseek.deniedRootPaths, [vaultRoot]);
  assert.deepEqual(configuration.workspacePolicy.antigravityDeniedRootPaths, [vaultRoot]);
  assert.throws(
    () => validateWorkspace(vaultRoot, configuration.allowedRoots, configuration.deepseek.deniedRootPaths),
    /korunan kökün içinde/
  );
  assert.throws(
    () => validateWorkspace(path.join(vaultRoot, "01_Projects"), configuration.allowedRoots, configuration.deepseek.deniedRootPaths),
    /korunan kökün içinde/
  );
});

test("Antigravity deny listesi DeepSeek deny listesinden bağımsızdır", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-antigravity-config-"));
  const vaultRoot = path.join(root, "vault");
  const antigravityDeniedRoot = path.join(root, "antigravity-deny");
  const deepseekDeniedRoot = path.join(root, "deepseek-deny");
  const configurationPath = path.join(root, "policy.json");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(vaultRoot);
  fs.mkdirSync(antigravityDeniedRoot);
  fs.mkdirSync(deepseekDeniedRoot);
  const policy = JSON.parse(fs.readFileSync(path.resolve("config/policy.json"), "utf8"));
  policy.allowedRoots = [root];
  policy.memory.vaultRoot = vaultRoot;
  policy.workspacePolicy.antigravityDeniedRoots = [antigravityDeniedRoot];
  policy.deepseek.deniedRoots = [deepseekDeniedRoot];
  fs.writeFileSync(configurationPath, JSON.stringify(policy), "utf8");
  const configuration = loadConfiguration({ configurationPath });
  assert.throws(
    () => validateWorkspace(antigravityDeniedRoot, configuration.allowedRoots, configuration.workspacePolicy.antigravityDeniedRootPaths),
    /korunan kökün içinde/
  );
  assert.doesNotThrow(
    () => validateWorkspace(deepseekDeniedRoot, configuration.allowedRoots, configuration.workspacePolicy.antigravityDeniedRootPaths)
  );
});

test("provider rol profilleri exact model kullanır ve edit fallback policy ile sınırlıdır", () => {
  const policy = JSON.parse(fs.readFileSync(path.resolve("config/policy.json"), "utf8"));
  const profiles = policy.orchestration.taskProfiles;
  assert.deepEqual({ target: profiles.quick_read.target, model: profiles.quick_read.model }, { target: "codex", model: "gpt-5.6-luna" });
  assert.deepEqual({ target: profiles.review.target, model: profiles.review.model }, { target: "codex", model: "gpt-5.6-terra" });
  assert.deepEqual({ target: profiles.critical_review.target, model: profiles.critical_review.model }, { target: "codex", model: "gpt-5.6-sol" });
  assert.deepEqual({ target: profiles.luna_implementation.target, model: profiles.luna_implementation.model, mode: profiles.luna_implementation.mode }, { target: "codex", model: "gpt-5.6-luna", mode: "edit" });
  assert.deepEqual({ target: profiles.implementation.target, model: profiles.implementation.model, mode: profiles.implementation.mode }, { target: "codex", model: "gpt-5.6-terra", mode: "edit" });
  assert.deepEqual({ target: profiles.critical_implementation.target, model: profiles.critical_implementation.model, mode: profiles.critical_implementation.mode }, { target: "codex", model: "gpt-5.6-sol", mode: "edit" });
  assert.deepEqual({ target: profiles.astra_review.target, model: profiles.astra_review.model, mode: profiles.astra_review.mode, priority: profiles.astra_review.priority, cacheable: profiles.astra_review.cacheable }, { target: "codex", model: "gpt-6-astra", mode: "read_only", priority: 14, cacheable: true });
  assert.deepEqual({ target: profiles.astra_implementation.target, model: profiles.astra_implementation.model, mode: profiles.astra_implementation.mode, priority: profiles.astra_implementation.priority, cacheable: profiles.astra_implementation.cacheable }, { target: "codex", model: "gpt-6-astra", mode: "edit", priority: 4, cacheable: false });
  assert.deepEqual(profiles.astra_implementation.fallbackTargets, [
    { target: "codex", model: "gpt-5.6-sol" },
    { target: "glm", model: "glm_5_2" }
  ]);
  assert.deepEqual({ target: profiles.deep_analysis.target, model: profiles.deep_analysis.model }, { target: "opencode", model: "deepseek/deepseek-v4-pro" });
  assert.equal(profiles.web_research.target, "gemini_pro");
  assert.equal(profiles.implementation.mode, "edit");
  assert.equal(profiles.critical_implementation.mode, "edit");
  assert.equal(Object.values(profiles).filter((profile) => profile.mode === "read_only").some((profile) => profile.fallbackTargets), false);
  assert.ok(profiles.implementation.fallbackTargets.length > 0);
  assert.deepEqual(profiles.implementation.fallbackTargets, [
    { target: "glm", model: "glm_5_2" },
    { target: "opencode", model: "deepseek/deepseek-v4-pro" },
    { target: "gemini_pro" }
  ]);
  assert.equal(profiles.low_cost_glm_highspeed.model, "glm_5_2_highspeed");
  assert.deepEqual({ target: profiles.glm53_implementation.target, model: profiles.glm53_implementation.model, mode: profiles.glm53_implementation.mode, priority: profiles.glm53_implementation.priority, cacheable: profiles.glm53_implementation.cacheable }, { target: "glm", model: "glm_5_3", mode: "edit", priority: 7, cacheable: false });
  assert.deepEqual(profiles.glm53_implementation.fallbackTargets, [
    { target: "opencode", model: "deepseek/deepseek-v4-pro" },
    { target: "codex", model: "gpt-5.6-terra" },
    { target: "gemini_pro" }
  ]);
  assert.deepEqual({ target: profiles.glm53_flash_implementation.target, model: profiles.glm53_flash_implementation.model, mode: profiles.glm53_flash_implementation.mode, priority: profiles.glm53_flash_implementation.priority, cacheable: profiles.glm53_flash_implementation.cacheable }, { target: "glm", model: "glm_5_3_flash", mode: "edit", priority: 6, cacheable: false });
  assert.deepEqual(profiles.glm53_flash_implementation.fallbackTargets, [
    { target: "glm", model: "glm_5_2" },
    { target: "opencode", model: "deepseek/deepseek-v4-flash" }
  ]);
});

test("deepseek-readonly agent dış dizin erişimini açıkça reddeder", () => {
  const opencodeConfiguration = JSON.parse(fs.readFileSync(path.resolve("opencode.jsonc"), "utf8"));
  assert.equal(opencodeConfiguration.agent["deepseek-readonly"].permission.external_directory, "deny");
});

test("config v1→v2 migrate eksik alanları varsayılanlarla tamamlar", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "config-migrate-"));
  const policy = JSON.parse(fs.readFileSync(path.resolve("config/policy.json"), "utf8"));
  const v1Policy = { ...policy, configVersion: 1 };
  delete v1Policy.observability.maxMetricRetentionDays;
  delete v1Policy.orchestration.scheduler.leaseHeartbeatMs;
  const configurationPath = path.join(root, "policy.json");
  fs.writeFileSync(configurationPath, JSON.stringify(v1Policy), "utf8");
  const configuration = loadConfiguration({ configurationPath });
  assert.equal(configuration.configVersion, 2);
  assert.equal(configuration.observability.maxMetricRetentionDays, 30);
  assert.equal(configuration.orchestration.scheduler.leaseHeartbeatMs, 300000);
  fs.rmSync(root, { recursive: true, force: true });
});

test("config desteklenmeyen sürüm reddedilir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "config-badversion-"));
  const policy = JSON.parse(fs.readFileSync(path.resolve("config/policy.json"), "utf8"));
  policy.configVersion = 99;
  const configurationPath = path.join(root, "policy.json");
  fs.writeFileSync(configurationPath, JSON.stringify(policy), "utf8");
  assert.throws(() => loadConfiguration({ configurationPath }), /Unsupported configuration version/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("agents.json backend adı policy anahtarıyla çakışırsa reddedilir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "config-collision-"));
  const policy = JSON.parse(fs.readFileSync(path.resolve("config/policy.json"), "utf8"));
  policy.allowedRoots = [root];
  policy.memory.vaultRoot = path.join(root, "vault");
  fs.mkdirSync(policy.memory.vaultRoot);
  const configurationPath = path.join(root, "policy.json");
  fs.writeFileSync(configurationPath, JSON.stringify(policy), "utf8");
  const agents = {
    agents: {
      memory: {
        enabled: true,
        executable: "test.exe",
        defaultMode: "read_only",
        allowedModes: ["read_only"]
      }
    }
  };
  const agentsPath = path.join(root, "agents.json");
  fs.writeFileSync(agentsPath, JSON.stringify(agents), "utf8");
  assert.throws(
    () => loadRuntimeConfiguration({ configurationPath, agentsPath }),
    /collides/i
  );
  fs.rmSync(root, { recursive: true, force: true });
});
