import { describe, expect, it } from "vitest";
import { patternOf, previewLine } from "../src/renderer/ide/replacePreview.js";

const show = (parts: ReturnType<typeof previewLine>) =>
  parts.map((p) => (p.kind === "old" ? `[-${p.text}-]` : p.kind === "new" ? `{+${p.text}+}` : p.text)).join("");

describe("previewLine (VS Code's find and replace semantics)", () => {
  it("strikes each literal match and shows its replacement", () => {
    expect(show(previewLine("a.b a.b", { query: "a.b", replace: "x" }))).toBe("[-a.b-]{+x+} [-a.b-]{+x+}");
  });

  it("treats a literal query's dot as a dot", () => {
    expect(show(previewLine("axb", { query: "a.b", replace: "x" }))).toBe("axb");
  });

  it("uses capture groups in a regex replacement", () => {
    expect(show(previewLine("getName()", { query: "get(\\w+)", replace: "fetch$1", regex: true })))
      .toBe("[-getName-]{+fetchName+}()");
  });

  it("is case insensitive unless asked", () => {
    expect(show(previewLine("Foo foo", { query: "foo", replace: "bar" }))).toBe("[-Foo-]{+bar+} [-foo-]{+bar+}");
    expect(show(previewLine("Foo foo", { query: "foo", replace: "bar", caseSensitive: true }))).toBe("Foo [-foo-]{+bar+}");
  });

  it("matches whole words only when asked", () => {
    expect(show(previewLine("cat concat", { query: "cat", replace: "dog", wholeWord: true }))).toBe("[-cat-]{+dog+} concat");
  });

  it("shows a deletion as a strike with nothing after it", () => {
    expect(show(previewLine("a, b", { query: ", ", replace: "" }))).toBe("a[-, -]b");
  });

  it("leaves the line alone for a pattern that does not compile", () => {
    expect(patternOf({ query: "(", replace: "", regex: true })).toBeNull();
    expect(show(previewLine("(x)", { query: "(", replace: "", regex: true }))).toBe("(x)");
  });
});
