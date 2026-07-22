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
