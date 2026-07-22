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

- Records TUI user input; skips extension-injected messages and blank prompts,
  preserves multiline text. RPC, JSON, and print modes remain inert.
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

Install from npm so pi only offers updates after a published release:

```bash
pi install npm:pi-history
```

## Supported environments

| Component | Supported | Notes |
| --- | --- | --- |
| OS | macOS (primary), Linux | Windows unsupported (POSIX file permissions, symlink handling) |
| Node.js | `>=22.19.0` | CI tests exact minimum `22.19.0` and current `24` |
| pi | `>=0.80.x`, tested at `0.81.1` | Peer range is `*` per pi packaging rules; that is a loading requirement, not a support promise |
| Terminal | tested under [herdr](https://github.com/fitchmultz/herdr) and standard macOS terminals | Ghost completion is best effort and degrades gracefully (see Features) |
| Pi mode | TUI | RPC, JSON, and print may expose command metadata but perform no pi-history runtime work |

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

## Diagnostics

A healthy `/pi-history status` notification uses a fixed, versioned format:

```text
pi-history: diagnosticsVersion=1; state=healthy; initialization=ready; storage=ready; editor=ready; entries=12; cap=2000; scope=project
```

Version 1 fields always follow this order: `diagnosticsVersion`, `state`,
`initialization`, optional `initializationReason`, `storage`, optional
`storageReason`, `editor`, optional `editorReason`, optional `entries`, optional
`cap`, then optional `scope`. `entries` appears only for ready storage; `cap` and
`scope=project|global` appear only after configuration loads. Unavailable values
are omitted instead of replaced with sentinels.

Initialization failures use `state=initialization_failed`,
`storage=unavailable`, and one bounded reason:

- `configuration_load_failed`
- `identity_resolution_failed`
- `storage_load_failed`

Configuration failure omits unavailable `cap` and `scope`; every initialization
failure omits `entries`. Status reports the latest initialization attempt
without probing or retrying. Start or reload a TUI session to retry.

Storage that safely refuses writes uses `state=write_blocked` and one reason:

- `corrupt_history` — clearing can replace the corrupt history with an empty one.
- `project_root_mismatch` — clearing remains blocked to preserve foreign history.

Write-blocked status omits `entries`, prompt contents, project roots, and storage
paths.

Unexpected mutation failures use `state=storage_degraded` and one reason:

- `record_failed`
- `clear_failed`

Storage-degraded status uses warning severity and omits `entries`. A later
successful record or clear restores storage readiness; persistent write blocking
takes precedence over transient degradation.

Editor integration uses `state=editor_degraded`. Missing Pi editor hooks report
`editor=unavailable`, `editorReason=missing_editor_hooks`, and warning severity;
both reverse search and ghost completion are absent. Ghost-only degradation
reports `editor=degraded`, information severity, and one primary reason while
keeping `Ctrl+R` available:

- `missing_lines`
- `missing_cursor`
- `missing_insertion`
- `missing_render_seam`

Priority follows that list when multiple capabilities are missing. Editor
readiness means no degradation has been observed; status does not probe the
editor.

Top-level state precedence is `initialization_failed`, `write_blocked`,
`storage_degraded`, `editor_degraded`, then `healthy`. Combined conditions keep
each applicable component reason. Initialization failure, write blocking,
storage degradation, and unavailable editor integration use warning severity;
healthy and ghost-only degradation use information severity.

Share only a `pi-history:` line containing `diagnosticsVersion=1`. Versioned
diagnostics omit prompt text, raw errors, and exact filesystem paths.
Surrounding warnings and terminal output are local operational notices, not
share-safe diagnostics. Diagnostics remain local and are neither persisted nor
transmitted. Any structural or semantic change to field names, order, presence,
values, or meaning requires a new diagnostic contract version.

## Privacy

All history stays on your machine under `~/.pi/agent/pi-history/`. Nothing is
sent anywhere. Directory and files are created with private permissions.
Runtime behavior is limited to Pi's TUI; other modes do not load or mutate
pi-history state.

Note what the scope choice means: with global isolation, prompts from every
project (work repos included) land in one shared `global.json` and are
recallable from any directory. That is why global is opt-in only. The shipped
default keeps each repository's prompts in its own file.

## Maintainer development

Maintenance is owner-authorized. Public bug reports are welcome, but external
pull requests and feature requests are not accepted; see the
[participation policy](https://github.com/sagmans/pi-history/blob/main/CONTRIBUTING.md).

Requires Node.js >= 22.19.0 (tests use `node --experimental-transform-types`).

```bash
npm ci --ignore-scripts
npm run check       # biome lint + format
npm run check:fix   # apply biome fixes
npm run typecheck
npm run test
npm run verify       # deterministic offline checks
npm run audit        # network-dependent high-severity dependency gate
npm run verify:ci    # complete maintainer and CI gate
npm run smoke:herdr  # disposable real-TUI smoke; Herdr maintainers only
```

`npm run verify:ci` is the authoritative maintainer gate and runs in every CI
matrix leg. `npm run verify` is its deterministic offline subset. The Herdr
smoke remains outside CI; see [`docs/maintainer-smoke.md`](https://github.com/sagmans/pi-history/blob/main/docs/maintainer-smoke.md).
The audit
currently reports moderate `GHSA-j3f2-48v5-ccww` in the dev-only `protobufjs`
copy nested under pi; reassess it with every pi dependency update.

Two biome rules are disabled in `biome.json` on purpose (inline comments in
biome.json silently break rule overrides, so the rationale lives here):

- `suspicious/noConfusingVoidType` — `PiHistoryApi` mirrors pi's own
  `ExtensionAPI` handler signatures, which use `| void` unions.
- `suspicious/noControlCharactersInRegex` — the display sanitizer exists
  precisely to match C0/C1 control characters.

Git hooks via husky: pre-commit runs `npm run check`, pre-push runs
`npm run typecheck && npm test`. Hooks are dev-only: there is deliberately no
`prepare` script, because pi runs `npm install` inside its package clones and
hooks must never install on user machines. Maintainers opt in once after
cloning:

```bash
npx husky
```

## License

[MIT](LICENSE) · [Security](https://github.com/sagmans/pi-history/blob/main/SECURITY.md) · [Report bugs](https://github.com/sagmans/pi-history/blob/main/CONTRIBUTING.md) ·
[Releases](https://github.com/sagmans/pi-history/blob/main/RELEASE.md)
