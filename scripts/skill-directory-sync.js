import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function inventorySkillDirectory(directoryPath) {
  if (!fs.existsSync(directoryPath)) return null;
  const rootEntry = fs.lstatSync(directoryPath);
  if (!rootEntry.isDirectory()) {
    return { files: new Map(), unsupportedEntries: ["."] };
  }

  const files = new Map();
  const unsupportedEntries = [];
  const visit = (currentDirectory, relativeDirectory) => {
    const entries = fs.readdirSync(currentDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name;
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        unsupportedEntries.push(relativePath);
      } else if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.set(relativePath, crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex"));
      } else {
        unsupportedEntries.push(relativePath);
      }
    }
  };
  visit(directoryPath, "");
  return { files, unsupportedEntries };
}

export function compareSkillDirectories(sourceDirectory, targetDirectory) {
  const source = inventorySkillDirectory(sourceDirectory);
  const target = inventorySkillDirectory(targetDirectory);
  if (!source || !target) {
    return {
      equal: false,
      missingFiles: [],
      extraFiles: [],
      differentFiles: [],
      unsupportedEntries: [...(source?.unsupportedEntries || []), ...(target?.unsupportedEntries || [])],
      sourceMissing: source === null,
      targetMissing: target === null
    };
  }

  const missingFiles = [...source.files.keys()].filter((filePath) => !target.files.has(filePath)).sort();
  const extraFiles = [...target.files.keys()].filter((filePath) => !source.files.has(filePath)).sort();
  const differentFiles = [...source.files.keys()]
    .filter((filePath) => target.files.has(filePath) && source.files.get(filePath) !== target.files.get(filePath))
    .sort();
  const unsupportedEntries = [...source.unsupportedEntries.map((entry) => `source:${entry}`), ...target.unsupportedEntries.map((entry) => `target:${entry}`)].sort();
  return {
    equal: missingFiles.length === 0
      && extraFiles.length === 0
      && differentFiles.length === 0
      && unsupportedEntries.length === 0,
    missingFiles,
    extraFiles,
    differentFiles,
    unsupportedEntries,
    sourceMissing: false,
    targetMissing: false
  };
}
