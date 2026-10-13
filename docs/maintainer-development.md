# Maintainer development

The `pre-push` hook also runs typecheck and tests against Pi 1.1.0 in a throwaway copy.
The locked baseline remains unchanged so older supported hosts retain coverage.

Owner-authorized maintenance. Public bug reports and feature requests can be filed.
Feature requests do not guarantee evaluation or implementation. External pull
requests and support requests are not accepted. See the
[participation policy](https://github.com/sagmans/pi-history/blob/main/CONTRIBUTING.md).
For behaviour and install, see [`README.md`](../README.md).

Requires Node.js >= 22.19.0 (tests use native type stripping; `erasableSyntaxOnly` keeps the sources strippable).

```bash
npm ci --ignore-scripts
npm run check       # biome lint + format
npm run check:fix   # apply biome fixes
npm run typecheck
npm run test
npm run test:npm     # isolated fake-CLI coverage for npm release setup
npm run verify       # deterministic offline checks
npm run audit        # network-dependent high-severity dependency gate
npm run verify:ci    # complete maintainer and CI gate
npm run smoke:herdr  # disposable real-TUI smoke; Herdr maintainers only
```

`npm run verify:ci` is the authoritative maintainer gate and runs in every CI
matrix leg. `npm run verify` is its deterministic offline subset. The Herdr
smoke remains outside CI; see
[`docs/maintainer-smoke.md`](https://github.com/sagmans/pi-history/blob/main/docs/maintainer-smoke.md).

The npm setup shell suite is part of `npm test`; it never contacts npm or
GitHub. Maintainers with ShellCheck available can additionally run:

```bash
shellcheck -x --shell=bash scripts/npm/*.sh scripts/npm/lib/*.sh test/npm/*.sh
```

The audit currently requires no advisory waivers. Reassess the full report with
every pi dependency update; any future waiver must follow the exact-path,
owner-approved policy in [`SECURITY.md`](../SECURITY.md).

Two biome rules are disabled in `biome.json` on purpose (inline comments in
biome.json silently break rule overrides, so the rationale lives here):

- `suspicious/noConfusingVoidType` — `PiHistoryApi` mirrors pi's own
  `ExtensionAPI` handler signatures, which use `| void` unions.
- `suspicious/noControlCharactersInRegex` — the display sanitizer exists
  precisely to match C0/C1 control characters.

Git hooks live in `.githooks/`: pre-commit runs Biome on the staged files, pre-push runs
`npm run verify:ci` and the Pi compatibility check on each pushed commit. Each hook runs the global hook of the same name first.
Hooks are dev-only: there is deliberately no `prepare` script, because pi runs
`npm install` inside its package clones and hooks must never install on user
machines. Maintainers trust each clone once with `githooks-trust`; the global dotf hooks
then run `.githooks/<hook>.d/` (no repo-local `core.hooksPath`).
