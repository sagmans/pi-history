# Maintainer development

Owner-authorized maintenance. Public bug reports are welcome; external pull
requests and feature requests are not accepted — see the
[participation policy](https://github.com/sagmans/pi-history/blob/main/CONTRIBUTING.md).
For behaviour and install, see [`README.md`](../README.md).

Requires Node.js >= 22.19.0 (tests use `node --experimental-transform-types`).

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

The audit currently reports moderate `GHSA-j3f2-48v5-ccww` in the dev-only
`protobufjs` copy nested under pi; reassess it with every pi dependency update.

Two biome rules are disabled in `biome.json` on purpose (inline comments in
biome.json silently break rule overrides, so the rationale lives here):

- `suspicious/noConfusingVoidType` — `PiHistoryApi` mirrors pi's own
  `ExtensionAPI` handler signatures, which use `| void` unions.
- `suspicious/noControlCharactersInRegex` — the display sanitizer exists
  precisely to match C0/C1 control characters.

Git hooks via husky: pre-commit runs `npm run check`, pre-push runs
`npm run typecheck && npm test`. Hooks are dev-only: there is deliberately no
`prepare` script, because pi runs `npm install` inside its package clones and
hooks must never install on user machines. Maintainers opt in once after
cloning:

```bash
npx husky
```
