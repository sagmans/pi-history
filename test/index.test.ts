import { strict as assert } from "node:assert";
import test from "node:test";

import type {
	ExecOptions,
	ExecResult,
	InputEvent,
	InputEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	type EditorFactory,
	installPiHistoryForTest,
	type PiHistoryApi,
	type PiHistoryContext,
	type PiHistoryRuntime,
	type PiHistoryStore,
	type RuntimeInstallOptions,
	shouldCaptureInput,
} from "../index.ts";
import { IsolationLevel, type PiHistoryConfig } from "../src/config.ts";
import type {
	ClearHistoryResult,
	HistoryBlockReason,
	HistoryEntry,
	RecordPromptResult,
} from "../src/history-store.ts";
import {
	createProjectIdentity,
	GLOBAL_SCOPE_KEY,
	type ProjectExec,
	type ProjectIdentity,
} from "../src/project.ts";
import { testTheme } from "./theme-fixture.ts";

const PROJECT_ROOT = "/workspace/project";
const NON_TUI_MODES = ["rpc", "json", "print"] as const;
type RuntimeMode = "tui" | (typeof NON_TUI_MODES)[number];

test("config loading waits for TUI session start", async () => {
	const fixture = createRuntimeFixture();
	let configReads = 0;
	fixture.install({
		readConfig: () => {
			configReads++;
			return {};
		},
	});

	assert.equal(configReads, 0);

	await fixture.emitSessionStart();

	assert.equal(configReads, 1);
});

test("status observes state without initializing the runtime", async () => {
	const fixture = createRuntimeFixture();
	let configReads = 0;
	fixture.install({
		readConfig: () => {
			configReads++;
			return {};
		},
	});

	await fixture.runCommand("status");

	assert.equal(configReads, 0);
	assert.deepEqual(fixture.context.notifications.at(-1), {
		message: "pi-history is not initialized",
		type: "info",
	});
});

test("global isolation resolves the global identity without git discovery", async () => {
	const fixture = createRuntimeFixture({
		isolationLevel: IsolationLevel.Global,
	});
	let execCalls = 0;
	fixture.pi.exec = async () => {
		execCalls++;
		return { stdout: "", stderr: "", code: 1, killed: false };
	};
	let loadedIdentity: ProjectIdentity | undefined;
	fixture.install({
		resolveIdentity: undefined,
		loadStore: async (input) => {
			loadedIdentity = input.identity;
			return fixture.store;
		},
	});

	await fixture.emitSessionStart();

	assert.equal(execCalls, 0);
	assert.equal(loadedIdentity?.kind, "global");
	assert.equal(loadedIdentity?.isolationLevel, IsolationLevel.Global);
	assert.equal(loadedIdentity?.projectRoot, GLOBAL_SCOPE_KEY);
});

test("project isolation keeps git-based identity resolution", async () => {
	const fixture = createRuntimeFixture({
		isolationLevel: IsolationLevel.Project,
	});
	let loadedIdentity: ProjectIdentity | undefined;
	fixture.install({
		resolveIdentity: undefined,
		loadStore: async (input) => {
			loadedIdentity = input.identity;
			return fixture.store;
		},
	});

	await fixture.emitSessionStart();

	// FakePi.exec fails git discovery, so project isolation falls back to cwd.
	assert.equal(loadedIdentity?.kind, "directory");
	assert.equal(loadedIdentity?.isolationLevel, IsolationLevel.Project);
	assert.notEqual(loadedIdentity?.projectRoot, GLOBAL_SCOPE_KEY);
});

test("healthy global status uses the versioned diagnostic contract", async () => {
	const fixture = createRuntimeFixture({
		isolationLevel: IsolationLevel.Global,
	});
	fixture.install({ resolveIdentity: undefined });
	await fixture.emitSessionStart();

	await fixture.runCommand("status");

	assert.deepEqual(fixture.context.notifications.at(-1), {
		message:
			"pi-history: diagnosticsVersion=1; state=healthy; initialization=ready; storage=ready; editor=ready; entries=0; cap=500; scope=global",
		type: "info",
	});
});

