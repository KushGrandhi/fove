import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileWatcher, diskRead, diskReaddir, diskRename, diskStat, diskWrite, type DiskChange,
} from "../src/main/diskFs.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fove-diskfs-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (s: string) => new TextEncoder().encode(s);

describe("disk operations", () => {
  it("writes atomically and keeps the file's mode", async () => {
    const p = join(dir, "run.sh");
    writeFileSync(p, "old");
    chmodSync(p, 0o755);
    await diskWrite(p, bytes("new"), { create: false, overwrite: true });
    expect(text(await diskRead(p))).toBe("new");
    expect(statSync(p).mode & 0o777).toBe(0o755);
  });

  it("refuses to create when create is false, and to clobber when overwrite is false", async () => {
    await expect(diskWrite(join(dir, "nope"), bytes("x"), { create: false, overwrite: true }))
      .rejects.toThrow(/^ENOENT/);
    const p = join(dir, "a");
    writeFileSync(p, "a");
    await expect(diskWrite(p, bytes("x"), { create: true, overwrite: false })).rejects.toThrow(/^EEXIST/);
  });

  it("reports the node error code in the message", async () => {
    await expect(diskStat(join(dir, "missing"))).rejects.toThrow(/^ENOENT/);
  });

  it("lists entries with their types", async () => {
    writeFileSync(join(dir, "f"), "");
    await diskWrite(join(dir, "g"), bytes(""), { create: true, overwrite: false });
    const names = (await diskReaddir(dir)).sort();
    expect(names).toEqual([["f", "file"], ["g", "file"]]);
  });

  it("renames, refusing to overwrite unless asked", async () => {
    writeFileSync(join(dir, "a"), "a");
    writeFileSync(join(dir, "b"), "b");
    await expect(diskRename(join(dir, "a"), join(dir, "b"), false)).rejects.toThrow(/^EEXIST/);
    await diskRename(join(dir, "a"), join(dir, "b"), true);
    expect(text(await diskRead(join(dir, "b")))).toBe("a");
  });
});

describe("FileWatcher", () => {
  it("reports an update, including after an atomic replace", async () => {
    const p = join(dir, "app.py");
    writeFileSync(p, "one");
    const seen: DiskChange[][] = [];
    const w = new FileWatcher((c) => seen.push(c));
    await w.add(p);
    // An agent's write: temp file, then rename over the original.
    writeFileSync(join(dir, ".tmp"), "two, longer");
    renameSync(join(dir, ".tmp"), p);
    await w.compare(dir);
    expect(seen.flat()).toEqual([{ type: "updated", path: p }]);
    w.closeAll();
  });

  it("reports deletes and ignores files nobody watches", async () => {
    const p = join(dir, "a.txt");
    writeFileSync(p, "a");
    writeFileSync(join(dir, "other.txt"), "o");
    const seen: DiskChange[] = [];
    const w = new FileWatcher((c) => seen.push(...c));
    await w.add(p);
    rmSync(p);
    writeFileSync(join(dir, "other.txt"), "changed");
    await w.compare(dir);
    expect(seen).toEqual([{ type: "deleted", path: p }]);
    w.closeAll();
  });

  it("keeps watching until the last reference goes", async () => {
    const p = join(dir, "a.txt");
    writeFileSync(p, "a");
    const seen: DiskChange[] = [];
    const w = new FileWatcher((c) => seen.push(...c));
    await w.add(p);
    await w.add(p);
    w.remove(p);
    writeFileSync(p, "bb");
    await w.compare(dir);
    expect(seen).toHaveLength(1);
    w.remove(p);
    writeFileSync(p, "ccc");
    await w.compare(dir);
    expect(seen).toHaveLength(1);
    w.closeAll();
  });

  it("fires on its own from the directory watch", async () => {
    const p = join(dir, "live.txt");
    writeFileSync(p, "a");
    const got = new Promise<DiskChange[]>((resolve) => {
      const w = new FileWatcher((c) => { w.closeAll(); resolve(c); });
      void w.add(p).then(() => setTimeout(() => writeFileSync(p, "changed"), 50));
    });
    expect(await got).toEqual([{ type: "updated", path: p }]);
  });
});
