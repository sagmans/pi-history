import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
	type ConfigLayer,
	DEFAULT_ISOLATION_LEVEL,
	DEFAULT_MAX_ENTRIES,
	getExtensionRoot,
	IsolationLevel,
	loadPiHistoryConfig,
	normalizeConfig,
} from "../src/config.ts";

const SHIPPED_MAX_ENTRIES = 2_000;

function layer(value: unknown, origin = "config.json"): ConfigLayer {
	return { origin, value };
}

test("loads shipped config with managed history cap and global isolation", () => {
	// Empty user dir keeps the test hermetic; real user config must not leak in.
	withConfigFixture((_repoDir, userDir) => {
		const result = loadPiHistoryConfig(getExtensionRoot(), userDir);

		assert.equal(result.config.maxEntries, SHIPPED_MAX_ENTRIES);
		// Shipped config opts into global isolation so prompt history is shared
		// across repos on a host.
		assert.equal(result.config.isolationLevel, IsolationLevel.Global);
		assert.deepEqual(result.warnings, []);
	});
});

test("missing isolationLevel falls back to default", () => {
	const result = normalizeConfig([layer({ maxEntries: 100 })]);

	assert.equal(result.config.isolationLevel, DEFAULT_ISOLATION_LEVEL);
	assert.deepEqual(result.warnings, []);
});

test("tracked isolationLevel project is honored", () => {
	const result = normalizeConfig([layer({ isolationLevel: "project" })]);

	assert.equal(result.config.isolationLevel, IsolationLevel.Project);
	assert.deepEqual(result.warnings, []);
});

test("higher layer isolationLevel overrides lower value", () => {
	const result = normalizeConfig([
		layer({ isolationLevel: "project" }),
		layer({ isolationLevel: "global" }, "config.local.json"),
	]);

	assert.equal(result.config.isolationLevel, IsolationLevel.Global);
	assert.deepEqual(result.warnings, []);
});

test("invalid isolationLevel warns and falls back to default", () => {
	const invalidValue = normalizeConfig([layer({ isolationLevel: "host" })]);
	const invalidType = normalizeConfig([layer({ isolationLevel: 5 })]);

	assert.equal(invalidValue.config.isolationLevel, DEFAULT_ISOLATION_LEVEL);
	assert.match(invalidValue.warnings.join("\n"), /isolationLevel/);
	assert.equal(invalidType.config.isolationLevel, DEFAULT_ISOLATION_LEVEL);
	assert.match(invalidType.warnings.join("\n"), /project\|global/);
});

test("invalid higher-layer isolationLevel falls back to default instead of lower layer", () => {
	const result = normalizeConfig([
		layer({ isolationLevel: "project" }),
		layer({ isolationLevel: "bogus" }, "config.local.json"),
	]);

	assert.equal(result.config.isolationLevel, DEFAULT_ISOLATION_LEVEL);
	assert.match(result.warnings.join("\n"), /config\.local\.json/);
});

test("user local config overrides user config and shipped config", () => {
	withConfigFixture((repoDir, userDir) => {
		writeFileSync(path.join(repoDir, "config.json"), '{"maxEntries": 500}');
		writeFileSync(path.join(userDir, "config.json"), '{"maxEntries": 100}');
		writeFileSync(path.join(userDir, "config.local.json"), '{"maxEntries": 25}');

		const result = loadPiHistoryConfig(repoDir, userDir);

		assert.equal(result.config.maxEntries, 25);
		assert.deepEqual(result.warnings, []);
	});
});

test("user config overrides shipped config without a local layer", () => {
	withConfigFixture((repoDir, userDir) => {
		writeFileSync(path.join(repoDir, "config.json"), '{"maxEntries": 500}');
		writeFileSync(path.join(userDir, "config.json"), '{"maxEntries": 100}');

		const result = loadPiHistoryConfig(repoDir, userDir);

		assert.equal(result.config.maxEntries, 100);
		assert.deepEqual(result.warnings, []);
	});
});

test("invalid and non-positive caps fall back to default with warnings", () => {
	const invalidNumber = normalizeConfig([layer({ maxEntries: 0 })]);
	const invalidType = normalizeConfig([layer({ maxEntries: "500" })]);

	assert.equal(invalidNumber.config.maxEntries, DEFAULT_MAX_ENTRIES);
	assert.match(invalidNumber.warnings.join("\n"), /maxEntries/i);
	assert.equal(invalidType.config.maxEntries, DEFAULT_MAX_ENTRIES);
	assert.match(invalidType.warnings.join("\n"), /positive integer/i);
});

test("invalid higher-layer override falls back to default instead of lower layer", () => {
	const result = normalizeConfig([
		layer({ maxEntries: 250 }),
		layer({ maxEntries: -1 }, "config.local.json"),
	]);

	assert.equal(result.config.maxEntries, DEFAULT_MAX_ENTRIES);
	assert.match(result.warnings.join("\n"), /config\.local\.json/);
});

test("missing config files do not throw", () => {
	withConfigFixture((repoDir, userDir) => {
		const result = loadPiHistoryConfig(repoDir, userDir);

		assert.equal(result.config.maxEntries, DEFAULT_MAX_ENTRIES);
		assert.deepEqual(result.warnings, []);
	});
});

test("invalid JSON produces a runtime warning and defaults", () => {
	withConfigFixture((repoDir, userDir) => {
		writeFileSync(path.join(repoDir, "config.json"), "{");

		const result = loadPiHistoryConfig(repoDir, userDir);

		assert.equal(result.config.maxEntries, DEFAULT_MAX_ENTRIES);
		assert.match(result.warnings.join("\n"), /config\.json invalid/);
	});
});

test("invalid user JSON warns and keeps lower layers effective", () => {
	withConfigFixture((repoDir, userDir) => {
		writeFileSync(path.join(repoDir, "config.json"), '{"maxEntries": 300}');
		writeFileSync(path.join(userDir, "config.local.json"), "{");

		const result = loadPiHistoryConfig(repoDir, userDir);

		assert.equal(result.config.maxEntries, 300);
		assert.match(result.warnings.join("\n"), /config\.local\.json invalid/);
	});
});

function withConfigFixture(testBody: (repoDir: string, userDir: string) => void): void {
	const repoDir = mkdtempSync(path.join(tmpdir(), "pi-history-repo-"));
	const userDir = mkdtempSync(path.join(tmpdir(), "pi-history-user-"));
	try {
		testBody(repoDir, userDir);
	} finally {
		rmSync(repoDir, { force: true, recursive: true });
		rmSync(userDir, { force: true, recursive: true });
	}
}
