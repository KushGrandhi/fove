# Developing fove

How to build fove, how it is put together, and the traps already found.
[PLAN.md](PLAN.md) covers the architecture.

## Building from source

```bash
npm install             # also rebuilds node-pty for Electron
npm run dev             # build and launch
npm test                # run the test suite
npm run install:local   # build, sign ad-hoc, copy to /Applications
npm run dist            # also produce release/fove-<version>-arm64.dmg
```

Run `node scripts/fetch-tools.mjs` once in a fresh checkout to fetch the
bundled ripgrep and ruff. Required and optional tools are listed in
[`src/shared/deps.ts`](src/shared/deps.ts), which both Setup Check and
`scripts/bootstrap.sh` read.

The app is signed ad-hoc, so a copy downloaded to another Mac needs
right-click → Open the first time.

## Packaging and launching

**A debugging note worth keeping.** An automated agent running in a sandboxed
shell cannot launch this app with `open` -- every Electron app fails there with

    codesign_util.cc: task_name_for_pid: (os/kern) failure (5)

and dies before `main.js` runs. Stock Electron fails identically, so this is a
property of the sandbox, not of fove or its signature. Non-Electron apps
(Calculator) launch fine from the same shell, which makes it easy to
misdiagnose as an app bug. To launch it from such a context, go through the
user's own login session instead:

```bash
osascript -e 'tell application "Finder" to open POSIX file "/Applications/fove.app"'
```

Two packaging traps already paid for:

- **`ELECTRON_RUN_AS_NODE` in the user's login environment.** With it set,
  Electron runs `main.js` as plain Node and exits silently -- no window, no
  error. `npm start` clears it, but a double-clicked `.app` inherits it, so
  `main.ts` re-execs itself without the variable before importing electron.
  The re-exec must pass the app root explicitly: in a packaged app `argv` is
  just `[binary]`, so relaunching with the arguments alone starts Electron with
  nothing to run.
- **`node-pty` cannot load from inside an asar.** It ships a `.node` binary and
  a separate `spawn-helper` executable, so it is listed in `asarUnpack`.
  Everything else is bundled by Vite and excluded from `node_modules`, which
  took the archive from 117MB to 15MB (`monaco-editor` alone was 2,325 files).

## Pure logic

**Everything interesting lives in `src/shared/` and has no React and no
Electron in it**, which is why the test suite can cover it without
launching an app: `layout.ts` (splitting, closing, resizing, re-parenting),
`git-parse.ts` (every shape git can emit), `tree-rows.ts` (the editor tree's
flatten and reveal), `deps.ts` (what the machine needs) and `launch-cwd.ts`
(which folder a workspace opens in).

`src/shared/git-parse.ts` is likewise pure string -> data, so every shape git
can emit (renames, spaces in filenames, unmerged, detached HEAD, binary) is
tested without a repository. Porcelain v2 with `-z` is used deliberately: it is
the only form that survives filenames containing spaces or newlines.

## Internals

**`node-pty` must be rebuilt for Electron** (`electron-rebuild -f -w node-pty`);
the npm package ships Windows-only prebuilds. This runs on `postinstall`.

**`ELECTRON_RUN_AS_NODE` must be unset.** With it set, Electron runs `main.js`
as plain Node, `require("electron")` returns a path string, and `app` is
undefined. `npm start` clears it.

**Bun does not work.** `node-pty` spawns but its data callbacks never fire —
silently, no error. Node only.

**The preload cannot import shared modules.** Electron loads it as a single
file with no module resolution, so channel names are duplicated in
`src/main/preload.ts`; `test/ipc-contract.test.ts` keeps the copy honest.

