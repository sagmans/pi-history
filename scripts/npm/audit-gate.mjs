#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Release audit gate: fails on any high/critical advisory except explicitly
// waived ones. A waiver exists only when the vulnerable version is pinned
// inside a dependency's own published npm-shrinkwrap.json, which npm refuses
// to override consumer-side; each waiver names the exact install path so a
// second occurrence of the same advisory elsewhere still fails the gate.
import { readFileSync } from "node:fs";

// Re-examine on every Pi upgrade; tracked upstream at
// https://github.com/earendil-works/pi/issues/5653.
const WAIVED_ADVISORY_URL = "https://github.com/advisories/GHSA-mh99-v99m-4gvg";
const WAIVED_INSTALL_PATH =
	"node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";
const FAILING_SEVERITIES = new Set(["high", "critical"]);

function isWaived(vulnerability) {
	const objectVias = Array.isArray(vulnerability.via)
		? vulnerability.via.filter((via) => via && typeof via === "object")
		: [];
	const nodes = vulnerability.nodes;
	return (
		objectVias.length > 0 &&
		objectVias.every((via) => via.url === WAIVED_ADVISORY_URL) &&
		Array.isArray(nodes) &&
		nodes.length > 0 &&
		nodes.every((node) => node === WAIVED_INSTALL_PATH)
	);
}

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
	const relevant = vulnerabilities.filter((vulnerability) =>
		FAILING_SEVERITIES.has(vulnerability.severity),
	);
	const failing = relevant.filter((vulnerability) => !isWaived(vulnerability));
	for (const vulnerability of failing) {
		console.error(`audit gate: ${vulnerability.severity} ${vulnerability.name}`);
	}
	if (failing.length > 0) {
		console.error(`audit gate: ${failing.length} unwaived high/critical vulnerabilit(y/ies)`);
		process.exit(1);
	}
	console.log(`audit gate: pass (${relevant.length - failing.length} waived)`);
}

main();
