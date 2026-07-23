import { constants, type Stats } from "node:fs";
import {
	chmod,
	type FileHandle,
	lstat,
	mkdir,
	open,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";

import { hasErrorCode } from "./guards.ts";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./project.ts";

const COPY_BUFFER_SIZE = 64 * 1024;

export type DirectorySnapshot = {
	path: string;
	device: number;
	inode: number;
	fileNames: string[];
};

export async function captureRegularDirectoryFiles(
	directory: string,
	acceptName: (name: string) => boolean,
): Promise<DirectorySnapshot | undefined> {
	let before: Stats;
	try {
		before = await lstat(directory);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
	if (!before.isDirectory()) throw new Error("migration source directory is not regular");
	const entries = await readdir(directory, { withFileTypes: true });
	const after = await lstat(directory);
	if (before.dev !== after.dev || before.ino !== after.ino || !after.isDirectory()) {
		throw new Error("migration source directory changed during inspection");
	}
	return {
		path: directory,
		device: before.dev,
		inode: before.ino,
		fileNames: entries
			.filter((entry) => entry.isFile() && acceptName(entry.name))
			.map((entry) => entry.name)
			.sort(),
	};
}

export async function copyPrivateFile(
	sourceDirectory: DirectorySnapshot,
	fileName: string,
	targetPath: string,
): Promise<void> {
	const sourcePath = path.join(sourceDirectory.path, fileName);
	let source: FileHandle | undefined;
	let target: FileHandle | undefined;
	let targetCreated = false;
	try {
		source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const sourceStats = await source.stat();
		if (!sourceStats.isFile()) throw new Error("migration source is not a regular file");
		await assertDirectoryIdentity(sourceDirectory);
		target = await open(
			targetPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			PRIVATE_FILE_MODE,
		);
		targetCreated = true;
		await copyHandle(source, target);
		await target.chmod(PRIVATE_FILE_MODE);
		await assertDirectoryIdentity(sourceDirectory);
	} catch (error) {
		await target?.close().catch(() => {});
		target = undefined;
		if (targetCreated) await rm(targetPath, { force: true });
		throw error;
	} finally {
		await target?.close().catch(() => {});
		await source?.close().catch(() => {});
	}
}

async function copyHandle(source: FileHandle, target: FileHandle): Promise<void> {
	const buffer = Buffer.alloc(COPY_BUFFER_SIZE);
	let position = 0;
	for (;;) {
		const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
		if (bytesRead === 0) return;
		let written = 0;
		while (written < bytesRead) {
			const result = await target.write(buffer, written, bytesRead - written);
			if (result.bytesWritten === 0) throw new Error("migration copy made no progress");
			written += result.bytesWritten;
		}
		position += bytesRead;
	}
}

async function assertDirectoryIdentity(directory: DirectorySnapshot): Promise<void> {
	const stats = await lstat(directory.path);
	if (!stats.isDirectory() || stats.dev !== directory.device || stats.ino !== directory.inode) {
		throw new Error("migration source directory changed during copy");
	}
}

export async function filesEqual(leftPath: string, rightPath: string): Promise<boolean> {
	let left: FileHandle | undefined;
	let right: FileHandle | undefined;
	try {
		left = await open(leftPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		right = await open(rightPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const [leftStats, rightStats] = await Promise.all([left.stat(), right.stat()]);
		if (!leftStats.isFile() || !rightStats.isFile() || leftStats.size !== rightStats.size) {
			return false;
		}
		const [leftBytes, rightBytes] = await Promise.all([left.readFile(), right.readFile()]);
		return leftBytes.equals(rightBytes);
	} catch {
		return false;
	} finally {
		await left?.close().catch(() => {});
		await right?.close().catch(() => {});
	}
}

export async function assertRegularDirectoryIfExists(directory: string): Promise<boolean> {
	try {
		const stats = await lstat(directory);
		if (!stats.isDirectory()) throw new Error("migration directory is unsafe");
		return true;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
	try {
		await mkdir(directory, { mode: PRIVATE_DIR_MODE });
		await chmod(directory, PRIVATE_DIR_MODE);
	} catch (error) {
		if (!hasErrorCode(error, "EEXIST")) throw error;
		const stats = await lstat(directory);
		if (!stats.isDirectory()) throw new Error("migration destination directory is unsafe");
	}
}

export async function pathExists(candidate: string): Promise<boolean> {
	try {
		await lstat(candidate);
		return true;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
}

export async function readOptionalPrivateText(filePath: string): Promise<string | undefined> {
	try {
		return await readPrivateText(filePath);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
}

export async function readPrivateText(filePath: string): Promise<string> {
	const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error("migration metadata is not a regular file");
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

export async function writePrivateFile(filePath: string, content: string): Promise<void> {
	await writeFile(filePath, content, {
		encoding: "utf8",
		flag: "wx",
		mode: PRIVATE_FILE_MODE,
	});
	await chmod(filePath, PRIVATE_FILE_MODE);
}
