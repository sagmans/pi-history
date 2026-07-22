# Maintainer smoke test

Use this maintainer-only Herdr smoke after runtime-loading changes. It launches
the checkout as a real Pi TUI package without reading or mutating real state
under `~/.pi/agent`.

## Preconditions

- Run inside a Herdr-managed pane with `HERDR_ENV=1`.
- Install `herdr`, `pi`, Node.js, and the locked project dependencies.
- The command surface is tested with Herdr `0.7.4`; the script reports the
  installed version and checks required commands before creating anything.

From the repository root:

```bash
npm ci --ignore-scripts
npm run smoke:herdr
```

The smoke is intentionally outside `npm run verify:ci`; Herdr is maintainer
infrastructure, not a package-user or CI dependency.

## Isolation and evidence

The script:

1. Creates disposable `HOME` and `PI_CODING_AGENT_DIR` trees.
2. Seeds synthetic global history containing a secret canary without submitting
   any model prompt.
3. Opens a non-focused sibling pane and launches
   `pi --approve --no-session -e .` with one-run project trust, update checks,
   and telemetry disabled.
4. Waits for concrete TUI readiness, invokes `/pi-history status`, and keeps raw
   pane output only in memory.
5. Extracts the exact diagnostic line and verifies this contract:

```text
pi-history: diagnosticsVersion=2; state=healthy; initialization=ready; storage=ready; editor=ready; entries=1; cap=42; scope=global
```

6. Verifies the extracted line omits the canary, repository path, history path,
   disposable home, and agent directory.
7. Requests a clean Pi exit, closes only the pane it created, and removes all
   disposable state on success or failure.

Only the validated `pi-history:` line is share-safe. Never persist or share raw
TUI capture: Pi itself may render repository and disposable paths unrelated to
pi-history diagnostics.

## Common failures

- `HERDR_ENV=1 is required`: run the smoke from a Herdr-managed pane.
- Missing Herdr command: install a compatible Herdr version and compare its
  reported command surface with tested version `0.7.4`.
- `pi is not available`: install a supported Pi version or add it to `PATH`.
- Pi readiness timeout: confirm the local TUI can launch with disposable state.
- Diagnostic mismatch or private-data failure: treat the diagnostic contract as
  failed; do not share captured pane output.
