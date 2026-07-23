import { strict as assert } from "node:assert";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { captureRegularDirectoryFiles, copyPrivateFile } from "../src/migration-safe-files.ts";

const FILE_NAME = "global.json";
const PRIVATE_FILE_MODE = 0o600;

test("copyPrivateFile copies captured regular bytes privately", async () => {
	await withFixture(async (root) => {
		const sourceDir = path.join(root, "source");
		const targetPath = path.join(root, "target.json");
		mkdirSync(sourceDir);
		writeFileSync(path.join(sourceDir, FILE_NAME), "synthetic bytes\n");
		const captured = await captureRegularDirectoryFiles(sourceDir, () => true);
		assert.ok(captured);

		await copyPrivateFile(captured, FILE_NAME, targetPath);

		assert.equal(readFileSync(targetPath, "utf8"), "synthetic bytes\n");
		assert.equal(statSync(targetPath).mode & 0o777, PRIVATE_FILE_MODE);
	});
});

test("copyPrivateFile preserves an existing target", async () => {
	await withFixture(async (root) => {
		const sourceDir = path.join(root, "source");
		const targetPath = path.join(root, "target.json");
		mkdirSync(sourceDir);
		writeFileSync(path.join(sourceDir, FILE_NAME), "source bytes\n");
		writeFileSync(targetPath, "existing bytes\n");
		const captured = await captureRegularDirectoryFiles(sourceDir, () => true);
		assert.ok(captured);

		await assert.rejects(copyPrivateFile(captured, FILE_NAME, targetPath));

		assert.equal(readFileSync(targetPath, "utf8"), "existing bytes\n");
	});
});

test("captureRegularDirectoryFiles rejects a symlinked directory", async () => {
	await withFixture(async (root) => {
		const externalDir = path.join(root, "external");
		const linkedDir = path.join(root, "linked");
		mkdirSync(externalDir);
		symlinkSync(externalDir, linkedDir);

		await assert.rejects(captureRegularDirectoryFiles(linkedDir, () => true));
	});
});

test("copyPrivateFile rejects a captured leaf replaced by a symlink", async () => {
	await withFixture(async (root) => {
		const sourceDir = path.join(root, "source");
		const sourcePath = path.join(sourceDir, FILE_NAME);
		const externalPath = path.join(root, "external.json");
		const targetPath = path.join(root, "target.json");
		mkdirSync(sourceDir);
		writeFileSync(sourcePath, "captured bytes\n");
		writeFileSync(externalPath, "external bytes\n");
		const captured = await captureRegularDirectoryFiles(sourceDir, () => true);
		assert.ok(captured);
		rmSync(sourcePath);
		symlinkSync(externalPath, sourcePath);

		await assert.rejects(copyPrivateFile(captured, FILE_NAME, targetPath));

		assert.equal(existsSync(targetPath), false);
	});
});

async function withFixture(testBody: (root: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "pi-history-safe-copy-"));
	try {
		await testBody(root);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}
