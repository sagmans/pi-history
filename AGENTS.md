# Repository agent guidance

Never run pi-history runtime checks against real prompt history or
`~/.pi/agent`. Use the isolated [maintainer smoke test](docs/maintainer-smoke.md)
for local extension loading and `/pi-history status` verification.
