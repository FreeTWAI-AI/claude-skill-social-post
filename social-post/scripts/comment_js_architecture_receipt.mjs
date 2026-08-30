/** Constrained and atomic receipt persistence for the JS architecture gate. */

import { createHash, randomUUID } from "node:crypto";
import {
  lstat, mkdir, open, readFile, rename, rm,
} from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function validateOutputSyntax(raw) {
  const normalized = raw.replaceAll("\\", "/");
  if (!/^\.rd\/receipts\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(normalized)) {
    throw new Error("--output must be an immediate .rd/receipts/*.json path");
  }
  return normalized;
}

async function requireSafeExistingPath(path, kind, label) {
  const stat = await lstatIfPresent(path);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink or junction`);
  if (kind === "directory" && !stat.isDirectory()) {
    throw new Error(`${label} must be a regular directory`);
  }
  if (kind === "file" && !stat.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
}

export async function safeOutputPath(raw, skillRoot) {
  if (raw === null) return { relative: null, absolute: null };
  const normalized = validateOutputSyntax(raw);
  const canonicalRoot = resolve(skillRoot);
  const rdDirectory = resolve(canonicalRoot, ".rd");
  const receiptsDirectory = resolve(rdDirectory, "receipts");
  const absolute = resolve(receiptsDirectory, posix.basename(normalized));
  await requireSafeExistingPath(canonicalRoot, "directory", "skill root");
  await requireSafeExistingPath(rdDirectory, "directory", ".rd");
  await requireSafeExistingPath(receiptsDirectory, "directory", ".rd/receipts");
  await requireSafeExistingPath(absolute, "file", "output receipt");
  return { relative: normalized, absolute };
}

export async function safeSidecarPath(output, skillRoot) {
  if (!output.absolute) return { relative: null, absolute: null };
  const refreshedOutput = await safeOutputPath(output.relative, skillRoot);
  const relative = `${refreshedOutput.relative}.sha256`;
  const absolute = `${refreshedOutput.absolute}.sha256`;
  await requireSafeExistingPath(absolute, "file", "output receipt SHA-256 sidecar");
  return { relative, absolute };
}

function temporaryPathFor(target) {
  return join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

async function cleanupTemporaryFile(temporary, target) {
  const expectedDirectory = resolve(dirname(target));
  const actualDirectory = resolve(dirname(temporary));
  const prefix = `.${basename(target)}.`;
  if (actualDirectory !== expectedDirectory || !basename(temporary).startsWith(prefix)) {
    throw new Error("refusing to clean an unbound atomic-write temporary path");
  }
  await rm(temporary, { force: true });
}

export async function atomicWriteTextFile(target, contents, options = {}) {
  const temporary = temporaryPathFor(target);
  let handle = null;
  await requireSafeExistingPath(dirname(target), "directory", "atomic-write parent");
  await requireSafeExistingPath(target, "file", "atomic-write target");
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = null;
    await requireSafeExistingPath(temporary, "file", "atomic-write temporary");
    if (options.beforeRename) await options.beforeRename({ temporary, target });
    await rename(temporary, target);
    const persisted = await readFile(target, "utf8");
    if (persisted !== contents) throw new Error("atomic-write read-back mismatch");
  } finally {
    if (handle) await handle.close();
    await cleanupTemporaryFile(temporary, target);
  }
}

export function receiptSidecarContents(serialized, outputRelative) {
  const hash = createHash("sha256").update(serialized, "utf8").digest("hex");
  return `${hash}  ${posix.basename(outputRelative)}\n`;
}

export async function writeReceiptBundle(rawOutput, skillRoot, serialized, hooks = {}) {
  let output = await safeOutputPath(rawOutput, skillRoot);
  if (!output.absolute) return { output, sidecar: null };
  await mkdir(resolve(skillRoot, ".rd", "receipts"), { recursive: true });
  output = await safeOutputPath(rawOutput, skillRoot);
  await atomicWriteTextFile(output.absolute, serialized, {
    beforeRename: hooks.beforeReceiptRename,
  });
  const sidecar = await safeSidecarPath(output, skillRoot);
  const sidecarContents = receiptSidecarContents(serialized, output.relative);
  await atomicWriteTextFile(sidecar.absolute, sidecarContents, {
    beforeRename: hooks.beforeSidecarRename,
  });
  return { output, sidecar };
}
