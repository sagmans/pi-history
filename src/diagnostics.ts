/** Stable status contract kept separate from operational notices and storage data. */
export const DIAGNOSTICS_VERSION = 1;

const DIAGNOSTIC_PREFIX = "pi-history: ";
const FIELD_SEPARATOR = "; ";

export type DiagnosticScope = "project" | "global";
export type StorageBlockReason = "corrupt_history" | "project_root_mismatch";
export type StorageDegradationReason = "record_failed" | "clear_failed";

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

type ConfigurationLoadFailureSnapshot = Readonly<{
	state: "initialization_failed";
	initialization: "failed";
	initializationReason: "configuration_load_failed";
	storage: "unavailable";
	editor: "ready";
}>;

type ScopedInitializationFailureSnapshot = Readonly<{
	state: "initialization_failed";
	initialization: "failed";
	initializationReason: Exclude<InitializationFailureReason, "configuration_load_failed">;
	storage: "unavailable";
	editor: "ready";
	cap: number;
	scope: DiagnosticScope;
}>;

type WriteBlockedDiagnosticSnapshot = Readonly<{
	state: "write_blocked";
	initialization: "ready";
	storage: "write_blocked";
	storageReason: StorageBlockReason;
	editor: "ready";
	cap: number;
	scope: DiagnosticScope;
}>;

type StorageDegradedDiagnosticSnapshot = Readonly<{
	state: "storage_degraded";
	initialization: "ready";
	storage: "degraded";
	storageReason: StorageDegradationReason;
	editor: "ready";
	cap: number;
	scope: DiagnosticScope;
}>;

export type DiagnosticSnapshot =
	| HealthyDiagnosticSnapshot
	| ConfigurationLoadFailureSnapshot
	| ScopedInitializationFailureSnapshot
	| WriteBlockedDiagnosticSnapshot
	| StorageDegradedDiagnosticSnapshot;

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
	if (snapshot.state === "write_blocked" || snapshot.state === "storage_degraded") {
		fields.push(`storageReason=${snapshot.storageReason}`);
	}
	fields.push(`editor=${snapshot.editor}`);
	if (snapshot.state === "healthy") fields.push(`entries=${snapshot.entries}`);
	if ("cap" in snapshot) fields.push(`cap=${snapshot.cap}`, `scope=${snapshot.scope}`);
	return `${DIAGNOSTIC_PREFIX}${fields.join(FIELD_SEPARATOR)}`;
}
