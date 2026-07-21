import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
	DEFAULT_ISOLATION_LEVEL,
	DEFAULT_MAX_ENTRIES,
	IsolationLevel,
	getExtensionRoot,
	loadPiHistoryConfig,
	normalizeConfig,
} from "../src/config.ts";

const SHIPPED_MAX_ENTRIES = 2_000;

test("loads shipped config with managed history cap and global isolation", () => {
	const result = loadPiHistoryConfig(getExtensionRoot());

	assert.equal(result.config.maxEntries, SHIPPED_MAX_ENTRIES);
	// Shipped config opts into global isolation so prompt history is shared
	// across repos on a host.
	assert.equal(result.config.isolationLevel, IsolationLevel.Global);
	assert.deepEqual(result.warnings, []);
});

test("missing isolationLevel falls back to default", () => {
	const result = normalizeConfig({ maxEntries: 100 });

	assert.equal(result.config.isolationLevel, DEFAULT_ISOLATION_LEVEL);
	assert.deepEqual(result.warnings, []);
});

test("tracked isolationLevel project is honored", () => {
	const result = normalizeConfig({ isolationLevel: "project" });

	assert.equal(result.config.isolationLevel, IsolationLevel.Project);
	assert.deepEqual(result.warnings, []);
});

test("local isolationLevel overrides tracked value", () => {
	const result = normalizeConfig(
		{ isolationLevel: "project" },
		{ isolationLevel: "global" },
	);

	assert.equal(result.config.isolationLevel, IsolationLevel.Global);
	assert.deepEqual(result.warnings, []);
});

test("invalid isolationLevel warns and falls back to default", () => {
	const invalidValue = normalizeConfig({ isolationLevel: "host" });
	const invalidType = normalizeConfig({ isolationLevel: 5 });

	assert.equal(invalidValue.config.isolationLevel, DEFAULT_ISOLATION_LEVEL);
	assert.match(invalidValue.warnings.join("\n"), /isolationLevel/);
	assert.equal(invalidType.config.isolationLevel, DEFAULT_ISOLATION_LEVEL);
	assert.match(invalidType.warnings.join("\n"), /project\|global/);
});

test("invalid local isolationLevel falls back to default instead of tracked config", () => {
	const result = normalizeConfig(
		{ isolationLevel: "project" },
		{ isolationLevel: "bogus" },
	);

	assert.equal(result.config.isolationLevel, DEFAULT_ISOLATION_LEVEL);
	assert.match(result.warnings.join("\n"), /config\.local\.json/);
});

test("local config overrides tracked maxEntries", () => {
	withConfigFixture((fixturePath) => {
		writeFileSync(path.join(fixturePath, "config.json"), '{"maxEntries": 500}');
		writeFileSync(path.join(fixturePath, "config.local.json"), '{"maxEntries": 25}');

		const result = loadPiHistoryConfig(fixturePath);

		assert.equal(result.config.maxEntries, 25);
		assert.deepEqual(result.warnings, []);
	});
});

test("invalid and non-positive caps fall back to default with warnings", () => {
	const invalidNumber = normalizeConfig({ maxEntries: 0 });
	const invalidType = normalizeConfig({ maxEntries: "500" });

	assert.equal(invalidNumber.config.maxEntries, DEFAULT_MAX_ENTRIES);
	assert.match(invalidNumber.warnings.join("\n"), /maxEntries/i);
	assert.equal(invalidType.config.maxEntries, DEFAULT_MAX_ENTRIES);
	assert.match(invalidType.warnings.join("\n"), /positive integer/i);
});

test("invalid local override falls back to default instead of tracked config", () => {
	const result = normalizeConfig({ maxEntries: 250 }, { maxEntries: -1 });

	assert.equal(result.config.maxEntries, DEFAULT_MAX_ENTRIES);
	assert.match(result.warnings.join("\n"), /config\.local\.json/);
});

test("missing config files do not throw", () => {
	withConfigFixture((fixturePath) => {
		const result = loadPiHistoryConfig(fixturePath);

		assert.equal(result.config.maxEntries, DEFAULT_MAX_ENTRIES);
		assert.deepEqual(result.warnings, []);
	});
});

test("invalid JSON produces a runtime warning and defaults", () => {
	withConfigFixture((fixturePath) => {
		writeFileSync(path.join(fixturePath, "config.json"), "{");

		const result = loadPiHistoryConfig(fixturePath);

		assert.equal(result.config.maxEntries, DEFAULT_MAX_ENTRIES);
		assert.match(result.warnings.join("\n"), /config\.json invalid/);
	});
});

function withConfigFixture(testBody: (fixturePath: string) => void): void {
	const fixturePath = mkdtempSync(path.join(tmpdir(), "pi-history-config-"));
	try {
		testBody(fixturePath);
	} finally {
		rmSync(fixturePath, { force: true, recursive: true });
	}
}
