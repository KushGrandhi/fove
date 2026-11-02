import { describe, expect, it } from "vitest";
import { latestTurnOriginals } from "../src/shared/turn-originals.js";
import type { TurnRecord } from "../src/shared/turns.js";

const prompt = (uuid: string, text: string, t: string): TurnRecord =>
  ({ type: "user", uuid, timestamp: t, message: { role: "user", content: text } });
const edit = (filePath: string, originalFile: string | null, t = "2026-11-01T10:00:05Z") =>
  ({
    type: "user", timestamp: t,
    message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
    toolUseResult: { filePath, originalFile, oldString: "a", newString: "b" },
  }) as unknown as TurnRecord;

describe("latestTurnOriginals", () => {
  it("keeps the text from before the turn's first change to each file", () => {
    const r = latestTurnOriginals([
      prompt("p1", "fix it", "2026-11-01T10:00:00Z"),
      edit("/r/a.ts", "v0"),
      edit("/r/a.ts", "v1 (after the first edit)"),
      edit("/r/b.ts", "b0"),
    ]);
    expect(r?.turnId).toBe("p1");
    expect(r?.files).toEqual({ "/r/a.ts": "v0", "/r/b.ts": "b0" });
  });

  it("gives a created file an empty original", () => {
    const r = latestTurnOriginals([prompt("p1", "add a file", "2026-11-01T10:00:00Z"), edit("/r/new.ts", null)]);
    expect(r?.files).toEqual({ "/r/new.ts": "" });
  });

  it("uses the latest turn that changed files, skipping a quiet follow-up", () => {
    const r = latestTurnOriginals([
      prompt("p1", "first", "2026-11-01T10:00:00Z"),
      edit("/r/a.ts", "old"),
      prompt("p2", "second", "2026-11-01T10:05:00Z"),
      edit("/r/c.ts", "c0", "2026-11-01T10:05:05Z"),
      prompt("p3", "thanks", "2026-11-01T10:09:00Z"),
    ]);
    expect(r?.turnId).toBe("p2");
    expect(r?.files).toEqual({ "/r/c.ts": "c0" });
  });

  it("is null when no turn changed a file", () => {
    expect(latestTurnOriginals([prompt("p1", "hi", "2026-11-01T10:00:00Z")])).toBeNull();
    expect(latestTurnOriginals([])).toBeNull();
  });

  it("ignores edits before the first prompt", () => {
    expect(latestTurnOriginals([edit("/r/a.ts", "x")])).toBeNull();
  });
});
