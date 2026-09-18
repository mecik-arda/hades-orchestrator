import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildCodexCheck } from "../scripts/verify-project.js";

test("VERIFY-CODEX-GUARD: codex yapılandırması yokken çökmez ve unavailable raporlar", () => {
  const result = buildCodexCheck({});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Codex configuration unavailable");
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
