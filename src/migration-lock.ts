import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, rmdir, unlink, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { hasErrorCode, isPositiveInteger, isRecord } from "./guards.ts";
import { readPrivateText, writePrivateFile } from "./migration-safe-files.ts";
import { PRIVATE_DIR_MODE } from "./project.ts";

const LOCK_OWNER_FILE = "owner.json";
const LOCK_RETRY_DELAY_MS = 25;
const OWNERLESS_LOCK_STALE_MS = 30_000;
const REMOTE_LOCK_STALE_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_STALE_MS = 30_000;

type MigrationLockOwner = {
	pid: number;
	host: string;
	createdAt: string;
	token: string;
};

export type MigrationLockTiming = {
	heartbeatIntervalMs: number;
	heartbeatStaleMs: number;
};

export async function withMigrationLock<Result>(
	lockPath: string,
	operation: () => Promise<Result>,
	timing?: Partial<MigrationLockTiming>,
): Promise<Result> {
	const heartbeatStaleMs = timing?.heartbeatStaleMs ?? HEARTBEAT_STALE_MS;
	const owner = await acquireMigrationLock(lockPath, heartbeatStaleMs);
	const heartbeat = startOwnerHeartbeat(
		path.join(lockPath, LOCK_OWNER_FILE),
		timing?.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
	);
	try {
		return await operation();
	} finally {
		heartbeat.stop();
		await removeOwnedLock(lockPath, owner.token);
	}
}

// A reused PID can fake process existence but cannot refresh this file, so the
// heartbeat is the portable proof that the original owner is still alive.
function startOwnerHeartbeat(ownerPath: string, intervalMs: number): { stop: () => void } {
	const timer = setInterval(() => {
		const now = new Date();
		utimes(ownerPath, now, now).catch(() => {});
	}, intervalMs);
	timer.unref();
	return { stop: () => clearInterval(timer) };
}

async function acquireMigrationLock(
	lockPath: string,
	heartbeatStaleMs: number,
): Promise<MigrationLockOwner> {
	for (;;) {
		try {
			await mkdir(lockPath, { mode: PRIVATE_DIR_MODE });
			const owner = createMigrationLockOwner();
			try {
				await writePrivateFile(path.join(lockPath, LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`);
			} catch (error) {
				await rmdir(lockPath).catch(() => {});
				throw error;
			}
			return owner;
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST")) throw error;
			if (await reclaimAbandonedMigrationLock(lockPath, heartbeatStaleMs)) continue;
			// Live migration owns the cutoff boundary; waiting is safer than
			// allowing writable initialization to race ahead of the snapshot.
			await delay(LOCK_RETRY_DELAY_MS);
		}
	}
}

function createMigrationLockOwner(): MigrationLockOwner {
	return {
		pid: process.pid,
		host: hostname(),
		createdAt: new Date().toISOString(),
		token: randomUUID(),
	};
}

async function reclaimAbandonedMigrationLock(
	lockPath: string,
	heartbeatStaleMs: number,
): Promise<boolean> {
	let lockStats: Stats;
	try {
		lockStats = await lstat(lockPath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return true;
		throw error;
	}
	if (!lockStats.isDirectory()) throw new Error("migration lock is unsafe");
	const owner = await readMigrationLockOwner(lockPath);
	if (owner) {
		if (await migrationLockOwnerIsActive(lockPath, owner, heartbeatStaleMs)) return false;
		return removeOwnedLock(lockPath, owner.token);
	}
	if (Date.now() - lockStats.mtimeMs <= OWNERLESS_LOCK_STALE_MS) return false;
	let entries: string[];
	try {
		entries = await readdir(lockPath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return true;
		throw error;
	}
	if (entries.length === 1 && entries[0] === LOCK_OWNER_FILE) {
		const ownerPath = path.join(lockPath, LOCK_OWNER_FILE);
		const ownerStats = await lstat(ownerPath).catch(() => undefined);
		if (!ownerStats?.isFile()) return false;
		if (await readMigrationLockOwner(lockPath)) return false;
		await unlink(ownerPath).catch(() => {});
	}
	return rmdir(lockPath)
		.then(() => true)
		.catch(() => false);
}

async function removeOwnedLock(lockPath: string, token: string): Promise<boolean> {
	const current = await readMigrationLockOwner(lockPath);
	if (current?.token !== token) return false;
	await unlink(path.join(lockPath, LOCK_OWNER_FILE)).catch(() => {});
	return rmdir(lockPath)
		.then(() => true)
		.catch(() => false);
}

async function readMigrationLockOwner(lockPath: string): Promise<MigrationLockOwner | undefined> {
	try {
		return normalizeMigrationLockOwner(
			JSON.parse(await readPrivateText(path.join(lockPath, LOCK_OWNER_FILE))),
		);
	} catch {
		return undefined;
	}
}

function normalizeMigrationLockOwner(raw: unknown): MigrationLockOwner | undefined {
	if (!isRecord(raw)) return undefined;
	if (!isPositiveInteger(raw.pid)) return undefined;
	if (typeof raw.host !== "string") return undefined;
	if (typeof raw.createdAt !== "string") return undefined;
	if (typeof raw.token !== "string" || raw.token.length === 0) return undefined;
	return {
		pid: raw.pid,
		host: raw.host,
		createdAt: raw.createdAt,
		token: raw.token,
	};
}

async function migrationLockOwnerIsActive(
	lockPath: string,
	owner: MigrationLockOwner,
	heartbeatStaleMs: number,
): Promise<boolean> {
	if (owner.host !== hostname()) {
		const createdAt = Date.parse(owner.createdAt);
		return Number.isFinite(createdAt) && Date.now() - createdAt <= REMOTE_LOCK_STALE_MS;
	}
	try {
		process.kill(owner.pid, 0);
	} catch {
		return false;
	}
	// The PID is alive, but that may be an unrelated process after PID reuse;
	// only a fresh heartbeat proves the original owner still holds the lock.
	const ownerStats = await lstat(path.join(lockPath, LOCK_OWNER_FILE)).catch(() => undefined);
	if (!ownerStats) return false;
	return Date.now() - ownerStats.mtimeMs <= heartbeatStaleMs;
}
