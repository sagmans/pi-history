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

Checks run in tracked local Git hooks instead of push/PR CI. The scripts live in `.githooks/<hook>.d/` and run through the global dotf hooks: the global check runs first, then each script in name order. There is no per-clone setup and no repo-local `core.hooksPath`; if an older setup left one, remove it with `git config --local --unset core.hooksPath`. Repository hooks run only after you review this clone's `.githooks` and trust it with `githooks-trust`; until then only the global checks run. Pre-push checks test exactly each pushed commit: in place only when it is the clean, unmodified checkout, otherwise in a temporary worktree of that commit.

This repository's checks:

- `pre-commit`: staged whitespace and conflict-marker check. Then Biome on the staged files.
- `pre-push`: `npm run verify:ci` (audit, Biome, typecheck, tests), then the Pi 1.1.0 compatibility check, installed with `npm ci --ignore-scripts` from the committed `compat/pi-1.1.0` lockfile (resolved with min-release-age=3).
