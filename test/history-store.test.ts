import { strict as assert } from "node:assert";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
	type Clock,
	HISTORY_SCHEMA_VERSION,
	loadHistoryStore,
	type PromptHistoryFile,
	removeOrphanedTempArtifacts,
	withHistoryFileLock,
} from "../src/history-store.ts";
import { LOCK_REMOVAL_CLAIM_DIRECTORY } from "../src/lock-directory.ts";
import { createGlobalIdentity, createProjectIdentity, GLOBAL_SCOPE_KEY } from "../src/project.ts";

const FIXTURE_TIMESTAMP = "2026-07-01T00:00:00.000Z";
const FIRST_CLEAR_TIMESTAMP = "2026-07-01T00:00:03.000Z";
const INTERVENING_PROMPT_TIMESTAMP = "2026-07-01T00:00:04.000Z";
const ROLLED_BACK_CLEAR_TIMESTAMP = "2026-07-01T00:00:01.000Z";
const POST_CLEAR_PROMPT_TIMESTAMP = "2026-07-01T00:00:05.000Z";
const LEGACY_HISTORY_SCHEMA_VERSION = 1;
const GENERATION_HISTORY_SCHEMA_VERSION = 2;
const UNSAFE_CLEAR_GENERATION = Number.MAX_SAFE_INTEGER + 1;
const STALE_CLEAR_EPOCH = "epoch-stale-clear";
const OVERLONG_CLEAR_EPOCH = "x".repeat(129);
const SENSITIVE_PROMPT = "synthetic sensitive prompt";
const POST_CLEAR_PROMPT = "synthetic post-clear prompt";
const LEGACY_PROMPT = "synthetic legacy prompt";
const LEGACY_ENTRY = {
	text: LEGACY_PROMPT,
	createdAt: FIXTURE_TIMESTAMP,
	updatedAt: FIXTURE_TIMESTAMP,
	useCount: 1,
} as const;
const UNSUPPORTED_SCHEMA_VERSION = HISTORY_SCHEMA_VERSION + 1;
const INVALID_SCHEMA_VERSIONS: ReadonlyArray<Readonly<{ label: string; value?: unknown }>> = [
	{ label: "missing" },
	{ label: "string", value: String(UNSUPPORTED_SCHEMA_VERSION) },
	{ label: "zero", value: 0 },
	{ label: "negative", value: -1 },
	{ label: "fractional", value: 1.5 },
];
const INVALID_CLEAR_METADATA = [
	{
		schema: "schema-2",
		schemaVersion: GENERATION_HISTORY_SCHEMA_VERSION,
		field: "clearGeneration",
		name: "clear generation",
		cases: [
			{ label: "missing", value: undefined },
			{ label: "string", value: "1" },
			{ label: "null", value: null },
			{ label: "boolean", value: true },
			{ label: "negative", value: -1 },
			{ label: "fractional", value: 0.5 },
			{ label: "unsafe", value: UNSAFE_CLEAR_GENERATION },
		],
	},
	{
		schema: "schema-3",
		schemaVersion: HISTORY_SCHEMA_VERSION,
		field: "clearEpoch",
		name: "clear epoch",
		cases: [
			{ label: "missing", value: undefined },
			{ label: "number", value: 1 },
			{ label: "boolean", value: true },
			{ label: "empty", value: "" },
			{ label: "overlong", value: OVERLONG_CLEAR_EPOCH },
		],
	},
] as const;
const LEGACY_MIGRATION_CASES = [
	{
		label: "without a clear marker",
		clearedAt: undefined,
		expectsClearEpoch: false,
	},
	{
		label: "with a clear marker",
		clearedAt: FIXTURE_TIMESTAMP,
		expectsClearEpoch: true,
	},
] as const;
const CAUSAL_CLEAR_CASES = [
	{
		label: "after clock rollback",
		secondClearAt: ROLLED_BACK_CLEAR_TIMESTAMP,
	},
	{
		label: "when clear clocks are equal",
		secondClearAt: FIRST_CLEAR_TIMESTAMP,
	},
] as const;
const FOREIGN_REVALIDATION_CASES = [
	{ operation: "record", label: "recording" },
	{ operation: "clear", label: "replacement" },
] as const;

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

		const clearResult = await store.clear();

		assert.deepEqual(clearResult, { kind: "cleared" });
		assert.equal(store.writeBlocked, false);
		assert.equal((await loadStore()).writeBlocked, false);
	});
});

