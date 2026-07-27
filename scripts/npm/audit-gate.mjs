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
const WAIVERS = [
	{
		url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
		node: "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
		reason:
			"dev-only; pinned by pi-coding-agent's published shrinkwrap; fixed by brace-expansion 5.0.8 once upstream regenerates it (earendil-works/pi#5653)",
	},
];

const FAILING_SEVERITIES = new Set(["high", "critical"]);

function isWaived(vulnerability) {
	const objectVias = vulnerability.via.filter((via) => typeof via === "object");
	if (objectVias.length === 0) return false;
	const waived = objectVias.every((via) =>
		WAIVERS.some(
			(waiver) =>
				waiver.url === via.url && (vulnerability.nodes ?? []).every((node) => node === waiver.node),
		),
	);
	return waived;
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
	const failing = vulnerabilities.filter(
		(vulnerability) => FAILING_SEVERITIES.has(vulnerability.severity) && !isWaived(vulnerability),
	);
	for (const vulnerability of failing) {
		console.error(`audit gate: ${vulnerability.severity} ${vulnerability.name}`);
	}
	if (failing.length > 0) {
		console.error(`audit gate: ${failing.length} unwaived high/critical vulnerabilit(y/ies)`);
		process.exit(1);
	}
	const waivedCount = vulnerabilities.filter(
		(vulnerability) => FAILING_SEVERITIES.has(vulnerability.severity) && isWaived(vulnerability),
	).length;
	console.log(`audit gate: pass (${waivedCount} waived)`);
}

main();
