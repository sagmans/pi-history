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
import {
	createDiagnosticSnapshot,
	type DiagnosticSnapshot,
	diagnosticSeverity,
	type EditorDiagnosticState,
	formatDiagnostic,
	type GhostDegradationReason,
	type InitializationFailureReason,
	type StorageDegradationReason,
} from "./diagnostics.ts";
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
	type LegacyProfileMigrationEvent,
	type LegacyProfileMigrationResult,
	prepareLegacyProfileMigration,
} from "./legacy-profile-migration.ts";
import {
	createGlobalIdentity,
	type ProjectExec,
	type ProjectIdentity,
	resolveProjectIdentity,
} from "./project.ts";

const COMMAND_NAME = "pi-history";

export type PiHistoryContext = {
	cwd: string;
	mode: "tui" | "rpc" | "json" | "print";
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
	prepareStorage?: () => Promise<LegacyProfileMigrationResult>;
	resolveIdentity?: (ctx: PiHistoryContext) => Promise<ProjectIdentity>;
	loadStore?: (input: {
		identity: ProjectIdentity;
		maxEntries: number;
		now?: Clock;
	}) => Promise<PiHistoryStore>;
};

export type PiHistoryRuntime = {
	readonly config: PiHistoryConfig | undefined;
	readonly warnings: readonly string[];
	getState(): RuntimeStateSnapshot;
};

export type RuntimeStateSnapshot = {
	identity: ProjectIdentity | undefined;
	store: PiHistoryStore | undefined;
	lastError: string | undefined;
	initializationFailureReason: InitializationFailureReason | undefined;
	storageDegradationReason: StorageDegradationReason | undefined;
	editor: EditorDiagnosticState;
};

type RuntimeState = {
	config: PiHistoryConfig | undefined;
	warnings: string[];
	identity: ProjectIdentity | undefined;
	store: PiHistoryStore | undefined;
	lastError: string | undefined;
	initializationFailureReason: InitializationFailureReason | undefined;
	storageDegradationReason: StorageDegradationReason | undefined;
	editor: EditorDiagnosticState;
	notifiedKeys: Set<string>;
	editorInstalled: boolean;
	storagePrepared: boolean;
};

