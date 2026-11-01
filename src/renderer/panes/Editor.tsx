/**
 * Editor pane: Monaco -- the same editor VS Code uses -- with a file tree.
 *
 * Deliberately not a vim surface: this is click-to-place-cursor, real syntax
 * highlighting, multi-cursor, find/replace, and ⌘S to save.
 *
 * Saves carry the mtime the file had when it was opened, so an agent editing
 * the same file underneath produces a visible conflict rather than a silent
 * overwrite.
 *
 * Two things a tab can be, and they are separated deliberately:
 *
 *   - a *document* is a file, its model and its undo history. It is what gets
 *     saved, and it exists once per path no matter how many views point at it.
 *   - a *tab* is a view of one: the file itself, or the file compared against
 *     a git revision.
 *
 * Keeping those apart is what lets a diff against the working tree be
 * editable and ⌘S-able rather than a read-only picture of one -- the diff's
 * right-hand side *is* the document, not a copy.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { C } from "../ui/Chrome.js";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu.js";
import { flattenTree, ancestorsWithin } from "../../shared/tree-rows.js";
import { breadcrumb, disambiguate, relativeTo } from "../../shared/editor-tabs.js";
import { kindGlyph, symbolPathAt, type SymbolCrumb } from "../ide/symbolPath.js";
import { SCANNED_LANGUAGES, scanSymbols, type ScannedSymbol } from "../../shared/symbols.js";
import { claimModel, releaseModel, renameModel } from "../ide/models.js";
import { claimNavigation, releaseNavigation } from "../ide/navigation.js";
import { ensureClients } from "../ide/languageClients.js";
import { ensureGitSource, refreshTurns, setCompareTo, type CompareTo } from "../ide/quickDiff.js";
import {
  backedUpPaths, backupText, discardBackup, followSize, historyFor, historyText, onSaveConflict,
  readDisk, recordHistory, saveText, servicesError, textFileModel, watchFile,
  type HistoryEntry,
} from "../ide/vscode.js";
import { hasConflictMarkers, threeWay } from "../ide/merge.js";
import { keymap } from "../ui/keymap-store.js";

/*
 * Per-window bookkeeping shared by every editor pane.
 *
 * A file open in two panes gets one disk event and one save conflict, but two
 * listeners; these keep that from turning into two history entries or two
 * merges.
 */
/** The last outside change recorded in local history, per path: its mtime and text. */
const historyRecorded = new Map<string, { mtime: number; text: string }>();
/** What fove itself last wrote to each path, to tell its own saves apart. */
const lastSaved = new Map<string, string>();
/** Paths whose save conflict is being merged right now. */
const merging = new Set<string>();
/** Backups already reopened this session, so a second pane does not reopen them. */
const restored = new Set<string>();

/** A file the pane has open: its metadata. The text lives in a Monaco model. */
interface Doc {
  path: string;
  name: string;
  mtimeMs: number;
  language: string;
  readonly?: boolean;
  /** Why the file could not be read, when it could not be. */
  error?: string;
}

/** A view of a document: the file itself. */
interface FileTab {
  kind: "file";
  key: string;
  path: string;
}

/**
 * A view of a document against a git revision.
 *
 * `modRev` absent means the right-hand side is the working file -- live,
 * editable, savable. Set, it is a fixed revision and the whole tab is a
 * read-only picture of a change that already happened.
 */
interface DiffTab {
  kind: "diff";
  key: string;
  path: string;
  /** Left-hand revision. "" is the index, as `git show :path` spells it. */
  rev: string;
  revLabel: string;
  modRev?: string;
  modLabel: string;
  original: string;
  modified?: string;
  /** The file did not exist at `rev`, so this is an addition rather than a change. */
  added: boolean;
  loading: boolean;
}

type Tab = FileTab | DiffTab;

interface Entry { name: string; path: string; dir: boolean; size: number }

/** One line's last-touched-by, as `git blame --porcelain` reports it. */
interface BlameLine {
  hash: string;
  author: string;
  /** Epoch milliseconds. */
  when: number;
  line: number;
  summary: string;
}

/** One diagnostic, for the problems list. */
interface Problem {
  path: string;
  line: number;
  column: number;
  error: boolean;
  message: string;
  /** "basedpyright", "Ruff", "ts", "fove-lint"... */
  source: string;
}

/** A commit in a file's history. */
interface Commit {
  oid: string;
  short: string;
  subject: string;
  author: string;
  when: string;
}

/** How a diff tab is addressed, so asking for the same one twice reuses it. */
function diffKey(path: string, rev: string, modRev?: string): string {
  return `diff:${rev}..${modRev ?? ""}:${path}`;
}

/**
 * Resolve a file to a Monaco language id using Monaco's OWN registry.
 *
 * Monaco ships ~90 languages and each declares its extensions, filenames and
 * aliases. Asking the registry means every one of them works -- and new ones
 * arrive with a Monaco upgrade -- instead of depending on a hand-written map
 * that silently falls back to plaintext for anything not typed out by hand.
 */
/**
 * Extensions Monaco's registry does not claim.
 *
 * Rather than highlight them as plaintext, borrow the closest grammar Monaco
 * does ship. Vue SFCs are mostly HTML with script/style blocks; Haskell has no
 * bundled grammar, so F# is the nearest ML-family fit.
 */
const EXTRA_FILENAMES: Record<string, string> = {
  makefile: "makefile",
  "gnumakefile": "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  brewfile: "ruby",
  vagrantfile: "ruby",
  procfile: "yaml",
  ".gitignore": "ini",
  ".gitattributes": "ini",
  ".dockerignore": "ini",
  ".npmrc": "ini",
  ".editorconfig": "ini",
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".bash_profile": "shell",
  ".profile": "shell",
};

const EXTRA_EXTENSIONS: Record<string, string> = {
  ".vue": "html",
  ".svelte": "html",
  ".astro": "html",
  ".hs": "fsharp",
  ".lhs": "fsharp",
  ".zig": "cpp",
  ".nim": "python",
  ".v": "go",
  ".gleam": "rust",
  ".prisma": "graphql",
  ".mdx": "markdown",
  ".tfvars": "hcl",
  ".env": "ini",
  ".gitignore": "ini",
  ".jsonl": "json",
  ".ndjson": "json",
};

