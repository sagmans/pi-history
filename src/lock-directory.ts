import { lstat, mkdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";

import { hasErrorCode } from "./guards.ts";
import { PRIVATE_DIR_MODE } from "./project.ts";

export const LOCK_REMOVAL_CLAIM_DIRECTORY = ".removal-claim";

type DirectoryIdentity = Readonly<{ device: number; inode: number }>;

// Removal is multi-step on every supported filesystem. The in-directory claim
// keeps cooperating releasers and reclaimers from validating one owner and
// later deleting a successor that reused the stable lock path.
export async function removeLockDirectoryIf(
	lockPath: string,
	validate: () => Promise<boolean>,
): Promise<boolean> {
	const claimPath = path.join(lockPath, LOCK_REMOVAL_CLAIM_DIRECTORY);
	try {
		await mkdir(claimPath, { mode: PRIVATE_DIR_MODE });
	} catch (error) {
		if (hasErrorCode(error, "EEXIST")) return false;
		if (hasErrorCode(error, "ENOENT")) return true;
		throw error;
	}

	const identity = await readDirectoryIdentity(lockPath);
	try {
		if (!identity || !(await validate())) return false;
		if (!(await directoryMatches(lockPath, identity))) return false;
		await rm(lockPath, { recursive: true });
		return true;
	} finally {
		// A different inode is a successor. Never address its claim path.
		if (identity && (await directoryMatches(lockPath, identity))) {
			await rmdir(claimPath).catch(() => {});
		}
	}
}

async function readDirectoryIdentity(lockPath: string): Promise<DirectoryIdentity | undefined> {
	try {
		const stats = await lstat(lockPath);
		if (!stats.isDirectory()) throw new Error("lock path is unsafe");
		return { device: stats.dev, inode: stats.ino };
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
}

async function directoryMatches(lockPath: string, identity: DirectoryIdentity): Promise<boolean> {
	const current = await readDirectoryIdentity(lockPath);
	return current?.device === identity.device && current.inode === identity.inode;
}
