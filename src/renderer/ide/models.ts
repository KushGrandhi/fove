/**
 * Each editor pane's hold on a file's text model.
 *
 * Models are shared -- two panes showing the same file show the same model,
 * which is what makes an edit in one appear in the other. VS Code's
 * text-model service counts the references and disposes the model when the
 * last goes (keeping it, and its backup, while it has unsaved edits). This
 * keeps each pane's references so it can give them back.
 *
 * Language servers need nothing from here: VS Code's language client follows
 * every open model on its own.
 */

import type * as monaco from "monaco-editor";
import { openText, textFileModel, type TextModelRef } from "./vscode.js";

const refs = new Map<string, TextModelRef[]>();

/** Take a reference to a file's model, resolving it from disk if needed. */
export async function claimModel(path: string): Promise<monaco.editor.ITextModel> {
  const ref = await openText(path);
  const model = ref.object.textEditorModel;
  if (!model) {
    ref.dispose();
    throw new Error("the file has no text model");
  }
  refs.set(path, [...(refs.get(path) ?? []), ref]);
  return model;
}

/** Give one reference back. */
export function releaseModel(path: string): void {
  const list = refs.get(path);
  list?.pop()?.dispose();
  if (list && list.length === 0) refs.delete(path);
}

/**
 * Move a file's buffer to its new path after a rename on disk.
 *
 * A model's URI is fixed for its lifetime, so the model at the new path is a
 * new one. Unsaved edits are carried over (the new buffer is dirty with
 * them); the old model is reverted first, so VS Code does not keep it alive
 * as an orphan of a path that no longer exists. Undo history does not
 * survive -- Monaco offers no way to move it.
 */
export async function renameModel(from: string, to: string): Promise<monaco.editor.ITextModel | null> {
  const list = refs.get(from);
  if (!list?.length) return null;
  const text = list[0]!.object.textEditorModel?.getValue() ?? "";
  const holders = list.length;
  await (await textFileModel(from))?.revert({ soft: true });
  for (const r of list) r.dispose();
  refs.delete(from);

  let next: monaco.editor.ITextModel | null = null;
  for (let i = 0; i < holders; i++) next = await claimModel(to);
  if (next && next.getValue() !== text) next.setValue(text);
  return next;
}
