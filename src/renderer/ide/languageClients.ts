/**
 * Language servers, through VS Code's own language client.
 *
 * `monaco-languageclient` is `vscode-languageclient` -- the library every VS
 * Code language extension uses -- running against VS Code's services in this
 * page. It brings the whole protocol for free: completion, hover, signature
 * help, go-to-definition (across files and into installed packages), find
 * references, rename, quick fixes, document and workspace symbols, formatting
 * and diagnostics. fove's job is only to connect it to a server: the main
 * process starts the process (`main/lsp.ts`) and relays messages over IPC.
 *
 * One client per server kind and repository root, started the first time a
 * file it serves is opened. A server that is not installed is not an error:
 * the editor keeps highlighting and says which server is missing.
 */

import * as vscode from "vscode";
import { MonacoLanguageClient } from "monaco-languageclient";
import {
  AbstractMessageReader, AbstractMessageWriter, CloseAction, ErrorAction,
  type DataCallback, type Disposable, type Message, type MessageTransports,
} from "vscode-languageclient/browser";

/** Which server kinds serve a Monaco language id. */
const KINDS_FOR_LANGUAGE: Record<string, string[]> = {
  python: ["python", "ruff"],
  typescript: ["typescript"],
  typescriptreact: ["typescript"],
  javascript: ["typescript"],
  javascriptreact: ["typescript"],
};

/** And the other way round: what each kind's client should be sent. */
const LANGUAGES_FOR_KIND: Record<string, string[]> = {
  python: ["python"],
  ruff: ["python"],
  typescript: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
};

export interface ClientStatus {
  kind: string;
  /** The server's name when it is running, e.g. "vtsls" or "ruff". */
  name?: string;
  /** Why there is no server, when there is not. */
  reason?: string;
}

/** Messages for one connection, from the main process. */
class IpcReader extends AbstractMessageReader {
  constructor(private readonly id: string) {
    super();
    const off = window.th.onLsExit((cid) => {
      if (cid !== this.id) return;
      off();
      this.fireClose();
    });
  }

  listen(callback: DataCallback): Disposable {
    const off = window.th.onLsMessage((cid, msg) => {
      if (cid === this.id) callback(msg as Message);
    });
    return { dispose: off };
  }
}

class IpcWriter extends AbstractMessageWriter {
  constructor(private readonly id: string) {
    super();
  }

  async write(msg: Message): Promise<void> {
    window.th.lsSend(this.id, msg);
  }

  end(): void {
    window.th.lsStop(this.id);
  }
}

/** Glob metacharacters in a path, escaped so the selector matches it literally. */
function globEscape(path: string): string {
  return path.replace(/[[\]{}*?!]/g, (c) => `[${c}]`);
}

/**
 * What a server asks for in `workspace/configuration`, beyond the empty
 * defaults a client with no settings would give.
 *
 * pyright's "python" section is the one that matters: without `pythonPath`
 * it has no site-packages, and every third-party import resolves to nothing
 * -- go-to-definition works on local variables and dies on `from flask
 * import ...`. vtsls is told to prefer the project's own TypeScript.
 */
async function settingsFor(kind: string, root: string, section: string | undefined): Promise<unknown> {
  if (kind === "python" && section === "python") {
    const pythonPath = await window.th.lsPythonPath(root);
    return pythonPath ? { pythonPath } : {};
  }
  if (kind === "typescript" && section === "vtsls") {
    return { autoUseWorkspaceTsdk: true };
  }
  return null;
}

let counter = 0;
const clients = new Map<string, Promise<ClientStatus>>();
/** Clients that started, for requests fove makes itself (workspace symbols). */
const running: MonacoLanguageClient[] = [];

