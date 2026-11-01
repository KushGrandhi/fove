import { describe, expect, it } from "vitest";
import {
  COMMANDS, RESERVED, STANDARD, assign, check, chordFromEvent, formatChord, keyFor,
  lookup, normalize, reset, sanitize, type Overrides,
} from "../src/shared/keymap.js";

const ev = (code: string, key: string, mods: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = {}) => ({
  code, key,
  metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift,
});

describe("defaults follow the standard", () => {
  it("never take a key macOS keeps for itself", () => {
    for (const c of COMMANDS) {
      if (c.key) expect(RESERVED[normalize(c.key)], `${c.id} on ${c.key}`).toBeUndefined();
    }
  });

  it("give fove-only actions keys macOS and VS Code leave free", () => {
    for (const c of COMMANDS.filter((x) => x.foveOnly && x.key)) {
      expect(STANDARD[normalize(c.key!)], `${c.id} on ${c.key}`).toBeUndefined();
    }
  });

  it("never bind two commands in one scope to the same key", () => {
    const seen = new Map<string, string>();
    for (const c of COMMANDS) {
      if (!c.key) continue;
      const slot = `${c.scope}:${normalize(c.key)}`;
      expect(seen.get(slot), `${c.id} and ${seen.get(slot)}`).toBeUndefined();
      seen.set(slot, c.id);
    }
  });

  it("leave ⌘M to macOS instead of the model picker", () => {
    expect(lookup({}, "app", "cmd+m")).toBeUndefined();
  });

  it("close the editor's file tab before the pane", () => {
    expect(lookup({}, "editor", "cmd+w")).toBe("editor.closeTab");
    expect(lookup({}, "app", "cmd+w")).toBe("ws.closePane");
  });
});

describe("chordFromEvent", () => {
  it("reads the physical key, so ⌥ and ⇧ do not change the letter", () => {
    expect(chordFromEvent(ev("KeyF", "ƒ", { meta: true, alt: true }))).toBe("alt+cmd+f");
    expect(chordFromEvent(ev("KeyD", "D", { meta: true, shift: true }))).toBe("shift+cmd+d");
  });

  it("ignores a bare modifier press", () => {
    expect(chordFromEvent(ev("MetaLeft", "Meta", { meta: true }))).toBeNull();
  });

  it("names punctuation and Enter", () => {
    expect(chordFromEvent(ev("Backslash", "\\", { meta: true }))).toBe("cmd+\\");
    expect(chordFromEvent(ev("Enter", "Enter", { meta: true }))).toBe("cmd+enter");
  });
});

describe("formatChord", () => {
  it("prints modifiers in macOS menu order", () => {
    expect(formatChord("cmd+shift+f")).toBe("⇧⌘F");
    expect(formatChord("cmd+ctrl+m")).toBe("⌃⌘M");
    expect(formatChord("cmd+enter")).toBe("⌘↵");
    expect(formatChord(null)).toBe("");
  });
});

describe("assign", () => {
  it("refuses keys macOS keeps", () => {
    const before: Overrides = {};
    expect(check(before, "pane.git", "cmd+q").reserved).toBe("Quit");
    expect(assign(before, "pane.git", "cmd+q")).toBe(before);
  });

  it("refuses a key with no modifier", () => {
    expect(assign({}, "pane.git", "g")).toEqual({});
  });

  it("takes the key from the command that had it, in the same scope", () => {
    const next = assign({}, "pane.git", "cmd+p");
    expect(keyFor(next, "pane.git")).toBe("cmd+p");
    expect(keyFor(next, "go.quickOpen")).toBeNull();
  });

  it("does not take a key from another scope", () => {
    // ⌘D in a terminal pane is iTerm's split; binding it app-wide leaves that alone.
    const next = assign({}, "pane.git", "cmd+d");
    expect(keyFor(next, "term.splitRight")).toBe("cmd+d");
  });

  it("warns, without refusing, about a standard key", () => {
    expect(check({}, "pane.agents", "cmd+b").standard).toMatch(/sidebar/);
    expect(keyFor(assign({}, "pane.agents", "cmd+b"), "pane.agents")).toBe("cmd+b");
  });

  it("stores nothing when a command is given its own default", () => {
    expect(assign({ "pane.git": "alt+cmd+g" }, "pane.git", "ctrl+shift+g")).toEqual({});
  });

  it("can remove a key", () => {
    expect(keyFor(assign({}, "pane.git", null), "pane.git")).toBeNull();
  });
});

describe("reset", () => {
  it("brings the default back and takes it from whoever borrowed it", () => {
    let o = assign({}, "pane.agents", "cmd+p"); // quick open loses ⌘P
    o = reset(o, "go.quickOpen");
    expect(keyFor(o, "go.quickOpen")).toBe("cmd+p");
    expect(keyFor(o, "pane.agents")).toBeNull();
  });
});

describe("sanitize", () => {
  it("drops unknown commands, reserved keys and junk from storage", () => {
    expect(sanitize({ "nope": "cmd+y", "pane.git": "cmd+q", "pane.agents": 3, "pane.browser": "cmd+shift+y" }))
      .toEqual({ "pane.browser": "shift+cmd+y" });
    expect(sanitize("garbage")).toEqual({});
  });
});
