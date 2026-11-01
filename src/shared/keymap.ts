/**
 * Every fove keyboard shortcut, in one table.
 *
 * Before this, shortcuts were an `if/else` chain in `App.tsx` with the hints
 * typed out again by hand in the palette and the toolbar, and most of them
 * gave a familiar key a fove-only meaning (⌘W closed a whole pane, ⌘P pinned
 * it, ⌘M opened the model picker instead of minimizing). Now the defaults
 * follow a standard, in this order, and the user can change any of them:
 *
 *   1. macOS, for anything app- or window-level. It wins every clash.
 *   2. VS Code's macOS defaults, for editing, search and panels.
 *   3. iTerm, only inside a focused terminal pane (⌘D splits).
 *   4. fove-only actions take keys none of the above use (⌃⌘ + letter).
 *
 * Pure data and functions, so the rules can be tested without a window.
 */

/**
 * Where a binding applies.
 *
 * A pane-scoped binding wins over an app-wide one while that kind of pane has
 * focus: ⌘W closes the editor's tab before it closes the pane, and ⌘D splits
 * from a terminal the way iTerm does.
 */
export type Scope = "app" | "terminal" | "editor";

export interface Command {
  id: string;
  label: string;
  group: string;
  scope: Scope;
  /** The default chord, or null for commands that only live in the palette. */
  key: string | null;
  /**
   * True for actions only fove has. Their defaults must not take a key that
   * macOS or VS Code already gives a meaning; `test/keymap.test.ts` checks it.
   */
  foveOnly?: boolean;
  /**
   * For the editor's own commands: the VS Code command this is. Its default
   * is VS Code's macOS default, and a change here is handed to VS Code's
   * keybinding service (ide/editorKeys.ts) rather than handled by fove.
   */
  vscode?: string;
}

const tabs: Command[] = Array.from({ length: 9 }, (_, i) => ({
  id: `tab.${i + 1}`,
  label: `Switch to workspace tab ${i + 1}`,
  group: "Workspace",
  scope: "app" as const,
  key: `cmd+${i + 1}`,
}));

export const COMMANDS: Command[] = [
  // Panes. The VS Code "show view" keys where VS Code has the same view.
  { id: "pane.editor", label: "Editor", group: "Open a pane", scope: "app", key: "shift+cmd+e" },
  { id: "pane.git", label: "Git", group: "Open a pane", scope: "app", key: "ctrl+shift+g" },
  { id: "pane.debug", label: "Debugger", group: "Open a pane", scope: "app", key: "shift+cmd+d" },
  { id: "pane.search", label: "Search in a pane (regex, globs)", group: "Open a pane", scope: "app", key: "shift+cmd+f" },
  { id: "pane.config", label: "Config", group: "Open a pane", scope: "app", key: "cmd+," },
  { id: "pane.claude", label: "New Claude pane", group: "Open a pane", scope: "app", key: "cmd+enter", foveOnly: true },
  { id: "pane.agents", label: "Agents", group: "Open a pane", scope: "app", key: "ctrl+cmd+a", foveOnly: true },
  { id: "pane.browser", label: "Browser", group: "Open a pane", scope: "app", key: "ctrl+cmd+b", foveOnly: true },
  { id: "pane.shell", label: "New shell pane", group: "Open a pane", scope: "app", key: null, foveOnly: true },

  { id: "go.quickOpen", label: "Go to a file, or search the codebase", group: "Go to", scope: "app", key: "cmd+p" },
  { id: "go.palette", label: "Command palette", group: "Go to", scope: "app", key: "shift+cmd+p" },
  { id: "go.model", label: "Switch model", group: "Go to", scope: "app", key: "ctrl+cmd+m", foveOnly: true },
  { id: "go.shortcuts", label: "Keyboard shortcuts", group: "Go to", scope: "app", key: null },

  { id: "ws.newTab", label: "New workspace tab (pick a folder)", group: "Workspace", scope: "app", key: "cmd+t" },
  { id: "ws.closePane", label: "Close pane", group: "Workspace", scope: "app", key: "cmd+w" },
  { id: "ws.splitRight", label: "Split right", group: "Workspace", scope: "app", key: "cmd+\\" },
  { id: "ws.splitDown", label: "Split down", group: "Workspace", scope: "app", key: null },
  { id: "ws.pinPane", label: "Pin or unpin pane", group: "Workspace", scope: "app", key: null, foveOnly: true },
  { id: "ws.pinTab", label: "Pin or unpin workspace tab", group: "Workspace", scope: "app", key: null, foveOnly: true },
  { id: "ws.popout", label: "Pop pane out, or put it back", group: "Workspace", scope: "app", key: null, foveOnly: true },
  ...tabs,

  // iTerm's keys, inside a terminal pane (Claude panes are terminals too).
  { id: "term.splitRight", label: "Split right", group: "Terminal pane", scope: "terminal", key: "cmd+d" },
  { id: "term.splitDown", label: "Split down", group: "Terminal pane", scope: "terminal", key: "shift+cmd+d" },

  { id: "editor.save", label: "Save", group: "Editor pane", scope: "editor", key: "cmd+s" },
  { id: "editor.closeTab", label: "Close file tab", group: "Editor pane", scope: "editor", key: "cmd+w" },
  { id: "editor.symbol", label: "Go to symbol in file", group: "Editor pane", scope: "editor", key: "shift+cmd+o" },
  ...editing(),
];

