import { strict as assert } from "node:assert";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { LOCK_REMOVAL_CLAIM_DIRECTORY } from "../src/lock-directory.ts";
import { withMigrationLock } from "../src/migration-lock.ts";

const OWNER_FILE_NAME = "owner.json";
const FIXTURE_TIMESTAMP = "2026-07-01T00:00:00.000Z";
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_STALE_MS = 30_000;

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
		const staleTime = new Date("2000-01-01T00:00:00.000Z");
		utimesSync(ownerPath, staleTime, staleTime);

		const waiting = withMigrationLock(lockPath, async () => "completed");
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

test("migration reclaimers preserve a claimed stale owner", async () => {
	await withFixture(async (lockPath) => {
		mkdirSync(lockPath);
		writeOwner(lockPath, {
			pid: 999_999,
			host: hostname(),
			createdAt: "2000-01-01T00:00:00.000Z",
			token: "stale-owner",
		});
		mkdirSync(path.join(lockPath, LOCK_REMOVAL_CLAIM_DIRECTORY));
		const releases = [deferred(), deferred()];
		const entered: number[] = [];
		const contenders = releases.map((release, index) =>
			withMigrationLock(lockPath, async () => {
				entered.push(index);
				await release.promise;
			}),
		);

		await delay(100);
		const enteredWhileClaimed = entered.length;
		const ownerPreserved = existsSync(path.join(lockPath, OWNER_FILE_NAME));
		for (const release of releases) release.resolve();
		if (!ownerPreserved) {
			writeOwner(lockPath, {
				pid: 999_999,
				host: hostname(),
				createdAt: "2000-01-01T00:00:00.000Z",
				token: "restored-stale-owner",
			});
		}
		const claimPath = path.join(lockPath, LOCK_REMOVAL_CLAIM_DIRECTORY);
		// Moving the fixture-owned claim atomically keeps teardown from deleting a
		// contender claim created immediately after release.
		renameSync(claimPath, path.join(path.dirname(lockPath), LOCK_REMOVAL_CLAIM_DIRECTORY));
		await Promise.all(contenders);

		assert.equal(enteredWhileClaimed, 0);
		assert.equal(ownerPreserved, true);
		assert.deepEqual(new Set(entered), new Set([0, 1]));
		assert.equal(existsSync(lockPath), false);
	});
});

test("withMigrationLock heartbeat keeps a genuine live owner protected", async (context) => {
	context.mock.timers.enable({
		apis: ["Date", "setInterval"],
		now: new Date(FIXTURE_TIMESTAMP),
	});
	await withFixture(async (lockPath) => {
		const ownerMayFinish = deferred();
		const owner = withMigrationLock(lockPath, async () => {
			await ownerMayFinish.promise;
		});
		const ownerPath = path.join(lockPath, OWNER_FILE_NAME);
		await waitFor(() => existsSync(ownerPath));

		context.mock.timers.tick(HEARTBEAT_STALE_MS + HEARTBEAT_INTERVAL_MS);
		await delay(10);
		assert.equal(statSync(ownerPath).mtimeMs, Date.now());

		let entered = false;
		const contender = withMigrationLock(lockPath, async () => {
			entered = true;
		});
		await delay(100);
		assert.equal(entered, false);

		ownerMayFinish.resolve();
		await owner;
		await contender;
		assert.equal(entered, true);
		assert.equal(existsSync(lockPath), false);
	});
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((release) => {
		resolve = release;
	});
	return { promise, resolve };
}

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
