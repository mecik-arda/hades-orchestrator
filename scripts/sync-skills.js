import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const codexSkillsRoot = path.join(projectRoot, ".agents", "skills");
const claudeSkillsRoot = path.join(projectRoot, ".claude", "skills");

fs.mkdirSync(claudeSkillsRoot, { recursive: true });

const skillDirectories = fs.readdirSync(codexSkillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory());

for (const skillDirectory of skillDirectories) {
  const sourceDirectory = path.join(codexSkillsRoot, skillDirectory.name);
  const targetDirectory = path.join(claudeSkillsRoot, skillDirectory.name);
  fs.cpSync(sourceDirectory, targetDirectory, { recursive: true, force: true });
}

console.log(JSON.stringify({
  synchronizedSkills: skillDirectories.map((entry) => entry.name)
}, null, 2));
