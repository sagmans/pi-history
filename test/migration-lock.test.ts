import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { withMigrationLock } from "../src/migration-lock.ts";

const OWNER_FILE_NAME = "owner.json";

test("withMigrationLock reclaims a dead owner", async () => {
	await withFixture(async (lockPath) => {
		mkdirSync(lockPath);
		writeOwner(lockPath, {
			pid: 999_999,
			host: hostname(),
			createdAt: "2000-01-01T00:00:00.000Z",
			token: "dead-owner",
		});

		const result = await withMigrationLock(lockPath, async () => "completed");

		assert.equal(result, "completed");
		assert.equal(existsSync(lockPath), false);
	});
});

test("withMigrationLock reclaims a stale malformed owner file", async () => {
	await withFixture(async (lockPath) => {
		mkdirSync(lockPath);
		writeFileSync(path.join(lockPath, OWNER_FILE_NAME), "malformed owner\n");
		const staleTime = new Date("2000-01-01T00:00:00.000Z");
		utimesSync(lockPath, staleTime, staleTime);
		const waiting = withMigrationLock(lockPath, async () => "completed");
		const completedBeforeCleanup = await Promise.race([
			waiting.then(() => true),
			delay(100).then(() => false),
		]);
		if (!completedBeforeCleanup) rmSync(lockPath, { force: true, recursive: true });
		await waiting;

		assert.equal(completedBeforeCleanup, true);
		assert.equal(existsSync(lockPath), false);
	});
});

test("withMigrationLock retries when a contended lock disappears", async () => {
	await withFixture(async (lockPath) => {
		mkdirSync(lockPath);
		writeOwner(lockPath, {
			pid: process.pid,
			host: hostname(),
			createdAt: new Date().toISOString(),
			token: "departing-owner",
		});
		const waiting = withMigrationLock(lockPath, async () => "completed");
		rmSync(lockPath, { force: true, recursive: true });

		const result = await waiting;

		assert.equal(result, "completed");
		assert.equal(existsSync(lockPath), false);
	});
});

test("withMigrationLock waits for a live owner", async () => {
	await withFixture(async (lockPath) => {
		mkdirSync(lockPath);
		writeOwner(lockPath, {
			pid: process.pid,
			host: hostname(),
			createdAt: new Date().toISOString(),
			token: "live-owner",
		});
		let entered = false;
		const waiting = withMigrationLock(lockPath, async () => {
			entered = true;
		});
		await delay(50);
		assert.equal(entered, false);
		rmSync(lockPath, { force: true, recursive: true });

		await waiting;

		assert.equal(entered, true);
	});
});

test("withMigrationLock reclaims an abandoned lock whose PID was reused", async () => {
	await withFixture(async (lockPath) => {
		mkdirSync(lockPath);
		const ownerPath = path.join(lockPath, OWNER_FILE_NAME);
		writeOwner(lockPath, {
			// Alive but unrelated: a reused PID never heartbeats this lock.
			pid: process.pid,
			host: hostname(),
			createdAt: new Date().toISOString(),
			token: "reused-pid-owner",
		});
		const staleTime = new Date(Date.now() - 10_000);
		utimesSync(ownerPath, staleTime, staleTime);

		const waiting = withMigrationLock(lockPath, async () => "completed", {
			heartbeatStaleMs: 100,
		});
		const acquiredQuickly = await Promise.race([
			waiting.then(() => true),
			delay(500).then(() => false),
		]);
		if (!acquiredQuickly) rmSync(lockPath, { force: true, recursive: true });
		const result = await waiting;

		assert.equal(acquiredQuickly, true);
		assert.equal(result, "completed");
		assert.equal(existsSync(lockPath), false);
	});
});

test("withMigrationLock heartbeat keeps a genuine live owner protected", async () => {
	await withFixture(async (lockPath) => {
		let releaseOwner!: () => void;
		const ownerMayFinish = new Promise<void>((resolve) => {
			releaseOwner = resolve;
		});
		const owner = withMigrationLock(
			lockPath,
			async () => {
				await ownerMayFinish;
			},
			{ heartbeatIntervalMs: 20 },
		);
		await waitFor(() => existsSync(path.join(lockPath, OWNER_FILE_NAME)));

		let entered = false;
		const contender = withMigrationLock(
			lockPath,
			async () => {
				entered = true;
			},
			{ heartbeatStaleMs: 80 },
		);
		await delay(200);
		assert.equal(entered, false);

		releaseOwner();
		await owner;
		await contender;
		assert.equal(entered, true);
		assert.equal(existsSync(lockPath), false);
	});
});

function writeOwner(
	lockPath: string,
	owner: { pid: number; host: string; createdAt: string; token: string },
): void {
	writeFileSync(path.join(lockPath, OWNER_FILE_NAME), `${JSON.stringify(owner)}\n`);
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempts = 0; attempts < 100; attempts += 1) {
		if (condition()) return;
		await delay(10);
	}
	throw new Error("condition not met in time");
}

async function withFixture(testBody: (lockPath: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "pi-history-migration-lock-"));
	try {
		await testBody(path.join(root, "lock"));
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}
