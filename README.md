# codex-s

`codex-s` installs the `cx` CLI, a small tool for listing and deleting local Codex sessions.

It reads sessions from a local Codex home, supports interactive multi-select deletion, and requires typing `DELETE` before it removes matching session files or index entries.

## Requirements

- Node.js `>=24` or Bun `>=1.1.0`

`codex-s` can be installed with npm or Bun. The default `cx` binary runs on Node.js. A Bun-specific binary is also exposed as `cx-bun` for users who want to run the same CLI under Bun.

## Install

From npm:

```bash
npm install -g codex-s
```

From Bun:

```bash
bun add -g codex-s
```

For local development from this repository:

```bash
bun install
bun link
```

You can also run the built CLI directly:

```bash
bun run build
node ./dist/cli/index.js list
bun ./dist/cli/index.js list
```

## Usage

```text
cx <command>

Commands:
  list, ls                List local Codex sessions
  delete, d, rm [session..]
                          Delete Codex sessions after confirmation
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

- Close Codex before deleting sessions manually.
- The CLI backs up `session_index.jsonl` before editing it.
- No sync, archive, rename, or export features are included yet.