test("unsupported schema blocks mutations and preserves original bytes", async () => {
	await withStoreFixture(async ({ projectRoot, storePath, loadStore }) => {
		const original = serializeHistory({
			schemaVersion: UNSUPPORTED_SCHEMA_VERSION,
			projectRoot,
			createdAt: FIXTURE_TIMESTAMP,
			updatedAt: FIXTURE_TIMESTAMP,
			entries: [
				{
					text: "synthetic future prompt",
					createdAt: FIXTURE_TIMESTAMP,
					updatedAt: FIXTURE_TIMESTAMP,
					useCount: 1,
				},
			],
		});
		mkdirSync(path.dirname(storePath), { recursive: true });
		writeFileSync(storePath, original, "utf8");

		const store = await loadStore();
		assert.equal(store.writeBlockedReason, "unsupported_schema");

		const recordResult = await store.recordPrompt("new synthetic prompt");
		const clearResult = await store.clear();

		assert.equal(recordResult.kind, "blocked");
		if (recordResult.kind === "blocked") {
			assert.equal(recordResult.reason, "unsupported_schema");
		}
		assert.equal(clearResult.kind, "blocked");
		if (clearResult.kind === "blocked") {
			assert.equal(clearResult.reason, "unsupported_schema");
		}
		assert.equal(store.writeBlockedReason, "unsupported_schema");
		assert.equal(readFileSync(storePath, "utf8"), original);
	});
});

for (const migrationCase of LEGACY_MIGRATION_CASES) {
	test(`schema-1 history migrates on first mutation ${migrationCase.label}`, async () => {
		await withStoreFixture(async ({ projectRoot, storePath, loadStore }) => {
			const original = serializeHistory({
				schemaVersion: LEGACY_HISTORY_SCHEMA_VERSION,
				projectRoot,
				createdAt: FIXTURE_TIMESTAMP,
				updatedAt: FIXTURE_TIMESTAMP,
				...(migrationCase.clearedAt ? { clearedAt: migrationCase.clearedAt } : {}),
				entries: [LEGACY_ENTRY],
			});
			mkdirSync(path.dirname(storePath), { recursive: true });
			writeFileSync(storePath, original, "utf8");

			const store = await loadStore({
				clock: makeClock([FIXTURE_TIMESTAMP, POST_CLEAR_PROMPT_TIMESTAMP]),
			});

			assert.equal(readFileSync(storePath, "utf8"), original);
			assert.deepEqual(store.entries, [LEGACY_ENTRY]);

			await store.recordPrompt(POST_CLEAR_PROMPT);

			const saved = JSON.parse(readFileSync(storePath, "utf8"));
			assert.equal(saved.schemaVersion, HISTORY_SCHEMA_VERSION);
			if (migrationCase.expectsClearEpoch) {
				assertOpaqueClearEpoch(saved.clearEpoch);
			} else {
				assert.equal(saved.clearEpoch, null);
			}
			assert.equal(saved.clearGeneration, undefined);
			assert.equal(saved.clearedAt, migrationCase.clearedAt);
			assert.deepEqual(
				saved.entries.map((entry: { text: string }) => entry.text),
				[POST_CLEAR_PROMPT, LEGACY_PROMPT],
			);
			assert.deepEqual(saved.entries[1], LEGACY_ENTRY);
		});
	});
}