/**
 * The editor's own keys, as VS Code ships them on macOS. The everyday ones,
 * not all four hundred: the palette lists the rest, with their keys.
 */
function editing(): Command[] {
  const e = (vscode: string, label: string, key: string): Command =>
    ({ id: `vs:${vscode}`, label, group: "Editing (VS Code)", scope: "editor", key, vscode });
  return [
    e("editor.action.commentLine", "Toggle line comment", "cmd+/"),
    e("editor.action.blockComment", "Toggle block comment", "shift+alt+a"),
    e("editor.action.addSelectionToNextFindMatch", "Select next match", "cmd+d"),
    e("editor.action.selectHighlights", "Select all matches", "shift+cmd+l"),
    e("editor.action.insertCursorAbove", "Add cursor above", "alt+cmd+up"),
    e("editor.action.insertCursorBelow", "Add cursor below", "alt+cmd+down"),
    e("editor.action.moveLinesUpAction", "Move line up", "alt+up"),
    e("editor.action.moveLinesDownAction", "Move line down", "alt+down"),
    e("editor.action.copyLinesDownAction", "Copy line down", "shift+alt+down"),
    e("editor.action.deleteLines", "Delete line", "shift+cmd+k"),
    e("editor.action.formatDocument", "Format document", "shift+alt+f"),
    e("editor.action.rename", "Rename symbol", "f2"),
    e("editor.action.revealDefinition", "Go to definition", "f12"),
    e("editor.action.goToReferences", "Find references", "shift+f12"),
    e("editor.action.quickFix", "Quick fix", "cmd+."),
    e("editor.action.triggerSuggest", "Show suggestions", "ctrl+space"),
    e("editor.action.marker.next", "Next problem in this file", "alt+f8"),
    e("actions.find", "Find", "cmd+f"),
    e("editor.action.startFindReplaceAction", "Find and replace", "alt+cmd+f"),
    e("editor.fold", "Fold", "alt+cmd+["),
    e("editor.unfold", "Unfold", "alt+cmd+]"),
  ];
}

export const COMMAND_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

/**
 * Keys macOS keeps for itself. Assigning one is refused: either the system
 * takes the key before fove sees it, or fove would break a key every Mac app
 * shares.
 */
export const RESERVED: Record<string, string> = {
  "cmd+q": "Quit",
  "cmd+h": "Hide fove",
  "alt+cmd+h": "Hide others",
  "cmd+m": "Minimize",
  "cmd+tab": "Switch apps",
  "cmd+space": "Spotlight",
  "cmd+`": "Switch windows",
  "cmd+c": "Copy",
  "cmd+v": "Paste",
  "cmd+x": "Cut",
  "cmd+z": "Undo",
  "shift+cmd+z": "Redo",
  "cmd+a": "Select all",
  "shift+cmd+3": "Screenshot",
  "shift+cmd+4": "Screenshot of an area",
  "shift+cmd+5": "Screenshot tools",
  "ctrl+cmd+q": "Lock screen",
  "ctrl+cmd+f": "Full screen",
  "ctrl+cmd+space": "Emoji & symbols",
  "ctrl+cmd+d": "Look up",
  "alt+cmd+escape": "Force quit",
};

