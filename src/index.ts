import {
	CustomEditor,
	type ExtensionAPI,
	type InputEvent,
	type InputEventResult,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";

import {
	type ConfigLayer,
	IsolationLevel,
	loadConfigFromDisk,
	normalizeConfig,
	type PiHistoryConfig,
} from "./config.ts";
import { HistoryEditor } from "./history-editor.ts";
import {
	type ClearHistoryResult,
	type Clock,
	type HistoryBlockReason,
	type HistoryEntry,
	loadHistoryStore,
	type RecordPromptResult,
} from "./history-store.ts";
import {
	createGlobalIdentity,
	type ProjectExec,
	type ProjectIdentity,
	resolveProjectIdentity,
} from "./project.ts";

const COMMAND_NAME = "pi-history";

export type PiHistoryContext = {
	cwd: string;
	hasUI?: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		confirm(title: string, message: string): Promise<boolean>;
		theme: { getFgAnsi(color: "accent" | "mdCode"): string };
		getEditorComponent?: () => EditorFactory | undefined;
		setEditorComponent?: (factory: EditorFactory | undefined) => void;
	};
};

export type EditorFactory = (
	tui: TUI,
	theme: EditorTheme,
	keybindings: KeybindingsManager,
) => EditorComponent;

export type PiHistoryApi = {
	exec: ProjectExec;
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
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler: (args: string, ctx: PiHistoryContext) => Promise<void>;
		},
	): void;
};

export type PiHistoryStore = {
	readonly projectRoot: string;
	readonly historyFilePath: string;
	readonly entries: readonly HistoryEntry[];
	readonly entryCount: number;
	readonly writeBlocked: boolean;
	readonly writeBlockedReason: HistoryBlockReason | undefined;
	readonly warnings: readonly string[];
	recordPrompt(text: string): Promise<RecordPromptResult>;
	clear(): Promise<ClearHistoryResult>;
};

export type RuntimeInstallOptions = {
	config?: Partial<PiHistoryConfig>;
	now?: Clock;
	readConfig?: () => { layers?: ConfigLayer[]; warnings?: string[] };
	resolveIdentity?: (ctx: PiHistoryContext) => Promise<ProjectIdentity>;
	loadStore?: (input: {
		identity: ProjectIdentity;
		maxEntries: number;
		now?: Clock;
	}) => Promise<PiHistoryStore>;
};

export type PiHistoryRuntime = {
	config: PiHistoryConfig;
	warnings: string[];
	getState(): RuntimeStateSnapshot;
};

export type RuntimeStateSnapshot = {
	identity: ProjectIdentity | undefined;
	store: PiHistoryStore | undefined;
	lastError: string | undefined;
};

type RuntimeState = {
	config: PiHistoryConfig;
	warnings: string[];
	identity: ProjectIdentity | undefined;
	store: PiHistoryStore | undefined;
	lastError: string | undefined;
	notifiedKeys: Set<string>;
	editorInstalled: boolean;
};