test("clear revalidates a newly unsupported schema before replacement", async () => {
	await withStoreFixture(async ({ projectRoot, storePath, loadStore }) => {
		const store = await loadStore();
		const replacement = serializeHistory({
			schemaVersion: UNSUPPORTED_SCHEMA_VERSION,
			projectRoot,
			createdAt: FIXTURE_TIMESTAMP,
			updatedAt: FIXTURE_TIMESTAMP,
			entries: [],
		});
		mkdirSync(path.dirname(storePath), { recursive: true });
		writeFileSync(storePath, replacement, "utf8");

		const clearResult = await store.clear();

		assert.equal(clearResult.kind, "blocked");
		if (clearResult.kind === "blocked") {
			assert.equal(clearResult.reason, "unsupported_schema");
		}
		assert.equal(store.writeBlockedReason, "unsupported_schema");
		assert.equal(readFileSync(storePath, "utf8"), replacement);
	});
});

test("record revalidates a newly unsupported schema before recording", async () => {
	await withStoreFixture(async ({ projectRoot, storePath, loadStore }) => {
		const store = await loadStore();
		const replacement = serializeHistory({
			schemaVersion: UNSUPPORTED_SCHEMA_VERSION,
			projectRoot,
			createdAt: FIXTURE_TIMESTAMP,
			updatedAt: FIXTURE_TIMESTAMP,
			entries: [
				{
					text: "synthetic future prompt",
					createdAt: FIXTURE_TIMESTAMP,
					updatedAt: FIXTURE_TIMESTAMP,
					useCount: 1,
				},
			],
		});
		mkdirSync(path.dirname(storePath), { recursive: true });
		writeFileSync(storePath, replacement, "utf8");

		const recordResult = await store.recordPrompt("new synthetic prompt");

		assert.equal(recordResult.kind, "blocked");
		if (recordResult.kind === "blocked") {
			assert.equal(recordResult.reason, "unsupported_schema");
		}
		assert.equal(store.writeBlockedReason, "unsupported_schema");
		assert.equal(readFileSync(storePath, "utf8"), replacement);
	});
});

for (const revalidationCase of FOREIGN_REVALIDATION_CASES) {
	test(`${revalidationCase.operation} revalidates a newly foreign project root before ${revalidationCase.label}`, async () => {
		await withStoreFixture(async ({ storePath, loadStore }) => {
			const store = await loadStore();
			const foreign = {
				schemaVersion: HISTORY_SCHEMA_VERSION,
				clearEpoch: null,
				projectRoot: "/other/project",
				createdAt: FIXTURE_TIMESTAMP,
				updatedAt: FIXTURE_TIMESTAMP,
				entries: [],
			};
			seedHistoryFile(storePath, foreign);

			const result =
				revalidationCase.operation === "record"
					? await store.recordPrompt("alpha")
					: await store.clear();

			assert.equal(result.kind, "blocked");
			if (result.kind === "blocked") {
				assert.equal(result.reason, "project_root_mismatch");
			}
			assert.equal(store.writeBlockedReason, "project_root_mismatch");
			assert.equal(JSON.parse(readFileSync(storePath, "utf8")).projectRoot, "/other/project");
		});
	});
}

test("empty prompt skips before an existing block is reported", async () => {
	await withStoreFixture(async ({ projectRoot, storePath, loadStore }) => {
		const original = serializeHistory({
			schemaVersion: UNSUPPORTED_SCHEMA_VERSION,
			projectRoot,
			createdAt: FIXTURE_TIMESTAMP,
			updatedAt: FIXTURE_TIMESTAMP,
			entries: [],
		});
		mkdirSync(path.dirname(storePath), { recursive: true });
		writeFileSync(storePath, original, "utf8");

		const store = await loadStore();
		assert.equal(store.writeBlocked, true);
		const result = await store.recordPrompt("   ");

		assert.deepEqual(result, { kind: "skipped", reason: "empty" });
	});
});

