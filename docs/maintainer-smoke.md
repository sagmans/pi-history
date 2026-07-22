# Maintainer smoke test

Use this smoke test after runtime-loading changes. It loads the checkout as a
local pi package, invokes `/pi-history status` through RPC mode, and prevents pi
or the extension from reaching real state under `~/.pi/agent`.

## Run from the repository root

Install the locked development dependencies first:

```bash
npm ci --ignore-scripts
```

Then run the isolated smoke test:

```bash
PI_BIN="$(command -v pi)"
PI_HISTORY_SMOKE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/pi-history-smoke.XXXXXX")"
trap 'rm -rf "$PI_HISTORY_SMOKE_HOME"' EXIT

printf '%s\n' \
  '{"id":"status","type":"prompt","message":"/pi-history status"}' |
  HOME="$PI_HISTORY_SMOKE_HOME/home" \
  PI_CODING_AGENT_DIR="$PI_HISTORY_SMOKE_HOME/agent" \
  "$PI_BIN" --mode rpc --no-session -e .
```

Both overrides are required. `PI_CODING_AGENT_DIR` isolates pi settings and
credentials; `HOME` isolates pi-history's data directory. `--no-session`
prevents session persistence. The exit trap removes all disposable state.

## Expected evidence

Success emits a notification and command response similar to:

```json
{"type":"extension_ui_request","method":"notify","message":"pi-history: entries=0; cap=2000; project=/path/to/repository; file=/tmp/pi-history-smoke.../home/.pi/agent/pi-history/project-....json","notifyType":"info"}
{"id":"status","type":"response","command":"prompt","success":true}
```

The generated `file=` path must begin with the disposable
`$PI_HISTORY_SMOKE_HOME/home/` path. Any path under the maintainer's real home
means isolation failed; stop without running further commands.

## Common failures

- `pi: command not found`: install a supported pi version or add it to `PATH`.
- Module resolution or extension-load errors: rerun `npm ci --ignore-scripts`
  from the repository root and confirm Node.js satisfies `package.json`.
- A successful response without the `pi-history` notification: inspect preceding
  `extension_error` output; the local checkout did not load correctly.
- `file=` points outside the disposable directory: confirm both `HOME` and
  `PI_CODING_AGENT_DIR` are assigned on the `pi` invocation.
