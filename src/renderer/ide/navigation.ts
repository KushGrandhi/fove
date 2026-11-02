/**
 * Where a jump to another file lands: go-to-definition, a reference, a symbol.
 *
 * VS Code's editor service asks fove to open the file (`openEditor`, passed
 * to the editor-service override in `vscode.ts`) and expects the editor that
 * is now showing it. fove answers with an editor pane, so the jump becomes a
 * tab in fove rather than a VS Code window.
 *
 * There can be several editor panes, so the most recently focused one claims
 * the job. That is the one you are looking at, which is where the definition
 * should land.
 */

import type * as monaco from "monaco-editor";
import type { IReference } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";

/** Open a file in a pane at a position, and give back the editor showing it. */
type Open = (path: string, line: number, column: number) => Promise<monaco.editor.ICodeEditor | undefined>;

let openInFocusedPane: Open | null = null;

export function claimNavigation(open: Open): void {
  openInFocusedPane = open;
}

/** Release the claim if this pane still holds it, e.g. on unmount. */
export function releaseNavigation(open: Open): void {
  if (openInFocusedPane === open) openInFocusedPane = null;
}

/**
 * The editor service's open request. The model reference it hands over is
 * given back once the pane has taken its own.
 */
export async function openEditor(
  modelRef: IReference<{ textEditorModel: monaco.editor.ITextModel }>,
  options: { selection?: { startLineNumber?: number; startColumn?: number } } | undefined,
): Promise<monaco.editor.ICodeEditor | undefined> {
  try {
    if (!openInFocusedPane) return undefined;
    const uri = modelRef.object.textEditorModel.uri;
    if (uri.scheme !== "file") return undefined;
    return await openInFocusedPane(
      uri.fsPath,
      options?.selection?.startLineNumber ?? 1,
      options?.selection?.startColumn ?? 1,
    );
  } finally {
    modelRef.dispose();
  }
}
