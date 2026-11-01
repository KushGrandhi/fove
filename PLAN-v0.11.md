# v0.11 — The editor stops being hand-rolled

## Why

fove's editor is Monaco plus about 2,100 lines of our own code in `Editor.tsx`,
with more in `lspProviders.ts`, `tsProject.ts`, `lsp.ts`, `dapClient.ts` and
`watch.ts`. Every VS Code behaviour we wanted, we wrote again, and each copy
covers less than the original. Two failures show the pattern:

- **Open tabs don't reload.** `watch.ts` watches directories so the file tree
  stays current. Nothing pushes a disk change into an open Monaco model, so
  when Claude writes a file you're viewing, the tab keeps showing the old text
  until you close and reopen it.
- **A save conflict loses work.** `files.ts:112` notices the file changed on
  disk, and then `Editor.tsx:1084` says "reopen to merge". There is no merge:
  reopening loads the disk version and throws away your buffer.

VS Code solved both years ago, in MIT-licensed code that is published as
libraries. The rule for v0.11: **fove owns the layout, the panes and the AI
features. Everything below is taken from open source, not rewritten.**

Not an option: running a full editor (code-server, OpenVSCode Server or
Theia) inside a pane. A pane is part of fove, not a second IDE living inside
it, and none of fove's own features may be lost.

## The foundation: VS Code's services, without VS Code's shell

**`@codingame/monaco-vscode-api`** (MIT, v38). It is the code from the VS Code
repository that Monaco leaves out — text files, working copies, the merge
editor, debugging, source control, search, quick access, keybindings — split
into separate "service override" packages. Monaco itself becomes VS Code's
real editor build. We install only the services we want and attach their
views to DOM elements that fove's panes own. There's no VS Code window and no
VS Code layout.

**`monaco-languageclient`** (MIT, from TypeFox) connects Monaco to any language
server. It replaces our hand-written provider glue in `lspProviders.ts`.

## The top 21

"Taken from" is the code we use instead of writing our own. fove's job for
each item is wiring it in and rendering it inside a fove pane.

### Files and state

