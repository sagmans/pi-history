# Repository agent guidance

This repository accepts bug reports only. External pull requests and feature
requests are unsupported; read the [participation policy](CONTRIBUTING.md).

## Maintainer paths

- Setup: run `npm ci --ignore-scripts` from the repository root.
- Verification: run `npm run verify` while iterating and `npm run verify:ci`
  before pushing. [`README.md`](README.md#maintainer-development) documents the
  available checks.
- Runtime loading: follow the isolated
  [maintainer smoke test](docs/maintainer-smoke.md).
- Security: follow [`SECURITY.md`](SECURITY.md), including private vulnerability
  reporting and secret handling.
- Releases: follow [`RELEASE.md`](RELEASE.md); never invent or waive a release
  gate not recorded there.

## Privacy invariants

Never read, copy, log, or mutate real prompt history or `~/.pi/agent`. Runtime
checks must use the disposable `HOME` and `PI_CODING_AGENT_DIR` environment from
the maintainer smoke test. Use synthetic, redacted test data only.
