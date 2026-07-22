# Maintainer smoke test

Use this manual smoke test after runtime-loading changes. It loads the checkout
as a local Pi package in TUI mode and prevents Pi or the extension from reaching
real state under `~/.pi/agent`.

## Run from the repository root

Install the locked development dependencies first:

```bash
npm ci --ignore-scripts
```

Then launch an isolated TUI:

```bash
PI_BIN="$(command -v pi)"
PI_HISTORY_SMOKE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/pi-history-smoke.XXXXXX")"
trap 'rm -rf "$PI_HISTORY_SMOKE_HOME"' EXIT

HOME="$PI_HISTORY_SMOKE_HOME/home" \
PI_CODING_AGENT_DIR="$PI_HISTORY_SMOKE_HOME/agent" \
"$PI_BIN" --no-session -e .
```

Both overrides are required. `PI_CODING_AGENT_DIR` isolates Pi settings and
credentials; `HOME` isolates pi-history configuration and data. `--no-session`
prevents session persistence. The exit trap removes all disposable state.

Inside the TUI:

1. Enter `/pi-history status`.
2. Confirm one `pi-history:` notification appears.
3. Exit Pi without submitting a model prompt.

## Expected evidence

The notification reports zero entries, the configured cap, project scope, and
a history file beneath the disposable home. Any history-file path outside
`$PI_HISTORY_SMOKE_HOME/home/` means isolation failed; exit immediately.

Do not copy or share the complete terminal output. This pre-diagnostic status
format still contains local paths; issue #8 replaces it with a share-safe line.

## Common failures

- `pi: command not found`: install a supported Pi version or add it to `PATH`.
- Module resolution or extension-load errors: rerun `npm ci --ignore-scripts`
  from the repository root and confirm Node.js satisfies `package.json`.
- No pi-history notification: inspect the visible extension error; the local
  checkout did not load correctly.
- History path escapes the disposable home: confirm both environment overrides
  are assigned on the Pi invocation.
