import fs from "node:fs";
import path from "node:path";

const maximumFileBytes = 1048576;
const maximumTotalBytes = 5242880;
const maximumFiles = 200;
const excludedPilotFiles = new Set(["opencode.json", "opencode.jsonc"]);
const sensitiveFileNames = /^(?:\.env(?:\..*)?|id_[^.]+|.*\.(?:pem|key|p12|pfx))$/i;
const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|token|password|secret|client_secret|private_key)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}(?![A-Za-z0-9._-]*\s*\()/i,
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_=-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/
];
const sourceCodeSecretReferencePattern = /\b(?:api[_-]?key|token|password|secret|client_secret|private_key)\s*[:=]\s*(?:self|this)\.[A-Za-z_][A-Za-z0-9_]*/gi;

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) throw new Error("pilot file path must be relative");
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw new Error("pilot file path traversal rejected");
  if (excludedPilotFiles.has(normalized.toLocaleLowerCase("en-US")) || sensitiveFileNames.test(path.basename(normalized))) throw new Error("pilot sensitive file rejected");
  return normalized;
}

function requireSafeSourceFile(sourceRoot, relativePath) {
  let current = sourceRoot;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const status = fs.lstatSync(current);
    if (status.isSymbolicLink()) throw new Error("pilot source link rejected");
  }
  const status = fs.lstatSync(current);
  if (!status.isFile() || status.nlink !== 1 || status.size > maximumFileBytes) throw new Error("pilot source file rejected");
  const realPath = fs.realpathSync(current);
  if (!isInside(realPath, sourceRoot)) throw new Error("pilot source file escapes workspace");
  const content = fs.readFileSync(realPath);
  if (content.includes(0)) throw new Error("pilot binary file rejected");
  return content;
}

function readOptionalSourceFile(sourceRoot, relativePath, allowMissing) {
  const absolutePath = path.join(sourceRoot, ...relativePath.split("/"));
  if (fs.existsSync(absolutePath)) return requireSafeSourceFile(sourceRoot, relativePath);
  if (!allowMissing) throw new Error("pilot source file not found");
  const parentPath = path.dirname(absolutePath);
  if (!fs.existsSync(parentPath)) throw new Error("pilot target parent not found");
  const parentStatus = fs.lstatSync(parentPath);
  if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) throw new Error("pilot target parent rejected");
  if (!isInside(fs.realpathSync(parentPath), sourceRoot)) throw new Error("pilot target parent escapes workspace");
  return null;
}

function readWorkspaceFiles(workspace) {
  const files = new Map();
  let totalBytes = 0;
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(workspace, absolutePath).replaceAll("\\", "/");
      if (excludedPilotFiles.has(relativePath.toLocaleLowerCase("en-US"))) continue;
      const status = fs.lstatSync(absolutePath);
      if (status.isSymbolicLink()) throw new Error("pilot output link rejected");
      if (status.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!status.isFile() || status.nlink !== 1 || status.size > maximumFileBytes) throw new Error("pilot output file rejected");
      const content = fs.readFileSync(absolutePath);
      if (content.includes(0)) throw new Error("pilot binary output rejected");
      totalBytes += content.length;
      if (totalBytes > maximumTotalBytes || files.size >= maximumFiles) throw new Error("pilot output limit exceeded");
      files.set(relativePath, content.toString("utf8"));
    }
  }
  visit(workspace);
  return files;
}

function createUnifiedDiff(relativePath, before, after) {
  const beforeLines = before === null ? [] : before.replace(/\r\n/g, "\n").split("\n");
  const afterLines = after === null ? [] : after.replace(/\r\n/g, "\n").split("\n");
  return [
    `--- ${before === null ? "/dev/null" : `a/${relativePath}`}`,
    `+++ ${after === null ? "/dev/null" : `b/${relativePath}`}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`)
  ].join("\n");
}

export function containsSecretLikeValue(value) {
  const scannedValue = value.replace(sourceCodeSecretReferencePattern, "");
  return secretPatterns.some((pattern) => pattern.test(scannedValue));
}

