/** Stable status contract kept separate from operational notices and storage data. */
export const DIAGNOSTICS_VERSION = 1;

const DIAGNOSTIC_PREFIX = "pi-history: ";
const FIELD_SEPARATOR = "; ";

export type DiagnosticScope = "project" | "global";
export type StorageBlockReason = "corrupt_history" | "project_root_mismatch";
export type StorageDegradationReason = "record_failed" | "clear_failed";
export type GhostDegradationReason =
	| "missing_lines"
	| "missing_cursor"
	| "missing_insertion"
	| "missing_render_seam";

export type EditorDiagnosticState =
	| Readonly<{ editor: "ready" }>
	| Readonly<{ editor: "degraded"; editorReason: GhostDegradationReason }>
	| Readonly<{ editor: "unavailable"; editorReason: "missing_editor_hooks" }>;

export type HealthyDiagnosticSnapshot = Readonly<{
	state: "healthy";
	initialization: "ready";
	storage: "ready";
	editor: "ready";
	entries: number;
	cap: number;
	scope: DiagnosticScope;
}>;

export type InitializationFailureReason =
	| "configuration_load_failed"
	| "identity_resolution_failed"
	| "storage_load_failed";

type ConfigurationLoadFailureSnapshot = Readonly<
	{
		state: "initialization_failed";
		initialization: "failed";
		initializationReason: "configuration_load_failed";
		storage: "unavailable";
	} & EditorDiagnosticState
>;

type ScopedInitializationFailureSnapshot = Readonly<
	{
		state: "initialization_failed";
		initialization: "failed";
		initializationReason: Exclude<InitializationFailureReason, "configuration_load_failed">;
		storage: "unavailable";
		cap: number;
		scope: DiagnosticScope;
	} & EditorDiagnosticState
>;

type WriteBlockedDiagnosticSnapshot = Readonly<
	{
		state: "write_blocked";
		initialization: "ready";
		storage: "write_blocked";
		storageReason: StorageBlockReason;
		cap: number;
		scope: DiagnosticScope;
	} & EditorDiagnosticState
>;

type StorageDegradedDiagnosticSnapshot = Readonly<
	{
		state: "storage_degraded";
		initialization: "ready";
		storage: "degraded";
		storageReason: StorageDegradationReason;
		cap: number;
		scope: DiagnosticScope;
	} & EditorDiagnosticState
>;

type EditorDegradedDiagnosticSnapshot = Readonly<
	{
		state: "editor_degraded";
		initialization: "ready";
		storage: "ready";
		entries: number;
		cap: number;
		scope: DiagnosticScope;
	} & Exclude<EditorDiagnosticState, { editor: "ready" }>
>;

export type DiagnosticSnapshot =
	| HealthyDiagnosticSnapshot
	| ConfigurationLoadFailureSnapshot
	| ScopedInitializationFailureSnapshot
	| WriteBlockedDiagnosticSnapshot
	| StorageDegradedDiagnosticSnapshot
	| EditorDegradedDiagnosticSnapshot;

type WithoutState<Snapshot> = Snapshot extends { state: string } ? Omit<Snapshot, "state"> : never;

export type DiagnosticComponents = WithoutState<DiagnosticSnapshot>;

export function createDiagnosticSnapshot(components: DiagnosticComponents): DiagnosticSnapshot {
	if (components.initialization === "failed") {
		return { state: "initialization_failed", ...components };
	}
	switch (components.storage) {
		case "write_blocked":
			return { state: "write_blocked", ...components };
		case "degraded":
			return { state: "storage_degraded", ...components };
		case "ready":
			return components.editor === "ready"
				? { state: "healthy", ...components }
				: { state: "editor_degraded", ...components };
		default: {
			const exhaustive: never = components;
			return exhaustive;
		}
	}
}

export function diagnosticSeverity(snapshot: DiagnosticSnapshot): "info" | "warning" {
	switch (snapshot.state) {
		case "initialization_failed":
		case "write_blocked":
		case "storage_degraded":
			return "warning";
		case "editor_degraded":
			return snapshot.editor === "unavailable" ? "warning" : "info";
		case "healthy":
			return "info";
		default: {
			const exhaustive: never = snapshot;
			return exhaustive;
		}
	}
}

export function formatDiagnostic(snapshot: DiagnosticSnapshot): string {
	// Field order is compatibility-sensitive so agents can compare lines without parsing prose.
	const fields = [
		`diagnosticsVersion=${DIAGNOSTICS_VERSION}`,
		`state=${snapshot.state}`,
		`initialization=${snapshot.initialization}`,
	];
	if (snapshot.state === "initialization_failed") {
		fields.push(`initializationReason=${snapshot.initializationReason}`);
	}
	fields.push(`storage=${snapshot.storage}`);
	if (snapshot.storage === "write_blocked" || snapshot.storage === "degraded") {
		fields.push(`storageReason=${snapshot.storageReason}`);
	}
	fields.push(`editor=${snapshot.editor}`);
	if (snapshot.editor !== "ready") fields.push(`editorReason=${snapshot.editorReason}`);
	if (snapshot.storage === "ready") fields.push(`entries=${snapshot.entries}`);
	if ("cap" in snapshot) fields.push(`cap=${snapshot.cap}`, `scope=${snapshot.scope}`);
	return `${DIAGNOSTIC_PREFIX}${fields.join(FIELD_SEPARATOR)}`;
}
