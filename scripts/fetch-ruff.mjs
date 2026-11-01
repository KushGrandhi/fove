#!/usr/bin/env node
/**
 * Fetch the ruff binary fove ships, for the packaged app.
 *
 * Python lint, quick fixes and formatting come from `ruff server`. A new user
 * should get them without installing anything, so the app carries its own
 * ruff (MIT) under Resources/bin -- the official release build, pinned to one
 * version and checked against its published SHA-256 before it is used.
 *
 * Runs before electron-builder (see "pack" and "dist" in package.json).
 * Skips the download when the right binary is already in build/bin.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.17.3";
const TARGET = "aarch64-apple-darwin";
// From the release's own ruff-aarch64-apple-darwin.tar.gz.sha256.
const SHA256 = "118f7121aa838785672bf612487f755a89108bb5f44e0f3df96c5967a72614f9";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "build", "bin");
const out = join(outDir, "ruff");

function installedVersion() {
  if (!existsSync(out)) return null;
  try {
    return execFileSync(out, ["--version"], { encoding: "utf8" }).trim().split(" ")[1] ?? null;
  } catch {
    return null;
  }
}

if (installedVersion() === VERSION) {
  console.log(`ruff ${VERSION} already in build/bin`);
  process.exit(0);
}

const url = `https://github.com/astral-sh/ruff/releases/download/${VERSION}/ruff-${TARGET}.tar.gz`;
console.log(`fetching ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`download failed: HTTP ${res.status}`);
  process.exit(1);
}
const archive = Buffer.from(await res.arrayBuffer());
const digest = createHash("sha256").update(archive).digest("hex");
if (digest !== SHA256) {
  console.error(`checksum mismatch: expected ${SHA256}, got ${digest}. Not using it.`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "fove-ruff-"));
try {
  const tgz = join(work, "ruff.tar.gz");
  writeFileSync(tgz, archive);
  execFileSync("tar", ["-xzf", tgz, "-C", work]);
  // The archive holds ruff-<target>/ruff.
  const extracted = join(work, `ruff-${TARGET}`, "ruff");
  if (!existsSync(extracted)) throw new Error("archive did not contain the ruff binary");
  mkdirSync(outDir, { recursive: true });
  renameSync(extracted, out);
  chmodSync(out, 0o755);
} finally {
  rmSync(work, { recursive: true, force: true });
}

const got = installedVersion();
if (got !== VERSION) {
  console.error(`fetched ruff reports ${got ?? "nothing"}, expected ${VERSION}`);
  process.exit(1);
}
console.log(`ruff ${VERSION} ready in build/bin (sha256 ok, ${readFileSync(out).length} bytes)`);
