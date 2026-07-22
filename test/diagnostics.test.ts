import { strict as assert } from "node:assert";
import test from "node:test";

import { formatDiagnostic, type HealthyDiagnosticSnapshot } from "../src/diagnostics.ts";

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
