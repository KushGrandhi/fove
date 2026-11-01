import { describe, expect, it } from "vitest";
import { rankPaths, scoreText } from "../src/renderer/ui/fuzzy.js";

const paths = [
  "src/renderer/ui/editor-tabs.ts",
  "src/renderer/panes/Editor.tsx",
  "docs/editing.md",
  "src/main/search.ts",
];

describe("rankPaths (VS Code's quick open scorer)", () => {
  it("finds a file from scattered letters of its name", () => {
    expect(rankPaths(paths, "edtsx")[0]?.path).toBe("src/renderer/panes/Editor.tsx");
  });

  it("drops paths that do not match", () => {
    expect(rankPaths(paths, "search").map((r) => r.path)).toEqual(["src/main/search.ts"]);
  });

  it("lets space-separated pieces match the directory and the name", () => {
    expect(rankPaths(paths, "panes edit")[0]?.path).toBe("src/renderer/panes/Editor.tsx");
  });

  it("returns spans within the full path, for highlighting", () => {
    const [top] = rankPaths(paths, "search");
    const text = top!.spans.map((s) => top!.path.slice(s.start, s.end)).join("");
    expect(text).toBe("search");
  });

  it("keeps the given order for an empty query, up to the limit", () => {
    expect(rankPaths(paths, "", 2).map((r) => r.path)).toEqual(paths.slice(0, 2));
  });
});

describe("scoreText", () => {
  it("is 0 for an empty query and null for no match", () => {
    expect(scoreText("Format Document", "")).toBe(0);
    expect(scoreText("Format Document", "zz")).toBeNull();
  });

  it("matches word starts", () => {
    expect(scoreText("Format Document", "fd")).not.toBeNull();
  });
});
