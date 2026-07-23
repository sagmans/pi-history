import { strict as assert } from "node:assert";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareLegacyProfileMigration } from "../src/legacy-profile-migration.ts";

const LEGACY_AGENT_PATH = path.join(".pi", "agent");
const MIGRATION_BUNDLE_NAME = "pi-history-profile-migration-v1";
const HISTORY_DIRECTORY_NAME = "pi-history";
const MIGRATION_COMPLETE_MARKER = ".complete";
const PROFILE_IMPORT_COMPLETE_MARKER = ".pi-history-profile-migration-v1.complete";
const SNAPSHOT_DIRECTORY_NAME = "snapshot";
const SYNTHETIC_HISTORY = "synthetic history\n";
const PROJECT_HISTORY_FILE_NAME = `project-${"a".repeat(64)}.json`;
const SOURCE_DIRECTORY_MODE = 0o750;
const SOURCE_FILE_MODE = 0o640;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

test("absent legacy source freezes an empty migration bundle", async () => {
	await withMigrationFixture(async ({ homeDir, agentDir }) => {
		const result = await prepareLegacyProfileMigration({ homeDir, agentDir });
		const bundleDir = path.join(homeDir, LEGACY_AGENT_PATH, MIGRATION_BUNDLE_NAME);

		assert.deepEqual(result.events, ["snapshot_empty"]);
		assert.equal(existsSync(path.join(bundleDir, MIGRATION_COMPLETE_MARKER)), true);
		assert.equal(existsSync(path.join(bundleDir, SNAPSHOT_DIRECTORY_NAME)), false);
		assert.equal(existsSync(path.join(agentDir, HISTORY_DIRECTORY_NAME)), false);
	});
});

test("completed empty bundle ignores legacy data created after the cutoff", async () => {
	await withMigrationFixture(async ({ homeDir, agentDir }) => {
		await prepareLegacyProfileMigration({ homeDir, agentDir });
		const legacyHistoryDir = path.join(homeDir, LEGACY_AGENT_PATH, HISTORY_DIRECTORY_NAME);
		mkdirSync(legacyHistoryDir, { recursive: true });
		writeFileSync(path.join(legacyHistoryDir, "global.json"), SYNTHETIC_HISTORY);
		const laterAgentDir = path.join(path.dirname(agentDir), "later-profile");

		const result = await prepareLegacyProfileMigration({ homeDir, agentDir: laterAgentDir });

		assert.deepEqual(result.events, []);
		assert.equal(existsSync(path.join(laterAgentDir, HISTORY_DIRECTORY_NAME)), false);
	});
});

test("populated legacy source freezes and imports exact bytes privately", async () => {
	await withMigrationFixture(async ({ homeDir, agentDir }) => {
		const legacyHistoryDir = path.join(homeDir, LEGACY_AGENT_PATH, HISTORY_DIRECTORY_NAME);
		const sourceFile = path.join(legacyHistoryDir, "global.json");
		mkdirSync(legacyHistoryDir, { recursive: true, mode: SOURCE_DIRECTORY_MODE });
		writeFileSync(sourceFile, SYNTHETIC_HISTORY, { mode: SOURCE_FILE_MODE });
		const sourceMode = statSync(sourceFile).mode;

		const result = await prepareLegacyProfileMigration({ homeDir, agentDir });
		const bundleSnapshot = path.join(
			homeDir,
			LEGACY_AGENT_PATH,
			MIGRATION_BUNDLE_NAME,
			SNAPSHOT_DIRECTORY_NAME,
			"global.json",
		);
		const importedFile = path.join(agentDir, HISTORY_DIRECTORY_NAME, "global.json");

		assert.deepEqual(result.events, ["snapshot_created", "profile_imported"]);
		assert.equal(readFileSync(bundleSnapshot, "utf8"), SYNTHETIC_HISTORY);
		assert.equal(readFileSync(importedFile, "utf8"), SYNTHETIC_HISTORY);
		assert.equal(statSync(path.dirname(importedFile)).mode & 0o777, PRIVATE_DIRECTORY_MODE);
		assert.equal(statSync(importedFile).mode & 0o777, PRIVATE_FILE_MODE);
		assert.equal(
			statSync(path.join(path.dirname(importedFile), PROFILE_IMPORT_COMPLETE_MARKER)).mode & 0o777,
			PRIVATE_FILE_MODE,
		);
		assert.equal(readFileSync(sourceFile, "utf8"), SYNTHETIC_HISTORY);
		assert.equal(statSync(sourceFile).mode, sourceMode);
	});
});

