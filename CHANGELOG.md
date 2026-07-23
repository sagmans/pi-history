# Changelog

All notable changes to this project are documented here. This format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Reusable, CLI-only npm and GitHub trusted-publishing setup scripts with guarded mutations and fake-CLI tests.

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

[Unreleased]: https://github.com/sagmans/pi-history/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/sagmans/pi-history/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/sagmans/pi-history/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sagmans/pi-history/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sagmans/pi-history/releases/tag/v0.1.0
