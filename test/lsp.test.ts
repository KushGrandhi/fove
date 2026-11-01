import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameReader, LanguageServerHost, SERVERS, frame } from "../src/main/lsp.js";

describe("LSP framing", () => {
  test("a message split across chunks comes out whole", () => {
    const got: unknown[] = [];
    const r = new FrameReader((m) => got.push(m));
    const bytes = frame({ jsonrpc: "2.0", id: 1, result: { ok: "é" } });
    r.push(bytes.subarray(0, 10));
    r.push(bytes.subarray(10, 25));
    expect(got).toEqual([]);
    r.push(bytes.subarray(25));
    expect(got).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: "é" } }]);
  });

  test("two messages in one chunk are both delivered", () => {
    const got: unknown[] = [];
    const r = new FrameReader((m) => got.push(m));
    r.push(Buffer.concat([frame({ a: 1 }), frame({ b: 2 })]));
    expect(got).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("Content-Length counts bytes, not characters", () => {
    const bytes = frame({ s: "日本" });
    const header = bytes.toString("ascii").split("\r\n")[0]!;
    expect(Number(header.split(": ")[1])).toBe(Buffer.byteLength(JSON.stringify({ s: "日本" })));
  });
});

/**
 * Drives the stub server in fixtures/stub-lsp.cjs, which answers `initialize`
 * and then asks for `workspace/configuration` the way pyright does.
 */
describe("LanguageServerHost", () => {
  let dir: string;
  let host: LanguageServerHost;
  const messages: { id: string; msg: Record<string, unknown> }[] = [];
  const exits: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fove-lsp-"));
    process.env.STUB_LSP_LOG = join(dir, "log");
    writeFileSync(process.env.STUB_LSP_LOG, "");
    SERVERS.stub = [{ bin: process.execPath, args: [join(__dirname, "fixtures/stub-lsp.cjs")] }];
    messages.length = 0;
    exits.length = 0;
    host = new LanguageServerHost(
      (id, msg) => messages.push({ id, msg: msg as Record<string, unknown> }),
      (id) => exits.push(id),
    );
  });

  afterEach(() => {
    host.stopAll();
    delete SERVERS.stub;
    delete process.env.STUB_LSP_LOG;
    rmSync(dir, { recursive: true, force: true });
  });

  const waitFor = async (pred: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  test("passes messages both ways, tagged with the client's id", async () => {
    const r = await host.start("c1", "stub", dir);
    expect(r).toEqual({ ok: true, name: process.execPath });
    host.send("c1", { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
    await waitFor(() => messages.some((m) => m.msg.id === 1));
    expect(messages.find((m) => m.msg.id === 1)).toEqual({
      id: "c1", msg: { jsonrpc: "2.0", id: 1, result: { capabilities: {} } },
    });
    // The server's own request reaches the client to answer, not main.
    await waitFor(() => messages.some((m) => m.msg.method === "workspace/configuration"));
  });

  test("a kind with nothing installed says so instead of throwing", async () => {
    SERVERS.stub = [{ bin: "definitely-not-a-real-server-xyz", args: [] }];
    host.forget("stub");
    const r = await host.start("c2", "stub", dir);
    expect(r.ok).toBe(false);
  });

  test("a server that exits is reported once", async () => {
    await host.start("c3", "stub", dir);
    host.send("c3", { jsonrpc: "2.0", method: "exit" });
    await waitFor(() => exits.includes("c3"));
    expect(exits.filter((x) => x === "c3")).toEqual(["c3"]);
  });

  test("a server installed mid-session is found once the probe is forgotten", async () => {
    SERVERS.stub = [{ bin: "definitely-not-a-real-server-xyz", args: [] }];
    host.forget("stub");
    expect(await host.available("stub")).toBeNull();
    SERVERS.stub = [{ bin: process.execPath, args: [join(__dirname, "fixtures/stub-lsp.cjs")] }];
    expect(await host.available("stub")).toBeNull(); // still cached
    host.forget("stub");
    expect(await host.available("stub")).toBe(process.execPath);
  });

  test("the bundled TypeScript server is there", async () => {
    expect(await host.available("typescript")).toBe("vtsls");
  });
});
