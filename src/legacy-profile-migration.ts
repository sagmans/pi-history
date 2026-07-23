import { constants } from "node:fs";
import {
	chmod,
	copyFile,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	rmdir,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { hasErrorCode } from "./guards.ts";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./project.ts";

const HISTORY_DIRECTORY_NAME = "pi-history";
const LEGACY_AGENT_PATH = path.join(".pi", "agent");
const MIGRATION_BUNDLE_NAME = "pi-history-profile-migration-v1";
const MIGRATION_COMPLETE_MARKER = ".complete";
const PROFILE_IMPORT_COMPLETE_MARKER = ".pi-history-profile-migration-v1.complete";
const MIGRATION_VERSION = "1\n";
const SNAPSHOT_DIRECTORY_NAME = "snapshot";
const GLOBAL_HISTORY_FILE_NAME = "global.json";
const USER_CONFIG_FILE_NAMES = new Set(["config.json", "config.local.json"]);
const PROJECT_HISTORY_FILE_PATTERN = /^project-[a-f0-9]{64}\.json$/;
const MIGRATION_LOCK_NAME = ".pi-history-profile-migration-v1.lock";
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_TIMEOUT_MS = 2_000;
const BUNDLE_STAGE_PREFIX = ".pi-history-profile-migration-v1-stage-";
const IMPORT_STAGE_PREFIX = ".pi-history-profile-import-v1-stage-";

export type LegacyProfileMigrationEvent =
	| "snapshot_created"
	| "snapshot_empty"
	| "profile_imported";

export type LegacyProfileMigrationResult = {
	events: LegacyProfileMigrationEvent[];
};

type PublishFile = (sourcePath: string, targetPath: string) => Promise<void>;

export async function prepareLegacyProfileMigration(
	input: { homeDir?: string; agentDir?: string; publishFile?: PublishFile } = {},
): Promise<LegacyProfileMigrationResult> {
	const legacyAgentDir = path.join(input.homeDir ?? homedir(), LEGACY_AGENT_PATH);
	await mkdir(legacyAgentDir, { recursive: true, mode: PRIVATE_DIR_MODE });
	return withMigrationLock(path.join(legacyAgentDir, MIGRATION_LOCK_NAME), () =>
		prepareLockedMigration({
			legacyAgentDir,
			agentDir: input.agentDir ?? getAgentDir(),
			publishFile: input.publishFile ?? link,
		}),
	);
}

async function prepareLockedMigration(input: {
	legacyAgentDir: string;
	agentDir: string;
	publishFile: PublishFile;
}): Promise<LegacyProfileMigrationResult> {
	const legacyHistoryDir = path.join(input.legacyAgentDir, HISTORY_DIRECTORY_NAME);
	const bundleDir = path.join(input.legacyAgentDir, MIGRATION_BUNDLE_NAME);
	const snapshotDir = path.join(bundleDir, SNAPSHOT_DIRECTORY_NAME);
	const markerPath = path.join(bundleDir, MIGRATION_COMPLETE_MARKER);
	const events: LegacyProfileMigrationEvent[] = [];
	if (!(await migrationIsComplete(markerPath))) {
		if (await pathExists(bundleDir)) throw new Error("legacy migration bundle is incomplete");
		events.push(
			await publishSnapshot({
				legacyAgentDir: input.legacyAgentDir,
				legacyHistoryDir,
				bundleDir,
				publishFile: input.publishFile,
			}),
		);
	}

	const snapshotFileNames = await migratableFileNames(snapshotDir);
	if (
		snapshotFileNames.length > 0 &&
		(await importSnapshot({
			agentDir: input.agentDir,
			snapshotDir,
			fileNames: snapshotFileNames,
			publishFile: input.publishFile,
		}))
	) {
		events.push("profile_imported");
	}
	return { events };
}

async function publishSnapshot(input: {
	legacyAgentDir: string;
	legacyHistoryDir: string;
	bundleDir: string;
	publishFile: PublishFile;
}): Promise<Extract<LegacyProfileMigrationEvent, "snapshot_created" | "snapshot_empty">> {
	const stageDir = await mkdtemp(path.join(input.legacyAgentDir, BUNDLE_STAGE_PREFIX));
	await chmod(stageDir, PRIVATE_DIR_MODE);
	try {
		const sourceFileNames = await migratableFileNames(input.legacyHistoryDir);
		const stageSnapshotDir = path.join(stageDir, SNAPSHOT_DIRECTORY_NAME);
		if (sourceFileNames.length > 0) {
			await mkdir(stageSnapshotDir, { mode: PRIVATE_DIR_MODE });
			for (const fileName of sourceFileNames) {
				await copyPrivateFile(
					path.join(input.legacyHistoryDir, fileName),
					path.join(stageSnapshotDir, fileName),
				);
			}
		}
		const stageMarkerPath = path.join(stageDir, MIGRATION_COMPLETE_MARKER);
		await writePrivateFile(stageMarkerPath, MIGRATION_VERSION);

		await mkdir(input.bundleDir, { mode: PRIVATE_DIR_MODE });
		await chmod(input.bundleDir, PRIVATE_DIR_MODE);
		if (sourceFileNames.length > 0) {
			const publishedSnapshotDir = path.join(input.bundleDir, SNAPSHOT_DIRECTORY_NAME);
			await mkdir(publishedSnapshotDir, { mode: PRIVATE_DIR_MODE });
			for (const fileName of sourceFileNames) {
				await input.publishFile(
					path.join(stageSnapshotDir, fileName),
					path.join(publishedSnapshotDir, fileName),
				);
			}
		}
		await input.publishFile(stageMarkerPath, path.join(input.bundleDir, MIGRATION_COMPLETE_MARKER));
		return sourceFileNames.length > 0 ? "snapshot_created" : "snapshot_empty";
	} finally {
		await rm(stageDir, { force: true, recursive: true });
	}
}

async function importSnapshot(input: {
	agentDir: string;
	snapshotDir: string;
	fileNames: readonly string[];
	publishFile: PublishFile;
}): Promise<boolean> {
	const targetDir = path.join(input.agentDir, HISTORY_DIRECTORY_NAME);
	if (await pathExists(targetDir)) return false;
	await mkdir(input.agentDir, { recursive: true, mode: PRIVATE_DIR_MODE });
	const stageDir = await mkdtemp(path.join(input.agentDir, IMPORT_STAGE_PREFIX));
	await chmod(stageDir, PRIVATE_DIR_MODE);
	try {
		for (const fileName of input.fileNames) {
			await copyPrivateFile(path.join(input.snapshotDir, fileName), path.join(stageDir, fileName));
		}
		const stageMarkerPath = path.join(stageDir, PROFILE_IMPORT_COMPLETE_MARKER);
		await writePrivateFile(stageMarkerPath, MIGRATION_VERSION);
		if (!(await claimTargetDirectory(targetDir))) return false;
		for (const fileName of input.fileNames) {
			await input.publishFile(path.join(stageDir, fileName), path.join(targetDir, fileName));
		}
		await input.publishFile(stageMarkerPath, path.join(targetDir, PROFILE_IMPORT_COMPLETE_MARKER));
		return true;
	} finally {
		await rm(stageDir, { force: true, recursive: true });
	}
}

async function withMigrationLock<Result>(
	lockPath: string,
	operation: () => Promise<Result>,
): Promise<Result> {
	await acquireMigrationLock(lockPath);
	try {
		return await operation();
	} finally {
		// Only release the empty lock we acquired; never recursively delete a path
		// another process may have replaced while migration was running.
		await rmdir(lockPath).catch(() => {});
	}
}

async function acquireMigrationLock(lockPath: string): Promise<void> {
	const startedAt = Date.now();
	for (;;) {
		try {
			await mkdir(lockPath, { mode: PRIVATE_DIR_MODE });
			return;
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST")) throw error;
			if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
				throw new Error("timed out waiting for legacy migration lock");
			}
			await delay(LOCK_RETRY_DELAY_MS);
		}
	}
}