test("configuration loading failure omits unavailable metadata", async () => {
	const fixture = createRuntimeFixture();
	fixture.install({
		readConfig: () => {
			throw new Error("config secret at /private/config");
		},
	});
	await fixture.emitSessionStart();

	await fixture.runCommand("status");

	assert.deepEqual(fixture.context.notifications.at(-1), {
		message:
			"pi-history: diagnosticsVersion=1; state=initialization_failed; initialization=failed; initializationReason=configuration_load_failed; storage=unavailable; editor=ready",
		type: "warning",
	});
	assert.match(notificationText(fixture.context), /config secret at \/private\/config/);
});

test("new TUI session retries failed initialization", async () => {
	const fixture = createRuntimeFixture();
	let configReads = 0;
	fixture.install({
		readConfig: () => {
			configReads++;
			if (configReads === 1) throw new Error("transient config failure");
			return {};
		},
	});

	await fixture.emitSessionStart();
	await fixture.runCommand("status");
	await fixture.runCommand("status");
	assert.equal(configReads, 1);

	await fixture.emitSessionStart();
	await fixture.runCommand("status");

	assert.equal(configReads, 2);
	assert.match(fixture.context.notifications.at(-1)?.message ?? "", /state=healthy/);
});

test("identity resolution failure reports a safe stage code", async () => {
	const fixture = createRuntimeFixture();
	fixture.install({
		resolveIdentity: async () => {
			throw new Error("identity secret at /private/project");
		},
	});
	await fixture.emitSessionStart();

	await fixture.runCommand("status");

	assert.deepEqual(fixture.context.notifications.at(-1), {
		message:
			"pi-history: diagnosticsVersion=1; state=initialization_failed; initialization=failed; initializationReason=identity_resolution_failed; storage=unavailable; editor=ready; cap=500; scope=project",
		type: "warning",
	});
	assert.match(notificationText(fixture.context), /identity secret at \/private\/project/);
});

test("storage loading failure reports a safe stage code", async () => {
	const fixture = createRuntimeFixture();
	fixture.install({
		loadStore: async () => {
			throw new Error("storage secret at /private/history");
		},
	});
	await fixture.emitSessionStart();

	await fixture.runCommand("status");

	assert.deepEqual(fixture.context.notifications.at(-1), {
		message:
			"pi-history: diagnosticsVersion=1; state=initialization_failed; initialization=failed; initializationReason=storage_load_failed; storage=unavailable; editor=ready; cap=500; scope=project",
		type: "warning",
	});
	assert.match(notificationText(fixture.context), /storage secret at \/private\/history/);
});

test("clear on global scope confirms with host-wide wording", async () => {
	const fixture = createRuntimeFixture({
		isolationLevel: IsolationLevel.Global,
	});
	fixture.install({ resolveIdentity: undefined });
	await fixture.emitSessionStart();

	await fixture.runCommand("clear");

	assert.equal(fixture.store.clearCount, 1);
	assert.match(fixture.context.confirmMessages.at(-1) ?? "", /all projects on this host/);
	assert.match(fixture.context.notifications.at(-1)?.message ?? "", /global scope/);
});

test("interactive input records a prompt and continues", async () => {
	const fixture = createRuntimeFixture();
	fixture.install();
	await fixture.emitSessionStart();

	const result = await fixture.emitInput({
		text: "review the diff",
		source: "interactive",
	});

	assert.deepEqual(result, { action: "continue" });
	assert.deepEqual(fixture.store.recorded, ["review the diff"]);
});