**The editor runs on VS Code's own services.** `monaco-editor` is an alias for
`@codingame/monaco-vscode-editor-api` (VS Code's build of Monaco), and
`src/renderer/ide/vscode.ts` starts VS Code's file, text-file and working-copy
services before the first render. Files go through `ide/diskProvider.ts` to
`main/diskFs.ts` over IPC. That is what reloads an open tab when an agent writes
the file, refuses a save that would overwrite a newer file (fove then
three-way merges, `ide/merge.ts`), backs up unsaved buffers so they survive a
quit, and keeps local history. Every `@codingame/*` package is pinned to one
exact version; upgrade them together, on purpose.

**Language features come from real language servers, through VS Code's own
client.** `ide/languageClients.ts` runs `monaco-languageclient` (that is,
`vscode-languageclient`) against VS Code's services; `main/lsp.ts` only starts
the process and relays LSP messages over IPC. TypeScript/JavaScript use
`vtsls` (tsserver), bundled and run on Electron's own Node, so no Node install
is needed. Python uses whichever pyright-family server is installed, plus
`ruff server` -- and when the machine has neither, the copies fove ships:
basedpyright (npm, run on Electron's Node) and the official ruff binary,
which `scripts/fetch-tools.mjs` downloads at pack time, pinned and checked
against its published SHA-256. A new user gets Python navigation, type
errors, lint, fixes and format on save with nothing installed. Format on
save and the lint fallback use the bundled ruff too (`ruffCommand` in
`main/lsp.ts`). Bumping ruff means changing the version and checksum in
that script together. Servers start the first time a file of their language opens,
one per repository root. Jumps to another file reach a pane through the
editor-service override's `openEditor` (`ide/navigation.ts`).

**vtsls, basedpyright and ruff ship as `extraResources`, not inside the asar.** A child process
cannot run from inside an asar archive, and electron-builder's dependency
pruning drops vtsls's nested TypeScript (it looks like fove's own dev-only
`typescript`). So `package.json` copies the vtsls closure into
`Resources/vtsls`, nested `node_modules` listed separately because
extraResources skips them otherwise. If vtsls's dependencies change, check the
closure: a packaged app with a missing module has no TypeScript at all.

**Git in the editor is VS Code's SCM, fed by fove.** `ide/quickDiff.ts`
creates source controls through the `vscode` API (the git extension itself
needs Node and cannot run in the page) whose originals are HEAD (`git show`)
or, with the ± switch, each file before Claude's last turn -- read from the
`originalFile` Claude Code records on every Edit/Write
(`shared/turn-originals.ts`). VS Code decorates only editors its editor
service lists as visible, so that list is extended with fove's editors; and
the inline diff's buttons come from the git extension, so fove registers its
own "Revert this change" in `MenuId.SCMChangeContext`.

**fove's own surfaces stay; VS Code's parts go underneath.** Spotlight (⌘P),
the palette (⌘⇧P), the Search pane, the breadcrumb and the Shortcuts screen
are fove's. Under them: Spotlight and the palette rank with VS Code's quick
open scorer (`ui/fuzzy.ts`); the Search pane's replace builds its pattern
and replacement with VS Code's find code and applies through the bulk edit
service, one undo across files (`ide/replace.ts`); the breadcrumb's symbol
trail comes from VS Code's outline model (`ide/symbolPath.ts`); the palette
lists the focused editor's actions with their keys (`ide/editorCommands.ts`);
and editor keys changed in Shortcuts are handed to VS Code's keybinding
service (`ide/editorKeys.ts`). Two rules of fove's on top of VS Code's: a
replace never saves a file that already had unsaved edits, and a file no
editor shows is saved again after ⌘Z undoes a replace in it, so the disk
never silently disagrees with the undo.

**ripgrep and ruff are bundled binaries.** `scripts/fetch-tools.mjs`
downloads both at pack time, pinned and checked against their published
SHA-256, into `build/bin`, which ships as `Resources/bin`
(`main/bundled.ts` finds them). A tool on the user's PATH still wins. Run
the script once in a fresh checkout, or Spotlight and search find nothing on
a machine without ripgrep (and its tests fail).

**VS Code's web defaults are not desktop's.** Autosave is on in VS Code's web
build; `ide/vscode.ts` turns it off before the services start
(`initUserConfiguration`), as desktop VS Code has it.

**VS Code's Monaco differs from the npm one in three ways that bite.**
`automaticLayout` measures nothing, so every editor is sized by `followSize`
in `ide/vscode.ts`. The TypeScript/JSON/CSS/HTML language services and the
grammars are separate `@codingame/monaco-vscode-standalone-*` packages,
imported in `ide/vscode.ts`. And some editor features are workbench commands
rather than editor actions: `getAction("editor.action.quickOutline")` returns
null, `trigger(…, "workbench.action.gotoSymbol")` works.

**Monaco workers need relative paths under Rolldown.** Vite's `?worker` suffix
does not resolve against a package's `exports` map, so the workers are imported
via `../../../node_modules/@codingame/...` in `ide/vscode.ts`. Without them the
editor renders but every language feature silently does nothing.

**Driving the app from a script:** start it with
`--user-data-dir=<scratch dir> --remote-debugging-port=<port>` so it cannot
touch your real layout, and bring the window to the front over CDP
(`Page.bringToFront`). A window behind others is "hidden" to Chromium, which
skips repaints, so the screen lags the model and checks read stale text.

**Editor languages come from Monaco's own registry**, not a hand-written map —
91 languages, and new ones arrive with a Monaco upgrade. A small table adds
what Monaco does not ship (Vue/Svelte → html, Haskell → fsharp) and the
extensionless names a registry lookup misses (Makefile, Gemfile, .env, dotfiles).

**Teammates are not subagents.** A Task subagent lives inside one transcript and
can only be read after the fact. A *teammate* is its own `claude` process in a
tmux pane, so it can be watched live, interrupted, and talked to. The app joins
`~/.claude/teams/<team>/config.json` (who exists, their prompt and pane id) with
the live tmux socket (what they are doing now).

They surface as a sub-tab bar that exists only while a swarm is running — it
appears when agents start, disappears when the last finishes, and opens nothing
unless clicked.

**A teammate tab is a real terminal, one agent per tab.** Opening one runs
`tmux attach` against that teammate's own window, so you type directly into
that `claude` — no snapshot, no one-line input box. Since `attach` targets a
*window* rather than a pane, the tab first `break-pane -d`s the teammate into
its own window and `join-pane -d`s it back on close, which is what keeps one
tab from showing every teammate's output at once.

`capture-pane` is still used for the read-only preview in the agents pane, with
`-J` so a wrapped line arrives whole — without it a 120-character line comes
back as 43.

**tmux does not pass a literal tab through `-F`** — it arrives as `_`, so a
format string using `\t` silently produces one unsplittable field. Fields use
a `|:|` separator instead.

**The AI layer reads what Claude Code already writes.** Sessions live in
`~/.claude/projects/<slug>/*.jsonl`, so the subagent tree, token totals and
model list need no hooks and no cooperation from the CLI. Subagent logs key on
a hex `agentId` while the main transcript keys the same agent by its `toolu_…`
tool_use id; the `agent-<id>.meta.json` sidecars join the two.

**Token totals come from `modelUsage`, never `usage`.** On a result message
`usage` counts only the top-level loop and omits every subagent token — for an
app built around subagents that would make every figure quietly wrong.

**Editor saves are guarded by mtime.** An agent editing the same file produces
a visible conflict instead of a silent overwrite — see `FileService.write`.

**Never start a PTY at a degenerate size.** A pane that has not been laid out
reports 0x0; a 2x2 pty makes a full-screen TUI draw one frame and wedge. PTYs
start at 80x24 and take the first real resize instead.
