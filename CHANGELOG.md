# Changelog

All notable changes to this project are documented here. This format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.6] - 2026-08-13

### Changed

- Raised Pi development dependencies to 0.84.1, Biome to 2.5.7, and the dev-only `@types/node` typings to 26.2.0 (typecheck-only; Node runtime support stays `22.19.0` and `24`); upstream 0.84.1 resolves every shrinkwrap-pinned advisory, so the release audit gate now fails on any high or critical advisory with no waivers.
- Ported the maintainer Herdr smoke to the Herdr 0.8.0 command surface: Pi now launches through `agent start`, prompts and slash commands go through `agent prompt`, output assertions poll `pane read` after `wait output` was removed, and teardown closes the created pane by terminating its disposable shell.

### Fixed

- Prevented one wrapped-editor redraw without Pi's private cursor marker from permanently disabling ghost completion; pi-history now leaves that redraw unchanged and retries on the next render, while structural editor safeguards and `Ctrl+R` remain unchanged. (#52)

## [0.1.5] - 2026-07-30

### Changed

- Raised Pi development dependencies to 0.82.1, clearing the nested protobufjs advisory; the release audit gate now waives only the remaining dev-only brace-expansion advisory, which is pinned inside Pi's own published shrinkwrap and scoped to its exact install path until an upstream release resolves it.

### Fixed

- Made confirmed prompt-history clears monotonic across clock changes and corruption recovery so stale open sessions cannot restore cleared prompts; existing history migrates without eager rewrites.
- Replaced reusable clear counters with opaque per-clear epochs (schema 3) so distinct clears can never collapse into one lineage, including schema-1 old-writer clears on equal clocks; the terminal generation-exhaustion state no longer exists.
- Fenced history-lock ownership with unguessable tokens: release and publication only apply to the matching lock instance, a live same-host owner is never evicted by lock age alone, and a resumed displaced writer cannot rename stale history over newer state.
- Confirmed clears now remove crash-orphaned temporary prompt copies for the active history while holding mutation authority; symlinks, directories, malformed names, and unrelated files are left untouched, and cleanup failure blocks the clear with a path-free error.
- Migration-lock ownership now heartbeats while held, so an abandoned lock whose PID was reused by an unrelated process is reclaimed in bounded time instead of hanging session initialization, while a genuine live owner remains protected for the full migration.
- Release-workflow validation now parses the workflow structurally and verifies the tag trigger, approval-gated environment, effective `id-token: write` permission, and hardened publish command on the single intended publish job; duplicate keys, split controls, misleading text, anchors, and aliases fail closed.
- The Herdr maintainer smoke now seeds the final native history schema with clear-lineage metadata, keeps the legacy fixture pinned to schema 1, and exercises one synthetic capture, a confirmed clear, and a restart, with on-disk contract checks that fail on any schema or lineage drift.
- Isolated release smoke installs and runtime checks under one disposable Pi storage root with cleanup on success, failure, and interruption.

## [0.1.4] - 2026-07-23

### Added

- Reusable, CLI-only npm and GitHub trusted-publishing setup scripts with guarded mutations and fake-CLI tests.

### Fixed

- Isolated configuration and prompt history under Pi's active agent directory so profiles sharing one `HOME` no longer read each other's live data.
- Added a non-destructive frozen legacy snapshot for absent profile targets, with fixed privacy-safe migration notices.
- Made interrupted migration publication resumable, reclaimed dead migration locks without failing open, and rejected symlink-swapped migration sources.
- Corrected global history and clear language to the active Pi profile boundary.

## [0.1.3] - 2026-07-23

### Changed

- Moved npm distribution from `pi-history` to public package `@sagmans/pi-history`.
- Preserved existing configuration and prompt-history paths during package migration.

## [0.1.2] - 2026-07-23

### Added

- Versioned, deterministic, privacy-safe `/pi-history status` diagnostics.
- Disposable Herdr smoke coverage for real Pi TUI loading and status output.

### Changed

- Limited prompt capture, history I/O, commands, and editor integration to TUI sessions; RPC, JSON, and print modes are inert.
- Added bounded initialization, storage, write-blocking, and editor health states with safe recovery behavior.
- Bumped the diagnostic contract to version 2 with an `unsupported_schema` write-block reason.
- Unified history block reasons on a single shared type so storage and diagnostic contracts cannot drift.

### Fixed

- Preserved unsupported history schemas during record and clear attempts, including schemas written after runtime initialization.
- Cleared stale storage degradation when a TUI session re-initializes, so a transient prior failure does not persist into a fresh healthy session.

## [0.1.1] - 2026-07-22

### Added

- Tag-triggered npm release via OIDC trusted publishing with provenance attestations (no stored npm token).
- First npm-published release: manual `npm publish` bootstrap on the tagged SHA during one-time trusted-publisher setup, waived by the release owner.

## [0.1.0] - 2026-07-21

### Added

- Persistent local prompt history for pi with ghost completion and fuzzy `Ctrl+R` reverse search.
- Project-isolated history by default; opt-in host-wide `global` isolation.
- Prompt capture with restart persistence; skips extension-injected messages and blank prompts; preserves multiline text.
- `/pi-history status` (metadata only) and `/pi-history clear` (confirmed wipe with a clear marker so older open sessions cannot restore entries).
- Graceful fallback when ghost completion editor support is unavailable; `Ctrl+R` remains available.

[Unreleased]: https://github.com/sagmans/pi-history/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/sagmans/pi-history/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/sagmans/pi-history/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/sagmans/pi-history/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/sagmans/pi-history/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/sagmans/pi-history/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sagmans/pi-history/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sagmans/pi-history/releases/tag/v0.1.0