for (const mode of NON_TUI_MODES) {
	test(`${mode} mode keeps only static command metadata`, async () => {
		const fixture = createRuntimeFixture({ mode });
		let configReads = 0;
		let identityResolutions = 0;
		let storeLoads = 0;
		const resolveIdentity = fixture.options.resolveIdentity;
		const loadStore = fixture.options.loadStore;
		assert.ok(resolveIdentity);
		assert.ok(loadStore);
		fixture.install({
			readConfig: () => {
				configReads++;
				return {};
			},
			resolveIdentity: async (ctx) => {
				identityResolutions++;
				return resolveIdentity(ctx);
			},
			loadStore: async (input) => {
				storeLoads++;
				return loadStore(input);
			},
		});

		assert.equal(fixture.pi.commands.has("pi-history"), true);

		await fixture.emitSessionStart();
		const result = await fixture.emitInput({ text: "private prompt", source: "rpc" });
		await fixture.runCommand("status");
		await fixture.runCommand("clear");

		assert.deepEqual(result, { action: "continue" });
		assert.equal(configReads, 0);
		assert.equal(identityResolutions, 0);
		assert.equal(storeLoads, 0);
		assert.deepEqual(fixture.store.recorded, []);
		assert.equal(fixture.store.clearCount, 0);
		assert.equal(fixture.context.uiAccessCount, 0);
	});
}

test("extension input and empty input are ignored", async () => {
	const fixture = createRuntimeFixture();
	fixture.install();
	await fixture.emitSessionStart();

	await fixture.emitInput({ text: "automation", source: "extension" });
	await fixture.emitInput({ text: " \n\t ", source: "interactive" });

	assert.deepEqual(fixture.store.recorded, []);
});

test("capture errors notify the user but do not block prompt flow", async () => {
	const fixture = createRuntimeFixture();
	fixture.store.recordError = new Error("disk full");
	fixture.install();
	await fixture.emitSessionStart();

	const result = await fixture.emitInput({
		text: "save me",
		source: "interactive",
	});

	assert.deepEqual(result, { action: "continue" });
	assert.match(notificationText(fixture.context), /capture failed: disk full/);
});

test("blocked input capture warns once and continues", async () => {
	const fixture = createRuntimeFixture();
	fixture.store.blockReason = "project_root_mismatch";
	fixture.install();
	await fixture.emitSessionStart();

	const first = await fixture.emitInput({
		text: "alpha",
		source: "interactive",
	});
	const second = await fixture.emitInput({
		text: "beta",
		source: "interactive",
	});

	assert.deepEqual(first, { action: "continue" });
	assert.deepEqual(second, { action: "continue" });
	assert.equal(notificationText(fixture.context).match(/write blocked/g)?.length, 1);
	assert.doesNotMatch(notificationText(fixture.context), /alpha|beta/);
});

test("healthy project status omits private data without mutating runtime state", async () => {
	const fixture = createRuntimeFixture({ configMaxEntries: 42 });
	fixture.store.entriesSnapshot = [entry("secret prompt text")];
	const runtime = fixture.install();
	await fixture.emitSessionStart();
	const initializedState = runtime.getState();

	await fixture.runCommand("status");
	await fixture.runCommand("status");

	assert.deepEqual(runtime.getState(), initializedState);
	assert.equal(fixture.store.clearCount, 0);
	assert.deepEqual(fixture.context.notifications.at(-1), {
		message:
			"pi-history: diagnosticsVersion=1; state=healthy; initialization=ready; storage=ready; editor=ready; entries=1; cap=42; scope=project",
		type: "info",
	});
});

test("status reports project metadata without prompt contents", async () => {
	const fixture = createRuntimeFixture({ configMaxEntries: 42 });
	fixture.store.entriesSnapshot = [entry("secret prompt text")];
	fixture.store.blockReason = "corrupt_history";
	fixture.install();
	await fixture.emitSessionStart();

	await fixture.runCommand("status");

	const message = fixture.context.notifications.at(-1)?.message ?? "";
	assert.match(message, /entries=1/);
	assert.match(message, /cap=42/);
	assert.match(message, /project=\/workspace\/project/);
	assert.match(message, /writeBlocked=corrupt_history/);
	assert.doesNotMatch(message, /secret prompt text/);
});

test("clear confirms and clears active in-memory store", async () => {
	const fixture = createRuntimeFixture();
	fixture.install();
	await fixture.emitSessionStart();
	await fixture.emitInput({ text: "alpha", source: "interactive" });

	await fixture.runCommand("clear");

	assert.equal(fixture.store.clearCount, 1);
	assert.deepEqual(fixture.store.recorded, []);
	assert.match(fixture.context.notifications.at(-1)?.message ?? "", /cleared/);
});

