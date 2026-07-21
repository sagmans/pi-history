// Shared runtime type guards. Kept in one module so identical structural checks
// used by config parsing, runtime option reading, and history file validation
// cannot drift apart across those call sites.

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A positive integer is any integer >= 1. Shared so config caps, stored
// useCount values, and lock-owner pids all reject the same invalid inputs.
export function isPositiveInteger(value: unknown): value is number {
	return Number.isInteger(value) && typeof value === "number" && value > 0;
}

export function hasErrorCode(value: unknown, code: string): boolean {
	return typeof value === "object" && value !== null && Reflect.get(value, "code") === code;
}
