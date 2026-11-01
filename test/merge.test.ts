import { describe, expect, it } from "vitest";
import { MARK_MINE, MARK_SPLIT, MARK_THEIRS, hasConflictMarkers, threeWay } from "../src/renderer/ide/merge.js";

describe("threeWay", () => {
  const base = "a\nb\nc\nd\n";

  it("combines edits to different lines", () => {
    const mine = "A\nb\nc\nd\n";        // I changed line 1
    const theirs = "a\nb\nc\nD\n";      // the agent changed line 4
    expect(threeWay(base, mine, theirs)).toEqual({ text: "A\nb\nc\nD\n", conflicts: 0 });
  });

  it("keeps both sides of an edit to the same line, as conflict blocks", () => {
    const r = threeWay(base, "a\nMINE\nc\nd\n", "a\nTHEIRS\nc\nd\n");
    expect(r.conflicts).toBe(1);
    expect(r.text).toBe(
      `a\n${MARK_MINE}\nMINE\n${MARK_SPLIT}\nTHEIRS\n${MARK_THEIRS}\nc\nd\n`,
    );
    expect(hasConflictMarkers(r.text)).toBe(true);
  });

  it("does not call the same change on both sides a conflict", () => {
    expect(threeWay(base, "a\nX\nc\nd\n", "a\nX\nc\nd\nmore\n"))
      .toEqual({ text: "a\nX\nc\nd\nmore\n", conflicts: 0 });
  });

  it("takes the other side when only one side changed", () => {
    expect(threeWay(base, base, "new\n")).toEqual({ text: "new\n", conflicts: 0 });
    expect(threeWay(base, "mine\n", base)).toEqual({ text: "mine\n", conflicts: 0 });
  });

  it("keeps a missing final newline and CRLF endings", () => {
    const b = "x\r\ny\r\nz";
    const r = threeWay(b, "X\r\ny\r\nz", "x\r\ny\r\nZ");
    expect(r).toEqual({ text: "X\r\ny\r\nZ", conflicts: 0 });
  });

  it("closes an unterminated last line before a marker", () => {
    const r = threeWay("a", "mine", "theirs");
    expect(r.text).toBe(`${MARK_MINE}\nmine\n${MARK_SPLIT}\ntheirs\n${MARK_THEIRS}\n`);
  });

  it("only treats whole marker lines as markers", () => {
    expect(hasConflictMarkers("const s = '<<<<<<< your edits';\n")).toBe(false);
  });
});