test("clear cancellation leaves store intact", async () => {
	const fixture = createRuntimeFixture({ confirmResult: false });
	fixture.install();
	await fixture.emitSessionStart();
	await fixture.emitInput({ text: "alpha", source: "interactive" });

	await fixture.runCommand("clear");

	assert.equal(fixture.store.clearCount, 0);
	assert.deepEqual(fixture.store.recorded, ["alpha"]);
});

test("shouldCaptureInput is limited to real non-empty non-extension text", () => {
	assert.equal(shouldCaptureInput({ text: "hello", source: "interactive" }), true);
	assert.equal(shouldCaptureInput({ text: "hello", source: "rpc" }), true);
	assert.equal(shouldCaptureInput({ text: "hello", source: "extension" }), false);
	assert.equal(shouldCaptureInput({ text: " ", source: "interactive" }), false);
});

test("session start installs editor wrapper when editor UI is available", async () => {
	const fixture = createRuntimeFixture();
	fixture.install();

	await fixture.emitSessionStart();

	assert.equal(typeof fixture.context.editorFactory, "function");
});

function notificationText(context: FakeContext): string {
	return context.notifications.map((notification) => notification.message).join("\n");
}

type RuntimeFixtureOptions = {
	confirmResult?: boolean;
	configMaxEntries?: number;
	isolationLevel?: IsolationLevel;
	mode?: RuntimeMode;
};

type RuntimeFixture = {
	pi: FakePi;
	context: FakeContext;
	store: FakeStore;
	options: RuntimeInstallOptions;
	install: (extraOptions?: Partial<RuntimeInstallOptions>) => PiHistoryRuntime;
	emitSessionStart: () => Promise<void>;
	emitInput: (input: {
		text: string;
		source: InputEvent["source"];
	}) => Promise<InputEventResult | void>;
	runCommand: (args: string) => Promise<void>;
};

function buildFixtureConfig(options: RuntimeFixtureOptions): PiHistoryConfig {
	return {
		maxEntries: options.configMaxEntries ?? 500,
		isolationLevel: options.isolationLevel ?? IsolationLevel.Project,
	};
}

function createRuntimeFixture(options: RuntimeFixtureOptions = {}): RuntimeFixture {
	const identity = createProjectIdentity({
		kind: "directory",
		projectRoot: PROJECT_ROOT,
		historyBaseDir: "/private/history",
	});
	const store = new FakeStore(identity.historyFilePath, PROJECT_ROOT);
	const context = new FakeContext(options.confirmResult ?? true, options.mode ?? "tui");
	const pi = new FakePi();
	const fixtureOptions: RuntimeInstallOptions = {
		config: buildFixtureConfig(options),
		resolveIdentity: async () => identity,
		loadStore: async () => store,
	};
	return {
		pi,
		context,
		store,
		options: fixtureOptions,
		install: (extraOptions: Partial<RuntimeInstallOptions> = {}) =>
			installPiHistoryForTest(pi, { ...fixtureOptions, ...extraOptions }),
		emitSessionStart: async () => {
			await pi.sessionStartHandler?.({}, context);
		},
		emitInput: async (input) => {
			const event = makeInputEvent(input.text, input.source);
			return pi.inputHandler?.(event, context);
		},
		runCommand: async (args) => {
			const command = pi.commands.get("pi-history");
			assert.ok(command, "pi-history command should be registered");
			await command.handler(args, context);
		},
	};
}

function makeInputEvent(text: string, source: InputEvent["source"]): InputEvent {
	return { type: "input", text, source };
}

function entry(text: string): HistoryEntry {
	return {
		text,
		createdAt: "2026-07-01T00:00:00.000Z",
		updatedAt: "2026-07-01T00:00:00.000Z",
		useCount: 1,
	};
}

class FakeStore implements PiHistoryStore {
	recorded: string[] = [];
	entriesSnapshot: HistoryEntry[] = [];
	blockReason: HistoryBlockReason | undefined;
	recordError: Error | undefined;
	clearCount = 0;

	constructor(
		readonly historyFilePath: string,
		readonly projectRoot: string = PROJECT_ROOT,
	) {}