export function installPiHistoryForTest(
	pi: PiHistoryApi,
	options: RuntimeInstallOptions = {},
): PiHistoryRuntime {
	const state: RuntimeState = {
		config: undefined,
		warnings: [],
		identity: undefined,
		store: undefined,
		lastError: undefined,
		initializationFailureReason: undefined,
		storageDegradationReason: undefined,
		editor: { editor: "ready" },
		notifiedKeys: new Set(),
		editorInstalled: false,
		storagePrepared: false,
	};
	async function initialize(ctx: PiHistoryContext): Promise<void> {
		if (!state.storagePrepared && options.prepareStorage) {
			state.storagePrepared = true;
			try {
				const preparation = await options.prepareStorage();
				notifyMigrationEvents(ctx, preparation.events);
			} catch {
				notify(
					ctx,
					"pi-history profile migration failed; isolated storage remains active",
					"warning",
				);
			}
		}
		if (!state.config) {
			try {
				const loaded = loadRuntimeConfig(options);
				state.config = loaded.config;
				state.warnings = loaded.warnings;
			} catch (error) {
				handleInitializationFailure(ctx, state, "configuration_load_failed", error);
				return;
			}
		}
		notifyConfigWarnings(ctx, state);
		const config = state.config;
		// Global isolation skips git discovery entirely: one shared history per host.
		const resolveIdentity =
			options.resolveIdentity ??
			(config.isolationLevel === IsolationLevel.Global
				? () => Promise.resolve(createGlobalIdentity())
				: (runtimeContext: PiHistoryContext) =>
						resolveProjectIdentity({ cwd: runtimeContext.cwd, exec: pi.exec }));
		const loadStore = options.loadStore ?? loadHistoryStore;
		let identity: ProjectIdentity;
		try {
			identity = await resolveIdentity(ctx);
		} catch (error) {
			handleInitializationFailure(ctx, state, "identity_resolution_failed", error);
			return;
		}
		let store: PiHistoryStore;
		try {
			store = await loadStore({
				identity,
				maxEntries: config.maxEntries,
				now: options.now,
			});
		} catch (error) {
			handleInitializationFailure(ctx, state, "storage_load_failed", error);
			return;
		}
		state.identity = identity;
		state.store = store;
		state.lastError = undefined;
		state.initializationFailureReason = undefined;
		// A fresh store load supersedes any transient mutation failure from the
		// previous session; without this reset a stale degradation would persist
		// into the new session's status even though storage is now healthy.
		state.storageDegradationReason = undefined;
		notifyStoreWarnings(ctx, state, store);
	}

	async function ensureInitialized(ctx: PiHistoryContext): Promise<PiHistoryStore | undefined> {
		if (!state.store && !state.lastError) await initialize(ctx);
		return state.store;
	}

	pi.registerCommand(COMMAND_NAME, {
		description: "Inspect or clear private prompt history for the current scope",
		handler: async (args, ctx) => {
			await handleCommand(args, ctx, state, ensureInitialized);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!isTui(ctx)) return;
		installEditorWrapper(ctx, state);
		await initialize(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (!isTui(ctx) || !shouldCaptureInput(event)) return { action: "continue" };
		const store = await ensureInitialized(ctx);
		if (!store) return { action: "continue" };
		try {
			const result = await store.recordPrompt(event.text);
			handleRecordResult(ctx, state, result);
		} catch (error) {
			state.storageDegradationReason = "record_failed";
			notify(ctx, `pi-history capture failed: ${errorMessage(error)}`, "warning");
		}
		return { action: "continue" };
	});

	return {
		get config() {
			return state.config;
		},
		get warnings() {
			return state.warnings;
		},
		getState: () => ({
			identity: state.identity,
			store: state.store,
			lastError: state.lastError,
			initializationFailureReason: state.initializationFailureReason,
			storageDegradationReason: state.storageDegradationReason,
			editor: state.editor,
		}),
	};
}

export function shouldCaptureInput(event: Pick<InputEvent, "source" | "text">): boolean {
	return event.source !== "extension" && event.text.trim().length > 0;
}

function installEditorWrapper(ctx: PiHistoryContext, state: RuntimeState): void {
	if (state.editorInstalled) return;
	const getEditorComponent = ctx.ui.getEditorComponent;
	const setEditorComponent = ctx.ui.setEditorComponent;
	if (ctx.hasUI === false || !getEditorComponent || !setEditorComponent) {
		state.editor = { editor: "unavailable", editorReason: "missing_editor_hooks" };
		notifyOnce(
			ctx,
			state,
			"editor:missing_editor_hooks",
			"pi-history editor integration unavailable: missing editor hooks; Ctrl+R and ghost completion disabled",
			"warning",
		);
		return;
	}

	state.editor = { editor: "ready" };
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
				state.editor = { editor: "degraded", editorReason: reason };
				notifyOnce(
					ctx,
					state,
					`ghost:${reason}`,
					`pi-history ghost completion disabled: ${ghostDegradationMessage(reason)}; Ctrl+R reverse search remains available`,
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
	if (!isTui(ctx)) return;
	const command = args.trim() || "status";
	if (command === "status") {
		const status = buildStatus(state, state.store);
		notify(ctx, status.message, status.type);
		return;
	}
	if (command === "clear") {
		const store = await ensureInitialized(ctx);
		await handleClearCommand(ctx, state, store);
		return;
	}
	notify(ctx, "Usage: /pi-history status|clear", "warning");
}

async function handleClearCommand(
	ctx: PiHistoryContext,
	state: RuntimeState,
	store: PiHistoryStore | undefined,
): Promise<void> {
	if (!canUseUi(ctx)) return;
	if (!store) {
		notify(ctx, "pi-history is unavailable; nothing was cleared", "warning");
		return;
	}
	const globalScope = state.identity?.isolationLevel === IsolationLevel.Global;
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
	let result: ClearHistoryResult;
	try {
		result = await store.clear();
	} catch (error) {
		state.storageDegradationReason = "clear_failed";
		notify(ctx, `pi-history clear failed: ${errorMessage(error)}`, "warning");
		return;
	}
	if (result.kind === "blocked") {
		notify(ctx, `pi-history clear blocked: ${result.reason}`, "warning");
		return;
	}
	state.storageDegradationReason = undefined;
	notify(
		ctx,
		globalScope ? "pi-history cleared (global scope)" : "pi-history cleared for current project",
		"info",
	);
}

function handleInitializationFailure(
	ctx: PiHistoryContext,
	state: RuntimeState,
	reason: InitializationFailureReason,
	error: unknown,
): void {
	state.identity = undefined;
	state.store = undefined;
	state.lastError = errorMessage(error);
	state.initializationFailureReason = reason;
	notifyOnce(
		ctx,
		state,
		`init:${state.lastError}`,
		`pi-history unavailable: ${state.lastError}`,
		"warning",
	);
}

function handleRecordResult(
	ctx: PiHistoryContext,
	state: RuntimeState,
	result: RecordPromptResult,
): void {
	if (result.kind === "recorded") {
		state.storageDegradationReason = undefined;
		return;
	}
	if (result.kind !== "blocked") return;
	notifyOnce(
		ctx,
		state,
		`record:${result.reason}`,
		`pi-history write blocked: ${result.reason}`,
		"warning",
	);
}

function buildStatus(
	state: RuntimeState,
	store: PiHistoryStore | undefined,
): { message: string; type: "info" | "warning" } {
	const snapshot = buildDiagnosticSnapshot(state, store);
	return snapshot
		? { message: formatDiagnostic(snapshot), type: diagnosticSeverity(snapshot) }
		: { message: "pi-history is not initialized", type: "info" };
}

function buildDiagnosticSnapshot(
	state: RuntimeState,
	store: PiHistoryStore | undefined,
): DiagnosticSnapshot | undefined {
	if (state.initializationFailureReason === "configuration_load_failed") {
		return createDiagnosticSnapshot({
			initialization: "failed",
			initializationReason: state.initializationFailureReason,
			storage: "unavailable",
			...state.editor,
		});
	}
	if (state.initializationFailureReason && state.config) {
		return createDiagnosticSnapshot({
			initialization: "failed",
			initializationReason: state.initializationFailureReason,
			storage: "unavailable",
			...state.editor,
			cap: state.config.maxEntries,
			scope:
				state.config.isolationLevel === IsolationLevel.Global
					? IsolationLevel.Global
					: IsolationLevel.Project,
		});
	}
	if (!store || !state.identity || !state.config) return undefined;
	const scope =
		state.identity.isolationLevel === IsolationLevel.Global
			? IsolationLevel.Global
			: IsolationLevel.Project;
	if (store.writeBlocked) {
		const blockReason = store.writeBlockedReason;
		// writeBlocked is true only when the store set a bounded reason; the guard
		// narrows undefined out for the diagnostic contract without a cast.
		if (blockReason) {
			return createDiagnosticSnapshot({
				initialization: "ready",
				storage: "write_blocked",
				storageReason: blockReason,
				...state.editor,
				cap: state.config.maxEntries,
				scope,
			});
		}
	}
	if (state.storageDegradationReason) {
		return createDiagnosticSnapshot({
			initialization: "ready",
			storage: "degraded",
			storageReason: state.storageDegradationReason,
			...state.editor,
			cap: state.config.maxEntries,
			scope,
		});
	}
	return createDiagnosticSnapshot({
		initialization: "ready",
		storage: "ready",
		...state.editor,
		entries: store.entryCount,
		cap: state.config.maxEntries,
		scope,
	});
}

function ghostDegradationMessage(reason: GhostDegradationReason): string {
	switch (reason) {
		case "missing_lines":
			return "wrapped editor does not expose lines";
		case "missing_cursor":
			return "wrapped editor does not expose cursor";
		case "missing_insertion":
			return "wrapped editor cannot accept ghost text";
		case "missing_render_seam":
			return "wrapped editor has no safe ghost render seam";
		default: {
			const exhaustive: never = reason;
			return exhaustive;
		}
	}
}

function notifyMigrationEvents(
	ctx: PiHistoryContext,
	events: readonly LegacyProfileMigrationEvent[],
): void {
	for (const event of events) {
		switch (event) {
			case "snapshot_created":
				notify(
					ctx,
					"pi-history froze legacy data for profile migration; pre-snapshot history may be shared across profiles",
					"warning",
				);
				break;
			case "snapshot_empty":
				notify(ctx, "pi-history found no legacy data to migrate", "info");
				break;
			case "profile_imported":
				notify(
					ctx,
					"pi-history imported frozen legacy data into this profile; review or clear history if needed",
					"warning",
				);
				break;
			default: {
				const exhaustive: never = event;
				throw new Error(`unsupported migration event: ${exhaustive}`);
			}
		}
	}
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

function isTui(ctx: PiHistoryContext): boolean {
	return ctx.mode === "tui";
}

function canUseUi(ctx: PiHistoryContext): boolean {
	return ctx.hasUI !== false;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function installPiHistory(pi: ExtensionAPI): void {
	installPiHistoryForTest(pi, {
		prepareStorage: prepareLegacyProfileMigration,
		readConfig: loadConfigFromDisk,
	});
}
