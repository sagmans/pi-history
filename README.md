# pi-history

Ghost completion for prompt history across [pi](https://github.com/earendil-works/pi-coding-agent) sessions.

`pi-history` records your real prompts and keeps the data local. By default
each project gets its own history (`project` isolation). Project identity is
the shared git common directory, so every linked worktree of a repository
(including bare-repo worktrees) recalls one history; non-git directories fall
back to the current directory. You can opt into one host-wide history
(`global` isolation) if you want cross-project recall. History files live only
under `~/.pi/agent/pi-history/`, with private directory and file permissions.
File names use a bounded hash of the absolute project path to avoid collisions
and filesystem filename limits.

## Features

- Records interactive and RPC user input; skips extension-injected messages and
  blank prompts, preserves multiline text.
- Caps each project at `maxEntries`; exact duplicates move to newest instead of
  storing copies.
- `/pi-history status` reports only metadata.
- `/pi-history clear` confirms before wiping the current project's entries and
  records a clear marker so older open sessions cannot restore them.
- `Ctrl+R` opens fuzzy reverse search; Enter replaces the full editor buffer
  without submitting; Escape restores the draft.
- Ghost completion is best effort: when the wrapped editor can safely expose
  lines, cursor, insertion, and a render seam, a prefix match shows a dim
  suffix, `Ctrl+E` accepts all of it, and `Alt+Right` accepts the next word
  through the configured `tui.editor.cursorWordRight` binding. If that support
  is missing, the extension notifies once that ghost completion is disabled and
  leaves `Ctrl+R` available.

## Installation

```bash
pi install https://github.com/sagmans/pi-history
```

Pin a release tag to stay on a fixed version (recommended once releases are
tagged; unpinned installs track the default branch):

```bash
pi install git:github.com/sagmans/pi-history@v0.1.0
```

## Supported environments

| Component | Supported | Notes |
| --- | --- | --- |
| OS | macOS (primary), Linux | Windows unsupported (POSIX file permissions, symlink handling) |
| Node.js | `>=22.19.0` | CI tests exact minimum `22.19.0` and current `24` |
| pi | `>=0.80.x`, tested at `0.81.1` | Peer range is `*` per pi packaging rules; that is a loading requirement, not a support promise |
| Terminal | tested under [herdr](https://github.com/fitchmultz/herdr) and standard macOS terminals | Ghost completion is best effort and degrades gracefully (see Features) |

CI runs `npm run verify:ci` on Ubuntu and macOS across both Node versions.

## Configuration

The shipped default keeps one history per project:

```json
{
  "maxEntries": 2000,
  "isolationLevel": "project"
}
```
To share one history across all projects on the host, create
`~/.pi/agent/pi-history/config.json` (see `config.local.example.json` for the
shape) and set `"isolationLevel": "global"`. User config lives in the
pi-history data directory — not inside the installed package — so it survives
`pi update` (pi resets and cleans its package clones on update).

Precedence, lowest to highest:

1. built-in defaults (`500` / `project`) — safety fallback
2. shipped `config.json` in the installed package
3. `~/.pi/agent/pi-history/config.json`
4. `~/.pi/agent/pi-history/config.local.json` (for machine-local experiments)

The highest file that mentions an option wins. If that file's value is
invalid, the built-in default applies and a warning is shown — a broken
override is never silently masked by lower-precedence config.

## Privacy

All history stays on your machine under `~/.pi/agent/pi-history/`. Nothing is
sent anywhere. Directory and files are created with private permissions.

Note what the scope choice means: with global isolation, prompts from every
project (work repos included) land in one shared `global.json` and are
recallable from any directory. That is why global is opt-in only. The shipped
default keeps each repository's prompts in its own file.

## Development

Requires Node.js >= 22.19.0 (tests use `node --experimental-transform-types`).

```bash
npm ci --ignore-scripts
npm run check       # biome lint + format
npm run check:fix   # apply biome fixes
npm run typecheck
npm run test
npm run verify      # deterministic offline checks
npm run audit       # network-dependent high-severity dependency gate
npm run verify:ci   # complete maintainer and CI gate
```

Two biome rules are disabled in `biome.json` on purpose (inline comments in
biome.json silently break rule overrides, so the rationale lives here):

- `suspicious/noConfusingVoidType` — `PiHistoryApi` mirrors pi's own
  `ExtensionAPI` handler signatures, which use `| void` unions.
- `suspicious/noControlCharactersInRegex` — the display sanitizer exists
  precisely to match C0/C1 control characters.

Git hooks via husky: pre-commit runs `npm run check`, pre-push runs
`npm run typecheck && npm test`. Hooks are dev-only: there is deliberately no
`prepare` script, because pi runs `npm install` inside its package clones and
hooks must never install on user machines. Contributors opt in once after
cloning:

```bash
npx husky
```

## License

[MIT](LICENSE) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) ·
[Releases](RELEASE.md)