for (const invalidSchema of INVALID_SCHEMA_VERSIONS) {
	test(`${invalidSchema.label} schema version remains recoverable corruption`, async () => {
		await withStoreFixture(async ({ projectRoot, storePath, loadStore }) => {
			const raw: Record<string, unknown> = {
				projectRoot,
				createdAt: FIXTURE_TIMESTAMP,
				updatedAt: FIXTURE_TIMESTAMP,
				entries: [],
			};
			if (invalidSchema.value !== undefined) raw.schemaVersion = invalidSchema.value;
			seedHistoryFile(storePath, raw);

			const store = await loadStore();
			assert.equal(store.writeBlockedReason, "corrupt_history");

			const clearResult = await store.clear();

			assert.equal(store.writeBlocked, false);
			assert.deepEqual(clearResult, { kind: "cleared" });
			assert.equal(
				JSON.parse(readFileSync(storePath, "utf8")).schemaVersion,
				HISTORY_SCHEMA_VERSION,
			);
		});
	});
}

for (const metadata of INVALID_CLEAR_METADATA) {
	for (const invalidCase of metadata.cases) {
		test(`${metadata.schema} ${invalidCase.label} ${metadata.name} is recoverable corruption`, async () => {
			await withStoreFixture(async ({ projectRoot, storePath, loadStore }) => {
				const raw: Record<string, unknown> = {
					schemaVersion: metadata.schemaVersion,
					projectRoot,
					createdAt: FIXTURE_TIMESTAMP,
					updatedAt: FIXTURE_TIMESTAMP,
					entries: [],
				};
				if (invalidCase.value !== undefined) raw[metadata.field] = invalidCase.value;
				seedHistoryFile(storePath, raw);

				const store = await loadStore({ clock: () => FIXTURE_TIMESTAMP });
				assert.equal(store.writeBlockedReason, "corrupt_history");

				const clearResult = await store.clear();
				const saved = JSON.parse(readFileSync(storePath, "utf8"));

				assert.deepEqual(clearResult, { kind: "cleared" });
				assert.equal(store.writeBlocked, false);
				assert.equal(saved.schemaVersion, HISTORY_SCHEMA_VERSION);
				assertOpaqueClearEpoch(saved.clearEpoch);
			});
		});
	}
}

test("corrupt-history recovery clear supersedes stale-epoch memory", async () => {
	await withStoreFixture(async ({ projectRoot, storePath, loadStore }) => {
		seedHistoryFile(storePath, {
			schemaVersion: HISTORY_SCHEMA_VERSION,
			clearEpoch: STALE_CLEAR_EPOCH,
			projectRoot,
			createdAt: FIXTURE_TIMESTAMP,
			updatedAt: FIXTURE_TIMESTAMP,
			clearedAt: FIXTURE_TIMESTAMP,
			entries: [LEGACY_ENTRY],
		});
		const stale = await loadStore({ clock: () => FIXTURE_TIMESTAMP });
		seedHistoryFile(storePath, {
			schemaVersion: HISTORY_SCHEMA_VERSION,
			projectRoot,
			createdAt: FIXTURE_TIMESTAMP,
			updatedAt: FIXTURE_TIMESTAMP,
			entries: [],
		});
		const recovery = await loadStore({ clock: () => FIXTURE_TIMESTAMP });
		assert.equal(recovery.writeBlockedReason, "corrupt_history");

		assert.deepEqual(await recovery.clear(), { kind: "cleared" });
		await stale.recordPrompt(POST_CLEAR_PROMPT);

		const saved = JSON.parse(readFileSync(storePath, "utf8"));
		assert.deepEqual(
			saved.entries.map((entry: { text: string }) => entry.text),
			[POST_CLEAR_PROMPT],
		);
		assertOpaqueClearEpoch(saved.clearEpoch);
		assert.notEqual(saved.clearEpoch, STALE_CLEAR_EPOCH);
	});
});

test("repeated clears mint distinct epochs without a terminal state", async () => {
	await withStoreFixture(async ({ storePath, loadStore }) => {
		const store = await loadStore();
		const epochs: string[] = [];
		for (let index = 0; index < 3; index += 1) {
			await store.recordPrompt(`synthetic prompt ${index}`);
			assert.deepEqual(await store.clear(), { kind: "cleared" });
			const saved = JSON.parse(readFileSync(storePath, "utf8"));
			assertOpaqueClearEpoch(saved.clearEpoch);
			epochs.push(saved.clearEpoch);
		}

		assert.equal(new Set(epochs).size, epochs.length);
		assert.equal(store.writeBlocked, false);
	});
});

