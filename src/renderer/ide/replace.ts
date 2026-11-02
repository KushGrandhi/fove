/**
 * Search and replace across files, on VS Code's own pieces.
 *
 *   - The pattern: `createRegExp` (vs/base/common/strings) builds the search
 *     the way VS Code's find does -- literal or regex, match case, whole word.
 *   - The replacement: `parseReplaceString` (the find widget's), so `$1`,
 *     `$&`, `\n` and `\t` mean what they mean in VS Code.
 *   - Applying: the bulk edit service. Files not open are loaded, open
 *     editors update in place, and the whole replace is one undo.
 *   - Saving: edited files are saved, as VS Code saves a refactoring --
 *     except files that already had unsaved edits, which stay unsaved.
 *
 * The preview and the edit use the same pattern and the same replacement, so
 * what a row shows is what replacing it writes.
 */

import * as monaco from "monaco-editor";
import { getService, IBulkEditService } from "@codingame/monaco-vscode-api";
import { parseReplaceString } from "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/find/browser/replacePattern";
import { ResourceTextEdit } from "@codingame/monaco-vscode-api/vscode/vs/editor/browser/services/bulkEditService";
import { USUAL_WORD_SEPARATORS } from "@codingame/monaco-vscode-api/vscode/vs/editor/common/core/wordHelper";
import { openText, saveText, textFileModel } from "./vscode.js";
import { patternOf, type ReplaceQuery } from "./replacePreview.js";

export type { ReplaceQuery };

/** Which matches to replace in one file: all of them, or the nth on a line. */
export interface Target {
  path: string;
  /** 1-based; with `index`, only that match on that line. */
  line?: number;
  index?: number;
}

/**
 * The documents of the last replace, held open.
 *
 * VS Code's undo for an edit across files lives on each file's model; a
 * model that is closed takes its share of the undo with it. Holding them
 * until the next replace keeps ⌘Z able to put every file back.
 */
let held: { dispose(): void }[] = [];

/**
 * Undo and redo of a replace, for files no editor shows.
 *
 * ⌘Z in one file undoes the replace in every file -- but a file nobody has
 * open would be left undone in memory and still replaced on disk, with
 * nothing on screen saying so. Such a file is saved after an undo or redo,
 * as the replace itself saved it. A file open in an editor is left to its
 * editor: there the change is visible, and saving is the user's call.
 */
function followUndo(model: monaco.editor.ITextModel, path: string): { dispose(): void } {
  return model.onDidChangeContent((e) => {
    if (!e.isUndoing && !e.isRedoing) return;
    const shown = monaco.editor.getEditors().some((ed) => ed.getModel() === model);
    if (!shown) void saveText(path);
  });
}

/**
 * Replace in files, as one undoable edit. Answers how many matches were
 * replaced, in how many files.
 */
export async function replaceIn(
  targets: Target[],
  q: ReplaceQuery,
): Promise<{ files: number; replaced: number; unsaved: string[] }> {
  if (!q.query || !patternOf(q)) return { files: 0, replaced: 0, unsaved: [] };
  const pattern = parseReplaceString(q.replace);
  const refs: { dispose(): void }[] = [];
  const edits: ResourceTextEdit[] = [];
  const touched = new Set<string>();
  /** Files that had unsaved edits before: replaced in the buffer, never saved. */
  const draft = new Set<string>();
  const models = new Map<string, monaco.editor.ITextModel>();
  try {
    for (const t of targets) {
      const ref = await openText(t.path);
      refs.push(ref);
      const model = ref.object.textEditorModel;
      if (!model) continue;
      models.set(t.path, model);
      if ((await textFileModel(t.path))?.isDirty()) draft.add(t.path);
      let found = model.findMatches(
        q.query, false, q.regex === true, q.caseSensitive === true,
        q.wholeWord ? USUAL_WORD_SEPARATORS : null, true,
      );
      if (t.line !== undefined) {
        found = found.filter((m) => m.range.startLineNumber === t.line);
        if (t.index !== undefined) found = found.slice(t.index, t.index + 1);
      }
      for (const m of found) {
        edits.push(new ResourceTextEdit(model.uri as never, {
          range: m.range,
          text: pattern.buildReplaceString(m.matches),
        }, model.getVersionId()));
        touched.add(t.path);
      }
    }
    if (!edits.length) return { files: 0, replaced: 0, unsaved: [] };
    const bulk = await getService(IBulkEditService);
    await bulk.apply(edits, {
      label: `Replace "${q.query}" with "${q.replace}"`,
      quotableLabel: `Replacing "${q.query}"`,
    });
    // Saved as VS Code saves a refactoring -- but a file that held unsaved
    // edits stays unsaved: saving would publish a half-finished draft.
    const saved = [...touched].filter((p) => !draft.has(p));
    await Promise.all(saved.map((p) => saveText(p)));
    for (const p of saved) {
      const model = models.get(p);
      if (model) refs.push(followUndo(model, p));
    }
    return { files: touched.size, replaced: edits.length, unsaved: [...draft].filter((p) => touched.has(p)) };
  } finally {
    for (const r of held) r.dispose();
    held = refs;
  }
}