/**
 * Keys macOS or VS Code give a meaning. Assigning one is allowed, with a
 * warning that people will expect the standard meaning.
 */
export const STANDARD: Record<string, string> = {
  "cmd+w": "Close (macOS)",
  "cmd+o": "Open (macOS)",
  "cmd+n": "New window (macOS)",
  "cmd+t": "New tab (macOS)",
  "cmd+,": "Settings (macOS)",
  "cmd+s": "Save (macOS)",
  "cmd+f": "Find (macOS)",
  "cmd+g": "Find next (macOS)",
  "shift+cmd+g": "Find previous (macOS)",
  "cmd+e": "Find with selection (macOS)",
  "cmd+p": "Go to file (VS Code)",
  "shift+cmd+p": "Command palette (VS Code)",
  "cmd+b": "Toggle sidebar (VS Code)",
  "cmd+j": "Toggle panel (VS Code)",
  "cmd+k": "Start of a two-key shortcut (VS Code)",
  "cmd+d": "Select next match (VS Code)",
  "cmd+l": "Select line (VS Code)",
  "cmd+/": "Toggle comment (VS Code)",
  "cmd+\\": "Split editor (VS Code)",
  "shift+cmd+e": "Explorer (VS Code)",
  "shift+cmd+f": "Search (VS Code)",
  "shift+cmd+d": "Run and debug (VS Code)",
  "shift+cmd+x": "Extensions (VS Code)",
  "shift+cmd+m": "Problems (VS Code)",
  "shift+cmd+o": "Go to symbol (VS Code)",
  "ctrl+shift+g": "Source control (VS Code)",
  "ctrl+`": "Terminal (VS Code)",
  "cmd+r": "Reload (browsers)",
};

/** commandId → chord, or null when the user removed a default. */
export type Overrides = Record<string, string | null>;

const MOD_ORDER = ["ctrl", "alt", "shift", "cmd"] as const;

/** Map a physical key to the name chords use. */
function keyName(code: string | undefined, key: string): string | null {
  if (code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit\d$/.test(code)) return code.slice(5);
    const named: Record<string, string> = {
      Backslash: "\\", Slash: "/", Comma: ",", Period: ".", Semicolon: ";",
      Quote: "'", BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=",
      Backquote: "`", Enter: "enter", NumpadEnter: "enter", Space: "space",
      Tab: "tab", Escape: "escape", Backspace: "backspace", Delete: "delete",
      ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    };
    if (named[code]) return named[code]!;
    if (/^F\d{1,2}$/.test(code)) return code.toLowerCase();
  }
  if (["Meta", "Control", "Alt", "Shift"].includes(key)) return null;
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
}

/**
 * The chord a key event spells, or null for a bare modifier press.
 *
 * Keyed on `code` (the physical key) rather than `key`: with ⌥ held, macOS
 * turns ⌥⌘F into "ƒ", and with ⇧ held "d" arrives as "D".
 */
export function chordFromEvent(e: {
  key: string; code?: string;
  metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean;
}): string | null {
  const name = keyName(e.code, e.key);
  if (!name) return null;
  const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "cmd"]
    .filter(Boolean);
  return [...mods, name].join("+");
}

/** Put a hand-written chord in canonical order, so "cmd+shift+f" == "shift+cmd+f". */
export function normalize(chord: string): string {
  const parts = chord.toLowerCase().split("+");
  // "cmd++" would split into an empty key; chords here never bind "+".
  const key = parts.pop()!;
  const mods = MOD_ORDER.filter((m) => parts.includes(m));
  return [...mods, key].join("+");
}

