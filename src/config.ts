import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hasErrorCode, isPositiveInteger, isRecord } from "./guards.ts";

export const DEFAULT_MAX_ENTRIES = 500;

export enum IsolationLevel {
	Project = "project",
	Global = "global",
}

const ISOLATION_LEVELS = [IsolationLevel.Project, IsolationLevel.Global] as const;

// Project isolation is the safe default: prompt history must not leak across
// unrelated repos on a host unless the user explicitly opts into global scope.
export const DEFAULT_ISOLATION_LEVEL: IsolationLevel = IsolationLevel.Project;

export type PiHistoryConfig = {
	maxEntries: number;
	isolationLevel: IsolationLevel;
};

export type ConfigLoadResult = {
	config: PiHistoryConfig;
	warnings: string[];
};

type ConfigFileName = "config.json" | "config.local.json";

type OptionCandidate<Value> =
	| { kind: "absent" }
	| { kind: "valid"; value: Value }
	| { kind: "invalid"; warning: string };

export function normalizeConfig(
	tracked?: unknown,
	local?: unknown,
): ConfigLoadResult {
	const maxEntries = resolveOption({
		tracked,
		local,
		read: readMaxEntries,
		fallback: DEFAULT_MAX_ENTRIES,
	});
	const isolationLevel = resolveOption({
		tracked,
		local,
		read: readIsolationLevel,
		fallback: DEFAULT_ISOLATION_LEVEL,
	});

	return {
		config: {
			maxEntries: maxEntries.value,
			isolationLevel: isolationLevel.value,
		},
		warnings: [...maxEntries.warnings, ...isolationLevel.warnings],
	};
}

function resolveOption<Value>(input: {
	tracked: unknown;
	local: unknown;
	read: (source: unknown, origin: ConfigFileName) => OptionCandidate<Value>;
	fallback: Value;
}): { value: Value; warnings: string[] } {
	const trackedCandidate = input.read(input.tracked, "config.json");
	const localCandidate = input.read(input.local, "config.local.json");
	const warnings = [trackedCandidate, localCandidate].flatMap((candidate) =>
		candidate.kind === "invalid" ? [candidate.warning] : [],
	);
	return {
		value: chooseValue({ trackedCandidate, localCandidate, fallback: input.fallback }),
		warnings,
	};
}

function chooseValue<Value>(input: {
	trackedCandidate: OptionCandidate<Value>;
	localCandidate: OptionCandidate<Value>;
	fallback: Value;
}): Value {
	if (input.localCandidate.kind === "valid") return input.localCandidate.value;
	// A broken local override should be obvious and safe, not silently masked by tracked config.
	if (input.localCandidate.kind === "invalid") return input.fallback;
	if (input.trackedCandidate.kind === "valid") return input.trackedCandidate.value;
	return input.fallback;
}

function readMaxEntries(source: unknown, origin: ConfigFileName): OptionCandidate<number> {
	if (!isRecord(source) || !("maxEntries" in source)) return { kind: "absent" };
	if (isPositiveInteger(source.maxEntries)) {
		return { kind: "valid", value: source.maxEntries };
	}
	return {
		kind: "invalid",
		warning: `${origin}: maxEntries must be a positive integer; using default ${DEFAULT_MAX_ENTRIES}`,
	};
}

function readIsolationLevel(
	source: unknown,
	origin: ConfigFileName,
): OptionCandidate<IsolationLevel> {
	if (!isRecord(source) || !("isolationLevel" in source)) return { kind: "absent" };
	if (isIsolationLevel(source.isolationLevel)) {
		return { kind: "valid", value: source.isolationLevel };
	}
	return {
		kind: "invalid",
		warning: `${origin}: isolationLevel must be one of ${ISOLATION_LEVELS.join("|")}; using default ${DEFAULT_ISOLATION_LEVEL}`,
	};
}

function isIsolationLevel(value: unknown): value is IsolationLevel {
	return (ISOLATION_LEVELS as readonly unknown[]).includes(value);
}

function readJsonIfExists(filePath: string): unknown {
	// One try/catch avoids a TOCTOU race; loadConfigFromDisk only cares whether a file
	// is absent (undefined) or unreadable/invalid (warning), so both collapse here.
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return undefined;
		throw new Error("invalid JSON", { cause: error });
	}
}

export function getExtensionRoot(): string {
	return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

export function loadConfigFromDisk(extensionRoot = getExtensionRoot()): {
	tracked?: unknown;
	local?: unknown;
	warnings: string[];
} {
	const warnings: string[] = [];
	let tracked: unknown;
	let local: unknown;
	try {
		tracked = readJsonIfExists(path.join(extensionRoot, "config.json"));
	} catch {
		warnings.push("config.json invalid; using defaults");
	}
	try {
		local = readJsonIfExists(path.join(extensionRoot, "config.local.json"));
	} catch {
		warnings.push("config.local.json invalid; ignoring local overrides");
	}
	return { tracked, local, warnings };
}

export function loadPiHistoryConfig(extensionRoot = getExtensionRoot()): ConfigLoadResult {
	const loaded = loadConfigFromDisk(extensionRoot);
	const normalized = normalizeConfig(loaded.tracked, loaded.local);
	return {
		config: normalized.config,
		warnings: [...loaded.warnings, ...normalized.warnings],
	};
}
