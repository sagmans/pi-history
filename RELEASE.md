# Release Policy

Applies to maintainers. Current release owner: repository owner
([`LICENSE`](LICENSE)).

## Versioning

[SemVer](https://semver.org). While at 0.x, minor bumps may contain breaking
changes; patch bumps are fixes only. The git tag (`vX.Y.Z`) and
`package.json` `version` must always match.

## Gates — all required before tagging

1. Candidate lands on `main` through a reviewed PR (squash merge).
2. Full CI matrix green on the exact merged SHA: Ubuntu + macOS ×
   Node 22.19.0 + 24, audit gate included.
3. `npm run verify:ci` green locally for the maintainer.
4. Install smoke in a disposable pi home against the exact SHA:

   ```bash
   HOME=$(mktemp -d) pi install git:github.com/sagmans/pi-history@<sha>
   ```

   Exercise: prompt capture, restart persistence, `/pi-history status`,
   `/pi-history clear`, `Ctrl+R`, ghost completion or its graceful fallback.
5. README accuracy pass: every documented command/path/config key still
   behaves as written.
6. Changelog roll-forward: `CHANGELOG.md` carries a new dated `[X.Y.Z]`
   section for the target version with the relevant `Unreleased` entries,
   and exactly one `Unreleased` section remains.
7. Waiver evidence (only if a gate above is waived): a durable, SHA-bound
   waiver record written by the release owner exists against the exact
   candidate SHA. With no waiver record, the tag cannot be created and
   publication cannot be approved.

A gate may only be waived by the release owner. The waiver rationale is
recorded against the exact candidate SHA before tagging (gate 7) and
reproduced in the published GitHub release notes after publication; the
SHA-bound waiver record — not the later GitHub release — is what authorizes
the tag and publication approval.

## Tagging

Draft the GitHub release notes against the candidate SHA before tagging:
user-facing changes, fixes, contributors, and any pre-recorded gate waivers.
These drafted notes become the GitHub release only after npm publication
succeeds.

```bash
git tag -s -a vX.Y.Z -m "vX.Y.Z" <merged-sha>
git push origin vX.Y.Z
```

Tag creation for `v*` is restricted to repository admins by a ruleset. The
tag push triggers the `release` workflow: it re-verifies the candidate and
then waits for the release owner's approval on the `npm-release` environment
before publishing to npm via OIDC trusted publishing (no npm token is stored
anywhere; provenance attestations are generated automatically). A waived gate
cannot clear this approval without the SHA-bound waiver record from gate 7.

After publication, create the GitHub release from the tag using the drafted
notes.

## npm trusted publishing

After the scoped-package bootstrap, the npm package accepts publishes only
from the `release` workflow of this repository on the `npm-release`
environment, configured under package settings on npmjs.com. Package settings
must also be set to "Require
two-factor authentication and disallow tokens" so the OIDC flow is the only
publish path. The release owner is the sole package maintainer.

The reusable [CLI-only setup guide](docs/npm-release-setup.md) provisions
npm and GitHub controls through independent scripts under [`scripts/npm/`](scripts/npm/).
The GitHub step is idempotent; every remote mutation supports dry-run and
requires an action-specific confirmation value.

### Scoped-package bootstrap (`v0.1.3` only)

npm requires a package to exist before trusted publishing can be configured.
The release workflow therefore verifies `v0.1.3` but skips its publish job.
After that tag's verify job succeeds, the release owner publishes from a clean
checkout of the exact signed tag:

```bash
npm publish --access public
```

Local publication cannot generate npm provenance; provenance begins with later
OIDC releases from the supported GitHub-hosted runner. Then configure
`@sagmans/pi-history` to trust this repository's
`.github/workflows/release.yml` workflow and `npm-release` environment, with
`npm publish` explicitly allowed. Require two-factor authentication and
disallow tokens before any later release. Releases after `v0.1.3` use the
approval-gated OIDC publish job and automatic provenance normally.

### Retire the unscoped package

Only after `@sagmans/pi-history@0.1.3` is publicly installable and its package
metadata points to this repository, deprecate—never unpublish—the old package:

```bash
npm deprecate "pi-history@*" "Moved to @sagmans/pi-history; migrate with: pi remove npm:pi-history && pi install npm:@sagmans/pi-history"
```

Existing pi settings keep the old npm identity until users migrate explicitly.
Runtime configuration and prompt history remain under
`~/.pi/agent/pi-history/`; migration must not read or rewrite them.

## Rollback

- **Bad tag/release:** keep the signed tag, source SHA, and GitHub release
  record intact. npm versions are immutable, and deleting these references
  breaks the source/notes chain and allows accidental tag-name reuse.
  Instead, deprecate the broken npm version with a reason and replacement:

  ```bash
  npm deprecate "@sagmans/pi-history@<version>" "<reason>; use @sagmans/pi-history@<replacement> instead"
  ```

  Edit the GitHub release notes to mark the version broken and point at the
  replacement, and publish a patch release restoring correct
  behavior (forward-fix preferred over history rewrite or unpublish). This
  preserves version → tag → source SHA → warning → replacement traceability.
- **Bad default/config:** patch release; never silently rewrite user config
  under `~/.pi/agent/pi-history/`.
- **History data:** the store must never delete or rewrite a history file it
  does not recognize (project-mismatch protection). Any schema change
  requires a migration plan in the PR and a note in the release notes.
