# Maintainer smoke test

Use this maintainer-only Herdr smoke after runtime-loading changes. It launches
the checkout as a real Pi TUI package without reading or mutating real state
under `~/.pi/agent`.

## Preconditions

- Run inside a Herdr-managed pane with `HERDR_ENV=1`.
- Install `herdr`, `pi`, Node.js, and the locked project dependencies.
- The command surface is tested with Herdr `0.8.0`; the script reports the
  installed version and checks required commands before creating anything.

From the repository root:

```bash
npm ci --ignore-scripts
npm run smoke:herdr
```

The smoke is intentionally outside `npm run verify:ci`; Herdr is maintainer
infrastructure, not a package-user or CI dependency.

## Isolation and evidence

The script proves five obligations:

1. All Pi state is disposable. Canonical native history and conflicting legacy
   history use distinct synthetic canaries; Pi runs in a non-focused sibling
   pane with trust, updates, and telemetry disabled.
2. TUI readiness and `/pi-history status` produce this exact share-safe line:

```text
pi-history: diagnosticsVersion=2; state=healthy; initialization=ready; storage=ready; editor=ready; entries=1; cap=42; scope=global
```

3. Synthetic capture, confirmed clear, and restart agree in diagnostics and on
   disk, including schema, count, `clearEpoch`, and `clearedAt`; canaries and
   private paths never appear in extracted diagnostics.
4. Reverse search puts the captured entry into the draft, proved by
   deduplication: the stored count holds while that entry's use count rises.
   Ghost completion renders the seeded entry for a stored prefix and accepts it
   without submitting, and the same prefix renders nothing after a confirmed
   clear.
5. Pi exits cleanly, only the created pane closes, and disposable state is
   removed after success or failure.

Proven paths: native profile history (schema 3 load, capture rewrite,
reverse-search selection, ghost render and acceptance, ghost absence after
clear, confirmed clear with minted clear epoch, restart reload) and legacy HOME
history (schema 1 fixture present but shadowed by the populated profile
target). Legacy migration import itself is covered by unit tests, not this
smoke.

Only the validated `pi-history:` line is share-safe. Never persist or share raw
TUI capture: Pi itself may render repository and disposable paths unrelated to
pi-history diagnostics.

## Common failures

- `HERDR_ENV=1 is required`: run the smoke from a Herdr-managed pane.
- Missing Herdr command: install a compatible Herdr version and compare its
  reported command surface with tested version `0.8.0`.
- `pi is not available`: install a supported Pi version or add it to `PATH`.
- Pi readiness timeout: confirm the local TUI can launch with disposable state.
- Diagnostic mismatch or private-data failure: treat the diagnostic contract as
  failed; do not share captured pane output.
- Reverse-search, ghost, or ghost-absence failure: treat the search contract as
  failed; the messages name the step, and raw pane output stays private.
