import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LOCK_REMOVAL_CLAIM_DIRECTORY, removeLockDirectoryIf } from "../src/lock-directory.ts";

test("removeLockDirectoryIf removes a validated lock", async () => {
	await withLockFixture(async (lockPath) => {
		const removed = await removeLockDirectoryIf(lockPath, async () => true);

		assert.equal(removed, true);
		assert.equal(existsSync(lockPath), false);
	});
});

test("removeLockDirectoryIf preserves a lock claimed by another remover", async () => {
	await withLockFixture(async (lockPath) => {
		mkdirSync(path.join(lockPath, LOCK_REMOVAL_CLAIM_DIRECTORY));
		let validated = false;

		const removed = await removeLockDirectoryIf(lockPath, async () => {
			validated = true;
			return true;
		});

		assert.equal(removed, false);
		assert.equal(validated, false);
		assert.equal(existsSync(lockPath), true);
	});
});

test("removeLockDirectoryIf releases its claim after failed validation", async () => {
	await withLockFixture(async (lockPath) => {
		const removed = await removeLockDirectoryIf(lockPath, async () => false);

		assert.equal(removed, false);
		assert.equal(existsSync(lockPath), true);
		assert.equal(existsSync(path.join(lockPath, LOCK_REMOVAL_CLAIM_DIRECTORY)), false);
	});
});

async function withLockFixture(testBody: (lockPath: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "pi-history-lock-directory-"));
	const lockPath = path.join(root, "lock");
	mkdirSync(lockPath);
	try {
		await testBody(lockPath);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}
