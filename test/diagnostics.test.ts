import { strict as assert } from "node:assert";
import test from "node:test";

import {
	createDiagnosticSnapshot,
	type DiagnosticSnapshot,
	diagnosticSeverity,
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
			`pi-history: diagnosticsVersion=2; state=healthy; initialization=ready; storage=ready; editor=ready; entries=12; cap=2000; scope=${scope}`,
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
			"pi-history: diagnosticsVersion=2; state=initialization_failed; initialization=failed; initializationReason=configuration_load_failed; storage=unavailable; editor=ready",
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
			expected: `pi-history: diagnosticsVersion=2; state=initialization_failed; initialization=failed; initializationReason=${initializationReason}; storage=unavailable; editor=ready; cap=2000; scope=project`,
		}),
	),
];

for (const { snapshot, expected } of INITIALIZATION_FAILURE_CASES) {
	test(`${snapshot.initializationReason} diagnostic omits unavailable fields`, () => {
		assert.equal(formatDiagnostic(snapshot), expected);
	});
}

for (const storageReason of [
	"corrupt_history",
	"unsupported_schema",
	"project_root_mismatch",
] as const) {
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
			`pi-history: diagnosticsVersion=2; state=write_blocked; initialization=ready; storage=write_blocked; storageReason=${storageReason}; editor=ready; cap=2000; scope=project`,
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
			`pi-history: diagnosticsVersion=2; state=storage_degraded; initialization=ready; storage=degraded; storageReason=${storageReason}; editor=ready; cap=2000; scope=project`,
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
		"pi-history: diagnosticsVersion=2; state=editor_degraded; initialization=ready; storage=ready; editor=unavailable; editorReason=missing_editor_hooks; entries=12; cap=2000; scope=project",
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
			`pi-history: diagnosticsVersion=2; state=editor_degraded; initialization=ready; storage=ready; editor=degraded; editorReason=${editorReason}; entries=12; cap=2000; scope=project`,
		);
	});
}

const COMBINED_CASES: ReadonlyArray<{ snapshot: DiagnosticSnapshot; expected: string }> = [
	{
		snapshot: {
			state: "initialization_failed",
			initialization: "failed",
			initializationReason: "configuration_load_failed",
			storage: "unavailable",
			editor: "unavailable",
			editorReason: "missing_editor_hooks",
		},
		expected:
			"pi-history: diagnosticsVersion=2; state=initialization_failed; initialization=failed; initializationReason=configuration_load_failed; storage=unavailable; editor=unavailable; editorReason=missing_editor_hooks",
	},
	{
		snapshot: {
			state: "initialization_failed",
			initialization: "failed",
			initializationReason: "storage_load_failed",
			storage: "unavailable",
			editor: "degraded",
			editorReason: "missing_lines",
			cap: 2000,
			scope: "project",
		},
		expected:
			"pi-history: diagnosticsVersion=2; state=initialization_failed; initialization=failed; initializationReason=storage_load_failed; storage=unavailable; editor=degraded; editorReason=missing_lines; cap=2000; scope=project",
	},
	{
		snapshot: {
			state: "write_blocked",
			initialization: "ready",
			storage: "write_blocked",
			storageReason: "project_root_mismatch",
			editor: "degraded",
			editorReason: "missing_cursor",
			cap: 2000,
			scope: "project",
		},
		expected:
			"pi-history: diagnosticsVersion=2; state=write_blocked; initialization=ready; storage=write_blocked; storageReason=project_root_mismatch; editor=degraded; editorReason=missing_cursor; cap=2000; scope=project",
	},
	{
		snapshot: {
			state: "storage_degraded",
			initialization: "ready",
			storage: "degraded",
			storageReason: "clear_failed",
			editor: "unavailable",
			editorReason: "missing_editor_hooks",
			cap: 2000,
			scope: "global",
		},
		expected:
			"pi-history: diagnosticsVersion=2; state=storage_degraded; initialization=ready; storage=degraded; storageReason=clear_failed; editor=unavailable; editorReason=missing_editor_hooks; cap=2000; scope=global",
	},
];

for (const { snapshot, expected } of COMBINED_CASES) {
	test(`${snapshot.state} retains combined component reasons`, () => {
		assert.equal(formatDiagnostic(snapshot), expected);
	});
}

