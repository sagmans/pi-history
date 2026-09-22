#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// No advisory waivers exist. If a dependency pins a vulnerable version that
// cannot be overridden consumer-side, any waiver must be scoped
// to the exact advisory URLs and install path so a second occurrence of the
// same advisory elsewhere still fails the gate.
import { readFileSync } from "node:fs";

const FAILING_SEVERITIES = new Set(["high", "critical"]);

function auditReport(fixturePath) {
	if (fixturePath) {
		return JSON.parse(readFileSync(fixturePath, "utf8"));
	}
	const result = spawnSync("npm", ["audit", "--json"], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	return JSON.parse(result.stdout);
}

function main() {
	const fixtureIndex = process.argv.indexOf("--fixture");
	const report = auditReport(fixtureIndex === -1 ? undefined : process.argv[fixtureIndex + 1]);
	const vulnerabilities = Object.values(report.vulnerabilities ?? {});
	const failing = vulnerabilities.filter((vulnerability) =>
		FAILING_SEVERITIES.has(vulnerability.severity),
	);
	for (const vulnerability of failing) {
		console.error(`audit gate: ${vulnerability.severity} ${vulnerability.name}`);
	}
	if (failing.length > 0) {
		console.error(`audit gate: ${failing.length} high/critical vulnerabilit(y/ies)`);
		process.exit(1);
	}
	console.log("audit gate: pass");
}

main();