export function provisionDisposableWorkspace(configuration, sourceWorkspace, requestedFiles, editableFiles = requestedFiles, editAgentName = "deepseek-edit") {
  const sourceRoot = fs.realpathSync(sourceWorkspace);
  const relativePaths = [...new Set(requestedFiles.map(normalizeRelativePath))];
  const editablePaths = new Set(editableFiles.map(normalizeRelativePath));
  if ([...editablePaths].some((relativePath) => !relativePaths.includes(relativePath))) throw new Error("pilot editable file must be selected");
  if (relativePaths.length === 0 || relativePaths.length > maximumFiles) throw new Error("pilot requires selected files");
  const disposableRoot = path.join(configuration.statePaths.cache, "deepseek-edit-pilot");
  fs.mkdirSync(disposableRoot, { recursive: true });
  const rootStatus = fs.lstatSync(disposableRoot);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) throw new Error("unsafe disposable workspace root");
  const container = fs.mkdtempSync(path.join(disposableRoot, "run-"));
  const workspace = path.join(container, "workspace");
  fs.mkdirSync(workspace);
  try {
    let totalBytes = 0;
    for (const relativePath of relativePaths) {
      const content = readOptionalSourceFile(sourceRoot, relativePath, editablePaths.has(relativePath));
      const targetPath = path.join(workspace, ...relativePath.split("/"));
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      if (content === null) continue;
      if (containsSecretLikeValue(content.toString("utf8"))) throw new Error("pilot source secret rejected");
      totalBytes += content.length;
      if (totalBytes > maximumTotalBytes) throw new Error("pilot input limit exceeded");
      fs.writeFileSync(targetPath, content, { flag: "wx" });
    }
    fs.writeFileSync(path.join(workspace, "opencode.json"), `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      agent: {
        [editAgentName]: {
          description: "Edits only files inside the disposable workspace without shell or delegation.",
          mode: "primary",
          permission: {
            read: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            edit: "allow",
            bash: "deny",
            task: "deny",
            question: "deny",
            external_directory: "deny"
          },
          prompt: "Edit only files inside the current disposable workspace. Never run shell commands, delegate, access external directories, or read secrets."
        }
      }
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    const baseline = readWorkspaceFiles(workspace);
    return {
      workspace,
      collectChanges() {
        if (fs.readdirSync(container).some((entry) => entry !== "workspace")) throw new Error("pilot workspace escape detected");
        const current = readWorkspaceFiles(workspace);
        const paths = [...new Set([...baseline.keys(), ...current.keys()])].sort();
        const changes = paths.flatMap((relativePath) => {
          const before = baseline.has(relativePath) ? baseline.get(relativePath) : null;
          const after = current.has(relativePath) ? current.get(relativePath) : null;
          if (before === after) return [];
          return [{ relativePath, changeType: before === null ? "created" : after === null ? "deleted" : "modified", diff: createUnifiedDiff(relativePath, before, after) }];
        });
        if (changes.some((change) => !editablePaths.has(change.relativePath))) throw new Error("pilot changed a non-editable file");
        const diff = changes.map((change) => change.diff).join("\n");
        if (Buffer.byteLength(diff, "utf8") > maximumTotalBytes) throw new Error("pilot diff limit exceeded");
        return { filesChanged: changes.map((change) => change.relativePath), changes, diff };
      },
      promoteChanges() {
        const collected = this.collectChanges();
        const prepared = [];
        for (const change of collected.changes) {
          if (change.changeType === "deleted") throw new Error("pilot file deletion is not allowed");
          const sourcePath = path.join(sourceRoot, ...change.relativePath.split("/"));
          const baselineContent = baseline.has(change.relativePath) ? baseline.get(change.relativePath) : null;
          const currentContent = fs.existsSync(sourcePath) ? requireSafeSourceFile(sourceRoot, change.relativePath).toString("utf8") : null;
          if (currentContent !== baselineContent) throw new Error("pilot source changed before promotion");
          const parentPath = path.dirname(sourcePath);
          if (!fs.existsSync(parentPath) || !fs.lstatSync(parentPath).isDirectory() || fs.lstatSync(parentPath).isSymbolicLink() || !isInside(fs.realpathSync(parentPath), sourceRoot)) throw new Error("pilot promotion target rejected");
          const disposablePath = path.join(workspace, ...change.relativePath.split("/"));
          const content = fs.readFileSync(disposablePath);
          if (containsSecretLikeValue(content.toString("utf8"))) throw new Error("pilot promotion secret rejected");
          const temporaryPath = path.join(parentPath, `.${path.basename(sourcePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
          const backupPath = `${temporaryPath}.backup`;
          fs.writeFileSync(temporaryPath, content, { flag: "wx" });
          if (fs.existsSync(sourcePath)) fs.chmodSync(temporaryPath, fs.statSync(sourcePath).mode);
          prepared.push({ sourcePath, temporaryPath, backupPath, existed: fs.existsSync(sourcePath) });
        }
        const applied = [];
        try {
          for (const item of prepared) {
            if (item.existed) fs.renameSync(item.sourcePath, item.backupPath);
            try {
              fs.renameSync(item.temporaryPath, item.sourcePath);
              applied.push(item);
            } catch (error) {
              if (item.existed && fs.existsSync(item.backupPath)) fs.renameSync(item.backupPath, item.sourcePath);
              throw error;
            }
          }
          for (const item of applied) {
            if (fs.existsSync(item.backupPath)) fs.rmSync(item.backupPath, { force: true });
          }
        } catch (error) {
          for (const item of applied.reverse()) {
            if (fs.existsSync(item.sourcePath)) fs.rmSync(item.sourcePath, { force: true });
            if (item.existed && fs.existsSync(item.backupPath)) fs.renameSync(item.backupPath, item.sourcePath);
          }
          throw error;
        } finally {
          for (const item of prepared) {
            if (fs.existsSync(item.temporaryPath)) fs.rmSync(item.temporaryPath, { force: true });
            if (fs.existsSync(item.backupPath)) fs.rmSync(item.backupPath, { force: true });
          }
        }
        return { ...collected, applied: true };
      },
      cleanup() {
        fs.rmSync(container, { recursive: true, force: true });
        return !fs.existsSync(container);
      }
    };
  } catch (error) {
    fs.rmSync(container, { recursive: true, force: true });
    throw error;
  }
}
