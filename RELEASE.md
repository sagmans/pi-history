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
3. `npm run verify` green locally for the maintainer.
4. Install smoke in a disposable pi home against the exact SHA:

   ```bash
   HOME=$(mktemp -d) pi install git:github.com/sagmans/pi-history@<sha>
   ```

   Exercise: prompt capture, restart persistence, `/pi-history status`,
   `/pi-history clear`, `Ctrl+R`, ghost completion or its graceful fallback.
5. README accuracy pass: every documented command/path/config key still
   behaves as written.

A gate may only be waived by the release owner, in writing, in the release
notes.

## Tagging

```bash
git tag -s -a vX.Y.Z -m "vX.Y.Z" <merged-sha>
git push origin vX.Y.Z
```

Then create a GitHub release from the tag with notes: user-facing changes,
fixes, contributors, and any waived gates.

## Rollback

- **Bad tag:** delete the GitHub release and tag, publish a patch release
  restoring correct behavior (forward-fix preferred over history rewrite).
- **Bad default/config:** patch release; never silently rewrite user config
  under `~/.pi/agent/pi-history/`.
- **History data:** the store must never delete or rewrite a history file it
  does not recognize (project-mismatch protection). Any schema change
  requires a migration plan in the PR and a note in the release notes.
