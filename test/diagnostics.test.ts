import { strict as assert } from "node:assert";
import test from "node:test";

import {
	type DiagnosticSnapshot,
	formatDiagnostic,
	type HealthyDiagnosticSnapshot,
} from "../src/diagnostics.ts";

const HEALTHY_BASE: Omit<HealthyDiagnosticSnapshot, "scope"> = {
	state: "healthy",
	initialization: "ready",
	storage: "ready",
	editor: "ready",
	entries: 12,
	cap: 2000,
};

for (const scope of ["project", "global"] as const) {
	test(`healthy ${scope} diagnostic uses fixed fields and order`, () => {
		assert.equal(
			formatDiagnostic({ ...HEALTHY_BASE, scope }),
			`pi-history: diagnosticsVersion=1; state=healthy; initialization=ready; storage=ready; editor=ready; entries=12; cap=2000; scope=${scope}`,
		);
	});
}

type InitializationFailureSnapshot = Extract<
	DiagnosticSnapshot,
	{ state: "initialization_failed" }
>;

const INITIALIZATION_FAILURE_CASES: ReadonlyArray<{
	snapshot: InitializationFailureSnapshot;
	expected: string;
}> = [
	{
		snapshot: {
			state: "initialization_failed",
			initialization: "failed",
			initializationReason: "configuration_load_failed",
			storage: "unavailable",
			editor: "ready",
		},
		expected:
			"pi-history: diagnosticsVersion=1; state=initialization_failed; initialization=failed; initializationReason=configuration_load_failed; storage=unavailable; editor=ready",
	},
	...(["identity_resolution_failed", "storage_load_failed"] as const).map(
		(initializationReason) => ({
			snapshot: {
				state: "initialization_failed" as const,
				initialization: "failed" as const,
				initializationReason,
				storage: "unavailable" as const,
				editor: "ready" as const,
				cap: 2000,
				scope: "project" as const,
			},
			expected: `pi-history: diagnosticsVersion=1; state=initialization_failed; initialization=failed; initializationReason=${initializationReason}; storage=unavailable; editor=ready; cap=2000; scope=project`,
		}),
	),
];

for (const { snapshot, expected } of INITIALIZATION_FAILURE_CASES) {
	test(`${snapshot.initializationReason} diagnostic omits unavailable fields`, () => {
		assert.equal(formatDiagnostic(snapshot), expected);
	});
}

for (const storageReason of ["corrupt_history", "project_root_mismatch"] as const) {
	test(`${storageReason} diagnostic reports safe write blocking`, () => {
		const snapshot: DiagnosticSnapshot = {
			state: "write_blocked",
			initialization: "ready",
			storage: "write_blocked",
			storageReason,
			editor: "ready",
			cap: 2000,
			scope: "project",
		};
		assert.equal(
			formatDiagnostic(snapshot),
			`pi-history: diagnosticsVersion=1; state=write_blocked; initialization=ready; storage=write_blocked; storageReason=${storageReason}; editor=ready; cap=2000; scope=project`,
		);
	});
}

for (const storageReason of ["record_failed", "clear_failed"] as const) {
	test(`${storageReason} diagnostic reports transient degradation`, () => {
		const snapshot: DiagnosticSnapshot = {
			state: "storage_degraded",
			initialization: "ready",
			storage: "degraded",
			storageReason,
			editor: "ready",
			cap: 2000,
			scope: "project",
		};
		assert.equal(
			formatDiagnostic(snapshot),
			`pi-history: diagnosticsVersion=1; state=storage_degraded; initialization=ready; storage=degraded; storageReason=${storageReason}; editor=ready; cap=2000; scope=project`,
		);
	});
}

test("missing editor hooks report unavailable integration", () => {
	const snapshot: DiagnosticSnapshot = {
		state: "editor_degraded",
		initialization: "ready",
		storage: "ready",
		editor: "unavailable",
		editorReason: "missing_editor_hooks",
		entries: 12,
		cap: 2000,
		scope: "project",
	};
	assert.equal(
		formatDiagnostic(snapshot),
		"pi-history: diagnosticsVersion=1; state=editor_degraded; initialization=ready; storage=ready; editor=unavailable; editorReason=missing_editor_hooks; entries=12; cap=2000; scope=project",
	);
});

for (const editorReason of [
	"missing_lines",
	"missing_cursor",
	"missing_insertion",
	"missing_render_seam",
] as const) {
	test(`${editorReason} diagnostic reports ghost-only degradation`, () => {
		const snapshot: DiagnosticSnapshot = {
			state: "editor_degraded",
			initialization: "ready",
			storage: "ready",
			editor: "degraded",
			editorReason,
			entries: 12,
			cap: 2000,
			scope: "project",
		};
		assert.equal(
			formatDiagnostic(snapshot),
			`pi-history: diagnosticsVersion=1; state=editor_degraded; initialization=ready; storage=ready; editor=degraded; editorReason=${editorReason}; entries=12; cap=2000; scope=project`,
		);
	});
}
