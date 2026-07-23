import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { hasErrorCode, isPositiveInteger, isRecord } from "./guards.ts";

export const DEFAULT_MAX_ENTRIES = 500;

export enum IsolationLevel {
	Project = "project",
	Global = "global",
}

const ISOLATION_LEVELS = [IsolationLevel.Project, IsolationLevel.Global] as const;

// Built-in fallback when no config layer supplies a value. Both this fallback
// and the shipped tracked config.json default to project isolation: history
// from one repository must never surface in another unless the user explicitly
// opts into global sharing in their own user config.
export const DEFAULT_ISOLATION_LEVEL: IsolationLevel = IsolationLevel.Project;

const PI_HISTORY_DIR_NAME = "pi-history";

// Resolve on use so Pi's active profile remains the sole authority. User config
// stays outside the package clone because `pi update` removes untracked files.
export function getPiHistoryDir(): string {
	return path.join(getAgentDir(), PI_HISTORY_DIR_NAME);
}
export const USER_CONFIG_FILE_NAME = "config.json";
export const USER_LOCAL_CONFIG_FILE_NAME = "config.local.json";

export type PiHistoryConfig = {
	maxEntries: number;
	isolationLevel: IsolationLevel;
};

export type ConfigLoadResult = {
	config: PiHistoryConfig;
	warnings: string[];
};

// One layer of configuration, lowest precedence first. The shipped repo
// config.json is the bottom layer; user config.json and user config.local.json
// from PI_HISTORY_DIR stack on top; runtime overrides (tests) sit highest.
export type ConfigLayer = {
	origin: string;
	value: unknown;
};

type OptionCandidate<Value> =
	| { kind: "absent" }
	| { kind: "valid"; value: Value }
	| { kind: "invalid"; warning: string };

export function normalizeConfig(layers: readonly ConfigLayer[]): ConfigLoadResult {
	const maxEntries = resolveOption({
		layers,
		read: readMaxEntries,
		fallback: DEFAULT_MAX_ENTRIES,
	});
	const isolationLevel = resolveOption({
		layers,
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
	layers: readonly ConfigLayer[];
	read: (source: unknown, origin: string) => OptionCandidate<Value>;
	fallback: Value;
}): { value: Value; warnings: string[] } {
	const candidates = input.layers.map((layer) => input.read(layer.value, layer.origin));
	return {
		value: chooseValue(candidates, input.fallback),
		warnings: candidates.flatMap((candidate) =>
			candidate.kind === "invalid" ? [candidate.warning] : [],
		),
	};
}

// The highest layer that mentions the option decides. If that layer is broken,
// fall back to the built-in default rather than a lower layer: a broken explicit
// override must be loud and safe, not silently masked by config the user may
// have forgotten about.
function chooseValue<Value>(candidates: readonly OptionCandidate<Value>[], fallback: Value): Value {
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const candidate = candidates[index];
		if (candidate.kind === "valid") return candidate.value;
		if (candidate.kind === "invalid") return fallback;
	}
	return fallback;
}

function readMaxEntries(source: unknown, origin: string): OptionCandidate<number> {
	if (!isRecord(source) || !("maxEntries" in source)) return { kind: "absent" };
	if (isPositiveInteger(source.maxEntries)) {
		return { kind: "valid", value: source.maxEntries };
	}
	return {
		kind: "invalid",
		warning: `${origin}: maxEntries must be a positive integer; using default ${DEFAULT_MAX_ENTRIES}`,
	};
}

function readIsolationLevel(source: unknown, origin: string): OptionCandidate<IsolationLevel> {
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
	// One try/catch avoids a TOCTOU race; callers only care whether a file is
	// absent (undefined) or unreadable/invalid (warning), so both collapse here.
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

function readConfigLayer(input: {
	directory: string;
	fileName: string;
	origin: string;
	warnings: string[];
}): ConfigLayer | undefined {
	try {
		const value = readJsonIfExists(path.join(input.directory, input.fileName));
		return value === undefined ? undefined : { origin: input.origin, value };
	} catch {
		input.warnings.push(`${input.origin} invalid; ignoring this layer`);
		return undefined;
	}
}

export function loadConfigFromDisk(
	extensionRoot = getExtensionRoot(),
	userDir = getPiHistoryDir(),
): { layers: ConfigLayer[]; warnings: string[] } {
	const warnings: string[] = [];
	const layers = [
		readConfigLayer({
			directory: extensionRoot,
			fileName: USER_CONFIG_FILE_NAME,
			origin: USER_CONFIG_FILE_NAME,
			warnings,
		}),
		readConfigLayer({
			directory: userDir,
			fileName: USER_CONFIG_FILE_NAME,
			origin: path.join(userDir, USER_CONFIG_FILE_NAME),
			warnings,
		}),
		readConfigLayer({
			directory: userDir,
			fileName: USER_LOCAL_CONFIG_FILE_NAME,
			origin: path.join(userDir, USER_LOCAL_CONFIG_FILE_NAME),
			warnings,
		}),
	].flatMap((layer) => (layer ? [layer] : []));
	return { layers, warnings };
}

export function loadPiHistoryConfig(
	extensionRoot = getExtensionRoot(),
	userDir = getPiHistoryDir(),
): ConfigLoadResult {
	const loaded = loadConfigFromDisk(extensionRoot, userDir);
	const normalized = normalizeConfig(loaded.layers);
	return {
		config: normalized.config,
		warnings: [...loaded.warnings, ...normalized.warnings],
	};
}
