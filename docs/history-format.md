# History format and downgrade behavior

How pi-history persists prompt history, when the format changes on disk, and
what older releases do afterward. This document is normative: tests in
`test/history-store.test.ts` encode the same contract.

## Versions

| Schema | Shipped in | Clear lineage |
| ------ | ---------- | ------------- |
| 1 | 0.1.0 – 0.1.4 | `clearedAt` timestamp only |
| 2 | never released | reusable `clearGeneration` counter |
| 3 | next release | opaque per-clear `clearEpoch` |

Schema 2 existed only on a development branch. The runtime still migrates it
so disposable and pre-release installs are never stranded.

## When the on-disk format changes

The format upgrades lazily. Existing history is read and normalized in memory
without touching the file. The first **mutation** — recording a prompt or
confirming `/pi-history clear` — rewrites the file in the newest schema.
Until that moment the bytes are identical to what the older release wrote,
and no data is lost or converted.

## Downgrade behavior

Releases older than the writer fail closed:

- Before the first mutation, an older release reads its own bytes normally —
  nothing has changed yet.
- After the first mutation, an older release sees an unsupported schema,
  blocks record and clear, and preserves the file byte for byte. Status
  remains available and reports the blocked state without exposing content.

A mixed-version fleet (two machines or profiles sharing one history location)
therefore degrades to read-only on the older release instead of corrupting or
silently dropping clear-lineage metadata.

## Recovery

Return to a release that understands the newest schema; do not edit, trim, or
regenerate the history file by hand. Manual edits can mint false lineages or
destroy clear evidence, and the format treats malformed content as corruption
that only a confirmed clear can replace.

## Rollback expectations

- Schema 1 and 2 files migrate forward losslessly, including their clear
  markers.
- There is no supported path from schema 3 back to an older format; older
  releases fail closed by design.
- `clearedAt` is informational metadata. Causal ordering of clears comes from
  `clearEpoch`, never from wall-clock time.
