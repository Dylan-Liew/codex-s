# codex-s

`codex-s` installs the `cx` CLI, a small tool for listing and deleting local Codex sessions.

It reads the same local thread catalog used by Codex Desktop, supports interactive multi-select deletion, and asks for `y/N` confirmation before it removes matching session files, database rows, and cached Desktop state.

## Requirements

- Node.js `>=24`

`codex-s` runs on Node.js because it uses Node's runtime-native SQLite support to read the same local catalog used by Codex Desktop.

## Install

From npm:

```bash
npm install -g codex-s
```

For local development from this repository:

```bash
npm install
npm link
```

You can also run the built CLI directly:

```bash
npm run build
node ./dist/cli/index.js list
```

## Usage

```text
cx <command>

Commands:
  list, ls                List local Codex sessions
  delete, d, rm [session..]
                          Delete Codex sessions after confirmation
  cleanup                 Remove stale temp files and orphaned session data
  config <action> [value] Read or write codex-s configuration
  help                    Show CLI help
  completion              Print a fish completion script
```

When `cx delete` is run without arguments, it opens an interactive multi-select picker:

```text
type to filter, Space toggles, ↑/↓ moves, Enter confirms, Ctrl+C cancels
```

In non-TTY mode, enter numbers and ranges like `1,3,5-8`.

To delete explicit sessions:

```bash
cx delete 550e8400 "session title"
```

## Codex Home

Codex home is resolved in this order:

1. `--home <path>`
2. `CODEX_S_HOME`
3. `CODEX_HOME`
4. `codex-s.config.json` in the current directory
5. `~/.config/codex-s/config.json`
6. Auto-detected `.codex` home

To point WSL at a Windows host Codex home for the current repo, write an ignored local config:

```bash
cx config set-home /mnt/c/Users/Dylan/.codex --local
cx list
```

You can also use an explicit one-off path:

```bash
cx --home /mnt/c/Users/Dylan/.codex list
```

`codex-s.config.json` is gitignored so local host paths are not committed.

## Optional Fish Completions

If you use Fish, install a completion file into Fish's user completion directory:

```bash
mkdir -p ~/.config/fish/completions
cx completion fish > ~/.config/fish/completions/cx.fish
```

## Notes

- Close Codex before deleting sessions so the running app cannot rewrite cached state.
- Deletion removes rollout files, legacy index entries, Desktop catalog rows, state/cache database rows (`state_5`, `goals_1`, `memories_1`, `queue_1`), Desktop state references, and `history.jsonl` entries for the selected sessions.
- The CLI backs up every index, database, or Desktop state file that it changes.
- If Codex Desktop crashes after a manual deletion or failed update, run `cx cleanup` to clear leftover `*.tmp` state files and orphaned rows that reference missing sessions.
- No sync, archive, rename, or export features are included yet.
