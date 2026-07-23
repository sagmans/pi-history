import { strict as assert } from "node:assert";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

import { IsolationLevel } from "../src/config.ts";
import {
	createGlobalIdentity,
	createProjectIdentity,
	defaultHistoryBaseDir,
	GLOBAL_SCOPE_KEY,
	HISTORY_FILE_EXTENSION,
	type ProjectExec,
	resolveProjectIdentity,
	sanitizeProjectPath,
	validateStoredProjectRoot,
} from "../src/project.ts";

const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

test("global identity uses a fixed sentinel scope and shared file name", () => {
	const identity = createGlobalIdentity({ historyBaseDir: "/private/history" });

	assert.equal(identity.kind, "global");
	assert.equal(identity.isolationLevel, IsolationLevel.Global);
	assert.equal(identity.projectRoot, GLOBAL_SCOPE_KEY);
	assert.equal(identity.storageFileName, `global${HISTORY_FILE_EXTENSION}`);
	assert.equal(identity.historyFilePath, path.join("/private/history", identity.storageFileName));
});

test("global identity defaults to the shared history base dir", () => {
	const identity = createGlobalIdentity();

	assert.equal(path.dirname(identity.historyFilePath), defaultHistoryBaseDir());
});

test("global identity is stable across different hosts' cwds", () => {
	const first = createGlobalIdentity({ historyBaseDir: "/private/history" });
	const second = createGlobalIdentity({ historyBaseDir: "/private/history" });

	assert.deepEqual(first, second);
});

test("stored global sentinel validates against global identity and rejects project files", () => {
	const globalIdentity = createGlobalIdentity({
		historyBaseDir: "/private/history",
	});

	assert.deepEqual(
		validateStoredProjectRoot({
			identity: globalIdentity,
			storedProjectRoot: GLOBAL_SCOPE_KEY,
		}),
		{ kind: "match" },
	);
	assert.deepEqual(
		validateStoredProjectRoot({
			identity: globalIdentity,
			storedProjectRoot: "/workspace/project",
		}),
		{ kind: "mismatch", storedProjectRoot: "/workspace/project" },
	);
});

test("regular git worktree subdirectory resolves to repo root", async () => {
	await withProjectFixture(async ({ root, historyBaseDir }) => {
		const repoRoot = path.join(root, "repo");
		const subdir = path.join(repoRoot, "packages", "tool");
		const gitCommonDir = path.join(repoRoot, ".git");
		await mkdir(subdir, { recursive: true });
		await mkdir(gitCommonDir, { recursive: true });
		const exec = fakeGitExec({
			"--path-format=absolute --git-common-dir": success(`${gitCommonDir}\n`),
			"--is-bare-repository": success("false\n"),
		});

		const identity = await resolveProjectIdentity({
			cwd: subdir,
			exec,
			historyBaseDir,
		});

		assert.equal(identity.kind, "git-worktree");
		assert.equal(identity.isolationLevel, IsolationLevel.Project);
		assert.equal(identity.projectRoot, realpathSync(repoRoot));
		assert.equal(path.dirname(identity.historyFilePath), historyBaseDir);
	});
});

test("linked worktrees share one identity via the common git dir", async () => {
	await withProjectFixture(async ({ root, historyBaseDir }) => {
		const repoRoot = path.join(root, "repo");
		const gitCommonDir = path.join(repoRoot, ".git");
		const linkedWorktree = path.join(root, "feature");
		await mkdir(gitCommonDir, { recursive: true });
		await mkdir(linkedWorktree, { recursive: true });
		// Both checkouts report the same --git-common-dir, so keying on it must
		// collapse them to one history file regardless of the working tree.
		const exec = fakeGitExec({
			"--path-format=absolute --git-common-dir": success(`${gitCommonDir}\n`),
			"--is-bare-repository": success("false\n"),
		});

		const main = await resolveProjectIdentity({
			cwd: repoRoot,
			exec,
			historyBaseDir,
		});
		const linked = await resolveProjectIdentity({
			cwd: linkedWorktree,
			exec,
			historyBaseDir,
		});

		assert.equal(main.projectRoot, realpathSync(repoRoot));
		assert.equal(linked.projectRoot, realpathSync(repoRoot));
		assert.equal(linked.storageFileName, main.storageFileName);
	});
});

test("bare git repository resolves to bare root", async () => {
	await withProjectFixture(async ({ root, historyBaseDir }) => {
		const bareRoot = path.join(root, "repo.git");
		await mkdir(bareRoot, { recursive: true });
		const exec = fakeGitExec({
			"--path-format=absolute --git-common-dir": success(`${bareRoot}\n`),
			"--is-bare-repository": success("true\n"),
		});

		const identity = await resolveProjectIdentity({
			cwd: bareRoot,
			exec,
			historyBaseDir,
		});

		assert.equal(identity.kind, "git-bare");
		assert.equal(identity.isolationLevel, IsolationLevel.Project);
		assert.equal(identity.projectRoot, realpathSync(bareRoot));
	});
});

test("relative common git dir falls back and resolves against cwd", async () => {
	await withProjectFixture(async ({ root, historyBaseDir }) => {
		const repoRoot = path.join(root, "repo");
		await mkdir(path.join(repoRoot, ".git"), { recursive: true });
		// Older git without --path-format returns a cwd-relative common dir.
		const exec = fakeGitExec({
			"--git-common-dir": success(".git\n"),
			"--is-bare-repository": success("false\n"),
		});

		const identity = await resolveProjectIdentity({
			cwd: repoRoot,
			exec,
			historyBaseDir,
		});

		assert.equal(identity.kind, "git-worktree");
		assert.equal(identity.projectRoot, realpathSync(repoRoot));
	});
});

