# pi-history

Ghost completion for prompt history across [pi](https://github.com/earendil-works/pi-coding-agent) sessions.

`pi-history` records your real prompts per project and keeps the data local.
Project identity is the shared git common directory, so every linked worktree
of a repository (including bare-repo worktrees) recalls one history; non-git
directories fall back to the current directory. History files live only under
`~/.pi/agent/pi-history/`, with private directory and file permissions. File
names use a bounded hash of the absolute project path to avoid collisions and
filesystem filename limits.

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

## Configuration

Defaults live in `config.json`:

```json
{
  "maxEntries": 2000,
  "isolationLevel": "global"
}
```

Create `config.local.json` next to it to override tracked defaults locally;
local wins over tracked, tracked defaults apply when absent or invalid.
`config.local.json` is git-ignored. See `config.local.example.json`.

## Privacy

All history stays on your machine under `~/.pi/agent/pi-history/`. Nothing is
sent anywhere. Directory and files are created with private permissions.

## Development

Requires Node.js >= 22.19.0 (tests use `node --experimental-transform-types`).

```bash
npm ci --ignore-scripts
npm run test
npm run typecheck
```

## License

[MIT](LICENSE)
