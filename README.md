<p align="center">
  <img src="build/icon.png" width="96" alt="fove">
</p>

<h1 align="center">fove</h1>

<p align="center">
  <b>A terminal-first workspace for coding with agents.</b><br>
  Claude Code, a real editor, git and your shells in one window.
</p>

<p align="center">
  <a href="https://github.com/KushGrandhi/fove/releases"><img src="https://img.shields.io/github/v/tag/KushGrandhi/fove?label=version&color=blue" alt="version"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20(Apple%20silicon)-lightgrey" alt="platform">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="license"></a>
</p>

---

fove wraps the tools you already use instead of replacing them. A claude pane
is the real `claude`, the git pane is real `git`, and the editor is built from
VS Code's own services. You arrange them however you like: split, drag,
resize, pin.

## Features

- **Claude Code, unmodified.** Run several sessions side by side, resume past
  ones in a click, and watch subagents and teammates work live.
- **A real editor.** VS Code's editor and language servers, with TypeScript
  and Python working out of the box. Open files reload when an agent edits
  them, and saves never overwrite an agent's newer changes.
- **Review what the agent did.** Gutter markers show exactly what Claude's
  last turn changed. Revert any single hunk.
- **Git built in.** Status, diffs, staging, history, worktrees, blame and
  merge conflicts.
- **Fast search.** Fuzzy file and symbol search, a command palette, and
  project-wide find and replace.
- **Workspaces.** Each tab is a folder or git worktree with its own layout,
  restored on the next launch.

## Install

Requires macOS on Apple silicon, with [Claude Code](https://docs.claude.com/en/docs/claude-code) and git installed.

```bash
git clone https://github.com/KushGrandhi/fove.git
cd fove
./scripts/bootstrap.sh
```

The script checks your setup, installs anything missing via Homebrew, and
puts `fove.app` in your Applications folder. Run it with `--check` to see what
it would do first.

## Shortcuts

| Key | Action |
|---|---|
| `⌘P` | Go to file or symbol |
| `⌘⇧P` | Command palette |
| `⌘↵` | New Claude pane |
| `⌘⇧F` | Search |
| `⌘T` | Open a folder as a workspace |
| `⌘\` | Split right |

Every shortcut can be changed under **Keyboard shortcuts** in the palette.

## Contributing

Issues and pull requests are welcome. See [DEVELOPMENT.md](DEVELOPMENT.md)
for building from source and how the app is put together.

## License

[MIT](LICENSE) © Kush Grandhi
