import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareSkillDirectories } from "./skill-directory-sync.js";

const skillRootDefinitions = [
  { label: "config/opencode", relativePath: path.join(".config", "opencode", "skills") },
  { label: "codex", relativePath: path.join(".codex", "skills") },
  { label: "claude", relativePath: path.join(".claude", "skills") },
  { label: "agents", relativePath: path.join(".agents", "skills") }
];

export function buildGlobalSkillReport({ projectRoot, homeDirectory, allowedSkills }) {
  const canonicalRoot = path.join(projectRoot, ".agents", "skills");
  const skills = allowedSkills.map((skillName) => {
    const canonicalDirectory = path.join(canonicalRoot, skillName);
    const canonicalPath = path.join(canonicalDirectory, "SKILL.md");
    const canonicalExists = fs.existsSync(canonicalPath) && fs.statSync(canonicalPath).isFile();
    const roots = {};
    const differences = {};
    for (const definition of skillRootDefinitions) {
      const candidateDirectory = path.join(homeDirectory, definition.relativePath, skillName);
      const candidatePath = path.join(candidateDirectory, "SKILL.md");
      if (!canonicalExists || !fs.existsSync(candidatePath)) {
        roots[definition.label] = "MISSING";
        continue;
      }
      const comparison = compareSkillDirectories(canonicalDirectory, candidateDirectory);
      roots[definition.label] = comparison.equal ? "EQUAL" : "DIFF";
      if (!comparison.equal) differences[definition.label] = comparison;
    }
    return { skill: skillName, canonicalExists, roots, differences };
  });
  const statuses = skills.flatMap((entry) => Object.values(entry.roots));
  return {
    skills,
    equalCount: statuses.filter((status) => status === "EQUAL").length,
    diffCount: statuses.filter((status) => status === "DIFF").length,
    missingCount: statuses.filter((status) => status === "MISSING").length
  };
}

export function resolveGlobalSkillExitCode(report, { strict = false } = {}) {
  if (report.diffCount > 0) return 1;
  if (strict && report.missingCount > 0) return 1;
  return 0;
}

function loadAllowedSkills(projectRoot) {
  const policyPath = path.join(projectRoot, "config", "policy.json");
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  return policy.skills.allowed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDirectory, "..");
  const strict = process.argv.includes("--strict");
  const report = buildGlobalSkillReport({
    projectRoot,
    homeDirectory: os.homedir(),
    allowedSkills: loadAllowedSkills(projectRoot)
  });
  console.log(JSON.stringify({ ...report, strict }, null, 2));
  process.exitCode = resolveGlobalSkillExitCode(report, { strict });
}
