/**
 * The editor's commands, for fove's palette.
 *
 * VS Code's palette lists every editor action -- Format Document, Rename
 * Symbol, Fold All, Sort Lines -- with its key. fove keeps its own palette
 * and fills that part of it from the same places VS Code does: the editor's
 * supported actions (`getSupportedActions`, which already filters to what
 * applies to this file) and the keybinding service, for the key shown beside
 * each one.
 *
 * The commands act on the editor last focused, since opening the palette
 * moves focus into its input.
 */

import * as monaco from "monaco-editor";
import { getService, ICodeEditorService, IKeybindingService } from "@codingame/monaco-vscode-api";

let last: monaco.editor.ICodeEditor | null = null;
let tracking = false;

/** Follow which editor was focused last. Once, after the services start. */
export async function trackEditorFocus(): Promise<void> {
  if (tracking) return;
  tracking = true;
  const editors = await getService(ICodeEditorService);
  const follow = (ed: monaco.editor.ICodeEditor) => {
    ed.onDidFocusEditorText(() => { last = ed; });
    ed.onDidDispose(() => { if (last === ed) last = null; });
  };
  for (const ed of editors.listCodeEditors()) follow(ed as unknown as monaco.editor.ICodeEditor);
  editors.onCodeEditorAdd((ed) => follow(ed as unknown as monaco.editor.ICodeEditor));
}

export interface EditorCommand {
  id: string;
  label: string;
  /** The key, as VS Code prints it ("⇧⌥F"), or "" when it has none. */
  key: string;
  run: () => void;
}

/** The last-focused editor's commands, or none when no editor is on screen. */
export async function editorCommands(): Promise<EditorCommand[]> {
  const ed = last;
  if (!ed || !ed.getModel() || !ed.getContainerDomNode().isConnected) return [];
  const keys = await getService(IKeybindingService);
  const seen = new Set<string>();
  const out: EditorCommand[] = [];
  for (const action of ed.getSupportedActions()) {
    if (!action.label || seen.has(action.label) || !action.isSupported()) continue;
    seen.add(action.label);
    out.push({
      id: action.id,
      label: action.label,
      key: keys.lookupKeybinding(action.id)?.getLabel() ?? "",
      run: () => {
        ed.focus();
        void action.run();
      },
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