test("distinct legacy schema-1 clears never collapse into one lineage", async () => {
	await withStoreFixture(async ({ projectRoot, storePath, loadStore }) => {
		// An old writer's cleared file: the marker proves one clear happened.
		seedHistoryFile(storePath, {
			schemaVersion: LEGACY_HISTORY_SCHEMA_VERSION,
			projectRoot,
			createdAt: FIXTURE_TIMESTAMP,
			updatedAt: FIXTURE_TIMESTAMP,
			clearedAt: FIXTURE_TIMESTAMP,
			entries: [LEGACY_ENTRY],
		});
		const stale = await loadStore({ clock: () => FIXTURE_TIMESTAMP });

		// The old writer clears again on an equal clock; this is a distinct clear.
		seedHistoryFile(storePath, {
			schemaVersion: LEGACY_HISTORY_SCHEMA_VERSION,
			projectRoot,
			createdAt: FIXTURE_TIMESTAMP,
			updatedAt: FIXTURE_TIMESTAMP,
			clearedAt: FIXTURE_TIMESTAMP,
			entries: [],
		});

		await stale.recordPrompt(POST_CLEAR_PROMPT);

		const saved = JSON.parse(readFileSync(storePath, "utf8"));
		assert.deepEqual(
			saved.entries.map((entry: { text: string }) => entry.text),
			[POST_CLEAR_PROMPT],
		);
		assert.equal(saved.schemaVersion, HISTORY_SCHEMA_VERSION);
		assertOpaqueClearEpoch(saved.clearEpoch);
	});
});

test("malformed schema-1 content remains recoverable corruption", async () => {
	await withStoreFixture(async ({ projectRoot, storePath, loadStore }) => {
		// Version matches but an entry lacks required fields, so normalization must fail.
		const raw = {
			schemaVersion: LEGACY_HISTORY_SCHEMA_VERSION,
			projectRoot,
			createdAt: FIXTURE_TIMESTAMP,
			updatedAt: FIXTURE_TIMESTAMP,
			entries: [{ text: "synthetic prompt with missing fields" }],
		};
		seedHistoryFile(storePath, raw);

		const store = await loadStore();
		assert.equal(store.writeBlockedReason, "corrupt_history");

		const clearResult = await store.clear();

		assert.equal(store.writeBlocked, false);
		assert.deepEqual(clearResult, { kind: "cleared" });
		assert.equal(JSON.parse(readFileSync(storePath, "utf8")).schemaVersion, HISTORY_SCHEMA_VERSION);
	});
});

