import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRootDefinitions = [
  { label: "config/opencode", relativePath: path.join(".config", "opencode", "skills") },
  { label: "codex", relativePath: path.join(".codex", "skills") },
  { label: "claude", relativePath: path.join(".claude", "skills") },
  { label: "agents", relativePath: path.join(".agents", "skills") }
];

function calculateFileSha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function buildGlobalSkillReport({ projectRoot, homeDirectory, allowedSkills }) {
  const canonicalRoot = path.join(projectRoot, ".agents", "skills");
  const skills = allowedSkills.map((skillName) => {
    const canonicalPath = path.join(canonicalRoot, skillName, "SKILL.md");
    const canonicalExists = fs.existsSync(canonicalPath);
    const canonicalSha256 = canonicalExists ? calculateFileSha256(canonicalPath) : null;
    const roots = {};
    for (const definition of skillRootDefinitions) {
      const candidatePath = path.join(homeDirectory, definition.relativePath, skillName, "SKILL.md");
      if (!canonicalExists || !fs.existsSync(candidatePath)) {
        roots[definition.label] = "MISSING";
        continue;
      }
      roots[definition.label] = calculateFileSha256(candidatePath) === canonicalSha256 ? "EQUAL" : "DIFF";
    }
    return { skill: skillName, canonicalExists, roots };
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