test("non-git directory resolves to real current directory", async () => {
	await withProjectFixture(async ({ root, historyBaseDir }) => {
		const cwd = path.join(root, "plain");
		await mkdir(cwd, { recursive: true });

		const identity = await resolveProjectIdentity({
			cwd,
			exec: fakeGitExec({}),
			historyBaseDir,
		});

		assert.equal(identity.kind, "directory");
		assert.equal(identity.isolationLevel, IsolationLevel.Project);
		assert.equal(identity.projectRoot, realpathSync(cwd));
	});
});

test("symlinked cwd resolves to canonical path", async () => {
	await withProjectFixture(async ({ root, historyBaseDir }) => {
		const realCwd = path.join(root, "real");
		const linkedCwd = path.join(root, "linked");
		await mkdir(realCwd, { recursive: true });
		symlinkSync(realCwd, linkedCwd, "dir");

		const identity = await resolveProjectIdentity({
			cwd: linkedCwd,
			exec: fakeGitExec({}),
			historyBaseDir,
		});

		assert.equal(identity.kind, "directory");
		assert.equal(identity.projectRoot, realpathSync(realCwd));
	});
});

test("storage filename uses a bounded hash key", () => {
	const projectRoot = path.join("", "tmp", "alpha", "beta");
	const identity = createProjectIdentity({
		kind: "directory",
		projectRoot,
		historyBaseDir: "/private-history",
	});

	assert.equal(
		identity.storageFileName,
		`${sanitizeProjectPath(projectRoot)}${HISTORY_FILE_EXTENSION}`,
	);
	assert.match(identity.storageFileName, /^project-[a-f0-9]{64}\.json$/);
	assert.equal(identity.storageFileName.includes("/"), false);
	assert.equal(identity.storageFileName.includes("\\"), false);
	assert.equal(identity.historyFilePath, path.join("/private-history", identity.storageFileName));
});

test("storage filenames do not collide on ambiguous path escaping", () => {
	const first = createProjectIdentity({
		kind: "directory",
		projectRoot: "/tmp/a--b/c",
		historyBaseDir: "/private-history",
	});
	const second = createProjectIdentity({
		kind: "directory",
		projectRoot: "/tmp/a/b--c",
		historyBaseDir: "/private-history",
	});

	assert.notEqual(first.storageFileName, second.storageFileName);
});

test("storage filename stays bounded for deep project roots", () => {
	const longProjectRoot = `/${"nested/".repeat(100)}repo`;
	const identity = createProjectIdentity({
		kind: "directory",
		projectRoot: longProjectRoot,
		historyBaseDir: "/private-history",
	});

	assert.equal(
		identity.storageFileName.length,
		"project-".length + 64 + HISTORY_FILE_EXTENSION.length,
	);
});

test("default storage base stays under the Pi private agent directory", () => {
	assert.match(defaultHistoryBaseDir(), /\.pi[/\\]agent[/\\]pi-history$/);
});

test("default storage base follows Pi agent-directory changes", () => {
	const firstAgentDir = path.join(tmpdir(), "pi-profile-a");
	const secondAgentDir = path.join(tmpdir(), "pi-profile-b");

	const first = withEnvironmentVariable(PI_AGENT_DIR_ENV, firstAgentDir, defaultHistoryBaseDir);
	const second = withEnvironmentVariable(PI_AGENT_DIR_ENV, secondAgentDir, defaultHistoryBaseDir);

	assert.equal(first, path.join(firstAgentDir, "pi-history"));
	assert.equal(second, path.join(secondAgentDir, "pi-history"));
	assert.notEqual(first, second);
});

test("stored projectRoot mismatch returns write-blocking validation", () => {
	const identity = createProjectIdentity({
		kind: "directory",
		projectRoot: "/tmp/current",
		historyBaseDir: "/private-history",
	});

	const validation = validateStoredProjectRoot({
		identity,
		storedProjectRoot: "/tmp/other",
	});

	assert.equal(validation.kind, "mismatch");
	if (validation.kind === "mismatch") {
		assert.equal(validation.storedProjectRoot, "/tmp/other");
	}
});

function withEnvironmentVariable<Result>(
	name: string,
	value: string,
	operation: () => Result,
): Result {
	const previous = process.env[name];
	try {
		process.env[name] = value;
		return operation();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}

async function withProjectFixture(
	testBody: (fixture: { root: string; historyBaseDir: string }) => Promise<void>,
): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "pi-history-project-"));
	try {
		await testBody({ root, historyBaseDir: path.join(root, "history") });
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}

type GitRoutes = Record<string, ExecResult>;

function fakeGitExec(routes: GitRoutes): ProjectExec {
	return async (command: string, args: string[], _options?: ExecOptions) => {
		assert.equal(command, "git");
		assert.equal(args[0], "rev-parse");
		const routeKey = args.slice(1).join(" ");
		return routes[routeKey] ?? failure();
	};
}

function success(stdout: string): ExecResult {
	return { stdout, stderr: "", code: 0, killed: false };
}

function failure(): ExecResult {
	return { stdout: "", stderr: "not a git repo", code: 128, killed: false };
}
