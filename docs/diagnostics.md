# Diagnostics reference

The full field reference for `/pi-history status`. For behaviour and install,
see [`README.md`](../README.md); for the diagnostic vocabulary, see
[`CONTEXT.md`](../CONTEXT.md).

A healthy `/pi-history status` notification uses a fixed, versioned format:

```text
pi-history: diagnosticsVersion=2; state=healthy; initialization=ready; storage=ready; editor=ready; entries=12; cap=2000; scope=project
```

Version 2 fields always follow this order: `diagnosticsVersion`, `state`,
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
- `unsupported_schema` — recording and clearing remain blocked to preserve data this release cannot interpret.
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
each applicable component reason. Initialization failure, write blocking, storage
degradation, and unavailable editor integration use warning severity;
healthy and ghost-only degradation use information severity.

Version 2 adds `unsupported_schema` to the version 1 field vocabulary; field
order and presence rules remain unchanged.

Share only a `pi-history:` line containing `diagnosticsVersion=2`. Versioned
diagnostics omit prompt text, raw errors, and exact filesystem paths.
Surrounding warnings and terminal output are local operational notices, not
share-safe diagnostics. Diagnostics remain local and are neither persisted nor
transmitted. Any structural or semantic change to field names, order, presence,
values, or meaning requires a new diagnostic contract version.
