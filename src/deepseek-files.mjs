import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const fileLimit = 16 * 1024;
const totalLimit = 48 * 1024;
const blockedName = /^(?:\.env(?:\.|$)|\.git$|\.codex$|\.ssh$|\.aws$|credentials?(?:\.|$)|auth\.json$|id_(?:rsa|ed25519)(?:\.|$))/i;
const deviceName = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const fold = name => process.platform === "win32" ? name.toLowerCase() : name;

function inspect(root, name) {
  if (typeof name !== "string" || name.length > 500) throw new Error("Invalid file path");
  const parts = name.split("/");
  if (parts.some(part => !part || /[<>:"\\|?*\x00-\x1f]|[ .]$/.test(part) ||
      blockedName.test(part) || deviceName.test(part))) {
    throw new Error("File path is outside the allowed format");
  }
  let absolute = root;
  let stat;
  for (const [index, part] of parts.entries()) {
    absolute = path.join(absolute, part);
    stat = lstatSync(absolute);
    const valid = index === parts.length - 1 ? stat.isFile() && stat.nlink === 1 : stat.isDirectory();
    if (!valid || stat.isSymbolicLink()) throw new Error("Only regular files in ordinary directories are allowed");
  }
  if (fold(realpathSync.native(absolute)) !== fold(absolute)) throw new Error("File has a redirected path");
  if (stat.size > fileLimit) throw new Error("File exceeds 16 KiB");
  const bytes = readFileSync(absolute);
  if (bytes.length > fileLimit || bytes.includes(0)) throw new Error("File must be UTF-8 text under 16 KiB");
  const text = decoder.decode(bytes);
  return { absolute, stat, bytes, text };
}

function diffText(name, before, after) {
  const left = before.split("\n");
  const right = after.split("\n");
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let oldEnd = left.length;
  let newEnd = right.length;
  while (oldEnd > start && newEnd > start && left[oldEnd - 1] === right[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const lines = [
    `--- a/${name}`, `+++ b/${name}`,
    `@@ -${start + 1},${oldEnd - start} +${start + 1},${newEnd - start} @@`,
    ...left.slice(start, oldEnd).map(line => "-" + line.replace(/\r$/, "\\r")),
    ...right.slice(start, newEnd).map(line => "+" + line.replace(/\r$/, "\\r")),
  ];
  const diff = lines.join("\n");
  return diff.length <= 12000 ? diff : diff.slice(0, 12000) + "\n[diff truncated]";
}

export async function reviewFiles(args, complete) {
  const { workspace, task, files, write_file: writeFile, apply = false } = args ?? {};
  if (typeof workspace !== "string" || !path.isAbsolute(workspace) || workspace.startsWith("\\\\")) {
    throw new Error("Provide an absolute local workspace");
  }
  if (typeof task !== "string" || !task.trim() || task.length > 8000) throw new Error("Provide a task of up to 8,000 characters");
  if (!Array.isArray(files) || files.length < 1 || files.length > 12 ||
      files.some(name => typeof name !== "string") || new Set(files.map(fold)).size !== files.length) {
    throw new Error("Provide 1–12 unique relative file paths");
  }
  if (typeof apply !== "boolean" || (writeFile !== undefined && !files.includes(writeFile)) ||
      (apply && writeFile === undefined)) throw new Error("Select a write_file from files before requesting apply");

  const root = realpathSync.native(workspace);
  const rootName = fold(root);
  const home = fold(realpathSync.native(homedir()));
  const protectedHome = path.join(home, ".codex");
  if (!lstatSync(root).isDirectory() || root === path.parse(root).root || rootName === home ||
      rootName === protectedHome || rootName.startsWith(protectedHome + path.sep)) {
    throw new Error("Choose a project directory");
  }
  const originals = new Map();
  let total = 0;
  for (const name of files) {
    const file = inspect(root, name);
    total += file.bytes.length;
    if (total > totalLimit) throw new Error("Selected files exceed 48 KiB");
    originals.set(name, file);
  }

  const reply = await complete({ task, files: [...originals].map(([name, file]) => ({ path: name, text: file.text })),
    write_file: writeFile });
  if (!reply || typeof reply !== "object" || Array.isArray(reply) ||
      Object.keys(reply).length !== 2 || typeof reply.report !== "string" || reply.report.length > 4000 ||
      (reply.replacement !== null && (typeof reply.replacement !== "string" || writeFile === undefined ||
      reply.replacement.includes("\0") || Buffer.byteLength(reply.replacement) > fileLimit))) {
    throw new Error("DeepSeek returned an invalid replacement");
  }
  const original = originals.get(writeFile);
  const changed = reply.replacement !== null && reply.replacement !== original.text;
  const diff = changed ? diffText(writeFile, original.text, reply.replacement) : "";
  if (changed && apply) {
    const target = inspect(root, writeFile);
    if (target.stat.dev !== original.stat.dev || target.stat.ino !== original.stat.ino ||
        target.stat.mtimeMs !== original.stat.mtimeMs || !target.bytes.equals(original.bytes)) {
      throw new Error("The write target changed during review");
    }
    const temp = path.join(path.dirname(target.absolute), `.deepseek-${randomUUID()}.tmp`);
    let created = false;
    try {
      writeFileSync(temp, reply.replacement, { flag: "wx", mode: target.stat.mode & 0o777 });
      created = true;
      renameSync(temp, target.absolute);
    } finally {
      if (created) {
        try { unlinkSync(temp); }
        catch (failure) { if (failure.code !== "ENOENT") throw failure; }
      }
    }
  }
  return { report: reply.report, changed, applied: Boolean(changed && apply), diff, files };
}
