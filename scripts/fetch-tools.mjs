#!/usr/bin/env node
/**
 * Fetch the binaries fove ships, for the packaged app.
 *
 *   - ruff: Python lint, quick fixes and formatting (`ruff server`)
 *   - ripgrep: Spotlight and the Search pane
 *
 * A new user should get these without installing anything, so the app
 * carries its own copies under Resources/bin -- the official release builds,
 * pinned to one version each and checked against their published SHA-256
 * before use. Both are MIT (ripgrep is MIT or Unlicense).
 *
 * Runs before electron-builder (see "pack" and "dist" in package.json).
 * Skips a download when the right binary is already in build/bin.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS = [
  {
    name: "ruff",
    version: "0.17.3",
    url: (v) => `https://github.com/astral-sh/ruff/releases/download/${v}/ruff-aarch64-apple-darwin.tar.gz`,
    // From the release's own ruff-aarch64-apple-darwin.tar.gz.sha256.
    sha256: "118f7121aa838785672bf612487f755a89108bb5f44e0f3df96c5967a72614f9",
    inArchive: () => "ruff-aarch64-apple-darwin/ruff",
    // `ruff 0.17.3`
    versionOf: (out) => out.trim().split(" ")[1],
  },
  {
    name: "rg",
    version: "15.2.0",
    url: (v) => `https://github.com/BurntSushi/ripgrep/releases/download/${v}/ripgrep-${v}-aarch64-apple-darwin.tar.gz`,
    // From the release's own ripgrep-15.2.0-aarch64-apple-darwin.tar.gz.sha256.
    sha256: "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
    inArchive: (v) => `ripgrep-${v}-aarch64-apple-darwin/rg`,
    // `ripgrep 15.2.0\n...`
    versionOf: (out) => out.split("\n")[0].trim().split(" ")[1],
  },
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "build", "bin");

function installedVersion(tool) {
  const out = join(outDir, tool.name);
  if (!existsSync(out)) return null;
  try {
    return tool.versionOf(execFileSync(out, ["--version"], { encoding: "utf8" })) ?? null;
  } catch {
    return null;
  }
}

async function fetchTool(tool) {
  if (installedVersion(tool) === tool.version) {
    console.log(`${tool.name} ${tool.version} already in build/bin`);
    return;
  }
  const url = tool.url(tool.version);
  console.log(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${tool.name}: download failed: HTTP ${res.status}`);
  const archive = Buffer.from(await res.arrayBuffer());
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== tool.sha256) {
    throw new Error(`${tool.name}: checksum mismatch: expected ${tool.sha256}, got ${digest}. Not using it.`);
  }

  const work = mkdtempSync(join(tmpdir(), `fove-${tool.name}-`));
  const out = join(outDir, tool.name);
  try {
    const tgz = join(work, "archive.tar.gz");
    writeFileSync(tgz, archive);
    execFileSync("tar", ["-xzf", tgz, "-C", work]);
    const extracted = join(work, tool.inArchive(tool.version));
    if (!existsSync(extracted)) throw new Error(`${tool.name}: archive did not contain the binary`);
    mkdirSync(outDir, { recursive: true });
    renameSync(extracted, out);
    chmodSync(out, 0o755);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const got = installedVersion(tool);
  if (got !== tool.version) throw new Error(`${tool.name}: fetched binary reports ${got ?? "nothing"}, expected ${tool.version}`);
  console.log(`${tool.name} ${tool.version} ready in build/bin (sha256 ok, ${readFileSync(out).length} bytes)`);
}

try {
  for (const tool of TOOLS) await fetchTool(tool);
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(1);
}
