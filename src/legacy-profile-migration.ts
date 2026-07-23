import { chmod, link, mkdir, mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { hasErrorCode } from "./guards.ts";
import { withMigrationLock } from "./migration-lock.ts";
import {
	assertRegularDirectoryIfExists,
	captureRegularDirectoryFiles,
	copyPrivateFile,
	ensurePrivateDirectory,
	filesEqual,
	pathExists,
	readOptionalPrivateText,
	readPrivateText,
	writePrivateFile,
} from "./migration-safe-files.ts";
import { PRIVATE_DIR_MODE } from "./project.ts";

const HISTORY_DIRECTORY_NAME = "pi-history";
const LEGACY_AGENT_PATH = path.join(".pi", "agent");
const MIGRATION_BUNDLE_NAME = "pi-history-profile-migration-v1";
const MIGRATION_COMPLETE_MARKER = ".complete";
const BUNDLE_INCOMPLETE_MARKER = ".pi-history-profile-migration-v1.incomplete";
const BUNDLE_CLAIM_FILE = ".pi-history-profile-migration-v1.claim";
const PROFILE_IMPORT_COMPLETE_MARKER = ".pi-history-profile-migration-v1.complete";
const PROFILE_IMPORT_INCOMPLETE_MARKER = ".pi-history-profile-migration-v1.incomplete";
const PROFILE_IMPORT_CLAIM_FILE = ".pi-history-profile-import-v1.claim";
const MIGRATION_VERSION = "1\n";
const SNAPSHOT_DIRECTORY_NAME = "snapshot";
const GLOBAL_HISTORY_FILE_NAME = "global.json";
const USER_CONFIG_FILE_NAMES = new Set(["config.json", "config.local.json"]);
const PROJECT_HISTORY_FILE_PATTERN = /^project-[a-f0-9]{64}\.json$/;
const MIGRATION_LOCK_NAME = ".pi-history-profile-migration-v1.lock";
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
	await assertRegularDirectoryIfExists(bundleDir);
	if (!(await migrationIsComplete(markerPath))) {
		events.push(
			await publishSnapshot({
				legacyAgentDir: input.legacyAgentDir,
				legacyHistoryDir,
				bundleDir,
				publishFile: input.publishFile,
			}),
		);
	} else {
		await cleanCompletedBundleClaim(input.legacyAgentDir, bundleDir);
	}

	if (
		await importSnapshot({
			agentDir: input.agentDir,
			snapshotDir,
			publishFile: input.publishFile,
		})
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
	const claimPath = path.join(input.legacyAgentDir, BUNDLE_CLAIM_FILE);
	let stageName = await readOptionalPrivateText(claimPath);
	if (stageName === undefined) {
		if (await pathExists(input.bundleDir)) {
			throw new Error("legacy migration bundle is incomplete");
		}
		const stageDir = await createBundleStage(input.legacyAgentDir, input.legacyHistoryDir);
		stageName = `${path.basename(stageDir)}\n`;
		try {
			await writePrivateFile(claimPath, stageName);
		} catch (error) {
			await rm(stageDir, { force: true, recursive: true });
			throw error;
		}
	}

	const stageDir = claimedBundleStage(input.legacyAgentDir, stageName);
	if (!(await assertRegularDirectoryIfExists(stageDir))) {
		throw new Error("legacy migration stage is missing");
	}
	const stageMarker = path.join(stageDir, MIGRATION_COMPLETE_MARKER);
	if (!(await migrationIsComplete(stageMarker))) {
		throw new Error("legacy migration stage is incomplete");
	}
	const stageSnapshotDir = path.join(stageDir, SNAPSHOT_DIRECTORY_NAME);
	const stagedSnapshot = await captureMigratableDirectory(stageSnapshotDir);
	await ensureOwnedBundle(input.bundleDir);
	if (stagedSnapshot && stagedSnapshot.fileNames.length > 0) {
		const publishedSnapshotDir = path.join(input.bundleDir, SNAPSHOT_DIRECTORY_NAME);
		await ensurePrivateDirectory(publishedSnapshotDir);
		for (const fileName of stagedSnapshot.fileNames) {
			await publishMissingFile(
				path.join(stageSnapshotDir, fileName),
				path.join(publishedSnapshotDir, fileName),
				input.publishFile,
			);
		}
	}
	await publishMissingFile(
		stageMarker,
		path.join(input.bundleDir, MIGRATION_COMPLETE_MARKER),
		input.publishFile,
	);
	await cleanupOwnedPublication({
		claimPath,
		incompleteMarker: path.join(input.bundleDir, BUNDLE_INCOMPLETE_MARKER),
		stageDir,
	});
	return stagedSnapshot && stagedSnapshot.fileNames.length > 0
		? "snapshot_created"
		: "snapshot_empty";
}

async function createBundleStage(
	legacyAgentDir: string,
	legacyHistoryDir: string,
): Promise<string> {
	const stageDir = await mkdtemp(path.join(legacyAgentDir, BUNDLE_STAGE_PREFIX));
	await chmod(stageDir, PRIVATE_DIR_MODE);
	try {
		const source = await captureMigratableDirectory(legacyHistoryDir);
		if (source && source.fileNames.length > 0) {
			const stageSnapshotDir = path.join(stageDir, SNAPSHOT_DIRECTORY_NAME);
			await mkdir(stageSnapshotDir, { mode: PRIVATE_DIR_MODE });
			for (const fileName of source.fileNames) {
				await copyPrivateFile(source, fileName, path.join(stageSnapshotDir, fileName));
			}
		}
		await writePrivateFile(path.join(stageDir, MIGRATION_COMPLETE_MARKER), MIGRATION_VERSION);
		return stageDir;
	} catch (error) {
		await rm(stageDir, { force: true, recursive: true });
		throw error;
	}
}

async function ensureOwnedBundle(bundleDir: string): Promise<void> {
	if (!(await assertRegularDirectoryIfExists(bundleDir))) {
		await mkdir(bundleDir, { mode: PRIVATE_DIR_MODE });
		await chmod(bundleDir, PRIVATE_DIR_MODE);
		await writePrivateFile(path.join(bundleDir, BUNDLE_INCOMPLETE_MARKER), MIGRATION_VERSION);
		return;
	}
	if (await migrationIsComplete(path.join(bundleDir, BUNDLE_INCOMPLETE_MARKER))) return;
	if ((await readdir(bundleDir)).length !== 0) {
		throw new Error("legacy migration bundle ownership is ambiguous");
	}
	// A durable external claim predates the directory, so an empty directory is
	// the only crash gap that can be resumed without merging foreign bytes.
	await writePrivateFile(path.join(bundleDir, BUNDLE_INCOMPLETE_MARKER), MIGRATION_VERSION);
}

async function cleanCompletedBundleClaim(legacyAgentDir: string, bundleDir: string): Promise<void> {
	const claimPath = path.join(legacyAgentDir, BUNDLE_CLAIM_FILE);
	const stageName = await readOptionalPrivateText(claimPath);
	if (stageName === undefined) return;
	const stageDir = claimedBundleStage(legacyAgentDir, stageName);
	await cleanupOwnedPublication({
		claimPath,
		incompleteMarker: path.join(bundleDir, BUNDLE_INCOMPLETE_MARKER),
		stageDir,
	});
}

function claimedBundleStage(legacyAgentDir: string, claim: string): string {
	const stageName = claim.trim();
	if (!stageName.startsWith(BUNDLE_STAGE_PREFIX) || path.basename(stageName) !== stageName) {
		throw new Error("legacy migration bundle claim is invalid");
	}
	return path.join(legacyAgentDir, stageName);
}

async function importSnapshot(input: {
	agentDir: string;
	snapshotDir: string;
	publishFile: PublishFile;
}): Promise<boolean> {
	const targetDir = path.join(input.agentDir, HISTORY_DIRECTORY_NAME);
	const claimPath = path.join(input.agentDir, PROFILE_IMPORT_CLAIM_FILE);
	const existingClaim = await readOptionalPrivateText(claimPath);
	if (existingClaim === undefined && (await pathExists(targetDir))) return false;
	if (existingClaim !== undefined && existingClaim !== MIGRATION_VERSION) {
		throw new Error("profile migration claim is invalid");
	}
	if (existingClaim !== undefined) await assertRegularDirectoryIfExists(targetDir);
	if (
		existingClaim !== undefined &&
		(await migrationIsComplete(path.join(targetDir, PROFILE_IMPORT_COMPLETE_MARKER)))
	) {
		await cleanupOwnedPublication({
			claimPath,
			incompleteMarker: path.join(targetDir, PROFILE_IMPORT_INCOMPLETE_MARKER),
		});
		return false;
	}

	const snapshot = await captureMigratableDirectory(input.snapshotDir);
	if (!snapshot || snapshot.fileNames.length === 0) {
		if (existingClaim !== undefined) {
			throw new Error("profile migration snapshot is unavailable");
		}
		return false;
	}
	await mkdir(input.agentDir, { recursive: true, mode: PRIVATE_DIR_MODE });
	const stageDir = await mkdtemp(path.join(input.agentDir, IMPORT_STAGE_PREFIX));
	await chmod(stageDir, PRIVATE_DIR_MODE);
	try {
		for (const fileName of snapshot.fileNames) {
			await copyPrivateFile(snapshot, fileName, path.join(stageDir, fileName));
		}
		await writePrivateFile(path.join(stageDir, PROFILE_IMPORT_COMPLETE_MARKER), MIGRATION_VERSION);
		const targetOwned = await ensureOwnedProfileTarget({
			claimPath,
			targetDir,
			claimExists: existingClaim !== undefined,
		});
		if (!targetOwned) return false;
		for (const fileName of snapshot.fileNames) {
			await publishMissingFile(
				path.join(stageDir, fileName),
				path.join(targetDir, fileName),
				input.publishFile,
			);
		}
		await publishMissingFile(
			path.join(stageDir, PROFILE_IMPORT_COMPLETE_MARKER),
			path.join(targetDir, PROFILE_IMPORT_COMPLETE_MARKER),
			input.publishFile,
		);
		await cleanupOwnedPublication({
			claimPath,
			incompleteMarker: path.join(targetDir, PROFILE_IMPORT_INCOMPLETE_MARKER),
		});
		return true;
	} finally {
		await rm(stageDir, { force: true, recursive: true });
	}
}

async function ensureOwnedProfileTarget(input: {
	claimPath: string;
	targetDir: string;
	claimExists: boolean;
}): Promise<boolean> {
	if (!input.claimExists) {
		await writePrivateFile(input.claimPath, MIGRATION_VERSION);
		if (!(await claimTargetDirectory(input.targetDir))) {
			await unlink(input.claimPath).catch(() => {});
			return false;
		}
		await writePrivateFile(
			path.join(input.targetDir, PROFILE_IMPORT_INCOMPLETE_MARKER),
			MIGRATION_VERSION,
		);
		return true;
	}
	if (!(await assertRegularDirectoryIfExists(input.targetDir))) {
		await mkdir(input.targetDir, { mode: PRIVATE_DIR_MODE });
		await chmod(input.targetDir, PRIVATE_DIR_MODE);
		await writePrivateFile(
			path.join(input.targetDir, PROFILE_IMPORT_INCOMPLETE_MARKER),
			MIGRATION_VERSION,
		);
		return true;
	}
	if (await migrationIsComplete(path.join(input.targetDir, PROFILE_IMPORT_INCOMPLETE_MARKER))) {
		return true;
	}
	if ((await readdir(input.targetDir)).length === 0) {
		await writePrivateFile(
			path.join(input.targetDir, PROFILE_IMPORT_INCOMPLETE_MARKER),
			MIGRATION_VERSION,
		);
		return true;
	}
	// A foreign writer won the mkdir race before our ownership marker. Its
	// target remains authoritative and no legacy bytes are merged into it.
	await unlink(input.claimPath).catch(() => {});
	return false;
}

async function publishMissingFile(
	sourcePath: string,
	targetPath: string,
	publishFile: PublishFile,
): Promise<void> {
	try {
		await publishFile(sourcePath, targetPath);
	} catch (error) {
		if (!(hasErrorCode(error, "EEXIST") && (await filesEqual(sourcePath, targetPath)))) {
			throw error;
		}
	}
}

async function cleanupOwnedPublication(input: {
	claimPath: string;
	incompleteMarker: string;
	stageDir?: string;
}): Promise<void> {
	await unlink(input.incompleteMarker).catch(() => {});
	await unlink(input.claimPath).catch(() => {});
	if (input.stageDir) await rm(input.stageDir, { force: true, recursive: true });
}

async function captureMigratableDirectory(directory: string) {
	return captureRegularDirectoryFiles(
		directory,
		(fileName) =>
			fileName === GLOBAL_HISTORY_FILE_NAME ||
			USER_CONFIG_FILE_NAMES.has(fileName) ||
			PROJECT_HISTORY_FILE_PATTERN.test(fileName),
	);
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
		return (await readPrivateText(markerPath)) === MIGRATION_VERSION;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
}