	get entries(): readonly HistoryEntry[] {
		return this.entriesSnapshot.length > 0 ? this.entriesSnapshot : this.recorded.map(entry);
	}

	get entryCount(): number {
		return this.entries.length;
	}

	get writeBlocked(): boolean {
		return this.blockReason !== undefined;
	}

	get writeBlockedReason(): HistoryBlockReason | undefined {
		return this.blockReason;
	}

	get warnings(): readonly string[] {
		return this.blockReason ? [`blocked: ${this.blockReason}`] : [];
	}

	async recordPrompt(text: string): Promise<RecordPromptResult> {
		if (this.recordError) throw this.recordError;
		if (this.blockReason) {
			return {
				kind: "blocked",
				reason: this.blockReason,
				warnings: [...this.warnings],
			};
		}
		this.recorded = [text, ...this.recorded.filter((entryText) => entryText !== text)];
		return { kind: "recorded", entryCount: this.recorded.length };
	}

	async clear(): Promise<ClearHistoryResult> {
		this.clearCount++;
		this.recorded = [];
		this.entriesSnapshot = [];
		return { kind: "cleared" };
	}
}

class FakeContext implements PiHistoryContext {
	notifications: Array<{
		message: string;
		type: "info" | "warning" | "error" | undefined;
	}> = [];
	confirmMessages: string[] = [];
	cwd = PROJECT_ROOT;
	editorFactory: EditorFactory | undefined;
	hasUI: boolean;
	uiAccessCount = 0;

	constructor(
		private readonly confirmResult: boolean,
		readonly mode: RuntimeMode,
	) {
		this.hasUI = mode === "tui" || mode === "rpc";
	}

	ui = {
		notify: (message: string, type?: "info" | "warning" | "error") => {
			this.uiAccessCount++;
			this.notifications.push({ message, type });
		},
		confirm: async (_title: string, message: string) => {
			this.uiAccessCount++;
			this.confirmMessages.push(message);
			return this.confirmResult;
		},
		theme: testTheme,
		getEditorComponent: () => {
			this.uiAccessCount++;
			return undefined;
		},
		setEditorComponent: (factory: EditorFactory | undefined) => {
			this.uiAccessCount++;
			this.editorFactory = factory;
		},
	};
}

class FakePi implements PiHistoryApi {
	commands = new Map<string, { handler: (args: string, ctx: PiHistoryContext) => Promise<void> }>();
	sessionStartHandler:
		| ((event: unknown, ctx: PiHistoryContext) => void | Promise<void>)
		| undefined;
	inputHandler:
		| ((
				event: InputEvent,
				ctx: PiHistoryContext,
		  ) => InputEventResult | void | Promise<InputEventResult | void>)
		| undefined;
	exec: ProjectExec = async (_command: string, _args: string[], _options?: ExecOptions) =>
		failure();

	on(
		event: "session_start",
		handler: (event: unknown, ctx: PiHistoryContext) => void | Promise<void>,
	): void;
	on(
		event: "input",
		handler: (
			event: InputEvent,
			ctx: PiHistoryContext,
		) => InputEventResult | void | Promise<InputEventResult | void>,
	): void;
	on(
		event: "session_start" | "input",
		handler:
			| ((event: unknown, ctx: PiHistoryContext) => void | Promise<void>)
			| ((
					event: InputEvent,
					ctx: PiHistoryContext,
			  ) => InputEventResult | void | Promise<InputEventResult | void>),
	): void {
		if (event === "session_start") {
			this.sessionStartHandler = handler as (
				event: unknown,
				ctx: PiHistoryContext,
			) => void | Promise<void>;
			return;
		}
		this.inputHandler = handler as (
			event: InputEvent,
			ctx: PiHistoryContext,
		) => InputEventResult | void | Promise<InputEventResult | void>;
	}

	registerCommand(
		name: string,
		options: {
			handler: (args: string, ctx: PiHistoryContext) => Promise<void>;
		},
	): void {
		this.commands.set(name, options);
	}
}

function failure(): ExecResult {
	return { stdout: "", stderr: "", code: 1, killed: false };
}