test("project mismatch blocks writes instead of merging histories", async () => {
	await withStoreFixture(async ({ storePath, loadStore }) => {
		const foreign = {
			schemaVersion: HISTORY_SCHEMA_VERSION,
			clearEpoch: null,
			projectRoot: "/other/project",
			createdAt: FIXTURE_TIMESTAMP,
			updatedAt: FIXTURE_TIMESTAMP,
			entries: [],
		};
		seedHistoryFile(storePath, foreign);

		const store = await loadStore();
		const result = await store.recordPrompt("alpha");

		assert.equal(store.writeBlockedReason, "project_root_mismatch");
		assert.equal(result.kind, "blocked");
		assert.match(store.warnings.join("\n"), /belongs to/);
		assert.equal(store.warnings.join("\n").includes("/other/project"), false);
		assert.equal(store.warnings.join("\n").includes(storePath), false);

		const clearResult = await store.clear();

		assert.equal(clearResult.kind, "blocked");
		assert.equal(store.writeBlockedReason, "project_root_mismatch");
		assert.equal(JSON.parse(readFileSync(storePath, "utf8")).projectRoot, "/other/project");
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

test("record publication failure preserves prior in-memory state", async (context) => {
	context.mock.timers.enable({ apis: ["Date"], now: new Date(FIXTURE_TIMESTAMP) });
	await withStoreFixture(async ({ storePath, loadStore }) => {
		const store = await loadStore({ clock: () => FIXTURE_TIMESTAMP });
		await store.recordPrompt(LEGACY_PROMPT);
		const priorEntries = [...store.entries];
		const priorWarnings = [...store.warnings];
		mkdirSync(`${storePath}.${process.pid}.${Date.now()}.tmp`);

		await assert.rejects(store.recordPrompt(POST_CLEAR_PROMPT));

		assert.deepEqual(store.entries, priorEntries);
		assert.equal(store.writeBlockedReason, undefined);
		assert.deepEqual(store.warnings, priorWarnings);
		assert.deepEqual(
			JSON.parse(readFileSync(storePath, "utf8")).entries.map(
				(entry: { text: string }) => entry.text,
			),
			[LEGACY_PROMPT],
		);
	});
});

test("clear publication failure preserves prior in-memory state", async (context) => {
	context.mock.timers.enable({ apis: ["Date"], now: new Date(FIXTURE_TIMESTAMP) });
	await withStoreFixture(async ({ storePath, loadStore }) => {
		const store = await loadStore({ clock: () => FIXTURE_TIMESTAMP });
		await store.recordPrompt(LEGACY_PROMPT);
		const priorEntries = [...store.entries];
		const priorWarnings = [...store.warnings];
		mkdirSync(`${storePath}.${process.pid}.${Date.now()}.tmp`);

		await assert.rejects(store.clear());

		assert.deepEqual(store.entries, priorEntries);
		assert.equal(store.writeBlockedReason, undefined);
		assert.deepEqual(store.warnings, priorWarnings);
		assert.deepEqual(
			JSON.parse(readFileSync(storePath, "utf8")).entries.map(
				(entry: { text: string }) => entry.text,
			),
			[LEGACY_PROMPT],
		);
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

for (const clearCase of CAUSAL_CLEAR_CASES) {
	test(`later clear prevents stale-session resurrection ${clearCase.label}`, async () => {
		const firstClock = makeClock([
			FIXTURE_TIMESTAMP,
			FIRST_CLEAR_TIMESTAMP,
			INTERVENING_PROMPT_TIMESTAMP,
			clearCase.secondClearAt,
		]);
		const staleClock = makeClock([INTERVENING_PROMPT_TIMESTAMP, POST_CLEAR_PROMPT_TIMESTAMP]);
		await withStoreFixture(async ({ storePath, loadStore }) => {
			const first = await loadStore({ clock: firstClock });
			await first.clear();
			await first.recordPrompt(SENSITIVE_PROMPT);
			const stale = await loadStore({ clock: staleClock });
			const firstClearEpoch = JSON.parse(readFileSync(storePath, "utf8")).clearEpoch;
			assertOpaqueClearEpoch(firstClearEpoch);

			await first.clear();
			await stale.recordPrompt(POST_CLEAR_PROMPT);
			const reloaded = await loadStore();
			const saved = JSON.parse(readFileSync(storePath, "utf8"));

			assert.deepEqual(
				reloaded.entries.map((entry) => entry.text),
				[POST_CLEAR_PROMPT],
			);
			assertOpaqueClearEpoch(saved.clearEpoch);
			assert.notEqual(saved.clearEpoch, firstClearEpoch);
			assert.equal(saved.clearedAt, clearCase.secondClearAt);
		});
	});
}

test("clear removes crash-orphaned temp artifacts for the active history", async () => {
	await withStoreFixture(async ({ storePath, loadStore }) => {
		const store = await loadStore();
		await store.recordPrompt("alpha");
		const orphanPath = `${storePath}.12345.67890.tmp`;
		writeFileSync(orphanPath, serializeHistory({ entries: [{ text: SENSITIVE_PROMPT }] }), {
			mode: 0o600,
		});

		assert.deepEqual(await store.clear(), { kind: "cleared" });

		assert.equal(existsSync(orphanPath), false);
		assert.equal(existsSync(storePath), true);
		assert.equal(statSync(storePath).mode & 0o777, 0o600);
	});
});

test("clear preserves unsafe or unrelated temp-shaped entries", async () => {
	await withStoreFixture(async ({ storePath, loadStore }) => {
		const store = await loadStore();
		await store.recordPrompt("alpha");
		const targetPath = `${storePath}.target`;
		const symlinkPath = `${storePath}.11111.22222.tmp`;
		const directoryPath = `${storePath}.33333.44444.tmp`;
		const malformedPath = `${storePath}.notapid.tmp`;
		const unrelatedPath = `${storePath}.unrelated`;
		writeFileSync(targetPath, "target", { mode: 0o600 });
		symlinkSync(targetPath, symlinkPath);
		mkdirSync(directoryPath);
		writeFileSync(malformedPath, "malformed", { mode: 0o600 });
		writeFileSync(unrelatedPath, "unrelated", { mode: 0o600 });

		assert.deepEqual(await store.clear(), { kind: "cleared" });

		assert.equal(lstatSync(symlinkPath).isSymbolicLink(), true);
		assert.equal(statSync(directoryPath).isDirectory(), true);
		assert.equal(readFileSync(malformedPath, "utf8"), "malformed");
		assert.equal(readFileSync(unrelatedPath, "utf8"), "unrelated");
		assert.equal(readFileSync(targetPath, "utf8"), "target");
	});
});

test("orphan cleanup fails safely when an artifact cannot be removed", async () => {
	// Root bypasses directory permission bits, so this failure mode is untestable there.
	if (process.getuid?.() === 0) return;
	await withStoreFixture(async ({ storePath }) => {
		mkdirSync(path.dirname(storePath), { recursive: true });
		const orphanPath = `${storePath}.12345.67890.tmp`;
		writeFileSync(orphanPath, "orphan", { mode: 0o600 });
		const directory = path.dirname(storePath);
		chmodSync(directory, 0o500);
		try {
			await assert.rejects(
				removeOrphanedTempArtifacts(storePath),
				/unable to remove orphaned history artifacts/,
			);
			assert.equal(readFileSync(orphanPath, "utf8"), "orphan");
		} finally {
			chmodSync(directory, 0o700);
		}
	});
});

test("stale lock owned by a dead process is reclaimed", async () => {
	await withStoreFixture(async ({ storePath, loadStore }) => {
		const lockPath = `${storePath}.lock`;
		mkdirSync(lockPath, { recursive: true, mode: 0o700 });
		writeLockOwnerFixture(lockPath, {
			pid: 999_999,
			host: "stale-host",
			createdAt: "2000-01-01T00:00:00.000Z",
		});

		const store = await loadStore();
		await store.recordPrompt("alpha");

		assert.equal(store.entries[0]?.text, "alpha");
		assert.equal(existsSync(lockPath), false);
	});
});

test("stale history reclaimers wait for an existing removal claim", async () => {
	await withStoreFixture(async ({ storePath }) => {
		const lockPath = `${storePath}.lock`;
		mkdirSync(lockPath, { recursive: true, mode: 0o700 });
		writeLockOwnerFixture(lockPath, {
			pid: 999_999,
			host: hostname(),
			createdAt: FIXTURE_TIMESTAMP,
		});
		mkdirSync(path.join(lockPath, LOCK_REMOVAL_CLAIM_DIRECTORY));
		const releases = [deferred(), deferred()];
		const entered: number[] = [];
		const contenders = releases.map((release, index) =>
			withHistoryFileLock(storePath, async () => {
				entered.push(index);
				await release.promise;
			}),
		);

		await delay(100);
		const enteredWhileClaimed = entered.length;
		for (const release of releases) release.resolve();
		rmSync(path.join(lockPath, LOCK_REMOVAL_CLAIM_DIRECTORY), {
			force: true,
			recursive: true,
		});
		await Promise.all(contenders);

		assert.equal(enteredWhileClaimed, 0);
		assert.deepEqual(new Set(entered), new Set([0, 1]));
		assert.equal(existsSync(lockPath), false);
	});
});

test("live same-host owner is never evicted by lock age alone", async () => {
	await withStoreFixture(async ({ storePath }) => {
		const lockPath = `${storePath}.lock`;
		mkdirSync(lockPath, { recursive: true, mode: 0o700 });
		writeLockOwnerFixture(lockPath, {
			pid: process.pid,
			host: hostname(),
			createdAt: "2000-01-01T00:00:00.000Z",
		});

		await assert.rejects(
			withHistoryFileLock(storePath, async () => "unreachable"),
			/timed out waiting for history lock/,
		);
		assert.equal(existsSync(lockPath), true);
	});
});

test("dead owner is reclaimed and the successor publishes", async () => {
	await withStoreFixture(async ({ storePath }) => {
		const lockPath = `${storePath}.lock`;
		mkdirSync(lockPath, { recursive: true, mode: 0o700 });
		writeLockOwnerFixture(lockPath, {
			pid: 999_999,
			host: hostname(),
			createdAt: FIXTURE_TIMESTAMP,
		});

		const result = await withHistoryFileLock(storePath, async () => "acquired");

		assert.equal(result, "acquired");
		assert.equal(existsSync(lockPath), false);
	});
});

test("old owner release cannot delete a successor lock", async () => {
	await withStoreFixture(async ({ storePath }) => {
		const lockPath = `${storePath}.lock`;
		const oldHoldsLock = deferred();
		const oldMayFinish = deferred();
		const oldOwner = withHistoryFileLock(storePath, async () => {
			oldHoldsLock.resolve();
			await oldMayFinish.promise;
		});
		await oldHoldsLock.promise;

		// Simulate reclamation: a successor takes over the same lock path.
		rmSync(lockPath, { force: true, recursive: true });
		const successorHoldsLock = deferred();
		const successorMayFinish = deferred();
		const successor = withHistoryFileLock(storePath, async () => {
			successorHoldsLock.resolve();
			await successorMayFinish.promise;
		});
		await successorHoldsLock.promise;

		oldMayFinish.resolve();
		await oldOwner;
		assert.equal(existsSync(lockPath), true);

		successorMayFinish.resolve();
		await successor;
		assert.equal(existsSync(lockPath), false);
	});
});

test("resumed displaced writer cannot fence or publish over a successor", async () => {
	await withStoreFixture(async ({ storePath }) => {
		const lockPath = `${storePath}.lock`;
		const displacedHoldsLock = deferred();
		const displacedMayResume = deferred();
		const displaced = withHistoryFileLock(storePath, async (fence) => {
			displacedHoldsLock.resolve();
			await displacedMayResume.promise;
			await fence();
			return "published";
		});
		await displacedHoldsLock.promise;

		rmSync(lockPath, { force: true, recursive: true });
		const markerPath = `${storePath}.successor-marker`;
		await withHistoryFileLock(storePath, async () => {
			writeFileSync(markerPath, "published", { mode: 0o600 });
		});

		displacedMayResume.resolve();
		await assert.rejects(displaced, /ownership/);
		assert.equal(readFileSync(markerPath, "utf8"), "published");
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

function serializeHistory(history: unknown): string {
	return `${JSON.stringify(history, null, 2)}\n`;
}

function seedHistoryFile(storePath: string, history: unknown): void {
	mkdirSync(path.dirname(storePath), { recursive: true });
	writeFileSync(storePath, serializeHistory(history), "utf8");
}

function writeLockOwnerFixture(
	lockPath: string,
	owner: { pid: number; host: string; createdAt: string },
): void {
	writeFileSync(
		path.join(lockPath, "owner.json"),
		`${JSON.stringify({ ...owner, token: "fixture-token" })}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}

function assertOpaqueClearEpoch(value: unknown): void {
	assert.equal(typeof value, "string");
	assert.notEqual((value as string).length, 0);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((release) => {
		resolve = release;
	});
	return { promise, resolve };
}

function makeClock(values: string[]): Clock {
	let index = 0;
	return () => values[index++] ?? values[values.length - 1] ?? "2026-07-01T00:00:00.000Z";
}