test("migration copies only recognized direct regular data files", async () => {
	await withMigrationFixture(async ({ homeDir, agentDir }) => {
		const legacyHistoryDir = path.join(homeDir, LEGACY_AGENT_PATH, HISTORY_DIRECTORY_NAME);
		mkdirSync(legacyHistoryDir, { recursive: true });
		writeFileSync(path.join(legacyHistoryDir, "config.json"), "{}\n");
		writeFileSync(path.join(legacyHistoryDir, PROJECT_HISTORY_FILE_NAME), SYNTHETIC_HISTORY);
		writeFileSync(path.join(legacyHistoryDir, "notes.json"), "private note\n");
		writeFileSync(path.join(legacyHistoryDir, "global.json.tmp"), "temporary\n");
		const linkedSource = path.join(homeDir, "linked-config.json");
		writeFileSync(linkedSource, "{}\n");
		symlinkSync(linkedSource, path.join(legacyHistoryDir, "config.local.json"));
		mkdirSync(path.join(legacyHistoryDir, `${PROJECT_HISTORY_FILE_NAME}.lock`));

		await prepareLegacyProfileMigration({ homeDir, agentDir });
		const importedDir = path.join(agentDir, HISTORY_DIRECTORY_NAME);

		assert.deepEqual(readdirSync(importedDir).sort(), [
			PROFILE_IMPORT_COMPLETE_MARKER,
			"config.json",
			PROJECT_HISTORY_FILE_NAME,
		]);
	});
});

test("snapshot copy failure leaves no bundle or profile target", async () => {
	await withMigrationFixture(async ({ homeDir, agentDir }) => {
		const legacyHistoryDir = path.join(homeDir, LEGACY_AGENT_PATH, HISTORY_DIRECTORY_NAME);
		mkdirSync(legacyHistoryDir, { recursive: true });
		writeFileSync(path.join(legacyHistoryDir, "config.json"), "{}\n");
		const unreadableFile = path.join(legacyHistoryDir, "global.json");
		writeFileSync(unreadableFile, SYNTHETIC_HISTORY);
		chmodSync(unreadableFile, 0o000);

		await assert.rejects(prepareLegacyProfileMigration({ homeDir, agentDir }));

		assert.equal(existsSync(path.join(homeDir, LEGACY_AGENT_PATH, MIGRATION_BUNDLE_NAME)), false);
		assert.equal(existsSync(path.join(agentDir, HISTORY_DIRECTORY_NAME)), false);
	});
});

test("pre-existing incomplete bundle is preserved and blocks migration", async () => {
	await withMigrationFixture(async ({ homeDir, agentDir }) => {
		const bundleDir = path.join(homeDir, LEGACY_AGENT_PATH, MIGRATION_BUNDLE_NAME);
		const sentinelPath = path.join(bundleDir, "sentinel");
		mkdirSync(bundleDir, { recursive: true });
		writeFileSync(sentinelPath, "existing bundle bytes\n");

		await assert.rejects(prepareLegacyProfileMigration({ homeDir, agentDir }));

		assert.deepEqual(readdirSync(bundleDir), ["sentinel"]);
		assert.equal(readFileSync(sentinelPath, "utf8"), "existing bundle bytes\n");
		assert.equal(existsSync(path.join(agentDir, HISTORY_DIRECTORY_NAME)), false);
	});
});

test("concurrent initializers serialize one complete snapshot and import", async () => {
	await withMigrationFixture(async ({ homeDir, agentDir }) => {
		const legacyHistoryDir = path.join(homeDir, LEGACY_AGENT_PATH, HISTORY_DIRECTORY_NAME);
		mkdirSync(legacyHistoryDir, { recursive: true });
		writeFileSync(path.join(legacyHistoryDir, "global.json"), SYNTHETIC_HISTORY);

		const results = await Promise.all([
			prepareLegacyProfileMigration({ homeDir, agentDir }),
			prepareLegacyProfileMigration({ homeDir, agentDir }),
		]);
		const events = results.flatMap((result) => result.events);
		const importedFile = path.join(agentDir, HISTORY_DIRECTORY_NAME, "global.json");

		assert.deepEqual(events, ["snapshot_created", "profile_imported"]);
		assert.equal(readFileSync(importedFile, "utf8"), SYNTHETIC_HISTORY);
	});
});