export function languageForPath(path: string): string {
  const file = (path.split("/").pop() ?? path).toLowerCase();
  const dot = file.lastIndexOf(".");
  const ext = dot > 0 ? file.slice(dot) : "";

  // Dotfile families: ".env", ".env.local", ".env.production" all read as ini.
  if (file.startsWith(".env")) return "ini";
  if (EXTRA_FILENAMES[file]) return EXTRA_FILENAMES[file]!;

  let extMatch: string | undefined;
  for (const lang of monaco.languages.getLanguages()) {
    // An exact filename wins over an extension: "Dockerfile", "Makefile",
    // ".bashrc" and friends carry no useful extension.
    if (lang.filenames?.some((f) => f.toLowerCase() === file)) return lang.id;
    if (lang.filenamePatterns?.some((p) =>
      new RegExp(`^${p.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(file),
    )) {
      return lang.id;
    }
    if (!extMatch && ext && lang.extensions?.some((e) => e.toLowerCase() === ext)) {
      extMatch = lang.id;
    }
  }
  return extMatch ?? EXTRA_EXTENSIONS[ext] ?? "plaintext";
}

/** Exposed so the smoke test can interrogate language resolution. */
(globalThis as unknown as { monaco: typeof monaco }).monaco = monaco;
(globalThis as unknown as { __thLanguageForPath: (p: string) => string }).__thLanguageForPath =
  (p: string) => languageForPath(p);

/** One dark theme, defined once, matching the app chrome. */
let themeReady = false;
export function ensureTheme(): void {
  if (themeReady) return;
  monaco.editor.defineTheme("th-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#0d0d11",
      "editorGutter.background": "#0d0d11",
      "editor.lineHighlightBackground": "#15151c",
      "editorLineNumber.foreground": "#3a3a44",
      "editorLineNumber.activeForeground": "#8a8a93",
      // The diff editor's own colours, which the base vs-dark theme tunes for
      // a lighter background than this one -- left as-is they wash out.
      "diffEditor.insertedTextBackground": "#1f7a3320",
      "diffEditor.removedTextBackground": "#f0505025",
      "diffEditor.insertedLineBackground": "#0e2a1680",
      "diffEditor.removedLineBackground": "#2d121480",
    },
  });

  /**
   * Breakpoint and paused-line styling.
   *
   * Injected rather than put in a stylesheet because Monaco addresses
   * decorations by class name only -- there is no inline-style path for a
   * glyph -- and this keeps the class and its appearance in one place.
   */
  const style = document.createElement("style");
  style.textContent = `
    /*
     * Monaco absolutely positions each glyph and sets its width and height
     * inline. Overriding those with !important collapsed every glyph but one
     * into the same place, so the dot is drawn with a background instead --
     * the element keeps the box Monaco gave it.
     */
    .fove-breakpoint {
      background: radial-gradient(circle at 50% 50%, #e5534b 0 4.5px, transparent 4.5px);
    }
    .fove-paused-line { background: rgba(210, 153, 34, 0.18); }


    /*
     * Inline blame. Dim enough to ignore while reading code, which is most of
     * the time -- it is answering a question you have not asked yet.
     */
    .fove-blame { color: #46464f; font-style: italic; cursor: pointer; }
    .fove-blame:hover { color: #7a7a86; text-decoration: underline; }
  `;
  document.head.appendChild(style);
  themeReady = true;
}

/**
 * Outline support for the languages Monaco does not cover.
 *
 * Registered once for the whole renderer rather than per pane: Monaco's
 * provider registry is global, and registering again for each editor pane
 * would return every symbol two or three times over.
 *
 * ⌘⇧O drives this. Monaco's own `editor.action.quickOutline` is what opens --
 * a real picker with filtering and symbol kinds -- so all that is missing for
 * a Python file is somebody to ask, which is this.
 */
let symbolsReady = false;
function ensureSymbolProviders(): void {
  if (symbolsReady) return;
  symbolsReady = true;

  const KINDS: Record<ScannedSymbol["kind"], monaco.languages.SymbolKind> = {
    class: monaco.languages.SymbolKind.Class,
    function: monaco.languages.SymbolKind.Function,
    method: monaco.languages.SymbolKind.Method,
    constant: monaco.languages.SymbolKind.Constant,
    struct: monaco.languages.SymbolKind.Struct,
    interface: monaco.languages.SymbolKind.Interface,
    enum: monaco.languages.SymbolKind.Enum,
    module: monaco.languages.SymbolKind.Module,
    trait: monaco.languages.SymbolKind.Interface,
  };

  const convert = (
    s: ScannedSymbol,
    model: monaco.editor.ITextModel,
  ): monaco.languages.DocumentSymbol => {
    const endLine = Math.min(Math.max(s.endLine, s.line), model.getLineCount());
    const full = new monaco.Range(s.line, 1, endLine, model.getLineMaxColumn(endLine));
    return {
      name: s.name,
      detail: s.detail ?? "",
      kind: KINDS[s.kind],
      tags: [],
      range: full,
      // What gets revealed on selection: the declaration, not the whole body.
      selectionRange: new monaco.Range(s.line, 1, s.line, model.getLineMaxColumn(s.line)),
      children: s.children.map((c) => convert(c, model)),
    };
  };

  for (const language of SCANNED_LANGUAGES) {
    scanners.set(language, monaco.languages.registerDocumentSymbolProvider(language, {
      displayName: "fove",
      provideDocumentSymbols(model) {
        return scanSymbols(language, model.getValue()).map((s) => convert(s, model));
      },
    }));
  }
}

/** The outline scanner per language, so a language server can replace it. */
const scanners = new Map<string, monaco.IDisposable>();

/**
 * Stand the outline scanner down for a language a server now answers.
 *
 * Both would otherwise be asked, and the symbol picker would list every
 * Python function twice: once from pyright, once from the scanner.
 */
function yieldScanner(language: string): void {
  scanners.get(language)?.dispose();
  scanners.delete(language);
}

/** Server kinds already reported missing this session. */
const toldMissing = new Set<string>();

/** Roots where `ruff server` is running, so the ruff CLI is not run as well. */
const ruffServes = new Set<string>();

/** The path a model was opened under, since Monaco models carry no path of ours. */
function pathOfModel(
  models: Map<string, monaco.editor.ITextModel>,
  model: monaco.editor.ITextModel,
): string | null {
  for (const [path, m] of models) if (m === model) return path;
  return null;
}

export function EditorPane(props: {
  cwd: string;
  initialPath?: string;
  /** Line to reveal after opening, e.g. from a diff hunk. */
  initialLine?: number;
  /**
   * Open this file as a diff instead of as a file, e.g. from the git pane.
   * `rev` is the left-hand side; the right is the working file.
   */
  initialDiff?: { path: string; rev: string; revLabel?: string };
  /** Changes per request, so opening the same path twice still acts. */
  openNonce?: number;
  /** Breakpoints to draw in the gutter, owned by the app so the debugger shares them. */
  breakpoints?: { path: string; line: number }[];
  onToggleBreakpoint?: (path: string, line: number) => void;
  /** Where execution is currently paused, highlighted like a breakpoint's target. */
  pausedAt?: { path: string; line: number } | null;
  /**
   * Report the file actually on screen, so the layout knows it.
   *
   * `initialPath` only says what the pane was *asked* to open. Opening a file
   * from the tree changes this pane's state and nothing else, so without this
   * the persisted layout keeps whatever was last requested through the palette
   * -- and popping the pane out reopens that stale file, or none at all.
   */
  onActivePathChange?: (path: string | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const diffHostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  /**
   * The toggle handler, via a ref.
   *
   * Monaco's listener is attached once on mount, so capturing the prop directly
   * would freeze the first render's copy -- the same shape the search debounce
   * and the palette opener both needed.
   */
  const onToggleBreakpointRef = useRef<(path: string, line: number) => void>(() => {});
  onToggleBreakpointRef.current = props.onToggleBreakpoint ?? (() => {});
  /** Monaco's handle for the breakpoint decorations, so they can be replaced. */
  const bpDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  /** Blame per file, and the decoration showing it on the cursor's line. */
  const blameRef = useRef<Map<string, BlameLine[]>>(new Map());
  const blameDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  /** Clicking the blame annotation opens that line's commit, as a diff tab. */
  const openBlameCommitRef = useRef<(line: number) => void>(() => {});
  /** One Monaco model per *document*, so undo history survives tab switches. */
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  /** Models for the fixed sides of a diff, keyed by tab. Disposed with the tab. */
  const sideModelsRef = useRef<Map<string, monaco.editor.ITextModel[]>>(new Map());
  /**
   * The dirty-tracking subscription on each document's model.
   *
   * Held so it can be disposed with the tab. The models themselves can
   * outlive the tab -- the language service owns the project's -- so a
   * listener added on every open would otherwise stack up one per open.
   */
  const contentSubsRef = useRef<Map<string, monaco.IDisposable>>(new Map());

  const [dir, setDir] = useState(props.cwd);
  /** The repository root, for repo-relative paths and revisions. */
  const [root, setRoot] = useState<string | null>(null);
  /**
   * Listings by directory, for the whole visible tree.
   *
   * A missing key means "not fetched yet" rather than "empty", which is what
   * lets an expand render instantly and fill in when the read lands.
   */
  const [children, setChildren] = useState<Map<string, Entry[]>>(new Map());
  /** Which directories are expanded. Paths, so it survives a re-listing. */
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [docs, setDocs] = useState<Map<string, Doc>>(new Map());
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** For the key handler, which is registered once and must see the current tab. */
  const activeKeyRef = useRef<string | null>(null);
  activeKeyRef.current = activeKey;
  /** Paths with unsaved edits. Keyed by document, since a diff tab shares one. */
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  /** The symbols enclosing the cursor, shown after the file in the breadcrumb. */
  const [symbols, setSymbols] = useState<SymbolCrumb[]>([]);
  const [treeOpen, setTreeOpen] = useState(true);
  /** Side-by-side or inline, for every diff tab in this pane. */
  const [sideBySide, setSideBySide] = useState(true);
  /*
   * Format on save, remembered across restarts.
   *
   * In localStorage rather than the persisted layout: it is a preference about
   * how you work, not about how this pane is arranged, and it should hold for
   * every editor pane in every workspace rather than travelling with one of
   * them. On by default -- it does nothing at all unless the project itself
   * ships a formatter, so the default cannot surprise anyone's repository.
   */
  const [formatOnSave, setFormatOnSave] = useState(
    () => localStorage.getItem("fove.formatOnSave") !== "off",
  );
  useEffect(() => {
    localStorage.setItem("fove.formatOnSave", formatOnSave ? "on" : "off");
  }, [formatOnSave]);
  /** What the diff editor last computed, for the +/− counts in the crumb bar. */
  const [diffStats, setDiffStats] = useState<{ added: number; removed: number } | null>(null);
  /** Inline blame on the cursor's line. Off by default -- it is a lot of ink. */
  const [blameOn, setBlameOn] = useState(
    () => localStorage.getItem("fove.blame") === "on",
  );
  useEffect(() => {
    localStorage.setItem("fove.blame", blameOn ? "on" : "off");
  }, [blameOn]);
  /** Commits that touched the active file, or null while the list is closed. */
  const [history, setHistory] = useState<Commit[] | null>(null);
  /** Local history of the active file: fove's saves and outside writes. Null while closed. */
  const [local, setLocal] = useState<HistoryEntry[] | null>(null);
  /**
   * Problems in this repository's open files, from every source: the
   * language servers (pyright, tsserver, ruff) and fove's own lint.
   */
  const [problems, setProblems] = useState<Problem[]>([]);
  const [problemsOpen, setProblemsOpen] = useState(false);
  /** What the gutter's change markers compare against. */
  const [compareTo, setCompare] = useState<CompareTo>("head");
  /** What the language service was given, for the breadcrumb bar to report. */
  /** Right-click menu position and the entry it was opened on. */
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; dir: boolean } | null>(null);
  /** An inline text box in the tree: renaming an entry, or naming a new one. */
  const [editing, setEditing] = useState<
    { mode: "rename"; path: string; value: string }
    | { mode: "new-file" | "new-folder"; value: string }
    | null
  >(null);
  const [treeError, setTreeError] = useState<string | null>(null);

  /*
   * Mirrors of state for the callbacks that need to *read* it.
   *
   * Assigned during render rather than in an effect, so a callback created in
   * the same render already sees the current value. The alternative -- listing
   * `docs` and `tabs` as dependencies of every callback -- rebuilds them on
   * each keystroke and re-fires the effects that depend on them.
   */
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const historyRef = useRef(history);
  historyRef.current = history;
  const rootRef = useRef(root);
  rootRef.current = root;

  const active = tabs.find((t) => t.key === activeKey) ?? null;
  const activeDoc = active ? docs.get(active.path) ?? null : null;
  const activeDirty = active ? dirty.has(active.path) : false;
  /** A diff against a fixed revision is history: there is nothing to save. */
  const activeEditable = !!active && (active.kind === "file" || !active.modRev);

  /*
   * Tell the app which file is on screen.
   *
   * Held in a ref rather than listed as a dependency: the callback is a fresh
   * closure on every parent render, so depending on it directly would fire
   * this effect continuously instead of only when the file actually changes.
   */
  const onActivePathChangeRef = useRef(props.onActivePathChange);
  onActivePathChangeRef.current = props.onActivePathChange;
  useEffect(() => {
    onActivePathChangeRef.current?.(active?.path ?? null);
  }, [active?.path]);

  // ---- file tree ----------------------------------------------------------

  /** Fetch one directory's listing into the cache, replacing any previous. */
  const loadDir = useCallback(async (d: string) => {
    const entries = (await window.th.fileList(d)) as Entry[];
    setChildren((prev) => new Map(prev).set(d, entries));
    return entries;
  }, []);

  /**
   * Re-read every directory currently on screen.
   *
   * The watcher and every mutating action land here. Refreshing only the root
   * would leave an expanded subdirectory showing a file that has since been
   * renamed or deleted, and the editor's mtime guard would then reject the
   * next save with a conflict the user cannot see the cause of.
   */
  const refresh = useCallback(async () => {
    const dirs = [dir, ...open];
    const listings = await Promise.all(
      dirs.map(async (d) => [d, (await window.th.fileList(d)) as Entry[]] as const),
    );
    setChildren((prev) => {
      const next = new Map(prev);
      for (const [d, entries] of listings) next.set(d, entries);
      return next;
    });
  }, [dir, open]);

  /** Move the tree's root, discarding expansion state that no longer applies. */
  const rootTo = useCallback(async (d: string) => {
    setDir(d);
    setOpen(new Set());
    setChildren(new Map());
    await loadDir(d);
  }, [loadDir]);

  /**
   * Expand or collapse a directory, fetching its children on first open.
   *
   * The listing is kept after a collapse: reopening a directory is the common
   * motion, and a cached listing makes it instant. The watcher keeps it honest.
   */
  const toggleDir = useCallback(async (path: string) => {
    let opened = false;
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else { next.add(path); opened = true; }
      return next;
    });
    if (opened && !children.has(path)) await loadDir(path);
  }, [children, loadDir]);

  useEffect(() => { void rootTo(props.cwd); }, [props.cwd, rootTo]);

  /** The repository this pane is looking at, or null outside one. */
  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await window.th.gitRoot(props.cwd);
      if (live) setRoot(r);
    })();
    return () => { live = false; };
  }, [props.cwd]);

  /**
   * Reveal the active file: expand every directory between the root and it.
   *
   * Without this the tree keeps showing wherever it was last navigated, so a
   * file opened from the palette, a diff hunk or a search hit appears in the
   * editor with no indication of where in the project it came from.
   *
   * A file outside the root is left alone rather than re-rooting the tree --
   * `ancestorsWithin` returns nothing for it. Opening something from another
   * worktree should not silently relocate the sidebar.
   */
  const activePath = active?.path ?? null;
  useEffect(() => {
    if (!activePath) return;
    const chain = ancestorsWithin(dir, activePath);
    if (chain.length === 0) return;

    setOpen((prev) => {
      // Only grow the set: collapsing what the user opened by hand would
      // undo their navigation every time a file opens.
      if (chain.every((d) => prev.has(d))) return prev;
      const next = new Set(prev);
      for (const d of chain) next.add(d);
      return next;
    });
    // Fetch whatever the newly-opened directories have not loaded. Awaiting
    // in sequence would stall the reveal on the deepest level.
    void Promise.all(chain.filter((d) => !children.has(d)).map(loadDir));
  }, [activePath, dir, children, loadDir]);

  // ---- documents ----------------------------------------------------------

  /**
   * Make sure a path has a document and a model, reading it if it has not been.
   *
   * Idempotent, because both opening a file tab and opening a diff against the
   * working tree need the same document, and the diff must not get a second
   * model with its own undo stack.
   */
  /**
   * What the file was when the buffer last matched the disk, per path.
   *
   * The common ancestor for a three-way merge when a save is refused: your
   * buffer is one side, the disk the other, and this is where both started.
   */
  const baseRef = useRef<Map<string, string>>(new Map());
  /** Paths merged with conflict blocks, and the disk mtime they were merged against. */
  const pendingMergeRef = useRef<Map<string, number>>(new Map());
  /** Set by the conflict handler, so the save that triggered it does not also report a failure. */
  const conflictSeenRef = useRef(false);

  const setDirtyFor = useCallback((path: string, isDirty: boolean) => {
    setDirty((prev) => {
      if (prev.has(path) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(path); else next.delete(path);
      return next;
    });
  }, []);

  /**
   * Follow one open file: dirty state, backups, disk changes, local history.
   *
   * Dirty comes from VS Code's text-file model, not from "has it changed
   * since open" -- so undoing back to the saved text clears the dot, and a
   * buffer restored from a backup opens dirty. Returns one disposable for all
   * of it.
   */
  const trackDocument = useCallback(async (
    path: string,
    model: monaco.editor.ITextModel,
  ): Promise<monaco.IDisposable> => {
    const subs: { dispose(): void }[] = [];
    const file = await textFileModel(path);
    const isDirty = () => file?.isDirty() ?? false;

    setDirtyFor(path, isDirty());
    // A buffer restored dirty from a backup did not come from the disk, so
    // its base is whatever the disk holds now.
    baseRef.current.set(path, isDirty() ? (await readDisk(path).catch(() => null))?.text ?? "" : model.getValue());

    if (file) {
      subs.push(file.onDidChangeDirty(() => {
        setDirtyFor(path, file.isDirty());
        if (!file.isDirty()) {
          baseRef.current.set(path, model.getValue());
          void discardBackup(file);
        }
      }));
    }

    /*
     * A content change on a clean buffer is VS Code reloading it from disk:
     * that is the new base. On a dirty buffer it is typing, and the buffer is
     * backed up a second after you stop, so a quit or a crash keeps it.
     */
    let backupTimer: ReturnType<typeof setTimeout> | undefined;
    subs.push(model.onDidChangeContent(() => {
      if (!isDirty()) {
        baseRef.current.set(path, model.getValue());
        return;
      }
      clearTimeout(backupTimer);
      backupTimer = setTimeout(() => { if (file && file.isDirty()) void backupText(file); }, 1000);
    }));
    subs.push({ dispose: () => clearTimeout(backupTimer) });

    // VS Code's workbench watches the workspace; fove watches each open file.
    subs.push(await watchFile(path));

    /*
     * An outside write -- an agent, a checkout, a formatter -- goes into
     * local history, so it is a point you can return to even though fove did
     * not make it. fove's own saves are recorded by `save` instead.
     */
    subs.push({
      dispose: window.th.onDfsChanged((changes) => {
        if (!changes.some((c) => c.path === path && c.type !== "deleted")) return;
        void (async () => {
          const disk = await readDisk(path).catch(() => null);
          if (!disk || disk.text === lastSaved.get(path)) return;
          // Same write seen twice, or rewritten with the same text: one entry.
          const prev = historyRecorded.get(path);
          if (prev && (prev.mtime === disk.mtime || prev.text === disk.text)) return;
          historyRecorded.set(path, { mtime: disk.mtime, text: disk.text });
          await recordHistory(path, true).catch(() => {});
        })();
      }),
    });

    return { dispose: () => { for (const s of subs) s.dispose(); } };
  }, [setDirtyFor]);

  /**
   * Make sure a path has a document and a model, reading it if it has not been.
   *
   * Idempotent, because both opening a file tab and opening a diff against the
   * working tree need the same document, and the diff must not get a second
   * model with its own undo stack.
   */
  const ensureDoc = useCallback(async (path: string): Promise<Doc> => {
    const known = docsRef.current.get(path);
    if (known) return known;

    // Main's read is still the gate for what should not open as text at all:
    // binaries, directories, files too large to hold in a buffer.
    const r = (await window.th.fileRead(path)) as {
      content?: string; mtimeMs?: number; readonly?: boolean; error?: string;
    };
    // Monaco's registry is authoritative; main's map is only a hint.
    const language = languageForPath(path);
    const broken = servicesError();
    const doc: Doc = {
      path,
      name: path.split("/").pop() ?? path,
      mtimeMs: r.mtimeMs ?? 0,
      language,
      readonly: r.readonly,
      error: r.error ?? (broken ? "the editor's file services did not start (see the console)" : undefined),
    };

    if (!doc.error && !modelsRef.current.has(path)) {
      try {
        /*
         * One model per path, from VS Code's text-model service, shared with
         * every other pane showing the file. That is what makes an edit in
         * one pane appear in the other, and navigation and editing agree.
         */
        const model = await claimModel(path);
        if (language !== "plaintext" && model.getLanguageId() !== language) {
          monaco.editor.setModelLanguage(model, language);
        }
        if (modelsRef.current.has(path)) {
          // Two callers raced into the same file; the first model wins.
          releaseModel(path);
        } else {
          modelsRef.current.set(path, model);
          contentSubsRef.current.get(path)?.dispose();
          contentSubsRef.current.set(path, await trackDocument(path, model));
        }
      } catch (e) {
        doc.error = String((e as Error)?.message ?? e);
      }
    }
    docsRef.current = new Map(docsRef.current).set(path, doc);
    setDocs(docsRef.current);
    return doc;
  }, [trackDocument]);

  /** Add a tab if it is not already there, and show it either way. */
  const showTab = useCallback((tab: Tab) => {
    setTabs((prev) => (prev.some((t) => t.key === tab.key) ? prev : [...prev, tab]));
    setActiveKey(tab.key);
  }, []);

  const openFile = useCallback(async (path: string) => {
    const doc = await ensureDoc(path);
    showTab({ kind: "file", key: path, path });
    if (doc.error) setNotice(`${doc.name}: ${doc.error}`);
  }, [ensureDoc, showTab]);

  /**
   * Open a file as a diff against a revision.
   *
   * The right-hand side is the working file unless `modRev` names one, so the
   * common case -- reviewing what an agent just did -- is an editable diff you
   * can fix in place and save, not a picture you have to leave to act on.
   *
   * A file that did not exist at `rev` gets an empty original rather than an
   * error: that is what an addition *is*, and git's own diff renders it the
   * same way.
   */
  const openDiff = useCallback(async (
    path: string,
    rev: string,
    opts: { revLabel?: string; modRev?: string; modLabel?: string } = {},
  ) => {
    const key = diffKey(path, rev, opts.modRev);
    const revLabel = opts.revLabel ?? (rev === "" ? "index" : rev);
    const modLabel = opts.modLabel ?? (opts.modRev ? opts.modRev : "working tree");

    // Show the tab before the reads land, so the click feels immediate.
    showTab({
      kind: "diff", key, path, rev, revLabel,
      modRev: opts.modRev, modLabel,
      original: "", added: false, loading: true,
    });

    const rel = root ? relativeTo(root, path) : null;
    if (!rel || !root) {
      setTabs((prev) => prev.map((t) =>
        t.key === key && t.kind === "diff"
          ? { ...t, loading: false, original: "", added: true }
          : t));
      setNotice("not in this repository — showing the file as new");
      return;
    }

    // The working-tree side is a document; a fixed side is just text.
    const [original, modified] = await Promise.all([
      window.th.gitFileAt(root, rev, rel),
      opts.modRev !== undefined
        ? window.th.gitFileAt(root, opts.modRev, rel)
        : Promise.resolve(null),
    ]);
    if (opts.modRev === undefined) await ensureDoc(path);

    setTabs((prev) => prev.map((t) =>
      t.key === key && t.kind === "diff"
        ? {
            ...t,
            loading: false,
            original: original ?? "",
            added: original === null,
            modified: opts.modRev !== undefined ? modified ?? "" : undefined,
          }
        : t));
  }, [root, showTab, ensureDoc]);

  /**
   * Act on an open request from the app: a file, or a diff.
   *
   * Gated on the *nonce* rather than on the path, and that is not a detail.
   * This pane reports the file it is showing back into the layout, so that a
   * popped-out window reopens what you were looking at -- which means the
   * pane's own props change as a result of what it displays. Keying off the
   * path, a request that opened a *diff* tab came straight back as a request
   * to open that same path as a plain file, on top of the diff that was just
   * asked for. The nonce is the only thing here that means "this is new".
   *
   * A mount with no nonce still acts, which is what restores a persisted
   * file when the workspace reloads.
   */
  const handledNonce = useRef<number | null>(null);
  useEffect(() => {
    const nonce = props.openNonce ?? 0;
    if (handledNonce.current === nonce) return;

    const diff = props.initialDiff;
    if (diff) {
      // The revision read is repo-relative, so a request arriving before the
      // repository is known waits for it rather than failing.
      if (!root) return;
      handledNonce.current = nonce;
      void openDiff(diff.path, diff.rev, { revLabel: diff.revLabel });
      return;
    }

    if (!props.initialPath) return;
    handledNonce.current = nonce;
    void (async () => {
      await openFile(props.initialPath!);
      const line = props.initialLine;
      if (!line) return;
      // The model is swapped in an effect, so reveal after it has landed.
      requestAnimationFrame(() => {
        const ed = editorRef.current;
        if (!ed) return;
        ed.revealLineInCenter(line);
        ed.setPosition({ lineNumber: line, column: 1 });
        ed.focus();
      });
    })();
  }, [
    props.initialPath, props.initialLine, props.initialDiff, props.openNonce,
    root, openFile, openDiff,
  ]);

  /**
   * Diagnostics for the active file.
   *
   * Monaco checks TypeScript and JavaScript itself, but has no Python language
   * service at all -- a .py file looked clean no matter what was in it. ruff
   * fills that gap: fast enough to run on every save, and precise enough to
   * mark an exact range.
   */
  const lint = useCallback(async (path: string) => {
    const model = modelsRef.current.get(path);
    if (!model) return;
    // `ruff server` already publishes these, live; running the CLI as well
    // would show every finding twice.
    if (ruffServes.has(rootRef.current ?? props.cwd)) return;
    const diags = (await window.th.lintCheck(path, props.cwd)) as {
      line: number; column: number; endLine: number; endColumn: number;
      message: string; code?: string; severity: "error" | "warning" | "info";
    }[];
    // The model may have been closed while ruff ran -- or `ruff server` may
    // have come up meanwhile and now owns these findings.
    if (model.isDisposed() || ruffServes.has(rootRef.current ?? props.cwd)) return;
    monaco.editor.setModelMarkers(
      model,
      "fove-lint",
      diags.map((d) => ({
        startLineNumber: d.line,
        startColumn: d.column,
        endLineNumber: d.endLine,
        endColumn: d.endColumn,
        message: d.code ? `${d.message} (${d.code})` : d.message,
        severity:
          d.severity === "error"
            ? monaco.MarkerSeverity.Error
            : d.severity === "warning"
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
      })),
    );
  }, [props.cwd]);

  // Check on open and after every save.
  useEffect(() => {
    if (activePath) void lint(activePath);
  }, [activePath, lint]);

  /**
   * Format the buffer in place, before it is written.
   *
   * Applied as a Monaco edit rather than by replacing the model's value: an
   * edit keeps one undo step (⌘Z after a save undoes the formatting, not your
   * work) and lets the cursor be put back where it was. Replacing the value
   * outright resets both, which is how format-on-save earns its reputation.
   *
   * A formatter that fails says so and changes nothing -- a syntax error is
   * the common case, and the save must still happen.
   */
  const formatBuffer = useCallback(async (
    path: string,
    model: monaco.editor.ITextModel,
  ): Promise<void> => {
    const r = await window.th.formatRun(path, model.getValue(), props.cwd);
    if (r.error) { setNotice(`${r.by}: ${r.error}`); return; }
    if (r.content === null || model.isDisposed() || r.content === model.getValue()) return;

    const ed = editorRef.current;
    const position = ed?.getPosition() ?? null;
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: r.content }],
      () => null,
    );
    // The formatted text may be shorter than where the cursor was sitting.
    if (position && ed && ed.getModel() === model) {
      const lineNumber = Math.min(position.lineNumber, model.getLineCount());
      ed.setPosition({
        lineNumber,
        column: Math.min(position.column, model.getLineMaxColumn(lineNumber)),
      });
    }
  }, [props.cwd]);

  // ---- language service ---------------------------------------------------

  useEffect(() => {
    const where = root ?? props.cwd;
    const prefix = where.endsWith("/") ? where : `${where}/`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const collect = () => {
      const S = monaco.MarkerSeverity;
      setProblems(monaco.editor.getModelMarkers({})
        .filter((m) => m.resource.scheme === "file" && m.resource.fsPath.startsWith(prefix)
          && (m.severity === S.Error || m.severity === S.Warning))
        .map((m) => ({
          path: m.resource.fsPath,
          line: m.startLineNumber,
          column: m.startColumn,
          error: m.severity === S.Error,
          message: m.message.split("\n")[0] ?? m.message,
          source: m.source ?? m.owner,
        }))
        .sort((a, b) => Number(b.error) - Number(a.error)
          || a.path.localeCompare(b.path) || a.line - b.line));
    };
    collect();
    // Servers publish in bursts as they analyse; one recount per burst.
    const sub = monaco.editor.onDidChangeMarkers(() => {
      clearTimeout(timer);
      timer = setTimeout(collect, 200);
    });
    return () => { sub.dispose(); clearTimeout(timer); };
  }, [root, props.cwd]);

  /*
   * VS Code's change markers for this repository, measured against HEAD.
   * HEAD moves when anyone commits or checks out -- an agent included -- so
   * the originals are re-read when fove regains focus and every 15 seconds.
   */
  useEffect(() => {
    if (!root || servicesError()) return;
    ensureGitSource(root);
    // A turn in progress keeps adding files, so its originals are re-read too.
    const refresh = () => void refreshTurns();
    const t = setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    return () => { clearInterval(t); window.removeEventListener("focus", refresh); };
  }, [root]);

  /**
   * Flip the gutter between "what changed since HEAD" and "what Claude's last
   * turn changed". In turn mode each marker is one of the turn's hunks, and
   * clicking it opens VS Code's inline diff with revert -- reviewing the turn
   * hunk by hunk, in the file, without leaving it.
   */
  const toggleCompare = useCallback(async () => {
    if (!root) return;
    const next: CompareTo = compareTo === "head" ? "turn" : "head";
    const info = await setCompareTo(root, next);
    if (next === "turn" && !info) {
      await setCompareTo(root, "head");
      setNotice("no Claude turn has edited files in this repository yet");
      return;
    }
    setCompare(next);
    setNotice(next === "turn"
      ? `markers: what Claude's last turn changed (${info!.files} file${info!.files === 1 ? "" : "s"}) — click one to review or revert it`
      : "markers: changes since HEAD");
    setTimeout(() => setNotice(null), 3200);
  }, [root, compareTo]);

  /**
   * Language servers for whatever was just opened.
   *
   * Driven by the file you open rather than started up front: pyright and
   * tsserver index the whole project on start, and a session that never
   * opens a `.py` file should never pay for that. Keyed on the repository
   * root, so a pane opened on `src/` shares the server of one opened on the
   * root.
   */
  useEffect(() => {
    const where = root ?? props.cwd;
    const language = activeDoc?.language;
    if (!where || !language) return;
    void ensureClients(language, where).then((statuses) => {
      const running = statuses.filter((st) => st.name);
      if (statuses.some((st) => st.kind === "python" && st.name)) yieldScanner("python");
      if (statuses.some((st) => st.kind === "ruff" && st.name) && !ruffServes.has(where)) {
        ruffServes.add(where);
        // The CLI may already have run on a file opened before the server
        // was up; its findings would now sit beside the server's own.
        const prefix = where.endsWith("/") ? where : `${where}/`;
        for (const m of monaco.editor.getModels()) {
          if (m.uri.scheme === "file" && m.uri.fsPath.startsWith(prefix)) {
            monaco.editor.setModelMarkers(m, "fove-lint", []);
          }
        }
      }
      // A missing server is said once per session, not on every file opened.
      const missing = statuses.filter((st) => !st.name && !toldMissing.has(st.kind)).map((st) => st.kind);
      for (const kind of missing) toldMissing.add(kind);
      if (running.length === 0 && missing.length === 0) return;
      const text = [running.length ? `${language}: ${running.map((st) => st.name).join(" + ")}` : "",
        missing.length ? `no ${missing.join(", ")} server (Setup Check)` : ""]
        .filter(Boolean).join(" · ");
      // Background information: it never pushes out a notice already up,
      // such as "restored unsaved edits".
      setNotice((prev) => prev ?? text);
      setTimeout(() => setNotice((prev) => (prev === text ? null : prev)), 2600);
    });
  }, [root, props.cwd, activeDoc?.language]);

  /**
   * Go-to-definition lands here.
   *
   * Monaco has no workspace of its own, so a definition in another file is a
   * request it hands back for somebody to fulfil. This pane fulfils it when
   * it is the one with the focus -- see `claimNavigation`.
   */
  const navigateTo = useCallback(async (path: string, line: number, column: number) => {
    await openFile(path);
    // The model is swapped in by an effect; wait for it to land.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const ed = editorRef.current;
    if (!ed) return undefined;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column });
    ed.focus();
    return ed;
  }, [openFile]);

  /*
   * Claim navigation on mount, and again whenever focus enters this pane.
   *
   * Not tied to the Monaco instance: this effect runs before the one that
   * creates the editor, and waiting for `editorRef` here meant the claim was
   * skipped on mount and never retried -- so no pane ever held it, and every
   * jump to another file went nowhere. Focus is watched on the pane's own
   * DOM, which exists from the first render.
   */
  useEffect(() => {
    claimNavigation(navigateTo);
    const host = hostRef.current;
    const claim = () => claimNavigation(navigateTo);
    host?.addEventListener("focusin", claim);
    return () => {
      host?.removeEventListener("focusin", claim);
      releaseNavigation(navigateTo);
    };
  }, [navigateTo]);

  // ---- blame --------------------------------------------------------------

  /**
   * Who last touched the cursor's line, written at the end of it.
   *
   * Only the cursor's line, not every line: blaming the whole file turns the
   * right-hand half of the editor into a second column of text you have to
   * read past to read the code. One line follows where you are looking.
   *
   * Blame is indexed by the line numbers of the *committed* file, so once the
   * buffer is edited the mapping drifts. Rather than show a confident wrong
   * name, editing hides the annotation until the next save re-blames.
   */
  const paintBlame = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (!blameDecorationsRef.current) {
      blameDecorationsRef.current = ed.createDecorationsCollection();
    }
    const model = ed.getModel();
    const path = model ? pathOfModel(modelsRef.current, model) : null;
    const lines = path ? blameRef.current.get(path) : undefined;
    const position = ed.getPosition();
    const stale = path ? dirtyRef.current.has(path) : true;

    if (!blameOn || !lines || !position || stale) {
      blameDecorationsRef.current.clear();
      return;
    }
    const hit = lines[position.lineNumber - 1];
    // A line added since the last commit has no blame entry, which is itself
    // the answer -- nothing is written rather than the neighbour's name.
    if (!hit || hit.line !== position.lineNumber) {
      blameDecorationsRef.current.clear();
      return;
    }

    const uncommitted = /^0+$/.test(hit.hash);
    const label = uncommitted
      ? "uncommitted"
      : `${hit.author} · ${ago(hit.when)} · ${hit.summary}`;
    const end = model!.getLineMaxColumn(position.lineNumber);
    /*
     * Anchored at the end of the line, where the annotation is drawn, so the
     * hover card appears over the annotation rather than over the code. The
     * card is what VS Code's blame shows: the whole subject, who, when
     * exactly, which commit -- and clicking the annotation opens the commit.
     */
    const hover = uncommitted
      ? "**Not committed yet**"
      : [
          `**${hit.summary.replace(/[\\`*_[\]]/g, "\\$&")}**`,
          `${hit.author} · ${new Date(hit.when).toLocaleString()} · \`${hit.hash.slice(0, 8)}\``,
          "_Click the annotation to open this commit's change to the file._",
        ].join("\n\n");
    blameDecorationsRef.current.set([{
      range: new monaco.Range(position.lineNumber, end, position.lineNumber, end),
      options: {
        after: { content: `    ${label}`, inlineClassName: "fove-blame" },
        hoverMessage: { value: hover },
        // An empty range draws nothing unless told to.
        showIfCollapsed: true,
      },
    }]);
  }, [blameOn]);

  const paintBlameRef = useRef(paintBlame);
  paintBlameRef.current = paintBlame;


  /**
   * Blame the active file, once it is asked for.
   *
   * `git blame` walks the whole history of a file, so it is not something to
   * run on every open -- only when the annotation is actually switched on.
   */
  const loadBlame = useCallback(async (path: string) => {
    if (!root) return;
    const rel = relativeTo(root, path);
    if (!rel) return;
    const lines = (await window.th.gitBlame(root, rel)) as BlameLine[];
    blameRef.current.set(path, lines);
    paintBlameRef.current();
  }, [root]);

  useEffect(() => {
    if (!blameOn || !activePath) { paintBlame(); return; }
    void loadBlame(activePath);
  }, [blameOn, activePath, loadBlame, paintBlame]);

  // ---- history ------------------------------------------------------------

  /**
   * The active file's past: local history first, then the commits.
   *
   * Local history is every save in fove and every outside write -- an
   * agent's edit is in there even though it was never committed. It works
   * outside a repository too, where there are no commits to show.
   */
  const openHistory = useCallback(async () => {
    const path = tabsRef.current.find((t) => t.key === activeKey)?.path;
    if (!path) return;
    setHistory([]);
    setLocal([]);
    void historyFor(path).then(setLocal, () => setLocal([]));
    const rel = root ? relativeTo(root, path) : null;
    if (!root || !rel) return;
    setHistory((await window.th.gitFileLog(root, rel, 100)) as Commit[]);
  }, [activeKey, root]);

  const closeHistory = useCallback(() => { setHistory(null); setLocal(null); }, []);

  /** A local history entry against the buffer, as an editable diff tab. */
  const openLocalDiff = useCallback(async (path: string, entry: HistoryEntry) => {
    closeHistory();
    const text = await historyText(path, entry.id);
    if (text === null) { setNotice("that history entry is gone"); return; }
    await ensureDoc(path);
    const rev = `local:${entry.id}`;
    showTab({
      kind: "diff", key: diffKey(path, rev), path, rev,
      revLabel: `${entry.source.toLowerCase()}, ${agoExact(entry.timestamp)}`,
      modLabel: "working tree", original: text, added: false, loading: false,
    });
  }, [closeHistory, ensureDoc, showTab]);

  /**
   * Put a local history entry back in the buffer.
   *
   * One undoable edit, and not saved: the buffer goes dirty with it, so you
   * can look before you keep it, and ⌘Z takes it back out.
   */
  const restoreLocal = useCallback(async (path: string, entry: HistoryEntry) => {
    closeHistory();
    const text = await historyText(path, entry.id);
    const model = modelsRef.current.get(path);
    if (text === null || !model) { setNotice("that history entry is gone"); return; }
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    setNotice(`restored the version from ${agoExact(entry.timestamp)}; save to keep it`);
  }, [closeHistory]);

  /**
   * Open one commit's own change to this file, as a diff tab.
   *
   * `<sha>^` against `<sha>` -- the same pair `git show` uses. A root commit
   * has no parent, so the left side reads as absent and the diff renders as
   * the addition it was. A commit from before a rename is the one case this
   * gets wrong: `--follow` finds it, but the path it knew the file by was a
   * different one, and the left side comes back empty.
   */
  const openCommitDiff = useCallback((path: string, c: Commit) => {
    setHistory(null);
    void openDiff(path, `${c.oid}^`, {
      revLabel: `${c.short}^`,
      modRev: c.oid,
      modLabel: c.short,
    });
  }, [openDiff]);

  openBlameCommitRef.current = (line: number) => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    const path = model ? pathOfModel(modelsRef.current, model) : null;
    const hit = path ? blameRef.current.get(path)?.[line - 1] : undefined;
    if (!path || !hit || /^0+$/.test(hit.hash)) return;
    openCommitDiff(path, {
      oid: hit.hash, short: hit.hash.slice(0, 8), subject: hit.summary,
      author: hit.author, when: ago(hit.when),
    });
  };

  /** After any successful save: the bookkeeping, and the follow-up checks. */
  const afterSave = useCallback((path: string, text: string) => {
    lastSaved.set(path, text);
    baseRef.current.set(path, text);
    pendingMergeRef.current.delete(path);
    void recordHistory(path, false).catch(() => {});
    // Re-check after a save: the diagnostics the user just fixed should go.
    void lint(path);
    // Blame was suppressed while the buffer was dirty and now has a clean
    // file to index against again.
    if (blameOn) void loadBlame(path);
  }, [lint, blameOn, loadBlame]);

  /**
   * Merge an outside change into a buffer whose save was refused.
   *
   * VS Code refused the save because the file changed on disk since the
   * buffer last matched it -- an agent wrote to it, usually. Your edits and
   * the disk's are combined against the text both started from. Edits to
   * different lines merge and save on their own; edits to the same lines
   * become conflict blocks in the buffer, and the save waits until you have
   * picked a side in each. Neither side is ever dropped.
   */
  const mergeOutside = useCallback(async (path: string) => {
    const model = modelsRef.current.get(path);
    if (!model) return;
    const name = path.split("/").pop() ?? path;
    const disk = await readDisk(path);
    const mine = model.getValue();
    const base = baseRef.current.get(path) ?? disk.text;
    const merged = threeWay(base, mine, disk.text);
    baseRef.current.set(path, disk.text);
    if (merged.text !== mine) {
      // One undoable edit, so ⌘Z takes the merge back out.
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: merged.text }], () => null);
    }
    if (merged.conflicts === 0) {
      const ok = await saveText(path, { overwrite: true });
      if (ok) afterSave(path, merged.text);
      setNotice(ok
        ? `${name} changed on disk; merged with your edits and saved`
        : `${name}: merged with the change on disk, but the save failed`);
      return;
    }
    pendingMergeRef.current.set(path, disk.mtime);
    setNotice(`${name} changed on disk: ${merged.conflicts} conflict${merged.conflicts === 1 ? "" : "s"} `
      + "with your edits. Keep one side of each <<<<<<< block, then save.");
  }, [afterSave]);

  useEffect(() => onSaveConflict((path) => {
    if (!modelsRef.current.has(path) || merging.has(path)) return;
    conflictSeenRef.current = true;
    merging.add(path);
    void mergeOutside(path)
      .catch((e) => setNotice(`couldn't merge: ${String((e as Error)?.message ?? e)}`))
      .finally(() => merging.delete(path));
  }), [mergeOutside]);

  const save = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.key === activeKey);
    // A diff against a fixed revision has no working file behind it.
    if (!tab || (tab.kind === "diff" && tab.modRev !== undefined)) return;
    const doc = docsRef.current.get(tab.path);
    const model = modelsRef.current.get(tab.path);
    if (!doc || !model || doc.readonly) return;

    const pending = pendingMergeRef.current.get(doc.path);
    if (pending !== undefined && hasConflictMarkers(model.getValue())) {
      setNotice(`${doc.name}: keep one side of each <<<<<<< block before saving`);
      return;
    }

    if (formatOnSave) await formatBuffer(doc.path, model);

    /*
     * After a conflicted merge the buffer already holds what was on disk, so
     * the save may go over it -- unless the disk moved again since, in which
     * case the save is refused and merged again like any other.
     */
    let overwrite = false;
    if (pending !== undefined) {
      const disk = await readDisk(doc.path).catch(() => null);
      overwrite = disk?.mtime === pending;
    }

    conflictSeenRef.current = false;
    const text = model.getValue();
    const ok = await saveText(doc.path, { overwrite });
    if (ok) {
      afterSave(doc.path, text);
      setNotice(`saved ${doc.name}`);
      setTimeout(() => setNotice(null), 1600);
    } else if (!conflictSeenRef.current) {
      setNotice(`couldn't save ${doc.name}`);
    }
  }, [activeKey, formatOnSave, formatBuffer, afterSave]);

  /*
   * Reopen files that had unsaved edits when fove last quit.
   *
   * VS Code backed them up as you typed; resolving the file finds the backup
   * and restores it, still unsaved. Each pane takes the ones under its own
   * folder, once per session.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (servicesError()) return;
      const prefix = props.cwd.endsWith("/") ? props.cwd : `${props.cwd}/`;
      const mine = (await backedUpPaths().catch(() => [] as string[]))
        .filter((p) => p.startsWith(prefix) && !restored.has(p));
      if (cancelled || mine.length === 0) return;
      for (const p of mine) restored.add(p);
      for (const p of mine) await openFile(p);
      setNotice(`restored unsaved edits in ${mine.length} file${mine.length === 1 ? "" : "s"}`);
    })();
    return () => { cancelled = true; };
    // Once per pane: the folder a pane opens on does not change under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Close a tab, and the document behind it once no tab still points at it.
   *
   * Disposing the model with the tab would throw away undo history that a
   * second view of the same file is still using -- close the diff, and the
   * file tab beside it would lose everything you had typed.
   */
  const closeTab = useCallback((key: string) => {
    for (const m of sideModelsRef.current.get(key) ?? []) m.dispose();
    sideModelsRef.current.delete(key);

    setTabs((prev) => {
      const closed = prev.find((t) => t.key === key);
      const rest = prev.filter((t) => t.key !== key);
      if (closed && !rest.some((t) => t.path === closed.path)) {
        const model = modelsRef.current.get(closed.path);
        contentSubsRef.current.get(closed.path)?.dispose();
        contentSubsRef.current.delete(closed.path);
        // Give the pane's reference back. The language client follows the
        // model on its own and tells its server the buffer closed.
        if (model) releaseModel(closed.path);
        modelsRef.current.delete(closed.path);
        docsRef.current = new Map(docsRef.current);
        docsRef.current.delete(closed.path);
        setDocs(docsRef.current);
      }
      setActiveKey((cur) => (cur === key ? rest[rest.length - 1]?.key ?? null : cur));
      return rest;
    });
  }, []);

  // ---- tree actions -------------------------------------------------------

  /** Report a failed operation beside the tree rather than swallowing it. */
  const runFs = useCallback(async (fn: () => Promise<unknown>) => {
    const r = (await fn()) as { ok: boolean; error?: string; path?: string };
    if (!r?.ok) setTreeError(r?.error ?? "operation failed");
    else setTreeError(null);
    await refresh();
    return r;
  }, [refresh]);

  /**
   * Rename, moving any open tab with the file.
   *
   * Monaco keys models by path, so without re-keying the map the editor keeps
   * writing to a path that no longer exists -- the save silently recreates the
   * old file.
   */
  const renameEntry = useCallback(async (from: string, name: string) => {
    const to = `${from.slice(0, from.lastIndexOf("/"))}/${name}`;
    const r = await runFs(() => window.th.fsRename(from, to));
    if (!r.ok) return;

    /*
     * Rebuild the buffer at the new path rather than re-keying the map.
     *
     * A model's URI cannot change, and the URI is what the language service
     * resolves imports against -- re-keying alone left a model claiming to be
     * a file that no longer exists.
     */
    const doc = docsRef.current.get(from);
    if (modelsRef.current.has(from)) {
      contentSubsRef.current.get(from)?.dispose();
      contentSubsRef.current.delete(from);
      modelsRef.current.delete(from);
      const moved = await renameModel(from, to);
      if (moved) {
        modelsRef.current.set(to, moved);
        contentSubsRef.current.set(to, await trackDocument(to, moved));
      }
    }
    if (doc) {
      docsRef.current = new Map(docsRef.current);
      docsRef.current.delete(from);
      docsRef.current.set(to, { ...doc, path: to, name });
      setDocs(docsRef.current);
    }
    setDirty((prev) => {
      if (!prev.has(from)) return prev;
      const next = new Set(prev);
      next.delete(from);
      next.add(to);
      return next;
    });
    // Anything cached under the old path is about a file that no longer
    // exists. Dropped rather than moved: both are re-read on demand, and a
    // blame indexed against the old name would be quietly wrong.
    blameRef.current.delete(from);

    // A file tab is keyed by its path, so the key moves with it; a diff tab's
    // key embeds the revision it was taken against and keeps its own shape.
    setTabs((prev) => prev.map((t) => {
      if (t.path !== from) return t;
      if (t.kind === "file") {
        setActiveKey((k) => (k === from ? to : k));
        return { ...t, key: to, path: to };
      }
      // The diff's cached side models are keyed by the tab key, which just
      // moved -- rebuild them under the new one rather than orphaning them.
      const nextKey = diffKey(to, t.rev, t.modRev);
      const sides = sideModelsRef.current.get(t.key);
      if (sides) {
        sideModelsRef.current.delete(t.key);
        sideModelsRef.current.set(nextKey, sides);
      }
      setActiveKey((k) => (k === t.key ? nextKey : k));
      return { ...t, key: nextKey, path: to };
    }));
  }, [runFs, trackDocument]);

  /** Delete to the system trash, after confirming -- the tabs go too. */
  const trashEntry = useCallback(async (path: string) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!confirm(`Move "${name}" to the Trash?`)) return;
    const r = await runFs(() => window.th.fsTrash(path));
    if (!r.ok) return;
    for (const t of tabsRef.current.filter((x) => x.path === path)) closeTab(t.key);
  }, [runFs, closeTab]);

  const copyText = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text);
  }, []);

  /** Build the menu for a tree entry. */
  const menuItems = useCallback((path: string, isDir: boolean): MenuItem[] => {
    const rel = path.startsWith(props.cwd) ? path.slice(props.cwd.length + 1) : path;
    return [
      { label: "New file…", onSelect: () => setEditing({ mode: "new-file", value: "" }) },
      { label: "New folder…", onSelect: () => setEditing({ mode: "new-folder", value: "" }) },
      {
        label: "Rename…",
        separated: true,
        onSelect: () =>
          setEditing({ mode: "rename", path, value: path.slice(path.lastIndexOf("/") + 1) }),
      },
      {
        label: "Duplicate",
        disabled: isDir,
        onSelect: () => void runFs(() => window.th.fsDuplicate(path)),
      },
      {
        label: "Diff against HEAD",
        separated: true,
        disabled: isDir || !root,
        onSelect: () => void openDiff(path, "HEAD"),
      },
      { label: "Copy path", separated: true, onSelect: () => copyText(path) },
      { label: "Copy relative path", onSelect: () => copyText(rel) },
      { label: "Reveal in Finder", onSelect: () => window.th.revealInFinder(path) },
      { label: "Open in VS Code", onSelect: () => window.th.openInEditor(path) },
      {
        label: "Move to Trash",
        separated: true,
        danger: true,
        onSelect: () => void trashEntry(path),
      },
    ];
  }, [props.cwd, runFs, copyText, trashEntry, openDiff, root]);

  /** Commit whatever the inline box is for. */
  const commitEditing = useCallback(async () => {
    if (!editing) return;
    const name = editing.value.trim();
    setEditing(null);
    if (!name) return;
    if (editing.mode === "rename") await renameEntry(editing.path, name);
    else if (editing.mode === "new-file") await runFs(() => window.th.fsCreateFile(`${dir}/${name}`));
    else await runFs(() => window.th.fsCreateDir(`${dir}/${name}`));
  }, [editing, renameEntry, runFs, dir]);

  /**
   * Keep the tree live: an agent changing a file is the normal case here, and
   * a stale list also makes the editor's mtime guard reject the next save.
   *
   * Every expanded directory is watched, not just the root -- a file created
   * three levels down is exactly the case the tree is now able to show.
   */
  useEffect(() => {
    const watched = [dir, ...open];
    window.th.fsWatch(watched);
    const off = window.th.onFsChanged((changed) => {
      if (watched.includes(changed)) void refresh();
    });
    return off;
  }, [dir, open, refresh]);

  // ---- monaco lifecycle ---------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    ensureTheme();
    ensureSymbolProviders();
    const ed = monaco.editor.create(host, {
      theme: "th-dark",
      automaticLayout: true,
      fontFamily: 'Menlo, "SF Mono", monospace',
      fontSize: 12,
      lineHeight: 18,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      tabSize: 2,
      padding: { top: 8 },
      // Required for breakpoints: without it there is no gutter to click.
      glyphMargin: true,
    });
    editorRef.current = ed;
    const sizing = followSize(ed, host);

    /**
     * Report the selection to Claude Code.
     *
     * This is what makes "look at the highlighted code" work: without it
     * getCurrentSelection returns nothing and Claude has no idea what the user
     * is pointing at. Monaco fires on every cursor move, so the send is
     * debounced -- each one is a WebSocket notification to a live agent.
     */
    let selTimer: ReturnType<typeof setTimeout> | undefined;
    const reportSelection = () => {
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        const model = ed.getModel();
        const sel = ed.getSelection();
        const path = model ? pathOfModel(modelsRef.current, model) : null;
        if (!model || !sel || !path) return;
        window.th.ideSelection({
          filePath: path,
          text: model.getValueInRange(sel),
          selection: {
            // Monaco counts lines from 1; the protocol counts from 0.
            start: { line: sel.startLineNumber - 1, character: sel.startColumn - 1 },
            end: { line: sel.endLineNumber - 1, character: sel.endColumn - 1 },
            isEmpty: sel.isEmpty(),
          },
        });
      }, 150);
    };
    /**
     * Toggle a breakpoint by clicking the glyph margin.
     *
     * Monaco reports the target type, so this fires only on the narrow gutter
     * strip -- clicking the line number or the code itself must not set one.
     */
    const onGutter = ed.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = e.target.position?.lineNumber;
      const model = ed.getModel();
      const path = model ? pathOfModel(modelsRef.current, model) : null;
      if (!line || !path) return;
      onToggleBreakpointRef.current(path, line);
    });

    let symTimer: ReturnType<typeof setTimeout> | undefined;
    function followSymbols() {
      clearTimeout(symTimer);
      symTimer = setTimeout(() => {
        const model = ed.getModel();
        const pos = ed.getPosition();
        if (!model || !pos) { setSymbols([]); return; }
        void symbolPathAt(model, pos).then((trail) => {
          // A model swapped while the outline was computing: drop the answer.
          if (ed.getModel() === model) setSymbols(trail);
        });
      }, 120);
    }

    const subs = [
      ed.onDidChangeCursorSelection(reportSelection),
      ed.onDidFocusEditorText(reportSelection),
      // Blame follows the cursor, so it is repainted on every move. Cheap:
      // the data is already in memory and it is one decoration.
      ed.onDidChangeCursorPosition(() => paintBlameRef.current()),
      // A tab switch is a model swap; blame belongs to the file, not the editor.
      ed.onDidChangeModel(() => paintBlameRef.current()),
      // The breadcrumb's symbol trail follows the cursor and the text.
      ed.onDidChangeCursorPosition(followSymbols),
      ed.onDidChangeModel(followSymbols),
      ed.onDidChangeModelContent(followSymbols),
      ed.onMouseDown((e) => {
        if (!(e.target.element as HTMLElement | null)?.classList?.contains("fove-blame")) return;
        const line = e.target.position?.lineNumber ?? ed.getPosition()?.lineNumber;
        if (line) openBlameCommitRef.current(line);
      }),
      onGutter,
    ];

    return () => {
      clearTimeout(selTimer);
      clearTimeout(symTimer);
      sizing.dispose();
      for (const sub of subs) sub.dispose();
      // Detach first: the diff editor shares these models, and disposing one
      // out from under it leaves it holding a disposed model.
      diffRef.current?.setModel(null);
      diffRef.current?.dispose();
      diffRef.current = null;
      ed.dispose();
      // Same rule as closing a tab: the project's models belong to the
      // language service, not to this pane, and a second editor pane is
      // probably still using them.
      for (const sub of contentSubsRef.current.values()) sub.dispose();
      contentSubsRef.current.clear();
      for (const path of modelsRef.current.keys()) releaseModel(path);
      modelsRef.current.clear();
      for (const models of sideModelsRef.current.values()) for (const m of models) m.dispose();
      sideModelsRef.current.clear();
      editorRef.current = null;
    };
  }, []);

  /**
   * The diff editor, built the first time one is actually asked for.
   *
   * Monaco's diff editor is two code editors and a worker-backed comparison,
   * so a pane that never shows a diff should not pay for one.
   */
  const ensureDiffEditor = useCallback((): monaco.editor.IStandaloneDiffEditor | null => {
    if (diffRef.current) return diffRef.current;
    const host = diffHostRef.current;
    if (!host) return null;
    ensureTheme();
    const d = monaco.editor.createDiffEditor(host, {
      theme: "th-dark",
      automaticLayout: true,
      fontFamily: 'Menlo, "SF Mono", monospace',
      fontSize: 12,
      lineHeight: 18,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderSideBySide: true,
      // The left side is a revision that has already happened; only the
      // working-tree side is anyone's to edit.
      originalEditable: false,
      renderOverviewRuler: false,
    });
    d.onDidUpdateDiff(() => {
      const changes = d.getLineChanges() ?? [];
      let added = 0;
      let removed = 0;
      for (const c of changes) {
        if (c.modifiedEndLineNumber > 0) added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
        if (c.originalEndLineNumber > 0) removed += c.originalEndLineNumber - c.originalStartLineNumber + 1;
      }
      setDiffStats({ added, removed });
    });
    diffRef.current = d;
    // Lives as long as the diff editor, which is disposed with the pane.
    const sizing = followSize(d, host);
    d.onDidDispose(() => sizing.dispose());
    return d;
  }, []);

  /**
   * Draw breakpoints and the paused line for whichever file is showing.
   *
   * A decorations *collection* rather than `deltaDecorations`: it owns its own
   * ids, so replacing the set cannot leave an orphan marker behind when the
   * user switches files with a breakpoint set in each.
   */
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (!bpDecorationsRef.current) bpDecorationsRef.current = ed.createDecorationsCollection();
    // A diff tab empties the code editor. There is nothing to decorate, and
    // the breakpoints belong to the file, not to the editor showing it.
    if (!ed.getModel()) { bpDecorationsRef.current.clear(); return; }

    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    for (const bp of props.breakpoints ?? []) {
      if (bp.path !== activePath) continue;
      decorations.push({
        range: new monaco.Range(bp.line, 1, bp.line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: "fove-breakpoint",
          glyphMarginHoverMessage: { value: "Breakpoint" },
          // Survives edits above it, so a breakpoint tracks its line.
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }
    if (props.pausedAt && props.pausedAt.path === activePath) {
      decorations.push({
        range: new monaco.Range(props.pausedAt.line, 1, props.pausedAt.line, 1),
        options: { isWholeLine: true, className: "fove-paused-line" },
      });
    }
    bpDecorationsRef.current.set(decorations);
  }, [props.breakpoints, props.pausedAt, activePath]);

  /**
   * Point whichever editor the active tab needs at the right models.
   *
   * Only one of the two ever holds a model at a time. A document's model can
   * legally live in both, but then both render it and both fight over the
   * scroll position -- so the one that is not on screen is emptied first.
   */
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;

    if (!active || active.kind === "file") {
      diffRef.current?.setModel(null);
      const model = active ? modelsRef.current.get(active.path) ?? null : null;
      ed.setModel(model);
      ed.updateOptions({ readOnly: !!activeDoc?.readonly });
      if (model) ed.focus();
      setDiffStats(null);
      return;
    }

    ed.setModel(null);
    if (active.loading) return;
    const d = ensureDiffEditor();
    if (!d) return;

    /*
     * Fixed sides get their own models, cached per tab so switching away and
     * back does not rebuild them -- and so closing the tab knows exactly what
     * to dispose. The working-tree side is the document's own model, never a
     * copy, which is what keeps the diff editable and savable.
     */
    let sides = sideModelsRef.current.get(active.key);
    if (!sides) {
      sides = [monaco.editor.createModel(active.original, languageForPath(active.path))];
      if (active.modified !== undefined) {
        sides.push(monaco.editor.createModel(active.modified, languageForPath(active.path)));
      }
      sideModelsRef.current.set(active.key, sides);
    }
    const modified = active.modRev !== undefined
      ? sides[1] ?? null
      : modelsRef.current.get(active.path) ?? null;
    if (!modified) return;

    d.setModel({ original: sides[0]!, modified });
    d.updateOptions({
      renderSideBySide: sideBySide,
      readOnly: active.modRev !== undefined || !!activeDoc?.readonly,
    });
    d.layout();
    d.getModifiedEditor().focus();
  }, [active, activeDoc?.readonly, sideBySide, ensureDiffEditor]);

  /**
   * Shortcuts that belong to this pane, and only while it has the focus.
   *
   * Registered in the capture phase so they run before the app's own window
   * handler and can stop it: ⌘⇧O is the app's second way into Spotlight
   * everywhere else, and inside an editor it has to mean what it means in
   * every other editor -- go to a symbol in this file.
   */
  useEffect(() => {
    const focused = () =>
      !!hostRef.current?.closest("[data-pane]")?.contains(document.activeElement);

    const onKey = (e: KeyboardEvent) => {
      // Escape closes the history sheet, and must not reach anything else
      // while it is open -- it is the only modal thing this pane has.
      if (e.key === "Escape" && historyRef.current) {
        e.preventDefault();
        e.stopPropagation();
        setHistory(null);
        return;
      }
      if (!(e.metaKey || e.ctrlKey || e.altKey) || !focused()) return;
      const command = keymap.match(e, "editor");

      if (command === "editor.save") {
        e.preventDefault();
        e.stopPropagation();
        void save();
        return;
      }

      /*
       * Close the smallest thing first: the file tab. With no tab open the
       * key falls through to the app, which closes the pane.
       */
      if (command === "editor.closeTab") {
        const key = activeKeyRef.current;
        if (!key || !tabsRef.current.some((t) => t.key === key)) return;
        e.preventDefault();
        e.stopPropagation();
        closeTab(key);
        return;
      }

      if (command === "editor.symbol") {
        // A diff tab's right-hand editor is the one showing the file.
        const target = diffRef.current && editorRef.current?.getModel() === null
          ? diffRef.current.getModifiedEditor()
          : editorRef.current;
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        /*
         * VS Code's own symbol picker ("@" in quick open). Monaco's standalone
         * quickOutline is not in VS Code's build, so asking for it by name
         * finds nothing; the workbench command is the same picker, with
         * symbols grouped by kind.
         */
        target.focus();
        target.trigger("fove", "workbench.action.gotoSymbol", null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [save, closeTab]);

  const parent = dir.replace(/\/[^/]+$/, "") || "/";
  /** The visible tree, depth-first, following what is expanded. */
  const rows = flattenTree(dir, children, open);

  /**
   * Tab labels, grown leftwards only where two tabs would otherwise read the
   * same. Recomputed from the open set rather than stored, so closing the
   * colliding tab shortens the survivor's label again.
   */
  const labels = useMemo(() => disambiguate(tabs.map((t) => t.path)), [tabs]);
  const crumbs = useMemo(
    () => (activePath ? breadcrumb(root ?? props.cwd, activePath) : []),
    [activePath, root, props.cwd],
  );

  return (
    <div style={S.pane}>
      <div style={S.toolbar}>
        <button style={S.glyphBtn} onClick={() => setTreeOpen((v) => !v)} title="Toggle file tree">
          {treeOpen ? "◧" : "▢"}
        </button>
        <div style={S.tabs}>
          {tabs.map((t) => (
            <div
              key={t.key}
              onClick={() => setActiveKey(t.key)}
              style={{ ...S.tab, ...(t.key === activeKey ? S.tabActive : null) }}
              title={t.kind === "diff" ? `${t.path} — ${t.revLabel} ↔ ${t.modLabel}` : t.path}
            >
              {t.kind === "diff" && <span style={S.tabGlyph}>⇄</span>}
              <span>
                {labels.get(t.path) ?? t.path}
                {dirty.has(t.path) && (t.kind === "file" || !t.modRev) ? " •" : ""}
              </span>
              <button
                style={S.tabClose}
                onClick={(e) => { e.stopPropagation(); closeTab(t.key); }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {notice && <span style={S.notice}>{notice}</span>}
        <button
          style={{ ...S.glyphBtn, opacity: activeDirty && activeEditable ? 1 : 0.4 }}
          onClick={() => void save()}
          title="Save (⌘S)"
          disabled={!activeDirty || !activeEditable}
        >
          ⤓
        </button>
        {active && (
          <button
            style={S.glyphBtn}
            onClick={() => window.th.openInEditor(active.path)}
            title="Open in VS Code"
          >
            ↗
          </button>
        )}
      </div>

      {/*
        * The path, in full, without hovering anything.
        *
        * A tab strip of basenames answers "which file is this" only when you
        * already know the project by heart; the breadcrumb answers it at a
        * glance, and each segment is a way back into the tree.
        */}
      {active && (
        <div style={S.crumbs}>
          {crumbs.map((c) => (
            <span key={c.path} style={S.crumbWrap}>
              <button
                style={{ ...S.crumb, color: c.leaf ? C.fg : C.dim }}
                title={c.leaf ? "Copy path" : `Reveal ${c.name} in the tree`}
                onClick={() => {
                  if (c.leaf) { copyText(c.path); setNotice("path copied"); setTimeout(() => setNotice(null), 1200); }
                  else { setOpen((prev) => new Set(prev).add(c.path)); void loadDir(c.path); setTreeOpen(true); }
                }}
              >
                {c.name}
              </button>
              {!c.leaf && <span style={S.crumbSep}>›</span>}
            </span>
          ))}
          {/* Where the cursor is inside the file, from VS Code's outline model. */}
          {active.kind !== "diff" && symbols.map((sym, i) => (
            <span key={`${i}:${sym.name}`} style={S.crumbWrap}>
              <span style={S.crumbSep}>›</span>
              <button
                style={{ ...S.crumb, color: i === symbols.length - 1 ? C.fg : C.dim }}
                title={`Go to ${sym.name}`}
                onClick={() => {
                  const ed = editorRef.current;
                  if (!ed) return;
                  ed.setPosition({ lineNumber: sym.line, column: sym.column });
                  ed.revealLineInCenterIfOutsideViewport(sym.line);
                  ed.focus();
                }}
              >
                <span style={S.symGlyph}>{kindGlyph(sym.kind)}</span>{sym.name}
              </button>
            </span>
          ))}

          <span style={{ flex: 1 }} />

          {active.kind === "diff" && (
            <>
              <span style={S.revPill} title="Left side">{active.revLabel}</span>
              <span style={S.crumbSep}>↔</span>
              <span style={S.revPill} title="Right side">{active.modLabel}</span>
              {active.added && <span style={S.addedPill}>new file</span>}
              {diffStats && (
                <>
                  <span style={{ color: "#3fb950" }}>+{diffStats.added}</span>
                  <span style={{ color: "#f05055" }}>−{diffStats.removed}</span>
                </>
              )}
              {/*
                * The glyph shows the layout you would switch *to*, not the
                * one you are in -- a button says what it does.
                */}
              <button
                style={S.glyphBtn}
                onClick={() => setSideBySide((v) => !v)}
                title={sideBySide ? "Switch to inline" : "Switch to side-by-side"}
              >
                {sideBySide ? "▤" : "▥"}
              </button>
              <button
                style={S.glyphBtn}
                onClick={() => void openFile(active.path)}
                title="Open the file itself"
              >
                ⊡
              </button>
            </>
          )}
          {active.kind === "file" && root && (
            <button
              style={S.glyphBtn}
              onClick={() => void openDiff(active.path, "HEAD")}
              title="Diff this file against HEAD"
            >
              ⇄
            </button>
          )}
          {root && (
            <button
              style={{ ...S.glyphBtn, color: compareTo === "turn" ? C.accent : C.faint }}
              onClick={() => void toggleCompare()}
              title={compareTo === "turn"
                ? "Gutter shows what Claude's last turn changed (edits made with its Edit and Write tools). Click for changes since HEAD"
                : "Gutter shows changes since HEAD. Click to see what Claude's last turn changed"}
            >
              {compareTo === "turn" ? "✳±" : "±"}
            </button>
          )}
          {root && (
            <>
              <button
                style={{ ...S.glyphBtn, color: blameOn ? C.fg : C.faint }}
                onClick={() => setBlameOn((v) => !v)}
                title={
                  blameOn
                    ? "Blame is on — who last touched the cursor's line"
                    : "Blame: who last touched the cursor's line"
                }
              >
                ◉
              </button>
            </>
          )}
          {problems.length > 0 && (
            <button
              style={{ ...S.glyphBtn, color: problems.some((p) => p.error) ? C.red : C.yellow }}
              onClick={() => setProblemsOpen((v) => !v)}
              title="Problems in the open files"
            >
              ⚠ {problems.length}
            </button>
          )}
          {/* Local history needs no repository, so this is not under `root`. */}
          {active && (
            <button
              style={S.glyphBtn}
              onClick={() => void openHistory()}
              title="History of this file: local saves, outside changes, commits"
            >
              ⟲
            </button>
          )}
          {activeEditable && (
            <button
              style={{ ...S.glyphBtn, color: formatOnSave ? C.fg : C.faint }}
              onClick={() => setFormatOnSave((v) => !v)}
              title={
                formatOnSave
                  ? "Format on save is on — uses the project's own prettier or ruff, and does nothing if it has neither"
                  : "Format on save is off"
              }
            >
              ≡
            </button>
          )}
        </div>
      )}

      <div style={S.body}>
        {treeOpen && (
          <div
            style={S.tree}
            onContextMenu={(ev) => {
              // Empty space acts on the directory being shown.
              if (ev.target !== ev.currentTarget) return;
              ev.preventDefault();
              setMenu({ x: ev.clientX, y: ev.clientY, path: dir, dir: true });
            }}
          >
            <div style={S.treePath} title={dir}>
              <button style={S.upBtn} onClick={() => void rootTo(parent)} title="Parent folder">↑</button>
              <span style={S.ellipsis}>{dir.split("/").pop() || "/"}</span>
            </div>
            {/* Naming a new file or folder happens in place, at the top. */}
            {editing && editing.mode !== "rename" && (
              <div style={S.treeRow}>
                <span style={{ width: 13 }}>{editing.mode === "new-folder" ? "▸" : "·"}</span>
                <input
                  autoFocus
                  style={S.inlineInput}
                  value={editing.value}
                  placeholder={editing.mode === "new-folder" ? "folder name" : "file name"}
                  onChange={(ev) => setEditing({ ...editing, value: ev.target.value })}
                  onBlur={() => void commitEditing()}
                  onKeyDown={(ev) => {
                    ev.stopPropagation(); // the app's shortcuts must not fire here
                    if (ev.key === "Enter") void commitEditing();
                    if (ev.key === "Escape") setEditing(null);
                  }}
                />
              </div>
            )}

            {rows.map((e) =>
              editing?.mode === "rename" && editing.path === e.path ? (
                <div key={e.path} style={{ ...S.treeRow, paddingLeft: indent(e.depth) }}>
                  <span style={{ width: 13 }}>{e.dir ? (e.open ? "▾" : "▸") : "·"}</span>
                  <input
                    autoFocus
                    style={S.inlineInput}
                    value={editing.value}
                    onChange={(ev) => setEditing({ ...editing, value: ev.target.value })}
                    onBlur={() => void commitEditing()}
                    onKeyDown={(ev) => {
                      ev.stopPropagation();
                      if (ev.key === "Enter") void commitEditing();
                      if (ev.key === "Escape") setEditing(null);
                    }}
                  />
                </div>
              ) : (
                <div
                  key={e.path}
                  onClick={() => (e.dir ? void toggleDir(e.path) : void openFile(e.path))}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    setMenu({ x: ev.clientX, y: ev.clientY, path: e.path, dir: e.dir });
                  }}
                  style={{
                    ...S.treeRow,
                    paddingLeft: indent(e.depth),
                    color: e.path === activePath ? C.fg : e.dir ? C.dim : C.faint,
                    background: e.path === activePath ? "#1e2636" : undefined,
                  }}
                  title={e.path}
                >
                  <span style={{ width: 13 }}>{e.dir ? (e.open ? "▾" : "▸") : "·"}</span>
                  <span style={S.ellipsis}>{e.name}</span>
                </div>
              ),
            )}

            {treeError && <div style={S.treeError}>{treeError}</div>}
            {rows.length === 0 && <div style={S.treeEmpty}>empty</div>}
          </div>
        )}

        <div style={S.editorWrap}>
          {/*
            * Both editors stay mounted and one is hidden, rather than being
            * created and torn down per tab: Monaco's construction cost is real
            * and switching between a file and its diff is a frequent motion.
            */}
          <div
            ref={hostRef}
            style={{ ...S.host, display: active?.kind === "diff" ? "none" : "block" }}
          />
          <div
            ref={diffHostRef}
            style={{ ...S.host, display: active?.kind === "diff" ? "block" : "none" }}
          />
          {!active && <div style={S.empty}>select a file from the tree</div>}
          {active?.kind === "diff" && active.loading && (
            <div style={S.empty}>reading {active.revLabel}…</div>
          )}
          {activeDoc?.error && active?.kind === "file" && (
            <div style={S.empty}>{activeDoc.name}: {activeDoc.error}</div>
          )}
        </div>
      </div>

      {/*
        * File history, as a sheet under the breadcrumb it was opened from.
        *
        * Deliberately not a pane: it is a list you read once to pick a commit
        * off, and giving it a pane would mean rearranging the workspace to
        * ask a question and rearranging it back afterwards.
        */}
      {/*
        * Problems, as a sheet like history: a list you read to pick one off.
        * Clicking a row opens the file at the problem.
        */}
      {problemsOpen && (
        <>
          <div style={S.scrim} onClick={() => setProblemsOpen(false)} />
          <div style={S.history}>
            <div style={S.historyHead}>
              <span>problems ({problems.length})</span>
              <span style={{ flex: 1 }} />
              <button style={S.glyphBtn} onClick={() => setProblemsOpen(false)} title="Close (esc)">✕</button>
            </div>
            {problems.length === 0 && <div style={S.historyEmpty}>no problems in the open files</div>}
            {problems.map((p, i) => (
              <div
                key={`${p.path}:${p.line}:${p.column}:${i}`}
                style={S.historyRow}
                onClick={() => { setProblemsOpen(false); void navigateTo(p.path, p.line, p.column); }}
                title={`${p.path}:${p.line}\n${p.message}`}
              >
                <span style={{ color: p.error ? C.red : C.yellow, flexShrink: 0 }}>{p.error ? "●" : "▲"}</span>
                <span style={S.ellipsis}>{p.message}</span>
                <span style={S.historyMeta}>{p.source}</span>
                <span style={S.historyMeta}>{p.path.split("/").pop()}:{p.line}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {history && active && (
        <>
          <div style={S.scrim} onClick={closeHistory} />
          <div style={S.history}>
            <div style={S.historyHead}>
              <span>history of {active.path.split("/").pop()}</span>
              <span style={{ flex: 1 }} />
              <button style={S.glyphBtn} onClick={closeHistory} title="Close (esc)">✕</button>
            </div>
            <div style={S.historySection}>local history</div>
            {local !== null && local.length === 0 && (
              <div style={S.historyEmpty}>nothing yet: saves and outside changes show up here</div>
            )}
            {local?.map((h) => (
              <div
                key={h.id}
                style={S.historyRow}
                onClick={() => void openLocalDiff(active.path, h)}
                title="Compare with your buffer"
              >
                <span style={S.ellipsis}>{h.source}</span>
                <span style={S.historyMeta}>{agoExact(h.timestamp)}</span>
                <button
                  style={S.glyphBtn}
                  title="Put this version back in the buffer (not saved)"
                  onClick={(e) => { e.stopPropagation(); void restoreLocal(active.path, h); }}
                >
                  restore
                </button>
              </div>
            ))}
            {root && <div style={S.historySection}>commits</div>}
            {root && history.length === 0 && <div style={S.historyEmpty}>reading…</div>}
            {history.map((c) => (
              <div
                key={c.oid}
                style={S.historyRow}
                onClick={() => openCommitDiff(active.path, c)}
                title={`${c.oid}\n${c.subject}`}
              >
                <span style={S.sha}>{c.short}</span>
                <span style={S.ellipsis}>{c.subject}</span>
                <span style={S.historyMeta}>{c.author}</span>
                <span style={S.historyMeta}>{c.when}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.path, menu.dir)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * A coarse "how long ago", for blame.
 *
 * Deliberately coarse: the difference between 14 and 16 days changes nothing
 * about how you read a line, and a precise timestamp is longer to read for an
 * annotation that is meant to be glanced at.
 */
/**
 * "How long ago" for local history, where entries minutes apart matter.
 *
 * Blame's `ago` stops at the day, which is right for commits and useless for
 * telling apart this morning's twenty saves.
 */
function agoExact(when: number): string {
  const s = Math.floor((Date.now() - when) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  const d = new Date(when);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (s < 86_400 && d.getDate() === new Date().getDate()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function ago(when: number): string {
  const days = Math.floor((Date.now() - when) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/**
 * Left padding for a row at `depth`.
 *
 * The tree is only 190px wide, so the step is small: deep paths need to stay
 * legible rather than run out of room for the filename.
 */
function indent(depth: number): number {
  return 8 + depth * 10;
}

const S: Record<string, React.CSSProperties> = {
  inlineInput: {
    flex: 1, minWidth: 0, background: "#0d0d11", color: C.fg,
    border: "1px solid #2f6feb", borderRadius: 3, padding: "0 4px",
    fontSize: 11, outline: "none", fontFamily: "inherit",
  },
  treeError: {
    margin: "4px 6px", padding: "4px 6px", borderRadius: 4,
    background: "#2a1214", border: "1px solid #6e2b30",
    color: "#ffb4b4", fontSize: 10, whiteSpace: "pre-wrap",
  },
  // `position: relative` so the history sheet is placed against the pane
  // rather than against whatever ancestor happens to be positioned.
  pane: { display: "flex", flexDirection: "column", height: "100%", position: "relative",
          background: "#0d0d11", color: C.fg, fontFamily: "system-ui", fontSize: 12,
          overflow: "hidden" },
  scrim: { position: "absolute", inset: 0, zIndex: 20 },
  history: {
    position: "absolute", top: 48, right: 8, zIndex: 21,
    width: "min(560px, calc(100% - 16px))", maxHeight: "70%", overflowY: "auto",
    background: "#14141a", border: `1px solid ${C.line}`, borderRadius: 6,
    boxShadow: "0 14px 36px rgba(0,0,0,0.5)",
  },
  historyHead: {
    display: "flex", alignItems: "center", gap: 8, padding: "6px 9px",
    borderBottom: `1px solid ${C.line}`, color: C.dim,
    position: "sticky", top: 0, background: "#14141a",
  },
  historyRow: {
    display: "flex", alignItems: "center", gap: 8, padding: "3px 9px",
    cursor: "pointer", lineHeight: "18px",
  },
  historyMeta: { color: C.faint, fontSize: 11, flexShrink: 0 },
  historySection: {
    color: C.faint, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.6,
    padding: "8px 9px 3px",
  },
  historyEmpty: { color: C.faint, padding: "8px 9px", fontSize: 11 },
  sha: { fontFamily: 'Menlo, "SF Mono", monospace', color: "#d29922", fontSize: 11, flexShrink: 0 },
  toolbar: { display: "flex", alignItems: "center", gap: 4, padding: "3px 7px",
             background: "#14141a", borderBottom: `1px solid ${C.line}`, flexShrink: 0,
             minHeight: 26 },
  tabs: { display: "flex", gap: 2, overflowX: "auto", maxWidth: "60%" },
  tab: { display: "flex", alignItems: "center", gap: 5, padding: "2px 7px",
         borderRadius: 4, color: C.faint, cursor: "pointer", whiteSpace: "nowrap",
         border: "1px solid transparent" },
  tabActive: { background: "#1e2636", color: C.fg, border: `1px solid ${C.line}` },
  tabGlyph: { color: "#d29922", fontSize: 10 },
  tabClose: { background: "transparent", border: "none", color: C.faint,
              cursor: "pointer", fontSize: 9, padding: 0, lineHeight: 1 },
  iconBtn: { background: "transparent", border: `1px solid ${C.line}`, color: C.dim,
             borderRadius: 4, padding: "1px 7px", cursor: "pointer", fontSize: 11 },
  /*
   * A button whose label is a single glyph.
   *
   * Fixed width, because these sit in a row that toggles: a ▥ that becomes a
   * ▤ must not shift everything beside it, and a word-width button would.
   * Slightly larger than the text buttons since a glyph at 11px is a smudge,
   * and every one of them carries a `title` -- a symbol nobody can name is
   * only an improvement if hovering it still answers the question.
   */
  glyphBtn: {
    background: "transparent", border: `1px solid ${C.line}`, color: C.dim,
    borderRadius: 4, padding: 0, width: 22, height: 17, lineHeight: "15px",
    cursor: "pointer", fontSize: 12, flexShrink: 0, textAlign: "center",
  },
  notice: { color: C.dim, fontSize: 11, marginRight: 4 },
  /*
   * One line, never two: the breadcrumb is a glance, and a wrapping one would
   * shove the editor down every time a deep file opened.
   */
  crumbs: {
    display: "flex", alignItems: "center", gap: 4, padding: "2px 8px",
    background: "#101017", borderBottom: `1px solid ${C.line}`, flexShrink: 0,
    minHeight: 21, overflowX: "auto", whiteSpace: "nowrap", fontSize: 11,
  },
  crumbWrap: { display: "inline-flex", alignItems: "center", gap: 4 },
  crumb: {
    background: "transparent", border: "none", padding: 0, cursor: "pointer",
    fontSize: 11, fontFamily: "inherit",
  },
  crumbSep: { color: "#3a3a44" },
  symGlyph: { color: "#6b6b78", marginRight: 3 },
  revPill: {
    color: C.dim, background: "#191922", border: `1px solid ${C.line}`,
    borderRadius: 3, padding: "0 5px", fontSize: 10,
  },
  addedPill: { color: "#3fb950", fontSize: 10 },
  body: { display: "flex", flex: 1, minHeight: 0 },
  tree: { width: 190, flexShrink: 0, overflowY: "auto", borderRight: `1px solid ${C.line}`,
          padding: "3px 0", background: "#0f0f14" },
  treePath: { display: "flex", alignItems: "center", gap: 5, padding: "3px 8px",
              color: C.dim, borderBottom: `1px solid ${C.line}`, marginBottom: 3 },
  upBtn: { background: "transparent", border: "none", color: C.faint, cursor: "pointer",
           fontSize: 11, padding: 0 },
  treeRow: { display: "flex", gap: 4, alignItems: "center", padding: "1px 8px",
             cursor: "pointer", lineHeight: "17px" },
  treeEmpty: { color: "#33333c", padding: "6px 9px", fontSize: 11 },
  ellipsis: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
  editorWrap: { flex: 1, minWidth: 0, position: "relative" },
  host: { position: "absolute", inset: 0, width: "100%", height: "100%" },
  empty: { position: "absolute", inset: 0, display: "flex", alignItems: "center",
           justifyContent: "center", color: "#33333c", fontSize: 11,
           pointerEvents: "none", background: "#0d0d11" },
};
