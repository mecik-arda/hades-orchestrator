import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGlobalSkillReport, resolveGlobalSkillExitCode } from "../scripts/check-global-skills.js";

function writeSkill(skillsRoot, skillName, content) {
  const directory = path.join(skillsRoot, skillName);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), content, "utf8");
}

function createTemporaryRoots(context) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "global-skills-project-"));
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "global-skills-home-"));
  context.after(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDirectory, { recursive: true, force: true });
  });
  return { projectRoot, homeDirectory };
}

test("GLOBAL-SKILLS-01: eşit, farklı ve eksik kök durumları ayrı raporlanır", (context) => {
  const { projectRoot, homeDirectory } = createTemporaryRoots(context);
  writeSkill(path.join(projectRoot, ".agents", "skills"), "alpha", "kanonik içerik");
  writeSkill(path.join(homeDirectory, ".config", "opencode", "skills"), "alpha", "kanonik içerik");
  writeSkill(path.join(homeDirectory, ".codex", "skills"), "alpha", "farklı içerik");
  const report = buildGlobalSkillReport({ projectRoot, homeDirectory, allowedSkills: ["alpha"] });
  assert.equal(report.skills[0].canonicalExists, true);
  assert.equal(report.skills[0].roots["config/opencode"], "EQUAL");
  assert.equal(report.skills[0].roots.codex, "DIFF");
  assert.equal(report.skills[0].roots.claude, "MISSING");
  assert.equal(report.skills[0].roots.agents, "MISSING");
  assert.equal(report.equalCount, 1);
  assert.equal(report.diffCount, 1);
  assert.equal(report.missingCount, 2);
  assert.equal(resolveGlobalSkillExitCode(report), 1);
  assert.equal(resolveGlobalSkillExitCode(report, { strict: true }), 1);
});

test("GLOBAL-SKILLS-02: yalnız eksik kopya varsayılan geçer, strict hata verir", (context) => {
  const { projectRoot, homeDirectory } = createTemporaryRoots(context);
  writeSkill(path.join(projectRoot, ".agents", "skills"), "beta", "kanonik içerik");
  const report = buildGlobalSkillReport({ projectRoot, homeDirectory, allowedSkills: ["beta"] });
  assert.equal(report.diffCount, 0);
  assert.equal(report.missingCount, 4);
  assert.equal(resolveGlobalSkillExitCode(report), 0);
  assert.equal(resolveGlobalSkillExitCode(report, { strict: true }), 1);
});

test("GLOBAL-SKILLS-03: kanonik skill yoksa tüm kökler eksik raporlanır", (context) => {
  const { projectRoot, homeDirectory } = createTemporaryRoots(context);
  const report = buildGlobalSkillReport({ projectRoot, homeDirectory, allowedSkills: ["gamma"] });
  assert.equal(report.skills[0].canonicalExists, false);
  assert.deepEqual(Object.values(report.skills[0].roots), ["MISSING", "MISSING", "MISSING", "MISSING"]);
  assert.equal(report.missingCount, 4);
  assert.equal(resolveGlobalSkillExitCode(report), 0);
});
