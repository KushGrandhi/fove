/**
 * Language servers, hosted for the editor.
 *
 * The editor runs VS Code's own language client (`monaco-languageclient`) in
 * the renderer. A renderer cannot start processes, so this is the other half:
 * it starts a server, frames and unframes its LSP messages, and passes them
 * through untouched. Everything a client does -- capabilities, document sync,
 * completion, diagnostics, rename -- happens in the real client, not here.
 *
 * Which servers:
 *   - typescript: `vtsls`, bundled with fove and run on Electron's own Node,
 *     so it works on a machine with no Node installed. It is tsserver, the
 *     same engine VS Code uses, and prefers the project's own TypeScript.
 *   - python: whichever of SERVERS.python is installed (pyright first).
 *   - ruff: `ruff server`, for Python lint, quick fixes and formatting.
 *
 * **A missing server is the normal case, not an error.** `start` answers why
 * it could not, and the editor carries on with highlighting alone.
 */

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ensureToolPath } from "./loginPath.js";
import { interpreterFor } from "./interpreters.js";

/**
 * Installed servers to try, best first, per server kind.
 *
 * Exported so the dependency spec can be held to it: the doctor offers to
 * install the first server for a kind, and a rename here that left
 * `shared/deps.ts` behind would have it install something this file never
 * looks for. test/deps.test.ts fails on that.
 */
export const SERVERS: Record<string, { bin: string; args: string[] }[]> = {
  python: [
    { bin: "pyright-langserver", args: ["--stdio"] },
    { bin: "basedpyright-langserver", args: ["--stdio"] },
    { bin: "jedi-language-server", args: [] },
    { bin: "pylsp", args: [] },
  ],
  ruff: [{ bin: "ruff", args: ["server"] }],
};

interface Spec {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** What the editor shows as "the server", e.g. "basedpyright-langserver". */
  name: string;
}

/**
 * The bundled vtsls, run on Electron's Node.
 *
 * In a packaged app it ships as a plain folder of node_modules under
 * `Resources/vtsls` (electron-builder `extraResources`), outside the asar
 * archive: a child process cannot run from inside one, and the builder's own
 * dependency pruning dropped vtsls's TypeScript as if it were fove's dev-only
 * copy. In development it is resolved from node_modules.
 */
function vtslsScript(): string | null {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources) {
    const packaged = join(resources, "vtsls", "node_modules", "@vtsls", "language-server", "bin", "vtsls.js");
    if (existsSync(packaged)) return packaged;
  }
  try {
    const script = createRequire(__filename).resolve("@vtsls/language-server/bin/vtsls.js");
    return existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

function vtslsSpec(): Spec | null {
  const script = vtslsScript();
  if (!script) return null;
  return {
    command: process.execPath,
    args: [script, "--stdio"],
    // Electron's binary behaves as plain Node with this set -- and so does
    // the tsserver vtsls forks from it, which inherits the environment.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    name: "vtsls",
  };
}

/**
 * The first of these paths that exists: the packaged app's Resources copy,
 * then the development one.
 */
function firstExisting(packaged: string[], dev: () => string | null): string | null {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources) {
    const p = join(resources, ...packaged);
    if (existsSync(p)) return p;
  }
  try {
    const d = dev();
    return d && existsSync(d) ? d : null;
  } catch {
    return null;
  }
}

/**
 * The servers fove ships, used when the machine has none of its own.
 *
 * A new user gets Python navigation, type errors and ruff's lint and format
 * with nothing installed. A server the user installed still wins: it is the
 * version their project and CI are pinned to.
 *
 *   - python: basedpyright (MIT), pure JavaScript, on Electron's Node
 *   - ruff: the official ruff binary, fetched and checksummed at build time
 *     by scripts/fetch-ruff.mjs
 */
function bundledSpec(kind: string): Spec | null {
  if (kind === "python") {
    const script = firstExisting(
      ["basedpyright", "langserver.index.js"],
      () => createRequire(__filename).resolve("basedpyright/langserver.index.js"),
    );
    return script
      ? {
          command: process.execPath,
          args: [script, "--stdio"],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          name: "basedpyright (bundled)",
        }
      : null;
  }
  if (kind === "ruff") {
    // The repository's build/bin, in development: three levels up from the
    // compiled dist/main/main/lsp.js, two from the source under test.
    const bin = firstExisting(["bin", "ruff"], () =>
      [join(__dirname, "..", "..", "..", "build", "bin", "ruff"), join(__dirname, "..", "..", "build", "bin", "ruff")]
        .find((p) => existsSync(p)) ?? null);
    return bin ? { command: bin, args: ["server"], name: "ruff (bundled)" } : null;
  }
  return null;
}

/**
 * The ruff to run as a command (format on save, the lint fallback): the
 * user's own if their shell has one, else the one fove ships. Null only in a
 * development checkout that never ran scripts/fetch-ruff.mjs.
 */
export async function ruffCommand(): Promise<string | null> {
  await ensureToolPath();
  const onPath = await new Promise<boolean>((resolve) => {
    execFile("ruff", ["--version"], { timeout: 5000 }, (err) => resolve(!err));
  });
  if (onPath) return "ruff";
  return bundledSpec("ruff")?.command ?? null;
}

/** Splits a server's stdout into LSP messages. Exported for tests. */
export class FrameReader {
  private buffer = Buffer.alloc(0);

