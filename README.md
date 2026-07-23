# pi-history

Ghost completion for prompt history across [pi](https://github.com/earendil-works/pi-coding-agent) sessions.

`pi-history` records your real prompts. Two isolation levels — `project`
(default: one history per project) and `global` (one host-wide history) —
configured under `~/.pi/agent/pi-history/`.

## Features

- Captures TUI input; skips extension-injected messages and blank prompts; preserves multiline text.
- Caps each project at `maxEntries`; exact duplicates move to newest instead of storing copies.
- `/pi-history status` — metadata only. `/pi-history clear` — confirms, then wipes and records a clear marker.
- `Ctrl+R` — fuzzy reverse search; Enter replaces the buffer, Escape restores the draft.
- Ghost completion (best effort): dim prefix-match suffix, `Ctrl+E` accepts all, `Alt+Right` accepts the next word. Degrades gracefully when editor support is missing.

## Install

```bash
pi install npm:@sagmans/pi-history
```

Install from npm so pi only offers updates after a published release.

Existing `pi-history` installs do not switch npm identities automatically. Migrate once:

```bash
pi remove npm:pi-history
pi install npm:@sagmans/pi-history
```

The package rename does not move or rewrite configuration or prompt history under
`~/.pi/agent/pi-history/`. Do not install both npm identities at once.

## Supported environments

| Component | Supported |
| --- | --- |
| OS | macOS (primary), Linux. Windows unsupported (POSIX permissions, symlinks). |
| Node.js | `>=22.19.0` (CI tests `22.19.0` and `24`) |
| pi | `>=0.80.x`, tested at `0.81.1` |
| Terminal | tested under [herdr](https://github.com/fitchmultz/herdr) and standard macOS terminals |
| Mode | TUI only. RPC, JSON, and print are inert. |

## Configuration

```json
{ "maxEntries": 2000, "isolationLevel": "project" }
```

User config lives in the data directory (`~/.pi/agent/pi-history/`), not the
installed package, so it survives `pi update`. Precedence (lowest → highest):
built-in defaults → shipped `config.json` → `config.json` → `config.local.json`.
The highest file that mentions an option wins; an invalid value falls back to
the default with a warning.

## Diagnostics

`/pi-history status` prints one versioned, privacy-safe line, e.g.
`pi-history: diagnosticsVersion=2; state=healthy; initialization=ready; storage=ready; editor=ready; entries=12; cap=2000; scope=project`.
Full field reference: [`docs/diagnostics.md`](https://github.com/sagmans/pi-history/blob/main/docs/diagnostics.md).

## Documentation

- [`docs/diagnostics.md`](https://github.com/sagmans/pi-history/blob/main/docs/diagnostics.md) — `/pi-history status` field reference
- [`docs/maintainer-development.md`](https://github.com/sagmans/pi-history/blob/main/docs/maintainer-development.md) — maintainer setup, commands, hooks
- [`docs/maintainer-smoke.md`](https://github.com/sagmans/pi-history/blob/main/docs/maintainer-smoke.md) — disposable Herdr smoke test
- [`docs/adr/`](https://github.com/sagmans/pi-history/tree/main/docs/adr) — architecture decision records
- [`CONTEXT.md`](https://github.com/sagmans/pi-history/blob/main/CONTEXT.md) — domain language
- [`CONTRIBUTING.md`](https://github.com/sagmans/pi-history/blob/main/CONTRIBUTING.md) — participation policy & bug reports
- [`SECURITY.md`](https://github.com/sagmans/pi-history/blob/main/SECURITY.md) — vulnerability reporting
- [`RELEASE.md`](https://github.com/sagmans/pi-history/blob/main/RELEASE.md) — release policy
- [`CHANGELOG.md`](https://github.com/sagmans/pi-history/blob/main/CHANGELOG.md) — version history

## License

[MIT](LICENSE) · [Security](https://github.com/sagmans/pi-history/blob/main/SECURITY.md) · [Report bugs](https://github.com/sagmans/pi-history/blob/main/CONTRIBUTING.md) · [Releases](https://github.com/sagmans/pi-history/blob/main/RELEASE.md)
