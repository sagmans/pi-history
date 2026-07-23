import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

import { getPiHistoryDir, IsolationLevel } from "./config.ts";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const HISTORY_FILE_EXTENSION = ".json";

const GIT_DISCOVERY_TIMEOUT_MS = 2000;
const HISTORY_FILE_PREFIX = "project-";
const HISTORY_FILE_HASH_ALGORITHM = "sha256";
const GIT_DIR_BASENAME = ".git";
const GLOBAL_STORAGE_BASENAME = "global";

// Sentinel scope key stored as projectRoot inside global history files. It can never
// collide with a real project because canonical paths are always absolute.
export const GLOBAL_SCOPE_KEY = "<global>";

export type ProjectKind = "git-worktree" | "git-bare" | "directory" | "global";

export type ProjectIdentity = {
	kind: ProjectKind;
	isolationLevel: IsolationLevel;
	projectRoot: string;
	storageFileName: string;
	historyFilePath: string;
};

export type ProjectExec = (
	command: string,
	args: string[],
	options?: ExecOptions,
) => Promise<ExecResult>;

export type ProjectRootValidation =
	| { kind: "match" }
	| { kind: "mismatch"; storedProjectRoot: string };

export function createGlobalIdentity(input: { historyBaseDir?: string } = {}): ProjectIdentity {
	const storageFileName = `${GLOBAL_STORAGE_BASENAME}${HISTORY_FILE_EXTENSION}`;
	return {
		kind: "global",
		isolationLevel: IsolationLevel.Global,
		projectRoot: GLOBAL_SCOPE_KEY,
		storageFileName,
		historyFilePath: path.join(input.historyBaseDir ?? defaultHistoryBaseDir(), storageFileName),
	};
}

export async function resolveProjectIdentity(input: {
	cwd: string;
	exec: ProjectExec;
	historyBaseDir?: string;
}): Promise<ProjectIdentity> {
	const cwd = await canonicalPath(input.cwd);
	// The common git dir is shared by every linked worktree, so it keys one
	// history per repository instead of one per worktree checkout.
	const commonDir = await gitCommonDir(input.exec, cwd);
	if (commonDir) {
		const bare = await gitRevParse(input.exec, cwd, ["--is-bare-repository"]);
		return createProjectIdentity({
			kind: bare === "true" ? "git-bare" : "git-worktree",
			projectRoot: repoRootFromCommonDir(commonDir),
			historyBaseDir: input.historyBaseDir,
		});
	}

	return createProjectIdentity({
		kind: "directory",
		projectRoot: cwd,
		historyBaseDir: input.historyBaseDir,
	});
}

export function createProjectIdentity(input: {
	kind: Exclude<ProjectKind, "global">;
	projectRoot: string;
	historyBaseDir?: string;
}): ProjectIdentity {
	const storageFileName = `${sanitizeProjectPath(input.projectRoot)}${HISTORY_FILE_EXTENSION}`;
	return {
		kind: input.kind,
		isolationLevel: IsolationLevel.Project,
		projectRoot: input.projectRoot,
		storageFileName,
		historyFilePath: path.join(input.historyBaseDir ?? defaultHistoryBaseDir(), storageFileName),
	};
}

export function defaultHistoryBaseDir(): string {
	return getPiHistoryDir();
}

export function sanitizeProjectPath(projectRoot: string): string {
	// A hash keeps filenames bounded and avoids ambiguous path separator escaping.
	const digest = createHash(HISTORY_FILE_HASH_ALGORITHM).update(projectRoot, "utf8").digest("hex");
	return `${HISTORY_FILE_PREFIX}${digest}`;
}

export function validateStoredProjectRoot(input: {
	identity: ProjectIdentity;
	storedProjectRoot: unknown;
}): ProjectRootValidation {
	if (input.storedProjectRoot === input.identity.projectRoot) {
		return { kind: "match" };
	}
	return {
		kind: "mismatch",
		storedProjectRoot:
			typeof input.storedProjectRoot === "string" ? input.storedProjectRoot : "<missing>",
	};
}

async function gitCommonDir(exec: ProjectExec, cwd: string): Promise<string | undefined> {
	// --path-format=absolute (git >= 2.31) avoids the cwd-vs-toplevel ambiguity of
	// a relative --git-common-dir; the plain form is a fallback for older git.
	const absolute = await gitRevParse(exec, cwd, ["--path-format=absolute", "--git-common-dir"]);
	if (absolute) return canonicalPath(path.resolve(cwd, absolute));
	const relative = await gitRevParse(exec, cwd, ["--git-common-dir"]);
	if (relative) return canonicalPath(path.resolve(cwd, relative));
	return undefined;
}

function repoRootFromCommonDir(commonDir: string): string {
	// A non-bare repo reports <root>/.git; strip it so the working tree root is the
	// key. Bare repos report their own directory, which is already the shared root.
	return path.basename(commonDir) === GIT_DIR_BASENAME ? path.dirname(commonDir) : commonDir;
}

async function gitRevParse(
	exec: ProjectExec,
	cwd: string,
	args: string[],
): Promise<string | undefined> {
	const result = await exec("git", ["rev-parse", ...args], {
		cwd,
		timeout: GIT_DISCOVERY_TIMEOUT_MS,
	}).catch(() => undefined);
	if (result?.code !== 0) return undefined;
	const stdout = result.stdout.trim();
	return stdout.length > 0 ? stdout : undefined;
}

async function canonicalPath(candidate: string): Promise<string> {
	const absolute = path.resolve(candidate);
	try {
		return await realpath(absolute);
	} catch {
		// Non-git fallback may point at a just-deleted cwd; preserve a stable absolute key.
		return absolute;
	}
}