async function start(kind: string, root: string): Promise<ClientStatus> {
  const id = `${kind}-${++counter}-${Date.now()}`;
  const r = await window.th.lsStart(id, kind, root);
  if (!r.ok) return { kind, reason: r.reason ?? "did not start" };

  const transports: MessageTransports = { reader: new IpcReader(id), writer: new IpcWriter(id) };
  const pattern = `${globEscape(root.replace(/\/$/, ""))}/**`;
  const client = new MonacoLanguageClient({
    id: `fove-${kind}`,
    name: `${r.name ?? kind}`,
    messageTransports: transports,
    clientOptions: {
      // Only files in this repository: a second repository open in another
      // tab gets its own server, which knows its own imports.
      documentSelector: LANGUAGES_FOR_KIND[kind]!.map((language) => ({ scheme: "file", language, pattern })),
      workspaceFolder: {
        index: 0,
        name: root.split("/").pop() || root,
        uri: vscode.Uri.file(root),
      },
      // A server that dies stays dead until the next window: restarting in a
      // loop would hide a broken install behind constant churn.
      errorHandler: {
        error: () => ({ action: ErrorAction.Continue }),
        closed: () => ({ action: CloseAction.DoNotRestart }),
      },
      middleware: {
        workspace: {
          configuration: async (params, token, next) => {
            const fallback = (await next(params, token)) as unknown[] | undefined;
            return Promise.all(params.items.map(async (item, i) =>
              (await settingsFor(kind, root, item.section)) ?? fallback?.[i] ?? null));
          },
        },
      },
    },
  });
  try {
    await client.start();
    running.push(client);
  } catch (e) {
    window.th.lsStop(id);
    return { kind, reason: String((e as Error)?.message ?? e) };
  }
  return { kind, name: r.name };
}

/**
 * Make sure every server for a language is running for this root.
 *
 * Idempotent and shared: the promise is stored before anything is awaited,
 * so two panes opening Python in the same moment get one pyright, not two.
 */
export function ensureClients(language: string, root: string): Promise<ClientStatus[]> {
  const kinds = KINDS_FOR_LANGUAGE[language] ?? [];
  return Promise.all(kinds.map((kind) => {
    const key = `${kind} ${root}`;
    let p = clients.get(key);
    if (!p) {
      p = start(kind, root);
      clients.set(key, p);
    }
    return p;
  }));
}

/** Whether some server answers for this language's symbols and navigation. */
export function servesLanguage(language: string): boolean {
  return language in KINDS_FOR_LANGUAGE;
}

export interface WorkspaceSymbol {
  path: string;
  /** 1-based. */
  line: number;
  name: string;
  kind: string;
  container: string;
}

/** LSP's SymbolKind, 1-based, as names. */
const KIND_NAMES = [
  "", "file", "module", "namespace", "package", "class", "method", "property", "field",
  "constructor", "enum", "interface", "function", "variable", "constant", "string",
  "number", "boolean", "array", "object", "key", "null", "enum member", "struct", "event",
  "operator", "type parameter",
];

/**
 * Symbols across the project, from every running language server -- what
 * `#` does in VS Code's quick open. Asked of each client directly with
 * `workspace/symbol`: VS Code's own command for it lives in its search
 * feature, which fove does not load. Only servers already started answer,
 * so a language whose files were never opened this session contributes
 * nothing.
 */
export async function workspaceSymbols(query: string): Promise<WorkspaceSymbol[]> {
  type Raw = {
    name: string; kind: number; containerName?: string;
    location: { uri: string; range?: { start: { line: number } } };
  };
  const answers = await Promise.all(running
    .filter((cl) => cl.initializeResult?.capabilities.workspaceSymbolProvider)
    .map((cl) => cl.sendRequest("workspace/symbol", { query }).then(
      (r) => (r ?? []) as Raw[],
      () => [] as Raw[],
    )));
  return answers.flat().map((sym) => ({
    path: vscode.Uri.parse(sym.location.uri).fsPath,
    line: (sym.location.range?.start.line ?? 0) + 1,
    name: sym.name,
    kind: KIND_NAMES[sym.kind] ?? "",
    container: sym.containerName ?? "",
  }));
}
