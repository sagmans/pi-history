# Changelog

All notable changes to this project are documented here. This format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Versioned, deterministic, privacy-safe `/pi-history status` diagnostics.
- Disposable Herdr smoke coverage for real Pi TUI loading and status output.

### Changed

- Limited prompt capture, history I/O, commands, and editor integration to TUI sessions; RPC, JSON, and print modes are inert.
- Added bounded initialization, storage, write-blocking, and editor health states with safe recovery behavior.

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

[Unreleased]: https://github.com/sagmans/pi-history/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/sagmans/pi-history/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sagmans/pi-history/releases/tag/v0.1.0