test("existing populated profile target wins without byte or mode changes", async () => {
	await withMigrationFixture(async ({ homeDir, agentDir }) => {
		const legacyHistoryDir = path.join(homeDir, LEGACY_AGENT_PATH, HISTORY_DIRECTORY_NAME);
		mkdirSync(legacyHistoryDir, { recursive: true });
		writeFileSync(path.join(legacyHistoryDir, "global.json"), SYNTHETIC_HISTORY);
		const targetDir = path.join(agentDir, HISTORY_DIRECTORY_NAME);
		const targetFile = path.join(targetDir, "global.json");
		mkdirSync(targetDir, { recursive: true, mode: SOURCE_DIRECTORY_MODE });
		writeFileSync(targetFile, "existing target bytes\n", { mode: SOURCE_FILE_MODE });
		const targetMode = statSync(targetFile).mode;

		const result = await prepareLegacyProfileMigration({ homeDir, agentDir });

		assert.deepEqual(result.events, ["snapshot_created"]);
		assert.equal(readFileSync(targetFile, "utf8"), "existing target bytes\n");
		assert.equal(statSync(targetFile).mode, targetMode);
		assert.equal(existsSync(path.join(targetDir, PROFILE_IMPORT_COMPLETE_MARKER)), false);
	});
});

test("existing empty profile target wins unchanged", async () => {
	await withMigrationFixture(async ({ homeDir, agentDir }) => {
		const legacyHistoryDir = path.join(homeDir, LEGACY_AGENT_PATH, HISTORY_DIRECTORY_NAME);
		mkdirSync(legacyHistoryDir, { recursive: true });
		writeFileSync(path.join(legacyHistoryDir, "global.json"), SYNTHETIC_HISTORY);
		const targetDir = path.join(agentDir, HISTORY_DIRECTORY_NAME);
		mkdirSync(targetDir, { recursive: true, mode: SOURCE_DIRECTORY_MODE });
		const targetMode = statSync(targetDir).mode;

		await prepareLegacyProfileMigration({ homeDir, agentDir });

		assert.deepEqual(readdirSync(targetDir), []);
		assert.equal(statSync(targetDir).mode, targetMode);
	});
});

test("later profiles import the frozen cutoff instead of live legacy changes", async () => {
	await withMigrationFixture(async ({ homeDir, agentDir }) => {
		const legacyHistoryDir = path.join(homeDir, LEGACY_AGENT_PATH, HISTORY_DIRECTORY_NAME);
		const sourceFile = path.join(legacyHistoryDir, "global.json");
		mkdirSync(legacyHistoryDir, { recursive: true });
		writeFileSync(sourceFile, "before cutoff\n");
		await prepareLegacyProfileMigration({ homeDir, agentDir });
		writeFileSync(sourceFile, "after cutoff\n");
		const laterAgentDir = path.join(path.dirname(agentDir), "later-profile");

		const result = await prepareLegacyProfileMigration({ homeDir, agentDir: laterAgentDir });
		const importedFile = path.join(laterAgentDir, HISTORY_DIRECTORY_NAME, "global.json");

		assert.deepEqual(result.events, ["profile_imported"]);
		assert.equal(readFileSync(importedFile, "utf8"), "before cutoff\n");
		assert.equal(readFileSync(sourceFile, "utf8"), "after cutoff\n");
	});
});

test("removed snapshot retires future automatic imports without refreezing", async () => {
	await withMigrationFixture(async ({ homeDir, agentDir }) => {
		const legacyHistoryDir = path.join(homeDir, LEGACY_AGENT_PATH, HISTORY_DIRECTORY_NAME);
		const sourceFile = path.join(legacyHistoryDir, "global.json");
		mkdirSync(legacyHistoryDir, { recursive: true });
		writeFileSync(sourceFile, SYNTHETIC_HISTORY);
		await prepareLegacyProfileMigration({ homeDir, agentDir });
		const snapshotDir = path.join(
			homeDir,
			LEGACY_AGENT_PATH,
			MIGRATION_BUNDLE_NAME,
			SNAPSHOT_DIRECTORY_NAME,
		);
		rmSync(snapshotDir, { recursive: true });
		const laterAgentDir = path.join(path.dirname(agentDir), "later-profile");

		const result = await prepareLegacyProfileMigration({ homeDir, agentDir: laterAgentDir });

		assert.deepEqual(result.events, []);
		assert.equal(existsSync(path.join(laterAgentDir, HISTORY_DIRECTORY_NAME)), false);
	});
});

async function withMigrationFixture(
	testBody: (fixture: { homeDir: string; agentDir: string }) => Promise<void>,
): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "pi-history-migration-"));
	try {
		await testBody({
			homeDir: path.join(root, "home"),
			agentDir: path.join(root, "profiles", "custom"),
		});
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}