async function pathExists(candidate: string): Promise<boolean> {
	try {
		await lstat(candidate);
		return true;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
}

async function migratableFileNames(directory: string): Promise<string[]> {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		return entries
			.filter(
				(entry) =>
					entry.isFile() &&
					(entry.name === GLOBAL_HISTORY_FILE_NAME ||
						USER_CONFIG_FILE_NAMES.has(entry.name) ||
						PROJECT_HISTORY_FILE_PATTERN.test(entry.name)),
			)
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return [];
		throw error;
	}
}

async function copyPrivateFile(sourcePath: string, targetPath: string): Promise<void> {
	await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
	await chmod(targetPath, PRIVATE_FILE_MODE);
}

async function writePrivateFile(filePath: string, content: string): Promise<void> {
	await writeFile(filePath, content, {
		encoding: "utf8",
		flag: "wx",
		mode: PRIVATE_FILE_MODE,
	});
	await chmod(filePath, PRIVATE_FILE_MODE);
}

async function claimTargetDirectory(targetDir: string): Promise<boolean> {
	try {
		await mkdir(targetDir, { mode: PRIVATE_DIR_MODE });
		await chmod(targetDir, PRIVATE_DIR_MODE);
		return true;
	} catch (error) {
		if (hasErrorCode(error, "EEXIST")) return false;
		throw error;
	}
}

async function migrationIsComplete(markerPath: string): Promise<boolean> {
	try {
		return (await readFile(markerPath, "utf8")) === MIGRATION_VERSION;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
}
