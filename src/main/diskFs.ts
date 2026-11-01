/**
 * The disk, as VS Code's file service wants to see it.
 *
 * The editor's text-file services (`@codingame/monaco-vscode-api`) run in the
 * renderer and talk to a file-system provider. This is the main-process half
 * of that provider: plain node:fs calls, plus a watcher that reports which
 * *file* changed, so the text-file service can reload an open buffer the
 * moment an agent writes to it.
 *
 * Errors keep their node `code` (ENOENT, EEXIST, ...) so the renderer can map
 * them onto the provider error kinds VS Code expects.
 */

import { watch, type FSWatcher } from "node:fs";
import {
  chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface DiskStat {
  type: "file" | "dir" | "other";
  ctime: number;
  mtime: number;
  size: number;
  readonly: boolean;
}

export interface DiskChange {
  type: "added" | "updated" | "deleted";
  path: string;
}

/** A failure the renderer can classify: the node error code and message. */
export interface DiskError { code: string; message: string }

function fail(e: unknown): never {
  const err = e as NodeJS.ErrnoException;
  // Electron's IPC drops custom error properties, so the code travels in the
  // message, where the renderer reads it back.
  throw new Error(`${err.code ?? "EUNKNOWN"}: ${err.message ?? String(e)}`);
}

export async function diskStat(path: string): Promise<DiskStat> {
  try {
    const st = await stat(path);
    return {
      type: st.isFile() ? "file" : st.isDirectory() ? "dir" : "other",
      ctime: st.ctimeMs,
      mtime: st.mtimeMs,
      size: st.size,
      // Owner write bit. Good enough for the editor's "read-only" badge; the
      // write itself is still the authority.
      readonly: (st.mode & 0o200) === 0,
    };
  } catch (e) {
    fail(e);
  }
}

export async function diskRead(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (e) {
    fail(e);
  }
}

/**
 * Write a whole file atomically, keeping its permissions.
 *
 * Temp file and rename in the same directory, as `files.ts` has always done:
 * a crash mid-write leaves the old file, never half of the new one.
 */
export async function diskWrite(
  path: string,
  data: Uint8Array,
  opts: { create: boolean; overwrite: boolean },
): Promise<void> {
  let mode = 0o644;
  let exists = false;
  try {
    const st = await stat(path);
    exists = true;
    mode = st.mode & 0o777;
  } catch {
    // New file.
  }
  if (exists && !opts.overwrite) fail(Object.assign(new Error("file exists"), { code: "EEXIST" }));
  if (!exists && !opts.create) fail(Object.assign(new Error("no such file"), { code: "ENOENT" }));
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, data);
    await chmod(tmp, mode).catch(() => {});
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    fail(e);
  }
}

export async function diskReaddir(path: string): Promise<[string, DiskStat["type"]][]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((d) => [d.name, d.isFile() ? "file" : d.isDirectory() ? "dir" : "other"]);
  } catch (e) {
    fail(e);
  }
}

export async function diskMkdir(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (e) {
    fail(e);
  }
}

export async function diskDelete(path: string, recursive: boolean): Promise<void> {
  try {
    await rm(path, { recursive });
  } catch (e) {
    fail(e);
  }
}

export async function diskRename(from: string, to: string, overwrite: boolean): Promise<void> {
  if (!overwrite) {
    const taken = await stat(to).then(() => true, () => false);
    if (taken) fail(Object.assign(new Error("file exists"), { code: "EEXIST" }));
  }
  try {
    await rename(from, to);
  } catch (e) {
    fail(e);
  }
}

/** How long to let a burst of events settle (temp file, rename, chmod). */
const DEBOUNCE_MS = 60;

interface Seen { mtime: number; size: number; exists: boolean }

/**
 * Watches individual files and says which ones changed.
 *
 * Each file is watched through its *parent directory*. Watching the file
 * itself breaks on the first atomic save -- an agent's write replaces the
 * inode, and a watcher on the old one goes quiet forever. A directory watch
 * survives that, and comparing mtime and size tells which watched files in
 * it actually moved.
 *
 * Reference-counted: two panes showing one file share one watch.
 */
export class FileWatcher {
  private readonly files = new Map<string, { refs: number; seen: Seen }>();
  private readonly dirs = new Map<string, { watcher: FSWatcher; timer?: NodeJS.Timeout }>();

  constructor(private readonly onChange: (changes: DiskChange[]) => void) {}

  async add(path: string): Promise<void> {
    const known = this.files.get(path);
    if (known) { known.refs++; return; }
    this.files.set(path, { refs: 1, seen: await this.look(path) });
    const dir = dirname(path);
    if (this.dirs.has(dir)) return;
    try {
      const watcher = watch(dir, { persistent: false }, () => this.poke(dir));
      watcher.on("error", () => this.dropDir(dir));
      this.dirs.set(dir, { watcher });
    } catch {
      // Unwatchable (gone, or a platform limit): the file simply gets no live
      // updates, which is what the editor had before.
    }
  }

  remove(path: string): void {
    const known = this.files.get(path);
    if (!known) return;
    if (--known.refs > 0) return;
    this.files.delete(path);
    const dir = dirname(path);
    if (![...this.files.keys()].some((p) => dirname(p) === dir)) this.dropDir(dir);
  }

  closeAll(): void {
    for (const dir of [...this.dirs.keys()]) this.dropDir(dir);
    this.files.clear();
  }

  private dropDir(dir: string): void {
    const d = this.dirs.get(dir);
    if (!d) return;
    clearTimeout(d.timer);
    d.watcher.close();
    this.dirs.delete(dir);
  }

  private poke(dir: string): void {
    const d = this.dirs.get(dir);
    if (!d) return;
    clearTimeout(d.timer);
    d.timer = setTimeout(() => void this.compare(dir), DEBOUNCE_MS);
  }

  private async look(path: string): Promise<Seen> {
    try {
      const st = await stat(path);
      return { mtime: st.mtimeMs, size: st.size, exists: true };
    } catch {
      return { mtime: 0, size: 0, exists: false };
    }
  }

  /** Exposed for tests: compare every watched file in a directory now. */
  async compare(dir: string): Promise<void> {
    const changes: DiskChange[] = [];
    for (const [path, entry] of this.files) {
      if (dirname(path) !== dir) continue;
      const now = await this.look(path);
      const was = entry.seen;
      entry.seen = now;
      if (!was.exists && now.exists) changes.push({ type: "added", path });
      else if (was.exists && !now.exists) changes.push({ type: "deleted", path });
      else if (now.exists && (now.mtime !== was.mtime || now.size !== was.size)) {
        changes.push({ type: "updated", path });
      }
    }
    if (changes.length) this.onChange(changes);
  }
}