test("overall state follows component precedence", () => {
	const initializationFailed = createDiagnosticSnapshot({
		initialization: "failed",
		initializationReason: "storage_load_failed",
		storage: "unavailable",
		editor: "degraded",
		editorReason: "missing_lines",
		cap: 2000,
		scope: "project",
	});
	const writeBlocked = createDiagnosticSnapshot({
		initialization: "ready",
		storage: "write_blocked",
		storageReason: "corrupt_history",
		editor: "degraded",
		editorReason: "missing_cursor",
		cap: 2000,
		scope: "project",
	});
	const storageDegraded = createDiagnosticSnapshot({
		initialization: "ready",
		storage: "degraded",
		storageReason: "record_failed",
		editor: "unavailable",
		editorReason: "missing_editor_hooks",
		cap: 2000,
		scope: "project",
	});
	const editorDegraded = createDiagnosticSnapshot({
		initialization: "ready",
		storage: "ready",
		editor: "degraded",
		editorReason: "missing_render_seam",
		entries: 12,
		cap: 2000,
		scope: "project",
	});
	const healthy = createDiagnosticSnapshot({
		initialization: "ready",
		storage: "ready",
		editor: "ready",
		entries: 12,
		cap: 2000,
		scope: "project",
	});

	assert.deepEqual(
		[initializationFailed, writeBlocked, storageDegraded, editorDegraded, healthy].map(
			(snapshot) => snapshot.state,
		),
		["initialization_failed", "write_blocked", "storage_degraded", "editor_degraded", "healthy"],
	);
	assert.equal(
		"editorReason" in initializationFailed && initializationFailed.editorReason,
		"missing_lines",
	);
	assert.equal("editorReason" in writeBlocked && writeBlocked.editorReason, "missing_cursor");
	assert.equal(
		"editorReason" in storageDegraded && storageDegraded.editorReason,
		"missing_editor_hooks",
	);
});

test("diagnostic severity follows top-level and editor availability", () => {
	const cases: ReadonlyArray<{ snapshot: DiagnosticSnapshot; expected: "info" | "warning" }> = [
		{ snapshot: { ...HEALTHY_BASE, scope: "project" }, expected: "info" },
		{
			snapshot: {
				state: "editor_degraded",
				initialization: "ready",
				storage: "ready",
				editor: "degraded",
				editorReason: "missing_lines",
				entries: 12,
				cap: 2000,
				scope: "project",
			},
			expected: "info",
		},
		{ snapshot: COMBINED_CASES[0].snapshot, expected: "warning" },
		{ snapshot: COMBINED_CASES[2].snapshot, expected: "warning" },
		{ snapshot: COMBINED_CASES[3].snapshot, expected: "warning" },
	];

	assert.deepEqual(
		cases.map(({ snapshot }) => diagnosticSeverity(snapshot)),
		cases.map(({ expected }) => expected),
	);
});

test("component types exclude impossible combinations", () => {
	const invalidComponentsAreRejected = () => {
		// @ts-expect-error Ready storage requires a trustworthy entry count.
		createDiagnosticSnapshot({
			initialization: "ready",
			storage: "ready",
			editor: "ready",
			cap: 2000,
			scope: "project",
		});
		// @ts-expect-error Write-blocked storage requires a bounded reason.
		createDiagnosticSnapshot({
			initialization: "ready",
			storage: "write_blocked",
			editor: "ready",
			cap: 2000,
			scope: "project",
		});
		// @ts-expect-error Degraded storage requires a bounded reason.
		createDiagnosticSnapshot({
			initialization: "ready",
			storage: "degraded",
			editor: "ready",
			cap: 2000,
			scope: "project",
		});
		createDiagnosticSnapshot({
			initialization: "ready",
			storage: "ready",
			editor: "ready",
			// @ts-expect-error Ready editor state cannot carry a degradation reason.
			editorReason: "missing_lines",
			entries: 12,
			cap: 2000,
			scope: "project",
		});
		createDiagnosticSnapshot({
			initialization: "failed",
			initializationReason: "configuration_load_failed",
			storage: "unavailable",
			editor: "ready",
			// @ts-expect-error Configuration failure cannot expose unavailable config metadata.
			cap: 2000,
			scope: "project",
		});
	};

	assert.equal(typeof invalidComponentsAreRejected, "function");
});
