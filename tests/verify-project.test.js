import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexCheck } from "../scripts/verify-project.js";

test("VERIFY-CODEX-GUARD: codex yapılandırması yokken çökmez ve unavailable raporlar", () => {
  const result = buildCodexCheck({});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Codex configuration unavailable");
});
