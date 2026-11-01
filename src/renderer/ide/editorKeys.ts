/**
 * The editor's keys, as the user set them in fove's Shortcuts screen.
 *
 * The editor's own commands (toggle comment, select next match, rename...)
 * are VS Code's, bound by VS Code's keybinding service. fove's keymap lists
 * the everyday ones with VS Code's defaults (shared/keymap.ts, `vscode`);
 * when the user changes one, this hands the change to VS Code: the default
 * binding is removed and the new one added, as a `keybindings.json` entry
 * pair would. Commands left at their default are not touched.
 */

import * as monaco from "monaco-editor";
import { COMMANDS, keyFor, normalize, type Overrides } from "../../shared/keymap.js";
import { keymap } from "../ui/keymap-store.js";

const { KeyCode, KeyMod } = monaco;

const NAMED: Record<string, number> = {
  up: KeyCode.UpArrow, down: KeyCode.DownArrow, left: KeyCode.LeftArrow, right: KeyCode.RightArrow,
  enter: KeyCode.Enter, escape: KeyCode.Escape, tab: KeyCode.Tab, space: KeyCode.Space,
  backspace: KeyCode.Backspace, delete: KeyCode.Delete,
  "/": KeyCode.Slash, "\\": KeyCode.Backslash, ",": KeyCode.Comma, ".": KeyCode.Period,
  ";": KeyCode.Semicolon, "'": KeyCode.Quote, "[": KeyCode.BracketLeft, "]": KeyCode.BracketRight,
  "-": KeyCode.Minus, "=": KeyCode.Equal, "`": KeyCode.Backquote,
};

/** "shift+cmd+k" as VS Code's numeric keybinding, or null for a key it has no code for. */
export function toKeybinding(chord: string): number | null {
  const parts = normalize(chord).split("+");
  const key = parts.pop()!;
  let code: number | undefined = NAMED[key];
  if (code === undefined && /^[a-z]$/.test(key)) code = KeyCode[`Key${key.toUpperCase()}` as keyof typeof KeyCode] as number;
  if (code === undefined && /^\d$/.test(key)) code = KeyCode[`Digit${key}` as keyof typeof KeyCode] as number;
  if (code === undefined && /^f\d{1,2}$/.test(key)) code = KeyCode[key.toUpperCase() as keyof typeof KeyCode] as number;
  if (code === undefined) return null;
  let mods = 0;
  if (parts.includes("cmd")) mods |= KeyMod.CtrlCmd;
  if (parts.includes("ctrl")) mods |= KeyMod.WinCtrl;
  if (parts.includes("alt")) mods |= KeyMod.Alt;
  if (parts.includes("shift")) mods |= KeyMod.Shift;
  return mods | code;
}

let applied: monaco.IDisposable | null = null;

function apply(overrides: Overrides): void {
  applied?.dispose();
  const rules: monaco.editor.IKeybindingRule[] = [];
  for (const c of COMMANDS) {
    if (!c.vscode) continue;
    const now = keyFor(overrides, c.id);
    if ((now && normalize(now)) === (c.key && normalize(c.key))) continue;
    const old = c.key ? toKeybinding(c.key) : null;
    if (old !== null) rules.push({ keybinding: old, command: `-${c.vscode}` });
    const next = now ? toKeybinding(now) : null;
    if (next !== null) rules.push({ keybinding: next, command: c.vscode, when: "editorTextFocus" });
  }
  applied = rules.length ? monaco.editor.addKeybindingRules(rules) : null;
}

let started = false;

/** Apply the user's editor keys now and whenever they change. Once, after the services start. */
export function startEditorKeys(): void {
  if (started) return;
  started = true;
  apply(keymap.get());
  keymap.subscribe(() => apply(keymap.get()));
}