| # | Feature | Taken from |
|---|---|---|
| 1 | An open, unedited tab reloads when its file changes on disk | textfile and files services (`files-`, `working-copy-service-override`); `@parcel/watcher`, VS Code's own file watcher |
| 2 | Saving over a file that changed underneath: auto-merge when the edits don't overlap, otherwise a 3-way merge view. Never last-write-wins | VS Code's save-conflict flow and merge editor; `node-diff3` for the automatic case |
| 3 | One model per file, shared by every pane and tab showing it | `model-service-override` (VS Code's text model and reference counting) |
| 4 | Unsaved buffers survive a restart (hot exit) | working-copy backup service |
| 5 | Local history: every save and every agent write, restorable | working-copy history and Timeline. Agent writes are recorded with the turn that made them (fove's `snapshots.ts`) |

### Navigation

| # | Feature | Taken from |
|---|---|---|
| 6 | Cmd-click go-to-definition, across files and into installed packages | LSP through `monaco-languageclient`, using `vtsls` (the TS server VS Code effectively uses) and `basedpyright` |
| 7 | Find all references, shown in a peek view and in a list | LSP + Monaco's peek widget + the references view |
| 8 | Go to symbol in the file (⌘⇧O) and in the workspace (`#` in ⌘P) | LSP + `quickaccess-service-override` |
| 9 | Quick open files (Cmd-P), fuzzy and ranked like VS Code | quickaccess + VS Code's fuzzy scorer; `rg --files` for the list |
| 10 | Project search and replace with a preview | `search-service-override` on top of `@vscode/ripgrep` (`search.ts` already uses rg) |
| 11 | Outline and breadcrumbs | `outline-service-override` |

### Editing intelligence

| # | Feature | Taken from |
|---|---|---|
| 12 | Completion, hover, signature help, rename, quick fixes | LSP |
| 13 | A problems list gathered from every source | `markers-service-override`; `ruff server` (ruff's own LSP), the TS server, ESLint's language server |
| 14 | Format on save and format selection | LSP formatting (`ruff format`, prettier) |

### Git

| # | Feature | Taken from |
|---|---|---|
| 15 | Gutter change markers and an inline diff against HEAD | `scm-service-override` quick diff |
| 16 | Blame inline and on hover, with click-through to the commit | VS Code's built-in git extension (blame decorations) |
| 17 | Reviewing agent changes side by side, accepting or rejecting each hunk | Monaco diff editor, fed by fove's `changeset.ts` |
| 18 | Resolving merge conflicts | the merge editor (same as #2) |

### Debugging and the shell

| # | Feature | Taken from |
|---|---|---|
| 19 | A debugger: breakpoints, stepping, call stack, variables, watch, debug console | `debug-service-override`, with debugpy for Python and `vscode-js-debug` for JS/TS. Replaces `dapClient.ts` |
| 20 | Command palette and keybindings that match VS Code | `keybindings-` and `quickaccess-service-override` |
| 21 | Every fove shortcut moves to a standard, not just the editor's (below) | VS Code's macOS keymap and macOS's standard shortcuts; the same keybinding service as #20, so every key is rebindable and shown in the palette |

### #21 — Shortcuts follow a standard

Today's bindings live in `App.tsx:428`, a hand-written `if/else` chain. Most
of them take a key people already know and give it a fove-only meaning, so
every user has to learn fove's keys first:

| Key | fove today | What people expect (source) |
|---|---|---|
| ⌘W | closes the whole focused pane | closes the editor tab or terminal session (VS Code, iTerm, browsers) |
| ⌘⇧F | Spotlight | search across files (VS Code) |
| ⌘P | pins the pane | quick open a file (VS Code) |
| ⌘⇧P | pins the tab | command palette (VS Code) |
| ⌘O | worktree palette | open (macOS) |
| ⌘M | model picker | minimize the window (macOS) |
| ⌘D | split the pane | add the next match to the selection, when in an editor (VS Code) |
| ⌘B | opens a browser pane | toggle the sidebar (VS Code); bold, in text |
| ⌘J | opens a Claude pane | toggle the bottom panel (VS Code) |
| ⌘K | opens the config pane | the leader key for VS Code's chords (⌘K ⌘S and others) |
| ⌘G, ⌘E | git pane, editor pane | find next, find with the selection (macOS) |

**The standard, in priority order:**

1. **macOS** for anything app- or window-level (⌘W, ⌘M, ⌘O, ⌘Q, ⌘H, ⌘,).
2. **VS Code's macOS defaults** for anything editing, navigation, search or
   panels: ⌘P, ⌘⇧P, ⌘⇧F, ⌘B, ⌘J, ⌘\\ to split, and its "show view" keys —
   ⌘⇧E explorer, ⌃⇧G source control (on macOS ⌘⇧G is Find Previous, which
   wins), ⌘⇧D debug, ⌘⇧M problems. fove's editor, git and debugger panes
   take those.
3. **iTerm** only inside a focused terminal pane (⌘D and ⌘⇧D split, ⌘T new
   tab, ⌘1–9 switch tab), which is where that muscle memory comes from.
4. **fove-only actions** (Claude pane, agents, browser, model picker,
   pinning) get keys that clash with none of the above — checked by a test
   against the VS Code and macOS keymaps — and are always reachable through
   ⌘⇧P with their key shown beside them.

**⌘W closes the smallest thing first**: the editor tab, then the terminal
session, and only then an empty pane. Never a pane holding work in one
keystroke.

**Wherever two standards clash, the macOS default wins.**

**Decided:** ⌘T is "new tab" everywhere; workspace symbols are `#` in ⌘P
(VS Code supports that too). ⌘1–9 switch tabs everywhere.

**A keybindings screen** lists every fove command with its key, lets you
record a new one, flags a clash with another command or a reserved macOS
key, and resets any key to the default. It's fove's own screen, not VS Code's
keybinding editor. When #20 lands, the same overrides feed the keybinding
service.

## Owned by fove, not taken from anywhere

These are why fove exists. They stay first-class and get rebuilt on the new
foundation where needed:

- Sending the editor selection or a file to Claude Code
- Agent edits arriving as attributed, reviewable changes (#5, #17), not
  silent rewrites
- Pane layout, pop-outs and the worktree switcher
- Opening a file from the agent tree, transcripts or search in fove's editor
  pane
- The Python interpreter chosen per project (`interpreters.ts`,
  `pythonEnv.ts`), passed to basedpyright and debugpy

## Order

1. **Spike (time-boxed).** Build `monaco-vscode-api` in our Vite/Electron
   setup with the files, model and working-copy services, rendered in one
   fove pane. It must show: (a) an open tab updates live when an outside
   process writes the file, (b) a conflicting save opens a merge view instead
   of losing work, (c) the bundle size and cold start compared with today.
   If any of these fails, stop and report before going further.
   **Shipped ahead of the spike:** #21's app-level half — the keymap
   (`src/shared/keymap.ts`), the keybindings screen (`ui/Shortcuts.tsx`), and
   the new defaults. Editor-internal keys follow with #20.
2. **State (#1–5).** Fixes the bugs that started this plan. **Done.**
   Verified in the running app (scripted over CDP): an open tab reloads on an
   outside write; an unsaved edit survives one; save merges edits to
   different lines and saves, and turns same-line edits into conflict blocks
   it will not save until resolved; unsaved edits survive a quit; local
   history lists saves and outside writes, each openable as a diff and
   restorable. #2 uses conflict blocks in the buffer rather than VS Code's
   merge editor, which needs workbench parts fove does not run yet.
   **Found, not fixed:** ⌘-click to a definition in another TS file opens
   the tab and then snaps back to the original file. The build before this
   work does the same; it belongs to step 3, which replaces that code.
3. **Language servers (#6–8, #12–14).** Switch to `monaco-languageclient`;
   delete `lspProviders.ts` and most of `tsProject.ts`. **Done.** VS Code
   packages moved to 37.6.1, the version `monaco-languageclient` 11.0.3 is
   built for. TypeScript/JavaScript run on bundled `vtsls`; Python on the
   installed pyright-family server plus `ruff server`. Verified in the
   running app, and TypeScript also in the packaged bundle: errors, hover,
   completion, ⌘-click into another file, find references, rename across
   files, quick fixes, ⌘⇧O symbols, `#` workspace symbols in ⌘P, a problems
   list across languages, Format Document through the server. Format on
   save still uses the project's own prettier/ruff, unchanged.
   **Fixed on the way:** ⌘-click to another file never worked -- no pane
   ever held the navigation claim. fove's shortcuts lost to VS Code's
   keybindings inside the editor (⌘P). VS Code's web build autosaves.
4. **Git (#15–18).** **Done.** VS Code's own change markers and inline
   diff (SCM service), fed by a fove "Git" source per repository; fove's
   hand-written change bars are gone. A ± switch compares the gutter with
   Claude's last turn instead of HEAD -- each file's original comes from
   the `originalFile` Claude Code records on every Edit and Write -- and a
   "Revert this change" action in the inline diff undoes one hunk. VS Code's
   merge-conflict extension adds Accept Current/Incoming/Both above every
   conflict block. Blame keeps fove's git data and gains a hover card and
   click-through to the commit. Limits: turn review sees only changes made
   with Claude's Edit/Write tools, not shell commands; there is no
   staging (VS Code's git extension needs Node and cannot run here).
5. **Search and the shell (#9–11, #20, #21).** — **Done.** All five below,
   verified in the running app. Found on the way: ripgrep was never shipped,
   so search found nothing without Homebrew's `rg`; it is now bundled like
   ruff. Not done: the replace preview is inline in each row (struck text,
   then the replacement), not a diff tab.
   The shortcut change lands
   together with the keybinding service, so keys move once, not twice.
   **Rule: fove's own surfaces stay; VS Code parts go underneath them.**
   ⌘P is already Spotlight (files, code, `#` symbols), ⌘⇧P is fove's
   palette, ⌘⇧F is the Search pane, and the breadcrumb is fove's. None of
   them is replaced by VS Code's widget. What changes:
   - #9: Spotlight and the palette rank with VS Code's fuzzy scorer
     (`vs/base/common/fuzzyScorer`) in place of `palette-rank.ts`'s own.
   - #10: the Search pane gains replace, previewed in a diff editor and
     applied through the working copies (open editors update, undo works).
   - #11: the breadcrumb gains the symbol path at the cursor, from the
     language servers' document symbols.
   - #20: fove's palette lists the editor's commands with their keys, read
     from VS Code's command and keybinding registries.
   - #21: editor-internal keys become rebindable in fove's Shortcuts screen.
6. **Debugger (#19).** Delete `dapClient.ts`.

The old editor code is deleted step by step as each piece is replaced.

## Risks

- **Version churn.** `monaco-vscode-api` follows VS Code releases and has
  shipped 38 major versions. Pin one exact version and upgrade on purpose,
  the way we already treat Electron.
- **Bundle size.** Each service adds weight. Measure it in the spike;
  `README.md` records shrinking the archive from 117MB to 15MB, so this is
  something we care about.
- **Rendering views into our own DOM.** The library supports attaching single
  views and parts to chosen elements, but whether every view we need (the
  merge editor, the debug views) fits cleanly into a fove pane is an
  assumption until the spike tests it.
- **Extensions.** Some features (git blame, the JS debugger) come as VS Code
  extensions, which need the extension host running in the renderer or a
  worker. Prefer the plain service where one exists.