export function installPiHistoryForTest(
	pi: PiHistoryApi,
	options: RuntimeInstallOptions = {},
): PiHistoryRuntime {
	const { config, warnings } = loadRuntimeConfig(options);
	const state: RuntimeState = {
		config,
		warnings,
		identity: undefined,
		store: undefined,
		lastError: undefined,
		notifiedKeys: new Set(),
		editorInstalled: false,
	};
	// Global isolation skips git discovery entirely: one shared history per host.
	const resolveIdentity =
		options.resolveIdentity ??
		(config.isolationLevel === IsolationLevel.Global
			? () => Promise.resolve(createGlobalIdentity())
			: (ctx: PiHistoryContext) => resolveProjectIdentity({ cwd: ctx.cwd, exec: pi.exec }));
	const loadStore = options.loadStore ?? loadHistoryStore;

	async function initialize(ctx: PiHistoryContext): Promise<void> {
		notifyConfigWarnings(ctx, state);
		try {
			const identity = await resolveIdentity(ctx);
			const store = await loadStore({
				identity,
				maxEntries: config.maxEntries,
				now: options.now,
			});
			state.identity = identity;
			state.store = store;
			state.lastError = undefined;
			notifyStoreWarnings(ctx, state, store);
		} catch (error) {
			state.identity = undefined;
			state.store = undefined;
			state.lastError = errorMessage(error);
			notifyOnce(
				ctx,
				state,
				`init:${state.lastError}`,
				`pi-history unavailable: ${state.lastError}`,
				"warning",
			);
		}
	}

	async function ensureInitialized(ctx: PiHistoryContext): Promise<PiHistoryStore | undefined> {
		if (!state.store && !state.lastError) await initialize(ctx);
		return state.store;
	}

	pi.registerCommand(COMMAND_NAME, {
		description: "Inspect or clear private project prompt history",
		handler: async (args, ctx) => {
			await handleCommand(args, ctx, state, ensureInitialized);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		installEditorWrapper(ctx, state);
		await initialize(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (!shouldCaptureInput(event)) return { action: "continue" };
		const store = await ensureInitialized(ctx);
		if (!store) return { action: "continue" };
		try {
			const result = await store.recordPrompt(event.text);
			handleRecordResult(ctx, state, result);
		} catch (error) {
			notify(ctx, `pi-history capture failed: ${errorMessage(error)}`, "warning");
		}
		return { action: "continue" };
	});

	return {
		config,
		warnings,
		getState: () => ({
			identity: state.identity,
			store: state.store,
			lastError: state.lastError,
		}),
	};
}

export function shouldCaptureInput(event: Pick<InputEvent, "source" | "text">): boolean {
	return event.source !== "extension" && event.text.trim().length > 0;
}

function installEditorWrapper(ctx: PiHistoryContext, state: RuntimeState): void {
	if (state.editorInstalled) return;
	if (ctx.hasUI === false) return;
	const getEditorComponent = ctx.ui.getEditorComponent;
	const setEditorComponent = ctx.ui.setEditorComponent;
	if (!getEditorComponent || !setEditorComponent) return;

	const previousFactory = getEditorComponent();
	setEditorComponent((tui, theme, keybindings) => {
		const inner = previousFactory
			? previousFactory(tui, theme, keybindings)
			: new CustomEditor(tui, theme, keybindings);
		return new HistoryEditor(tui, theme, keybindings, inner, {
			getEntries: () => state.store?.entries ?? [],
			getSearchMatchColorSgr: () => ctx.ui.theme.getFgAnsi("mdCode"),
			getSearchSelectedColorSgr: () => ctx.ui.theme.getFgAnsi("accent"),
			onGhostUnavailable: (reason) => {
				notifyOnce(
					ctx,
					state,
					`ghost:${reason}`,
					`pi-history ghost completion disabled: ${reason}; Ctrl+R reverse search remains available`,
					"info",
				);
			},
		});
	});
	state.editorInstalled = true;
}

const RUNTIME_CONFIG_ORIGIN = "runtime options";

function loadRuntimeConfig(options: RuntimeInstallOptions): {
	config: PiHistoryConfig;
	warnings: string[];
} {
	const loaded = options.readConfig?.() ?? {};
	// Runtime overrides (tests, embedding hosts) outrank every on-disk layer.
	const layers = [
		...(loaded.layers ?? []),
		...(options.config ? [{ origin: RUNTIME_CONFIG_ORIGIN, value: options.config }] : []),
	];
	const normalized = normalizeConfig(layers);
	return {
		config: normalized.config,
		warnings: [...(loaded.warnings ?? []), ...normalized.warnings],
	};
}

async function handleCommand(
	args: string,
	ctx: PiHistoryContext,
	state: RuntimeState,
	ensureInitialized: (ctx: PiHistoryContext) => Promise<PiHistoryStore | undefined>,
): Promise<void> {
	const command = args.trim() || "status";
	const store = await ensureInitialized(ctx);
	if (command === "status") {
		notify(ctx, buildStatusMessage(state, store), store?.writeBlocked ? "warning" : "info");
		return;
	}
	if (command === "clear") {
		await handleClearCommand(ctx, state.identity, store);
		return;
	}
	notify(ctx, "Usage: /pi-history status|clear", "warning");
}

async function handleClearCommand(
	ctx: PiHistoryContext,
	identity: ProjectIdentity | undefined,
	store: PiHistoryStore | undefined,
): Promise<void> {
	if (!canUseUi(ctx)) return;
	if (!store) {
		notify(ctx, "pi-history is unavailable; nothing was cleared", "warning");
		return;
	}
	const globalScope = identity?.isolationLevel === IsolationLevel.Global;
	const confirmed = await ctx.ui.confirm(
		"Clear pi-history?",
		globalScope
			? "Remove the global prompt history shared across all projects on this host."
			: "Remove stored prompt history for the current project only.",
	);
	if (!confirmed) {
		notify(ctx, "pi-history clear cancelled", "info");
		return;
	}
	const result = await store.clear();
	if (result.kind === "blocked") {
		notify(ctx, `pi-history clear blocked: ${result.reason}`, "warning");
		return;
	}
	notify(
		ctx,
		globalScope ? "pi-history cleared (global scope)" : "pi-history cleared for current project",
		"info",
	);
}

function handleRecordResult(
	ctx: PiHistoryContext,
	state: RuntimeState,
	result: RecordPromptResult,
): void {
	if (result.kind !== "blocked") return;
	notifyOnce(
		ctx,
		state,
		`record:${result.reason}`,
		`pi-history write blocked: ${result.reason}`,
		"warning",
	);
}

function buildStatusMessage(state: RuntimeState, store: PiHistoryStore | undefined): string {
	if (!store || !state.identity) {
		return state.lastError
			? `pi-history unavailable: ${state.lastError}`
			: "pi-history is not initialized";
	}
	const blocked = store.writeBlocked
		? `; writeBlocked=${store.writeBlockedReason ?? "unknown"}`
		: "";
	const scope =
		state.identity.isolationLevel === IsolationLevel.Global
			? "scope=global"
			: `project=${state.identity.projectRoot}`;
	return [
		`pi-history: entries=${store.entryCount}`,
		`cap=${state.config.maxEntries}`,
		scope,
		`file=${store.historyFilePath}${blocked}`,
	].join("; ");
}

function notifyConfigWarnings(ctx: PiHistoryContext, state: RuntimeState): void {
	for (const warning of state.warnings) {
		notifyOnce(ctx, state, `config:${warning}`, `pi-history config warning: ${warning}`, "warning");
	}
}

function notifyStoreWarnings(
	ctx: PiHistoryContext,
	state: RuntimeState,
	store: PiHistoryStore,
): void {
	for (const warning of store.warnings) {
		notifyOnce(ctx, state, `store:${warning}`, `pi-history warning: ${warning}`, "warning");
	}
}

function notifyOnce(
	ctx: PiHistoryContext,
	state: RuntimeState,
	key: string,
	message: string,
	type: "info" | "warning" | "error",
): void {
	if (state.notifiedKeys.has(key)) return;
	state.notifiedKeys.add(key);
	notify(ctx, message, type);
}

function notify(ctx: PiHistoryContext, message: string, type: "info" | "warning" | "error"): void {
	if (!canUseUi(ctx)) return;
	ctx.ui.notify(message, type);
}

function canUseUi(ctx: PiHistoryContext): boolean {
	return ctx.hasUI !== false;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function installPiHistory(pi: ExtensionAPI): void {
	installPiHistoryForTest(pi, { readConfig: loadConfigFromDisk });
}
