# pi-history Runtime

Language for pi-history runtime scope and privacy-safe health reporting.

## Language

**History scope**:
The boundary within which captured prompts share one private history, either project or global.
_Avoid_: Project path, storage location

**Project scope**:
A history scope shared by linked worktrees of one Git repository, or by one non-Git working directory.
_Avoid_: Repository path, current folder

**Global scope**:
An opt-in history scope shared across projects within one active Pi profile.
_Avoid_: Host scope, user scope, system scope

**Diagnostic surface**:
The versioned, share-safe health metadata emitted only by `/pi-history status` in TUI mode.
_Avoid_: Warning, log, diagnostic warning

**Operational notice**:
A local runtime message intended for the current user, not a stable or share-safe diagnostic.
_Avoid_: Diagnostic, status output

**Diagnostic contract version**:
The integer identifying one exact status field vocabulary, order, presence rules, and meaning; any structural or semantic contract change requires a new value.
_Avoid_: History schema version, package version

**Runtime initialization**:
The TUI-session transition that establishes effective configuration, history scope identity, and a loaded storage state.
_Avoid_: Startup, editor initialization

**Healthy state**:
A diagnostic snapshot with successful initialization and no observed storage blocking, storage degradation, or editor degradation.
_Avoid_: Proven healthy, health check passed

**Initialization-failed state**:
A diagnostic state where configuration, scope identity, or storage could not be established.
_Avoid_: Write blocked, unavailable

**Write-blocked state**:
The top-level diagnostic category for a write-blocked condition.
_Avoid_: Storage-degraded state

**Write-blocked condition**:
A loaded storage condition that permits safe inspection but rejects prompt recording because stored history is corrupt, uses an unsupported schema, or belongs to another project scope. Clear recovery remains condition-specific.
_Avoid_: Initialization failure, storage degradation

**Unsupported-schema condition**:
A write-blocked condition where stored history declares a positive integer schema version this release cannot interpret. Recording and clearing remain blocked until a compatible migration path or release is available.
_Avoid_: Corrupt history, storage degradation

**Storage-degraded condition**:
A loaded storage condition where the latest record or clear mutation failed unexpectedly, without establishing a persistent safety block.
_Avoid_: Write blocked, initialization failure

**Storage-degraded state**:
The top-level diagnostic category for a storage-degraded condition.
_Avoid_: Write-blocked state

**Diagnostic snapshot**:
A point-in-time report of the latest observed runtime condition; readiness means no degradation has yet been observed, not an active health probe.
_Avoid_: Health check, diagnostic test

**Overall diagnostic state**:
The highest-priority category in one snapshot: initialization failure, write blocking, storage degradation, editor degradation, then healthy; lower-priority component detail remains present.
_Avoid_: Aggregate error, summary message

**Editor integration**:
The TUI capability that provides pi-history reverse search and ghost completion through the active editor.
_Avoid_: Editor, ghost feature

**Editor-unavailable condition**:
An editor-integration condition where pi-history cannot install its wrapper, leaving both reverse search and ghost completion absent.
_Avoid_: Ghost degradation

**Ghost-degraded condition**:
An editor-integration condition where reverse search remains available but ghost completion is absent.
_Avoid_: Editor unavailable, editor failure

**Editor-degraded state**:
The top-level diagnostic category covering either an editor-unavailable or ghost-degraded condition.
_Avoid_: Ghost-degraded condition

**SDK-compatible change**:
New pi-history behavior built only on documented Pi SDK contracts for the supported Pi version.
_Avoid_: Workaround, private API integration

**Non-TUI no-op**:
A pi-history presence in RPC, JSON, or print mode limited to static extension metadata, with no pi-history runtime state or side effects.
_Avoid_: Headless mode, unsupported mode

**Pi agent directory**:
Pi's canonical profile root returned by the supported `getAgentDir()` API.
_Avoid_: Home directory, global config directory

**Profile storage**:
pi-history configuration and prompt history owned by one Pi agent directory under its `pi-history/` child.
_Avoid_: User-wide storage, host history

**Frozen migration snapshot**:
The immutable pre-cutoff copy of recognized legacy pi-history files used only to seed absent profile storage without consulting the still-live default profile again.
_Avoid_: Backup, live migration source

**Migration-owned claim**:
Private versioned metadata that distinguishes resumable interrupted migration publication from unrelated pre-existing profile or bundle data.
_Avoid_: Lock, backup marker
