/**
 * The real disk, as a VS Code file-system provider.
 *
 * VS Code's file and text-file services (`@codingame/monaco-vscode-api`) do
 * everything through a provider. In a browser that is memory or IndexedDB;
 * here every call goes to the main process (`main/diskFs.ts`) over IPC.
 *
 * Change events come from the main process's per-file watcher, so when an
 * agent writes a file you have open, VS Code's text-file service hears about
 * it and reloads the buffer -- or, if you have unsaved edits, keeps them and
 * refuses a save that would overwrite the agent's work.
 */

import { Emitter, Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { Disposable, toDisposable, type IDisposable } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import {
  FileChangeType, FilePermission, FileSystemProviderCapabilities, FileSystemProviderErrorCode,
  FileType, createFileSystemProviderError,
  type IFileChange, type IFileDeleteOptions, type IFileOverwriteOptions,
  type IFileSystemProviderWithFileReadWriteCapability, type IFileWriteOptions, type IStat,
  type IWatchOptions,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files";

interface DiskStat {
  type: "file" | "dir" | "other";
  ctime: number;
  mtime: number;
  size: number;
  readonly: boolean;
}

const TYPE: Record<string, FileType> = {
  file: FileType.File,
  dir: FileType.Directory,
  other: FileType.Unknown,
};

const CODE: Record<string, FileSystemProviderErrorCode> = {
  ENOENT: FileSystemProviderErrorCode.FileNotFound,
  EEXIST: FileSystemProviderErrorCode.FileExists,
  EISDIR: FileSystemProviderErrorCode.FileIsADirectory,
  ENOTDIR: FileSystemProviderErrorCode.FileNotADirectory,
  EACCES: FileSystemProviderErrorCode.NoPermissions,
  EPERM: FileSystemProviderErrorCode.NoPermissions,
  EROFS: FileSystemProviderErrorCode.NoPermissions,
};

/**
 * Turn an IPC failure back into the error kind VS Code acts on.
 *
 * The main process puts the node code at the start of the message (Electron
 * drops custom error properties on the way across), so "ENOENT: ..." becomes
 * FileNotFound -- which is what makes, say, a deleted file show as deleted
 * instead of as a generic failure.
 */
export function toProviderError(e: unknown): Error {
  const message = String((e as Error)?.message ?? e);
  // Electron prefixes "Error invoking remote method '...': Error: ".
  const m = /(E[A-Z]+): /.exec(message);
  const code = (m && CODE[m[1]!]) ?? FileSystemProviderErrorCode.Unknown;
  return createFileSystemProviderError(message, code);
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toProviderError(e);
  }
}

export class DiskProvider extends Disposable implements IFileSystemProviderWithFileReadWriteCapability {
  readonly capabilities = FileSystemProviderCapabilities.FileReadWrite;
  readonly onDidChangeCapabilities: Event<void> = Event.None;

  private readonly changes = this._register(new Emitter<readonly IFileChange[]>());
  readonly onDidChangeFile: Event<readonly IFileChange[]> = this.changes.event;

  constructor() {
    super();
    const off = window.th.onDfsChanged((list) => {
      this.changes.fire(list.map((c) => ({
        resource: URI.file(c.path),
        type: c.type === "added" ? FileChangeType.ADDED
          : c.type === "deleted" ? FileChangeType.DELETED
          : FileChangeType.UPDATED,
      })));
    });
    this._register(toDisposable(off));
  }

  /**
   * Watch one file. Directories and recursive watches are not supported --
   * the tree has its own watcher (`main/watch.ts`), and a recursive watch of
   * a repository would mean thousands of descriptors for nothing.
   */
  watch(resource: URI, opts: IWatchOptions): IDisposable {
    if (opts.recursive) return Disposable.None;
    const path = resource.fsPath;
    window.th.dfsWatch(path);
    return toDisposable(() => window.th.dfsUnwatch(path));
  }

  async stat(resource: URI): Promise<IStat> {
    const st = await call(() => window.th.dfsStat(resource.fsPath) as Promise<DiskStat>);
    return {
      type: TYPE[st.type] ?? FileType.Unknown,
      ctime: st.ctime,
      mtime: st.mtime,
      size: st.size,
      permissions: st.readonly ? FilePermission.Readonly : undefined,
    };
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    return call(() => window.th.dfsRead(resource.fsPath));
  }

  async writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
    await call(() => window.th.dfsWrite(resource.fsPath, content, {
      create: opts.create, overwrite: opts.overwrite,
    }));
  }

  async readdir(resource: URI): Promise<[string, FileType][]> {
    const list = await call(() => window.th.dfsReaddir(resource.fsPath));
    return list.map(([name, type]) => [name, TYPE[type] ?? FileType.Unknown]);
  }

  async mkdir(resource: URI): Promise<void> {
    await call(() => window.th.dfsMkdir(resource.fsPath));
  }

  async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
    await call(() => window.th.dfsDelete(resource.fsPath, opts.recursive));
  }

  async rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
    await call(() => window.th.dfsRename(from.fsPath, to.fsPath, opts.overwrite));
  }
}
