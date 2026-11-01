/**
 * Change markers in the gutter, from VS Code's own quick diff.
 *
 * VS Code marks added, changed and removed lines against what a source
 * control provider says the "original" of the file is, and clicking a marker
 * opens an inline diff of that change with previous/next and revert. fove
 * used to draw its own bars; this is VS Code's real implementation (the SCM
 * service override), fed by a small fove "Git" source per repository whose
 * original is the file as HEAD has it, read with `git show` over IPC.
 *
 * Two pieces of glue, both small:
 *
 *   - VS Code decorates the editors its editor service lists as visible, and
 *     fove's editors are standalone ones it does not know about. The list is
 *     extended with them (diff editors excluded: they show a diff already).
 *   - The source control is created through the `vscode` extension API, the
 *     same way the git extension would create it.
 */

import * as vscode from "vscode";
import * as monaco from "monaco-editor";
import { getService, ICodeEditorService, IEditorService } from "@codingame/monaco-vscode-api";
import { MenuId, MenuRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";

const SCHEME = "fove-git";
const TURN_SCHEME = "fove-turn";

/** Fires when HEAD may have moved, so the originals are read again. */
const changed = new vscode.EventEmitter<vscode.Uri>();
/** Originals handed out, so a refresh can say which ones changed. */
const handedOut = new Map<string, vscode.Uri>();

let started = false;

/** Wire VS Code's quick diff to fove's editors. Once per window, after the services start. */
export async function startQuickDiff(): Promise<void> {
  if (started) return;
  started = true;

  vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    onDidChange: changed.event,
    async provideTextDocumentContent(uri) {
      const { root, rev } = JSON.parse(uri.query) as { root: string; rev: string };
      const rel = uri.path.slice(root.replace(/\/$/, "").length + 1);
      return (await window.th.gitFileAt(root, rev, rel)) ?? "";
    },
  });

  vscode.workspace.registerTextDocumentContentProvider(TURN_SCHEME, {
    onDidChange: changed.event,
    provideTextDocumentContent(uri) {
      return turnFiles.get(JSON.parse(uri.query).root as string)?.files[uri.path] ?? "";
    },
  });

  const editorService = (await getService(IEditorService)) as unknown as {
    _onDidVisibleEditorsChange?: { fire(): void };
  };
  const codeEditors = await getService(ICodeEditorService);

  // The getter lives on a prototype; find it so the groups' own editors
  // (none, in fove) still come first.
  let proto: object | null = Object.getPrototypeOf(editorService);
  let base: PropertyDescriptor | undefined;
  while (proto && !base) {
    base = Object.getOwnPropertyDescriptor(proto, "visibleTextEditorControls");
    proto = Object.getPrototypeOf(proto);
  }
  const fromGroups = (): unknown[] => (base?.get ? (base.get.call(editorService) as unknown[]) : []);

  Object.defineProperty(editorService, "visibleTextEditorControls", {
    configurable: true,
    get() {
      const own = codeEditors.listCodeEditors().filter((ed) => {
        if (ed.getModel()?.uri.scheme !== "file") return false;
        // Either side of a diff editor: it already shows the change.
        return !ed.getContainerDomNode().closest(".monaco-diff-editor");
      });
      const groups = fromGroups();
      return [...groups, ...own.filter((ed) => !groups.includes(ed))];
    },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const announce = () => {
    clearTimeout(timer);
    timer = setTimeout(() => editorService._onDidVisibleEditorsChange?.fire(), 50);
  };
  const follow = (ed: { onDidChangeModel(fn: () => void): unknown }) => { ed.onDidChangeModel(announce); };
  for (const ed of codeEditors.listCodeEditors()) follow(ed);
  codeEditors.onCodeEditorAdd((ed) => { follow(ed); announce(); });
  codeEditors.onCodeEditorRemove(announce);

  /*
   * "Revert this change" in the inline diff. VS Code's git extension puts
   * revert and stage there; fove cannot run that extension, so it registers
   * the one action that needs no git: put the original lines back for this
   * hunk. Undoable like any edit, and not saved.
   */
  CommandsRegistry.registerCommand(REVERT, (_accessor, uri: monaco.Uri, changes: LineChange[], index: number) => {
    void revertChange(uri, changes, index);
  });
  MenuRegistry.appendMenuItem(MenuId.SCMChangeContext, {
    command: { id: REVERT, title: "Revert this change", icon: { id: "discard" } },
    group: "navigation",
  });
}

const REVERT = "fove.quickDiff.revertChange";

/** A hunk as the quick diff reports it: 1-based lines, end 0 for "none". */
interface LineChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

/** The original text a file is being compared against right now. */
async function originalText(path: string): Promise<string | null> {
  for (const [root, s] of sources) {
    if (!path.startsWith(`${root.replace(/\/$/, "")}/`)) continue;
    if (s.mode === "turn") return turnFiles.get(root)?.files[path] ?? null;
    return window.th.gitFileAt(root, "HEAD", path.slice(root.replace(/\/$/, "").length + 1));
  }
  return null;
}

/** Undo one hunk: the modified lines go, the original lines come back. */
export async function revertChange(uri: monaco.Uri, changes: LineChange[], index: number): Promise<void> {
  const model = monaco.editor.getModel(uri);
  const change = changes[index];
  if (!model || !change) return;
  const original = await originalText(uri.fsPath);
  if (original === null) return;
  const eol = model.getEOL();
  const lines = original.split(/\r?\n/);
  const originalLines = change.originalEndLineNumber === 0
    ? []
    : lines.slice(change.originalStartLineNumber - 1, change.originalEndLineNumber);

  let range: monaco.Range;
  let text: string;
  if (change.modifiedEndLineNumber === 0) {
    // Lines were deleted: put them back after the line the deletion follows.
    const after = change.modifiedStartLineNumber;
    if (after === 0) {
      range = new monaco.Range(1, 1, 1, 1);
      text = originalLines.join(eol) + eol;
    } else {
      const col = model.getLineMaxColumn(after);
      range = new monaco.Range(after, col, after, col);
      text = eol + originalLines.join(eol);
    }
  } else if (change.originalEndLineNumber === 0) {
    // Lines were added: remove them, with the line break that held them.
    const start = change.modifiedStartLineNumber;
    const end = change.modifiedEndLineNumber;
    range = end < model.getLineCount()
      ? new monaco.Range(start, 1, end + 1, 1)
      : start > 1
        ? new monaco.Range(start - 1, model.getLineMaxColumn(start - 1), end, model.getLineMaxColumn(end))
        : new monaco.Range(start, 1, end, model.getLineMaxColumn(end));
    text = "";
  } else {
    // Lines were changed: swap them back.
    const start = change.modifiedStartLineNumber;
    const end = change.modifiedEndLineNumber;
    range = new monaco.Range(start, 1, end, model.getLineMaxColumn(end));
    text = originalLines.join(eol);
  }
  model.pushEditOperations([], [{ range, text }], () => null);
}

export type CompareTo = "head" | "turn";

interface Sources {
  git: vscode.SourceControl;
  turn: vscode.SourceControl;
  mode: CompareTo;
}

const sources = new Map<string, Sources>();
/** Per root: the latest turn's originals, as main read them from the transcript. */
const turnFiles = new Map<string, { turnId: string; prompt: string; files: Record<string, string> }>();

const under = (root: string, uri: vscode.Uri) =>
  uri.scheme === "file" && uri.fsPath.startsWith(`${root.replace(/\/$/, "")}/`);

/** The provider that compares against HEAD. Untracked files get no original. */
function headProvider(root: string): vscode.QuickDiffProvider {
  return {
    async provideOriginalResource(uri) {
      if (!under(root, uri)) return undefined;
      const rel = uri.fsPath.slice(root.replace(/\/$/, "").length + 1);
      if ((await window.th.gitFileAt(root, "HEAD", rel)) === null) return undefined;
      const original = vscode.Uri.from({ scheme: SCHEME, path: uri.fsPath, query: JSON.stringify({ root, rev: "HEAD" }) });
      handedOut.set(original.toString(), original);
      return original;
    },
  };
}

/**
 * The provider that compares against the file before Claude's latest turn.
 * Files the turn did not touch get no original, so they show no markers --
 * the gutter then shows exactly what the turn did, nothing else.
 */
function turnProvider(root: string): vscode.QuickDiffProvider {
  return {
    provideOriginalResource(uri) {
      if (!under(root, uri)) return undefined;
      if (!(uri.fsPath in (turnFiles.get(root)?.files ?? {}))) return undefined;
      const original = vscode.Uri.from({ scheme: TURN_SCHEME, path: uri.fsPath, query: JSON.stringify({ root }) });
      handedOut.set(original.toString(), original);
      return original;
    },
  };
}

/**
 * Change markers for one repository: against HEAD by default, or against the
 * files before Claude's latest turn (`setCompareTo`). Two source controls,
 * one live at a time, so each change view is labelled with what it compares
 * against.
 */
export function ensureGitSource(root: string): void {
  if (sources.has(root)) return;
  const git = vscode.scm.createSourceControl("fove-git", "Git (HEAD)", vscode.Uri.file(root));
  const turn = vscode.scm.createSourceControl("fove-turn", "Claude's last turn", vscode.Uri.file(root));
  git.quickDiffProvider = headProvider(root);
  sources.set(root, { git, turn, mode: "head" });
}

/** Load the latest turn's originals for a root. Null when no turn changed files. */
async function loadTurn(root: string): Promise<{ prompt: string; files: number } | null> {
  const r = await window.th.keelTurnOriginals(root);
  if (!r) {
    turnFiles.delete(root);
    return null;
  }
  turnFiles.set(root, r);
  return { prompt: r.prompt, files: Object.keys(r.files).length };
}

/**
 * Switch what the gutter compares against. Returns, for "turn", which turn
 * and how many files it changed -- or null when there is no turn to review.
 */
export async function setCompareTo(root: string, mode: CompareTo): Promise<{ prompt: string; files: number } | null> {
  ensureGitSource(root);
  const s = sources.get(root)!;
  let info: { prompt: string; files: number } | null = null;
  if (mode === "turn") info = await loadTurn(root);
  s.mode = mode;
  s.git.quickDiffProvider = mode === "head" ? headProvider(root) : undefined;
  s.turn.quickDiffProvider = mode === "turn" ? turnProvider(root) : undefined;
  refreshOriginals();
  return info;
}

/**
 * Read every original again -- after a commit or checkout (HEAD moved), or a
 * new turn (the turn's originals changed). Only originals of open files are
 * re-read.
 */
export function refreshOriginals(): void {
  for (const uri of handedOut.values()) changed.fire(uri);
}

/** Re-read the latest turn for every root comparing against it, then refresh. */
export async function refreshTurns(): Promise<void> {
  await Promise.all([...sources.entries()]
    .filter(([, s]) => s.mode === "turn")
    .map(([root]) => loadTurn(root)));
  refreshOriginals();
}
