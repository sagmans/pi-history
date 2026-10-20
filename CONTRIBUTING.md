# Participation policy

This project accepts public bug reports and feature requests. Reporting a feature
request does not guarantee evaluation or implementation. External pull requests,
support requests, and implementation proposals are not accepted. Unsolicited pull
requests will be closed.

## Report a bug

Use the repository's [bug report form](https://github.com/sagmans/pi-history/issues/new?template=bug_report.yml)
and include:

- affected pi-history version or commit,
- operating system, Node.js version, pi version, and terminal,
- minimal reproduction steps,
- expected and actual behavior,
- synthetic or redacted diagnostic evidence.

## Request a feature

Use the repository's [feature request form](https://github.com/sagmans/pi-history/issues/new?template=feature_request.yml)
and include:

- the problem or use case,
- the requested behavior,
- current workarounds or alternatives.

Search existing issues before filing a bug report or feature request. Never include
prompt contents, credentials, private paths, or other sensitive data.

## Security reports

Do not report vulnerabilities publicly. Follow the private process in
[`SECURITY.md`](SECURITY.md).

## Custom behavior

Fork the repository and maintain the fork for features, integrations, or policy
changes outside this project's scope. The maintainer cannot provide design,
implementation, review, release, or support services for forks.

## Git hooks

Checks run in tracked local Git hooks instead of push/PR CI. Run `scripts/setup-hooks` once after cloning; it points this clone's `core.hooksPath` at `.githooks`. Each hook runs the generic checks first (sign-off and commit message format, a gitleaks secret scan, and signed, signed-off commits on push), then this repository's checks in `.githooks/<hook>.d/` in name order. Install [gitleaks](https://github.com/gitleaks/gitleaks) first. Every check must pass before you push; never use `--no-verify`. Pre-push checks test exactly each pushed commit: in place only when it is the clean, unmodified checkout, otherwise in a temporary worktree of that commit.

This repository's checks:

- `pre-commit`: staged whitespace and conflict-marker check. Then Biome on the staged files.
- `pre-push`: `npm run verify:ci` (audit, Biome, typecheck, tests), then the Pi 1.1.0 and 1.3.0 compatibility checks, each installed with `npm ci --ignore-scripts` from its committed `compat/pi-<version>` lockfile (resolved with min-release-age=3).
