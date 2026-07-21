import { strict as assert } from "node:assert";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
	type Clock,
	HISTORY_SCHEMA_VERSION,
	loadHistoryStore,
	type PromptHistoryFile,
} from "../src/history-store.ts";
import { createGlobalIdentity, createProjectIdentity, GLOBAL_SCOPE_KEY } from "../src/project.ts";

test("missing store loads empty and creates no file until first save", async () => {
	await withStoreFixture(async ({ storePath, loadStore }) => {
		const store = await loadStore();

		assert.equal(store.entryCount, 0);
		assert.equal(existsSync(storePath), false);
	});
});

test("global store persists the sentinel scope in the shared history file", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pi-history-global-store-"));
	try {
		const identity = createGlobalIdentity({
			historyBaseDir: path.join(root, "history"),
		});
		const store = await loadHistoryStore({
			identity,
			maxEntries: 500,
			now: () => "2026-07-01T00:00:00.000Z",
		});

		await store.recordPrompt("global prompt");

		const saved: PromptHistoryFile = JSON.parse(readFileSync(identity.historyFilePath, "utf8"));
		assert.equal(store.projectRoot, GLOBAL_SCOPE_KEY);
		assert.equal(saved.projectRoot, GLOBAL_SCOPE_KEY);
		assert.deepEqual(
			saved.entries.map((entry) => entry.text),
			["global prompt"],
		);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("saving creates owner-only directory and file permissions", async () => {
	await withStoreFixture(async ({ historyBaseDir, storePath, loadStore }) => {
		const store = await loadStore();

		await store.recordPrompt("review the diff");

		assert.equal(statSync(historyBaseDir).mode & 0o777, 0o700);
		assert.equal(statSync(storePath).mode & 0o777, 0o600);
	});
});

test("whitespace-only prompts are skipped", async () => {
	await withStoreFixture(async ({ storePath, loadStore }) => {
		const store = await loadStore();
		const result = await store.recordPrompt(" \n\t ");

		assert.deepEqual(result, { kind: "skipped", reason: "empty" });
		assert.equal(existsSync(storePath), false);
	});
});

test("multiline prompt text is preserved", async () => {
	await withStoreFixture(async ({ loadStore }) => {
		const store = await loadStore();
		const prompt = "first line\nsecond line";

		await store.recordPrompt(prompt);

		assert.equal(store.entries[0]?.text, prompt);
	});
});

test("exact duplicate moves to newest and increments useCount", async () => {
	const clock = makeClock([
		"2026-07-01T00:00:00.000Z",
		"2026-07-01T00:00:01.000Z",
		"2026-07-01T00:00:02.000Z",
		"2026-07-01T00:00:03.000Z",
	]);
	await withStoreFixture(async ({ loadStore }) => {
		const store = await loadStore({ clock });

		await store.recordPrompt("alpha");
		await store.recordPrompt("beta");
		await store.recordPrompt("alpha");

		assert.deepEqual(
			store.entries.map((entry) => entry.text),
			["alpha", "beta"],
		);
		assert.equal(store.entries[0]?.useCount, 2);
		assert.equal(store.entries[0]?.createdAt, "2026-07-01T00:00:01.000Z");
		assert.equal(store.entries[0]?.updatedAt, "2026-07-01T00:00:03.000Z");
	});
});

test("history cap keeps newest entries", async () => {
	await withStoreFixture(async ({ loadStore }) => {
		const store = await loadStore({ maxEntries: 2 });

		await store.recordPrompt("alpha");
		await store.recordPrompt("beta");
		await store.recordPrompt("gamma");

		assert.deepEqual(
			store.entries.map((entry) => entry.text),
			["gamma", "beta"],
		);
	});
});

test("lowering cap trims on next save", async () => {
	await withStoreFixture(async ({ loadStore }) => {
		const initial = await loadStore({ maxEntries: 3 });
		await initial.recordPrompt("alpha");
		await initial.recordPrompt("beta");
		await initial.recordPrompt("gamma");

		const lowered = await loadStore({ maxEntries: 2 });
		await lowered.recordPrompt("delta");

		assert.deepEqual(
			lowered.entries.map((entry) => entry.text),
			["delta", "gamma"],
		);
	});
});

test("corrupt JSON returns write-blocked state and preserves file", async () => {
	await withStoreFixture(async ({ storePath, loadStore }) => {
		mkdirSync(path.dirname(storePath), { recursive: true });
		writeFileSync(storePath, "not json", "utf8");

		const store = await loadStore();
		const result = await store.recordPrompt("alpha");

		assert.equal(store.writeBlocked, true);
		assert.equal(store.writeBlockedReason, "corrupt_history");
		assert.equal(result.kind, "blocked");
		assert.equal(store.warnings.join("\n").includes(storePath), false);
		assert.equal(readFileSync(storePath, "utf8"), "not json");
	});
});

test("project mismatch blocks writes instead of merging histories", async () => {
	await withStoreFixture(async ({ storePath, loadStore }) => {
		const foreign: PromptHistoryFile = {
			schemaVersion: HISTORY_SCHEMA_VERSION,
			projectRoot: "/other/project",
			createdAt: "2026-07-01T00:00:00.000Z",
			updatedAt: "2026-07-01T00:00:00.000Z",
			entries: [],
		};
		mkdirSync(path.dirname(storePath), { recursive: true });
		writeFileSync(storePath, `${JSON.stringify(foreign)}\n`, "utf8");

		const store = await loadStore();
		const result = await store.recordPrompt("alpha");

		assert.equal(store.writeBlockedReason, "project_root_mismatch");
		assert.equal(result.kind, "blocked");
		assert.match(store.warnings.join("\n"), /belongs to/);
		assert.equal(store.warnings.join("\n").includes("/other/project"), false);
		assert.equal(store.warnings.join("\n").includes(storePath), false);
	});
});

test("concurrent saves merge latest file content", async () => {
	const clock = makeClock([
		"2026-07-01T00:00:00.000Z",
		"2026-07-01T00:00:01.000Z",
		"2026-07-01T00:00:02.000Z",
		"2026-07-01T00:00:03.000Z",
		"2026-07-01T00:00:04.000Z",
		"2026-07-01T00:00:05.000Z",
	]);
	await withStoreFixture(async ({ loadStore }) => {
		const first = await loadStore({ clock });
		const second = await loadStore({ clock });

		await first.recordPrompt("from first session");
		await second.recordPrompt("from second session");
		const reloaded = await loadStore({ clock });

		assert.deepEqual(
			reloaded.entries.map((entry) => entry.text),
			["from second session", "from first session"],
		);
	});
});

test("parallel saves are serialized without losing prompts", async () => {
	await withStoreFixture(async ({ loadStore }) => {
		const prompts = Array.from({ length: 8 }, (_, index) => `prompt ${index}`);
		const stores = await Promise.all(prompts.map(() => loadStore()));

		await Promise.all(
			prompts.map((prompt, index) => {
				const store = stores[index];
				if (!store) throw new Error(`missing store for ${prompt}`);
				return store.recordPrompt(prompt);
			}),
		);
		const reloaded = await loadStore();

		assert.equal(reloaded.entries.length, prompts.length);
		assert.deepEqual(new Set(reloaded.entries.map((entry) => entry.text)), new Set(prompts));
	});
});

test("clear wipes current project history and records a clear marker", async () => {
	await withStoreFixture(async ({ storePath, loadStore }) => {
		const store = await loadStore();
		await store.recordPrompt("alpha");

		const result = await store.clear();
		const reloaded = await loadStore();

		assert.deepEqual(result, { kind: "cleared" });
		assert.equal(store.entryCount, 0);
		assert.equal(reloaded.entryCount, 0);
		assert.equal(existsSync(storePath), true);
	});
});

test("clear prevents older open sessions from resurrecting prompts", async () => {
	const clock = makeClock([
		"2026-07-01T00:00:00.000Z",
		"2026-07-01T00:00:01.000Z",
		"2026-07-01T00:00:02.000Z",
		"2026-07-01T00:00:03.000Z",
	]);
	await withStoreFixture(async ({ loadStore }) => {
		const first = await loadStore({ clock });
		await first.recordPrompt("secret old prompt");
		const second = await loadStore({ clock });

		await first.clear();
		await second.recordPrompt("new prompt");
		const reloaded = await loadStore({ clock });

		assert.deepEqual(
			reloaded.entries.map((entry) => entry.text),
			["new prompt"],
		);
	});
});

test("stale lock owned by a dead process is reclaimed", async () => {
	await withStoreFixture(async ({ storePath, loadStore }) => {
		const lockPath = `${storePath}.lock`;
		mkdirSync(lockPath, { recursive: true, mode: 0o700 });
		writeFileSync(
			path.join(lockPath, "owner.json"),
			`${JSON.stringify({
				pid: 999_999,
				host: "stale-host",
				createdAt: "2000-01-01T00:00:00.000Z",
			})}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);

		const store = await loadStore();
		await store.recordPrompt("alpha");

		assert.equal(store.entries[0]?.text, "alpha");
		assert.equal(existsSync(lockPath), false);
	});
});

type Fixture = {
	projectRoot: string;
	historyBaseDir: string;
	storePath: string;
	loadStore: (options?: {
		maxEntries?: number;
		clock?: Clock;
	}) => Promise<Awaited<ReturnType<typeof loadHistoryStore>>>;
};

async function withStoreFixture(testBody: (fixture: Fixture) => Promise<void>): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "pi-history-store-"));
	try {
		const projectRoot = path.join(root, "repo");
		const historyBaseDir = path.join(root, "history");
		const identity = createProjectIdentity({
			kind: "directory",
			projectRoot,
			historyBaseDir,
		});
		await testBody({
			projectRoot,
			historyBaseDir,
			storePath: identity.historyFilePath,
			loadStore: (options) =>
				loadHistoryStore({
					identity,
					maxEntries: options?.maxEntries ?? 500,
					now: options?.clock,
				}),
		});
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}

function makeClock(values: string[]): Clock {
	let index = 0;
	return () => values[index++] ?? values[values.length - 1] ?? "2026-07-01T00:00:00.000Z";
}