const GLYPH: Record<string, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
const KEY_GLYPH: Record<string, string> = {
  enter: "↵", escape: "⎋", backspace: "⌫", delete: "⌦", tab: "⇥", space: "Space",
  up: "↑", down: "↓", left: "←", right: "→",
};

/** "shift+cmd+f" → "⇧⌘F", in the order macOS menus print modifiers. */
export function formatChord(chord: string | null | undefined): string {
  if (!chord) return "";
  const parts = normalize(chord).split("+");
  const key = parts.pop()!;
  const keyText = KEY_GLYPH[key] ?? (key.length === 1 ? key.toUpperCase() : key.toUpperCase());
  return parts.map((m) => GLYPH[m] ?? m).join("") + keyText;
}

/** A chord with no modifier would fire while typing, so it is never bindable. */
export function hasModifier(chord: string): boolean {
  const parts = chord.split("+");
  return parts.length > 1 || /^f\d{1,2}$/.test(parts[0]!);
}

/** The key a command has now: the user's override if there is one, else the default. */
export function keyFor(overrides: Overrides, id: string): string | null {
  if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id] ?? null;
  return COMMAND_BY_ID.get(id)?.key ?? null;
}

/** The command bound to a chord in one scope, if any. */
export function lookup(overrides: Overrides, scope: Scope, chord: string): string | undefined {
  const want = normalize(chord);
  for (const c of COMMANDS) {
    if (c.scope !== scope) continue;
    const k = keyFor(overrides, c.id);
    if (k && normalize(k) === want) return c.id;
  }
  return undefined;
}

export interface Check {
  /** macOS keeps this key; the assignment is refused. */
  reserved?: string;
  /** Needs a modifier; the assignment is refused. */
  bare?: boolean;
  /** Another command in the same scope already has it, and would lose it. */
  clash?: string;
  /** What macOS or VS Code use this key for; a warning only. */
  standard?: string;
}

/** What assigning `chord` to `id` would mean, before doing it. */
export function check(overrides: Overrides, id: string, chord: string): Check {
  const c = normalize(chord);
  const out: Check = {};
  if (!hasModifier(c)) out.bare = true;
  if (RESERVED[c]) out.reserved = RESERVED[c];
  const scope = COMMAND_BY_ID.get(id)?.scope ?? "app";
  const other = lookup(overrides, scope, c);
  if (other && other !== id) out.clash = other;
  if (STANDARD[c]) out.standard = STANDARD[c];
  return out;
}

/**
 * Assign a chord, taking it from whichever command in the same scope had it.
 *
 * Refused (returns the overrides unchanged) for reserved and bare keys.
 * Assigning a command its own default stores no override, so a later change
 * to the default still reaches it.
 */
export function assign(overrides: Overrides, id: string, chord: string | null): Overrides {
  const next: Overrides = { ...overrides };
  if (chord === null) {
    if (COMMAND_BY_ID.get(id)?.key == null) delete next[id];
    else next[id] = null;
    return next;
  }
  const c = normalize(chord);
  const result = check(overrides, id, c);
  if (result.reserved || result.bare) return overrides;
  if (result.clash) {
    const loser = COMMAND_BY_ID.get(result.clash);
    if (loser?.key == null) delete next[result.clash];
    else next[result.clash] = null;
  }
  const def = COMMAND_BY_ID.get(id)?.key;
  if (def && normalize(def) === c) delete next[id];
  else next[id] = c;
  return next;
}

/** Back to the default; the default's chord is taken back from whoever holds it. */
export function reset(overrides: Overrides, id: string): Overrides {
  const def = COMMAND_BY_ID.get(id)?.key ?? null;
  const next = { ...overrides };
  delete next[id];
  return def ? assign(next, id, def) : next;
}

/** Drop anything unknown or malformed from a stored copy. */
export function sanitize(raw: unknown): Overrides {
  if (!raw || typeof raw !== "object") return {};
  const out: Overrides = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!COMMAND_BY_ID.has(id)) continue;
    if (v === null) out[id] = null;
    else if (typeof v === "string" && hasModifier(normalize(v)) && !RESERVED[normalize(v)]) {
      out[id] = normalize(v);
    }
  }
  return out;
}
