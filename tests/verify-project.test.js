import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildCodexCheck, buildCodexVerificationReport } from "../scripts/verify-project.js";

test("VERIFY-CODEX-GUARD: codex yapılandırması yokken çökmez ve unavailable raporlar", () => {
  const result = buildCodexCheck({});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Codex configuration unavailable");
});

test("VERIFY-CODEX-EVIDENCE: CLI version başarısı model seçimi veya model erişimi kanıtı değildir", () => {
  const report = buildCodexVerificationReport({ status: 0, stdout: "codex-cli 0.162.1\n", stderr: "" });
  assert.equal(report.ok, true);
  assert.equal(report.version, "codex-cli 0.162.1");
  assert.equal(report.model, null);
  assert.equal(report.modelAccess, "not_probed");
  assert.equal(report.role, "subagent");
});

test("VERIFY-CODEX-EVIDENCE-FAILURE: unavailable CLI model veya erişim iddiası üretmez", () => {
  const report = buildCodexVerificationReport(buildCodexCheck({}));
  assert.equal(report.ok, false);
  assert.equal(report.model, null);
  assert.equal(report.modelAccess, "not_probed");
});

test("VERIFY-SCRIPTS: package.json node script hedefleri mevcuttur", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  const missingTargets = [];
  for (const [name, command] of Object.entries(packageJson.scripts || {})) {
    if (typeof command !== "string") continue;
    const match = command.match(/^node\s+(.+)$/);
    if (!match) continue;
    const target = match[1].split(/\s+/).find((token) => !token.startsWith("-"));
    if (!target || target.includes("*") || target.includes("{")) continue;
    if (!fs.existsSync(path.resolve(target))) missingTargets.push(`${name}:${target}`);
  }
  assert.deepEqual(missingTargets, []);
});
