/** Stable status contract kept separate from operational notices and storage data. */
export const DIAGNOSTICS_VERSION = 1;

const DIAGNOSTIC_PREFIX = "pi-history: ";
const FIELD_SEPARATOR = "; ";

export type DiagnosticScope = "project" | "global";

export type HealthyDiagnosticSnapshot = Readonly<{
	state: "healthy";
	initialization: "ready";
	storage: "ready";
	editor: "ready";
	entries: number;
	cap: number;
	scope: DiagnosticScope;
}>;

export function formatDiagnostic(snapshot: HealthyDiagnosticSnapshot): string {
	// Field order is compatibility-sensitive so agents can compare lines without parsing prose.
	const fields = [
		`diagnosticsVersion=${DIAGNOSTICS_VERSION}`,
		`state=${snapshot.state}`,
		`initialization=${snapshot.initialization}`,
		`storage=${snapshot.storage}`,
		`editor=${snapshot.editor}`,
		`entries=${snapshot.entries}`,
		`cap=${snapshot.cap}`,
		`scope=${snapshot.scope}`,
	];
	return `${DIAGNOSTIC_PREFIX}${fields.join(FIELD_SEPARATOR)}`;
}
