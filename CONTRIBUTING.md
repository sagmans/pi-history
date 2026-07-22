# Contributing

## Setup

Requires Node.js >= 22.19.0 (see [Supported environments](README.md#supported-environments)).

```bash
npm ci --ignore-scripts
npx husky   # one-time: opt into pre-commit/pre-push hooks (dev-only, never installed for users)
```

## Validate before pushing

```bash
npm run verify:ci   # high-severity audit + biome check + typecheck + tests
```

This is the authoritative maintainer gate and the command CI runs on Ubuntu
and macOS across Node 22.19.0 and 24. A PR is not mergeable while any matrix
leg is red.

`npm run verify` is the deterministic, offline subset for quick iteration.
For local extension loading, use the isolated
[maintainer smoke test](docs/maintainer-smoke.md); never point runtime checks at
real prompt history.

`npm run audit` is the network-dependent high-severity gate. It currently
reports the moderate `GHSA-j3f2-48v5-ccww` advisory in `protobufjs` 7.x. The
package is dev-only, nested inside `@earendil-works/pi-coding-agent`'s
shrinkwrap, and cannot be updated here until `@google/genai` moves off
`protobufjs` 7.x; reassess it with every pi dependency bump.

## Expectations

- **Tests and docs travel with behavior changes.** Every fix or feature
  ships with its regression test; user-visible changes update `README.md`.
- **Privacy is a hard constraint.** History data stays local, private
  (0700/0600), and project-isolated by default. Do not add network calls,
  telemetry, or cross-project reads without an explicit, documented opt-in.
- **Commit style:** Conventional Commits, DCO sign-off (`git commit -s`),
  GPG signature (`-S`). Explain *why*, not *what*.
- **Inbound = outbound:** by submitting a PR you certify your contribution
  is your own work (or you have rights to it) and license it under the
  project's MIT license (see [DCO](https://developercertificate.org)).

## Review

PRs are reviewed by the maintainer before merge. Squash merge; the PR title
becomes the commit subject, so keep it in Conventional Commits format.

## Releases

Maintainers only — see [RELEASE.md](RELEASE.md).

## Security

Do not file public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).
