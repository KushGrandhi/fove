/**
 * VS Code's own services, under fove's editor.
 *
 * Monaco on its own is the text widget and little else: no idea of files on
 * disk, of a buffer being "dirty", of a save racing another writer. fove used
 * to fill those gaps by hand, and the hand-written versions lost work. These
 * are VS Code's real implementations, from `@codingame/monaco-vscode-api`:
 *
 *   - files: every read, write and watch goes through `DiskProvider`
 *   - text files: one model per file, reloaded when the disk changes and the
 *     buffer is clean; a save over a newer file is refused, never applied
 *   - working copies: backups of unsaved buffers (hot exit) and local history
 *
 * Started once per window, before the first editor is created. Everything the
 * editor needs is reached through the helpers below rather than the service
 * identifiers, so the rest of fove never imports from the library directly.
 */

import * as monaco from "monaco-editor";
import { initialize, getService, ITextFileService, ITextModelService, IFileService } from "@codingame/monaco-vscode-api";
import getFilesOverride, {
  createIndexedDBProviders, registerCustomProvider,
} from "@codingame/monaco-vscode-files-service-override";
import getModelOverride from "@codingame/monaco-vscode-model-service-override";
import getWorkingCopyOverride from "@codingame/monaco-vscode-working-copy-service-override";
import { IWorkingCopyBackupService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/workingCopy/common/workingCopyBackup.service";
import { IWorkingCopyHistoryService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/workingCopy/common/workingCopyHistory.service";
import { CancellationToken } from "@codingame/monaco-vscode-api/vscode/vs/base/common/cancellation";
import type { IReference } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import type { ITextFileEditorModel } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/textfile/common/textfiles";
import { SaveSourceRegistry } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor";

// Grammars for ~90 languages, and the four rich language services Monaco
// used to bundle. VS Code's build of Monaco leaves all of them out.
import "@codingame/monaco-vscode-standalone-languages";
import "@codingame/monaco-vscode-standalone-typescript-language-features";
import "@codingame/monaco-vscode-standalone-json-language-features";
import "@codingame/monaco-vscode-standalone-css-language-features";
import "@codingame/monaco-vscode-standalone-html-language-features";
/*
 * Relative paths, not package specifiers: Vite's `?worker` suffix does not
 * resolve through a package's `exports` map (see README, "Monaco workers").
 */
import editorWorker from "../../../node_modules/@codingame/monaco-vscode-api/workers/editor.worker.js?worker";
import tsWorker from "../../../node_modules/@codingame/monaco-vscode-standalone-typescript-language-features/languages/features/typescript/ts.worker.js?worker";
import jsonWorker from "../../../node_modules/@codingame/monaco-vscode-standalone-json-language-features/languages/features/json/json.worker.js?worker";
import cssWorker from "../../../node_modules/@codingame/monaco-vscode-standalone-css-language-features/languages/features/css/css.worker.js?worker";
import htmlWorker from "../../../node_modules/@codingame/monaco-vscode-standalone-html-language-features/languages/features/html/html.worker.js?worker";

import { DiskProvider } from "./diskProvider.js";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

/**
 * Keep an editor sized to its host.
 *
 * Monaco's `automaticLayout` measures nothing under VS Code's services here:
 * the editor stays at its 5x5 minimum and renders no lines at all. A plain
 * ResizeObserver on the host does the job, and also follows a pane being
 * dragged wider, which is the case automaticLayout existed for.
 */
export function followSize(
  editor: { layout(dim?: { width: number; height: number }): void },
  host: HTMLElement,
): { dispose(): void } {
  const observer = new ResizeObserver(() => {
    const { width, height } = host.getBoundingClientRect();
    if (width > 0 && height > 0) editor.layout({ width, height });
  });
  observer.observe(host);
  return { dispose: () => observer.disconnect() };
}

export type TextModelRef = IReference<{ textEditorModel: monaco.editor.ITextModel | null }>;

/** Why a save was refused, handed to whichever pane owns the file. */
export type SaveConflictHandler = (path: string, model: ITextFileEditorModel) => void;

let started: Promise<void> | null = null;
let failure: string | null = null;
const conflictHandlers = new Set<SaveConflictHandler>();

/**
 * Start the services. Safe to call more than once; later calls share the
 * first. Never rejects: a failure is recorded and reported by `servicesError`,
 * so the rest of the app -- terminals, agents -- still comes up.
 */
export function startServices(): Promise<void> {
  started ??= (async () => {
    try {
      // Backups and local history live in the user-data file system. In
      // memory by default; IndexedDB keeps them across a restart, which is
      // the whole point of hot exit.
      await createIndexedDBProviders();
      registerCustomProvider("file", new DiskProvider());
      await initialize({
        ...getFilesOverride(),
        ...getModelOverride(),
        ...getWorkingCopyOverride({ storage: "userData" }),
      });
      const textFiles = await getService(ITextFileService);
      /*
       * A save the file service refused. The only one fove acts on is "the
       * file changed on disk since you opened it": that model is now in
       * conflict mode, its buffer intact, and the pane decides how to merge.
       * Anything else (permissions, a vanished folder) is reported as-is.
       */
      textFiles.files.saveErrorHandler = {
        onSaveError(error, model) {
          const path = model.resource.fsPath;
          const modified = /modified since|FILE_MODIFIED_SINCE/i.test(String(error?.message))
            || (error as { fileOperationResult?: number }).fileOperationResult === 3;
          if (modified && conflictHandlers.size) {
            for (const h of conflictHandlers) h(path, model);
            return;
          }
          console.warn("[fove] save failed", path, error);
        },
      };
    } catch (e) {
      failure = String((e as Error)?.stack ?? e);
      console.error("[fove] VS Code services failed to start", e);
    }
  })();
  return started;
}

/** Why the services did not start, or null if they did. */
export function servicesError(): string | null {
  return failure;
}

export function onSaveConflict(handler: SaveConflictHandler): () => void {
  conflictHandlers.add(handler);
  return () => { conflictHandlers.delete(handler); };
}

const uriOf = (path: string) => monaco.Uri.file(path);

/**
 * A reference to a file's text model, resolved from disk -- or from its
 * backup, if fove closed with unsaved edits in it.
 *
 * Reference-counted by VS Code: every pane showing the file holds one, and
 * the model goes when the last is disposed (unless it is dirty).
 */
export async function openText(path: string): Promise<TextModelRef> {
  const models = await getService(ITextModelService);
  return models.createModelReference(uriOf(path)) as Promise<TextModelRef>;
}

/** VS Code's text-file model for a path, if one is open. */
export async function textFileModel(path: string): Promise<ITextFileEditorModel | undefined> {
  const textFiles = await getService(ITextFileService);
  return textFiles.files.get(uriOf(path));
}

/**
 * Save through the text-file service.
 *
 * Returns false when the save did not happen; a refusal because the file
 * changed on disk also reaches the `onSaveConflict` handlers. `overwrite`
 * skips that check, and is only for after a merge that already includes
 * what is on disk.
 */
export async function saveText(path: string, opts: { overwrite?: boolean } = {}): Promise<boolean> {
  const textFiles = await getService(ITextFileService);
  const saved = await textFiles.save(uriOf(path), {
    ignoreModifiedSince: opts.overwrite,
    source: fromFove,
  });
  return !!saved;
}

/** Throw away unsaved edits and read the file again. */
export async function revertText(path: string): Promise<void> {
  const textFiles = await getService(ITextFileService);
  await textFiles.revert(uriOf(path), { soft: false });
}

/** Ask for change events on one file; dispose to stop. */
export async function watchFile(path: string): Promise<{ dispose(): void }> {
  const files = await getService(IFileService);
  return files.watch(uriOf(path));
}

/** The file's text on disk right now, and its mtime. */
export async function readDisk(path: string): Promise<{ text: string; mtime: number }> {
  const files = await getService(IFileService);
  const r = await files.readFile(uriOf(path));
  return { text: r.value.toString(), mtime: r.mtime };
}

// ---- hot exit ---------------------------------------------------------------

/**
 * Back up a dirty buffer, so it survives fove quitting.
 *
 * VS Code's backup tracker does this from the workbench, which fove does not
 * run, so the editor calls it on a debounce while you type. Resolving the
 * file later finds the backup and restores it, still dirty.
 */
export async function backupText(model: ITextFileEditorModel): Promise<void> {
  const backups = await getService(IWorkingCopyBackupService);
  const snapshot = await model.backup(CancellationToken.None);
  await backups.backup(model, snapshot.content, model.textEditorModel?.getVersionId(), snapshot.meta);
}

export async function discardBackup(model: ITextFileEditorModel): Promise<void> {
  const backups = await getService(IWorkingCopyBackupService);
  await backups.discardBackup(model);
}

/** Paths with unsaved edits that survived the last quit. */
export async function backedUpPaths(): Promise<string[]> {
  const backups = await getService(IWorkingCopyBackupService);
  const ids = await backups.getBackups();
  return ids.filter((id) => id.resource.scheme === "file").map((id) => id.resource.fsPath);
}

// ---- local history ----------------------------------------------------------

const fromFove = SaveSourceRegistry.registerSource("fove.save", "Saved in fove");
const fromOutside = SaveSourceRegistry.registerSource("fove.outside", "Changed outside fove");

export interface HistoryEntry {
  id: string;
  timestamp: number;
  /** "Saved in fove", "Changed outside fove" -- an agent, a checkout, a formatter. */
  source: string;
}

/**
 * Record the file's current contents in local history.
 *
 * Called after each save, and when the disk changes under an open file, so
 * an agent's write is a point you can go back to even though fove did not
 * make it.
 */
export async function recordHistory(path: string, outside: boolean): Promise<void> {
  const history = await getService(IWorkingCopyHistoryService);
  await history.addEntry(
    { resource: uriOf(path), source: outside ? fromOutside : fromFove },
    CancellationToken.None,
  );
}

export async function historyFor(path: string): Promise<HistoryEntry[]> {
  const history = await getService(IWorkingCopyHistoryService);
  const entries = await history.getEntries(uriOf(path), CancellationToken.None);
  return entries
    .map((e) => ({
      id: e.id,
      timestamp: (e as unknown as { timestamp: number }).timestamp,
      source: SaveSourceRegistry.getSourceLabel(e.source),
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
}

/** The text a history entry recorded. */
export async function historyText(path: string, id: string): Promise<string | null> {
  const history = await getService(IWorkingCopyHistoryService);
  const files = await getService(IFileService);
  const entries = await history.getEntries(uriOf(path), CancellationToken.None);
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  return (await files.readFile(entry.location)).value.toString();
}
