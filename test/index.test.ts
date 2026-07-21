import { strict as assert } from "node:assert";
import test from "node:test";

import type { ExecOptions, ExecResult, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";

import { IsolationLevel, type PiHistoryConfig } from "../src/config.ts";
import {
	installPiHistoryForTest,
	shouldCaptureInput,
	type EditorFactory,
	type PiHistoryApi,
	type PiHistoryContext,
	type PiHistoryRuntime,
	type PiHistoryStore,
	type RuntimeInstallOptions,
} from "../index.ts";
import type {
	ClearHistoryResult,
	HistoryBlockReason,
	HistoryEntry,
	RecordPromptResult,
} from "../src/history-store.ts";
import {
	GLOBAL_SCOPE_KEY,
	createProjectIdentity,
	type ProjectExec,
	type ProjectIdentity,
} from "../src/project.ts";
import { testTheme } from "./theme-fixture.ts";

const PROJECT_ROOT = "/workspace/project";

test("global isolation resolves the global identity without git discovery", async () => {
	const fixture = createRuntimeFixture({ isolationLevel: IsolationLevel.Global });
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
	const fixture = createRuntimeFixture({ isolationLevel: IsolationLevel.Project });
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

test("status reports scope=global for global histories", async () => {
	const fixture = createRuntimeFixture({ isolationLevel: IsolationLevel.Global });
	fixture.install({ resolveIdentity: undefined });
	await fixture.emitSessionStart();

	await fixture.runCommand("status");

	const message = fixture.context.notifications.at(-1)?.message ?? "";
	assert.match(message, /scope=global/);
	assert.doesNotMatch(message, /project=/);
});

test("clear on global scope confirms with host-wide wording", async () => {
	const fixture = createRuntimeFixture({ isolationLevel: IsolationLevel.Global });
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

	const result = await fixture.emitInput({ text: "review the diff", source: "interactive" });

	assert.deepEqual(result, { action: "continue" });
	assert.deepEqual(fixture.store.recorded, ["review the diff"]);
});

test("RPC input records when source is not extension", async () => {
	const fixture = createRuntimeFixture();
	fixture.install();
	await fixture.emitSessionStart();

	await fixture.emitInput({ text: "follow up", source: "rpc" });

	assert.deepEqual(fixture.store.recorded, ["follow up"]);
});

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

	const result = await fixture.emitInput({ text: "save me", source: "interactive" });

	assert.deepEqual(result, { action: "continue" });
	assert.match(notificationText(fixture.context), /capture failed: disk full/);
});

test("blocked input capture warns once and continues", async () => {
	const fixture = createRuntimeFixture();
	fixture.store.blockReason = "project_root_mismatch";
	fixture.install();
	await fixture.emitSessionStart();

	const first = await fixture.emitInput({ text: "alpha", source: "interactive" });
	const second = await fixture.emitInput({ text: "beta", source: "interactive" });

	assert.deepEqual(first, { action: "continue" });
	assert.deepEqual(second, { action: "continue" });
	assert.equal(notificationText(fixture.context).match(/write blocked/g)?.length, 1);
	assert.doesNotMatch(notificationText(fixture.context), /alpha|beta/);
});

test("headless input capture never touches UI", async () => {
	const fixture = createRuntimeFixture({ headless: true });
	fixture.store.recordError = new Error("disk full");
	fixture.install();

	await fixture.emitSessionStart();
	const result = await fixture.emitInput({ text: "save me", source: "interactive" });

	assert.deepEqual(result, { action: "continue" });
	assert.equal(fixture.store.recorded.length, 0);
});

test("headless commands do not touch UI or clear without confirmation", async () => {
	const fixture = createRuntimeFixture({ headless: true });
	fixture.install();
	await fixture.emitSessionStart();

	await fixture.runCommand("status");
	await fixture.runCommand("clear");

	assert.equal(fixture.store.clearCount, 0);
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
	headless?: boolean;
	isolationLevel?: IsolationLevel;
};

type RuntimeFixture = {
	pi: FakePi;
	context: FakeContext;
	store: FakeStore;
	options: RuntimeInstallOptions;
	install: (extraOptions?: Partial<RuntimeInstallOptions>) => PiHistoryRuntime;
	emitSessionStart: () => Promise<void>;
	emitInput: (input: { text: string; source: InputEvent["source"] }) => Promise<InputEventResult | void>;
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
	const context = new FakeContext(options.confirmResult ?? true, options.headless ?? false);
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
			return { kind: "blocked", reason: this.blockReason, warnings: [...this.warnings] };
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
	notifications: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];
	confirmMessages: string[] = [];
	cwd = PROJECT_ROOT;
	editorFactory: EditorFactory | undefined;
	hasUI: boolean;

	constructor(
		private readonly confirmResult: boolean,
		headless: boolean,
	) {
		this.hasUI = !headless;
	}

	ui = {
		notify: (message: string, type?: "info" | "warning" | "error") => {
			this.assertUiAvailable();
			this.notifications.push({ message, type });
		},
		confirm: async (_title: string, message: string) => {
			this.assertUiAvailable();
			this.confirmMessages.push(message);
			return this.confirmResult;
		},
		theme: testTheme,
		getEditorComponent: () => {
			this.assertUiAvailable();
			return undefined;
		},
		setEditorComponent: (factory: EditorFactory | undefined) => {
			this.assertUiAvailable();
			this.editorFactory = factory;
		},
	};

	private assertUiAvailable(): void {
		if (!this.hasUI) throw new Error("UI should not be touched in headless mode");
	}
}

class FakePi implements PiHistoryApi {
	commands = new Map<string, { handler: (args: string, ctx: PiHistoryContext) => Promise<void> }>();
	sessionStartHandler:
		| ((event: unknown, ctx: PiHistoryContext) => void | Promise<void>)
		| undefined;
	inputHandler:
		| ((event: InputEvent, ctx: PiHistoryContext) => InputEventResult | void | Promise<InputEventResult | void>)
		| undefined;
	exec: ProjectExec = async (_command: string, _args: string[], _options?: ExecOptions) => failure();

	on(event: "session_start", handler: (event: unknown, ctx: PiHistoryContext) => void | Promise<void>): void;
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
			| ((event: InputEvent, ctx: PiHistoryContext) => InputEventResult | void | Promise<InputEventResult | void>),
	): void {
		if (event === "session_start") {
			this.sessionStartHandler = handler as (event: unknown, ctx: PiHistoryContext) => void | Promise<void>;
			return;
		}
		this.inputHandler = handler as (
			event: InputEvent,
			ctx: PiHistoryContext,
		) => InputEventResult | void | Promise<InputEventResult | void>;
	}

	registerCommand(
		name: string,
		options: { handler: (args: string, ctx: PiHistoryContext) => Promise<void> },
	): void {
		this.commands.set(name, options);
	}
}

function failure(): ExecResult {
	return { stdout: "", stderr: "", code: 1, killed: false };
}