  constructor(private readonly onMessage: (msg: unknown) => void) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const split = this.buffer.indexOf("\r\n\r\n");
      if (split < 0) return;
      const header = this.buffer.subarray(0, split).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Out of sync with no honest way back: drop what we have rather than
        // loop forever on a header we cannot read.
        this.buffer = Buffer.alloc(0);
        return;
      }
      const length = Number(match[1]);
      const start = split + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      try {
        this.onMessage(JSON.parse(body));
      } catch {
        // A malformed message is the server's bug; keep reading.
      }
    }
  }
}

export function frame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

export type StartResult = { ok: true; name: string } | { ok: false; reason: string };

/** How much of a server's stderr to keep for "why did it stop". */
const STDERR_TAIL = 4000;

export class LanguageServerHost {
  private readonly running = new Map<string, ChildProcessWithoutNullStreams>();
  /** Which installed binary serves a kind here, or null when none does. */
  private readonly resolved = new Map<string, { bin: string; args: string[] } | null>();
  private readonly probing = new Map<string, Promise<{ bin: string; args: string[] } | null>>();

  constructor(
    private readonly onMessage: (id: string, msg: unknown) => void,
    private readonly onExit: (id: string, info: { code: number | null; stderr: string }) => void,
  ) {}

  /**
   * Start a server for one client. `id` is chosen by the renderer and names
   * the connection in every message after this.
   */
  async start(id: string, kind: string, root: string): Promise<StartResult> {
    if (this.running.has(id)) return { ok: false, reason: "already started" };
    const spec = await this.specFor(kind);
    if (!spec) {
      return {
        ok: false,
        reason: kind === "typescript" ? "the bundled TypeScript server is missing" : `no ${kind} language server is installed`,
      };
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: root,
        env: spec.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      return { ok: false, reason: String((e as Error).message ?? e) };
    }

    let stderr = "";
    const reader = new FrameReader((msg) => this.onMessage(id, msg));
    child.stdout.on("data", (chunk: Buffer) => reader.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });
    child.on("exit", (code) => {
      this.running.delete(id);
      this.onExit(id, { code, stderr });
    });
    // A failed spawn (ENOENT) arrives here, not as a throw.
    const failed = await new Promise<string | null>((resolve) => {
      child.once("error", (e) => resolve(String(e.message ?? e)));
      child.once("spawn", () => resolve(null));
    });
    if (failed) return { ok: false, reason: failed };
    this.running.set(id, child);
    return { ok: true, name: spec.name };
  }

  send(id: string, msg: unknown): void {
    const child = this.running.get(id);
    if (!child || child.stdin.destroyed) return;
    child.stdin.write(frame(msg));
  }

  /** Stop one server. The client has normally sent shutdown/exit already. */
  stop(id: string): void {
    const child = this.running.get(id);
    if (!child) return;
    this.running.delete(id);
    // A server that ignores exit must not outlive its client and keep a
    // project's files open.
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 2000).unref();
  }

  stopAll(): void {
    for (const child of this.running.values()) child.kill();
    this.running.clear();
  }

  /** Forget what was probed, so a server installed mid-session is found. */
  forget(kind?: string): void {
    if (kind === undefined) this.resolved.clear();
    else this.resolved.delete(kind);
  }

  /** The Python a project's dependencies live in, for pyright's configuration. */
  pythonPath(root: string): Promise<string | null> {
    return interpreterFor(root);
  }

  /** The installed binary that would serve a kind, or null. Exported for the doctor's sake. */
  async available(kind: string): Promise<string | null> {
    if (kind === "typescript") return vtslsSpec() ? "vtsls" : null;
    return (await this.probe(kind))?.bin ?? bundledSpec(kind)?.name ?? null;
  }

  private async specFor(kind: string): Promise<Spec | null> {
    if (kind === "typescript") return vtslsSpec();
    const found = await this.probe(kind);
    if (found) return { command: found.bin, args: found.args, name: found.bin };
    return bundledSpec(kind);
  }

  /**
   * Find an installed server, once. Concurrent callers share one probe, so
   * two editor panes opening Python at the same moment do not race.
   */
  private probe(kind: string): Promise<{ bin: string; args: string[] } | null> {
    const known = this.resolved.get(kind);
    if (known !== undefined) return Promise.resolve(known);
    const inFlight = this.probing.get(kind);
    if (inFlight) return inFlight;
    const p = (async () => {
      // Installed per machine: probing before the login PATH is in place
      // would conclude, permanently, that there is none.
      await ensureToolPath();
      for (const candidate of SERVERS[kind] ?? []) {
        const ok = await new Promise<boolean>((resolve) => {
          execFile(candidate.bin, ["--version"], { timeout: 5000 }, (err) => {
            if (!err) return resolve(true);
            // A server that ran and objected to --version is still installed:
            // pyright-langserver exits 1 on it. Only a failed spawn (code is a
            // string, "ENOENT") or a timeout (code null) means there is none.
            resolve(typeof err.code === "number");
          });
        });
        if (ok) {
          this.resolved.set(kind, candidate);
          return candidate;
        }
      }
      this.resolved.set(kind, null);
      return null;
    })();
    this.probing.set(kind, p);
    void p.finally(() => this.probing.delete(kind));
    return p;
  }
}
