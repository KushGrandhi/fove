/**
 * The symbols enclosing the cursor, for fove's breadcrumb.
 *
 * VS Code's own outline model (`IOutlineModelService`): it gathers document
 * symbols from every registered provider -- the language servers, and fove's
 * outline scanner for languages none serves -- caches them per model version,
 * and answers "which symbol encloses this position". The breadcrumb is
 * fove's; this only supplies the trail after the file name.
 */

import * as monaco from "monaco-editor";
import { getService, IOutlineModelService } from "@codingame/monaco-vscode-api";
import { CancellationTokenSource } from "@codingame/monaco-vscode-api/vscode/vs/base/common/cancellation";

export interface SymbolCrumb {
  name: string;
  /** monaco.languages.SymbolKind, for the icon. */
  kind: number;
  /** Where clicking the crumb goes: the symbol's name. */
  line: number;
  column: number;
}

let pending: CancellationTokenSource | undefined;

/** Outermost first. Empty when nothing encloses the position or no provider answers. */
export async function symbolPathAt(model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<SymbolCrumb[]> {
  pending?.cancel();
  const cts = new CancellationTokenSource();
  pending = cts;
  try {
    const service = await getService(IOutlineModelService);
    const outline = await service.getOrCreate(model as never, cts.token);
    if (cts.token.isCancellationRequested) return [];
    const out: SymbolCrumb[] = [];
    let el: unknown = outline.getItemEnclosingPosition(position);
    while (el && typeof el === "object" && "symbol" in el) {
      const { symbol, parent } = el as { symbol: monaco.languages.DocumentSymbol; parent?: unknown };
      out.unshift({
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.selectionRange.startLineNumber,
        column: symbol.selectionRange.startColumn,
      });
      el = parent;
    }
    return out;
  } catch {
    return [];
  }
}

/** A one-character glyph per symbol kind, in the breadcrumb's quiet style. */
export function kindGlyph(kind: number): string {
  const K = monaco.languages.SymbolKind;
  switch (kind) {
    case K.Class: case K.Struct: case K.Interface: return "◇";
    case K.Method: case K.Function: case K.Constructor: return "ƒ";
    case K.Variable: case K.Constant: case K.Field: case K.Property: return "▫";
    case K.Enum: case K.EnumMember: return "≡";
    case K.Module: case K.Namespace: case K.Package: return "▣";
    default: return "·";
  }
}
