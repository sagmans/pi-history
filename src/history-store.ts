import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { BlockReason } from "./block-reason.ts";
import { hasErrorCode, isPositiveInteger, isRecord } from "./guards.ts";
import {
	PRIVATE_DIR_MODE,
	PRIVATE_FILE_MODE,
	type ProjectIdentity,
	validateStoredProjectRoot,
} from "./project.ts";

export const HISTORY_SCHEMA_VERSION = 1;

const LOCK_RETRY_DELAY_MS = 25;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 30_000;
const LOCK_OWNER_FILE = "owner.json";

export type HistoryEntry = {
	text: string;
	createdAt: string;
	updatedAt: string;
	useCount: number;
};

export type PromptHistoryFile = {
	schemaVersion: number;
	projectRoot: string;
	createdAt: string;
	updatedAt: string;
	clearedAt?: string;
	entries: HistoryEntry[];
};

export type HistoryLockOwner = {
	pid: number;
	host: string;
	createdAt: string;
};

// Re-exported under the storage-facing name so callers depend on storage
// vocabulary while the canonical union lives in one place.
export type HistoryBlockReason = BlockReason;

type ClearHistoryBlockReason = Exclude<HistoryBlockReason, "corrupt_history">;

export type LoadHistoryResult =
	| {
			kind: "ready";
			history: PromptHistoryFile;
			warnings: string[];
	  }
	| {
			kind: "blocked";
			history: PromptHistoryFile;
			reason: HistoryBlockReason;
			warnings: string[];
	  };

export type RecordPromptResult =
	| { kind: "recorded"; entryCount: number }
	| { kind: "skipped"; reason: "empty" }
	| { kind: "blocked"; reason: HistoryBlockReason; warnings: string[] };

export type ClearHistoryResult =
	| { kind: "cleared" }
	| { kind: "blocked"; reason: ClearHistoryBlockReason; warnings: string[] };

export type Clock = () => string;

export class HistoryStore {
	private history: PromptHistoryFile;
	private blockReason: HistoryBlockReason | undefined;
	private blockWarnings: string[];

	constructor(
		private readonly identity: ProjectIdentity,
		private readonly maxEntries: number,
		loaded: LoadHistoryResult,
		private readonly now: Clock = currentIsoTimestamp,
	) {
		this.history = loaded.history;
		this.blockReason = loaded.kind === "blocked" ? loaded.reason : undefined;
		this.blockWarnings = loaded.warnings;
	}

	get projectRoot(): string {
		return this.identity.projectRoot;
	}

	get historyFilePath(): string {
		return this.identity.historyFilePath;
	}

	get entries(): readonly HistoryEntry[] {
		return this.history.entries;
	}

	get entryCount(): number {
		return this.history.entries.length;
	}

	get writeBlocked(): boolean {
		return this.blockReason !== undefined;
	}

	get writeBlockedReason(): HistoryBlockReason | undefined {
		return this.blockReason;
	}

	get warnings(): readonly string[] {
		return this.blockWarnings;
	}

	async recordPrompt(text: string): Promise<RecordPromptResult> {
		if (text.trim().length === 0) return { kind: "skipped", reason: "empty" };
		// A session blocked at load time returns from memory instead of re-reading
		// under the lock on every input: the file is unlikely to self-heal
		// mid-session, and the next session start restores freshness.
		if (this.blockReason) {
			return {
				kind: "blocked",
				reason: this.blockReason,
				warnings: this.blockWarnings,
			};
		}

		return withHistoryFileLock(this.identity.historyFilePath, async () => {
			const timestamp = this.now();
			const latest = await loadHistoryFile({
				identity: this.identity,
				now: () => timestamp,
			});
			if (latest.kind === "blocked") {
				this.applyBlocked(latest);
				return {
					kind: "blocked",
					reason: latest.reason,
					warnings: latest.warnings,
				};
			}

			const staleMemoryCleared = historyClearsMemory({
				latest: latest.history,
				memory: this.history,
			});
			const merged = mergeHistories({
				identity: this.identity,
				maxEntries: this.maxEntries,
				now: timestamp,
				histories: staleMemoryCleared ? [latest.history] : [latest.history, this.history],
			});
			this.history = upsertPrompt({
				history: merged,
				text,
				maxEntries: this.maxEntries,
				now: timestamp,
			});
			await writeHistoryFile(this.identity.historyFilePath, this.history);
			return { kind: "recorded", entryCount: this.history.entries.length };
		});
	}

	async clear(): Promise<ClearHistoryResult> {
		// Same stale-safe short-circuit as recordPrompt: a blocked clear returns
		// from memory; the under-lock revalidation below catches a file that
		// became blocked after this session loaded ready.
		const existingBlock = clearBlockResult(this.blockReason, this.blockWarnings);
		if (existingBlock) return existingBlock;

		return withHistoryFileLock(this.identity.historyFilePath, async () => {
			const timestamp = this.now();
			// Validate under the replacement lock so another version cannot race in a new schema.
			const latest = await loadHistoryFile({
				identity: this.identity,
				now: () => timestamp,
			});
			if (latest.kind === "blocked") {
				const latestBlock = clearBlockResult(latest.reason, latest.warnings);
				if (latestBlock) {
					this.applyBlocked(latest);
					return latestBlock;
				}
			}

			this.history = {
				...createEmptyHistory(this.identity.projectRoot, timestamp),
				clearedAt: timestamp,
			};
			this.blockReason = undefined;
			this.blockWarnings = [];
			await writeHistoryFile(this.identity.historyFilePath, this.history);
			return { kind: "cleared" };
		});
	}

	private applyBlocked(loaded: Extract<LoadHistoryResult, { kind: "blocked" }>): void {
		this.history = loaded.history;
		this.blockReason = loaded.reason;
		this.blockWarnings = loaded.warnings;
	}
}

export async function loadHistoryStore(input: {
	identity: ProjectIdentity;
	maxEntries: number;
	now?: Clock;
}): Promise<HistoryStore> {
	const now = input.now ?? currentIsoTimestamp;
	const loaded = await loadHistoryFile({ identity: input.identity, now });
	return new HistoryStore(input.identity, input.maxEntries, loaded, now);
}

export async function loadHistoryFile(input: {
	identity: ProjectIdentity;
	now?: Clock;
}): Promise<LoadHistoryResult> {
	const now = input.now ?? currentIsoTimestamp;
	let text: string;
	try {
		text = await readFile(input.identity.historyFilePath, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return {
				kind: "ready",
				history: createEmptyHistory(input.identity.projectRoot, now()),
				warnings: [],
			};
		}
		return blockedHistory({
			identity: input.identity,
			now: now(),
			reason: "corrupt_history",
			warning: "unable to read history file; writes blocked",
		});
	}

	const parsed = parseHistoryText(text);
	switch (parsed.kind) {
		case "unsupported_schema":
			return blockedHistory({
				identity: input.identity,
				now: now(),
				reason: "unsupported_schema",
				warning: "history schema is unsupported; mutations blocked",
			});
		case "corrupt":
			return blockedHistory({
				identity: input.identity,
				now: now(),
				reason: "corrupt_history",
				warning: "history file is corrupt; writes blocked",
			});
		case "ready":
			break;
		default: {
			const exhaustive: never = parsed;
			return exhaustive;
		}
	}

	const validation = validateStoredProjectRoot({
		identity: input.identity,
		storedProjectRoot: parsed.history.projectRoot,
	});
	if (validation.kind === "mismatch") {
		return blockedHistory({
			identity: input.identity,
			now: now(),
			reason: "project_root_mismatch",
			warning: "history file belongs to another project; writes blocked",
		});
	}

	return { kind: "ready", history: parsed.history, warnings: [] };
}

export function createEmptyHistory(projectRoot: string, now: string): PromptHistoryFile {
	return {
		schemaVersion: HISTORY_SCHEMA_VERSION,
		projectRoot,
		createdAt: now,
		updatedAt: now,
		entries: [],
	};
}

export function upsertPrompt(input: {
	history: PromptHistoryFile;
	text: string;
	maxEntries: number;
	now: string;
}): PromptHistoryFile {
	const existing = input.history.entries.find((entry) => entry.text === input.text);
	const nextEntry: HistoryEntry = existing
		? {
				...existing,
				updatedAt: laterTimestamp(existing.updatedAt, input.now),
				useCount: existing.useCount + 1,
			}
		: {
				text: input.text,
				createdAt: input.now,
				updatedAt: input.now,
				useCount: 1,
			};
	return {
		...input.history,
		updatedAt: laterTimestamp(input.history.updatedAt, input.now),
		entries: [
			nextEntry,
			...input.history.entries.filter((entry) => entry.text !== input.text),
		].slice(0, input.maxEntries),
	};
}

function mergeHistories(input: {
	identity: ProjectIdentity;
	maxEntries: number;
	now: string;
	histories: PromptHistoryFile[];
}): PromptHistoryFile {
	const byText = new Map<string, HistoryEntry>();
	let createdAt = input.now;
	let updatedAt = input.now;
	let clearedAt: string | undefined;
	for (const history of input.histories) {
		createdAt = earlierTimestamp(createdAt, history.createdAt);
		updatedAt = laterTimestamp(updatedAt, history.updatedAt);
		if (history.clearedAt) clearedAt = laterOptionalTimestamp(clearedAt, history.clearedAt);
		for (const entry of history.entries) {
			byText.set(entry.text, mergeEntry(byText.get(entry.text), entry));
		}
	}
	// Relational comparison keeps timestamp ordering locale-independent and
	// consistent with earlierTimestamp/laterTimestamp; newest updatedAt first.
	const entries = [...byText.values()]
		.sort((left, right) =>
			left.updatedAt > right.updatedAt ? -1 : left.updatedAt < right.updatedAt ? 1 : 0,
		)
		.slice(0, input.maxEntries);
	return withOptionalClearMarker(
		{
			schemaVersion: HISTORY_SCHEMA_VERSION,
			projectRoot: input.identity.projectRoot,
			createdAt,
			updatedAt,
			entries,
		},
		clearedAt,
	);
}

function historyClearsMemory(input: {
	latest: PromptHistoryFile;
	memory: PromptHistoryFile;
}): boolean {
	return (
		input.latest.clearedAt !== undefined && input.latest.clearedAt > (input.memory.clearedAt ?? "")
	);
}

function mergeEntry(existing: HistoryEntry | undefined, next: HistoryEntry): HistoryEntry {
	if (!existing) return next;
	return {
		text: next.text,
		createdAt: earlierTimestamp(existing.createdAt, next.createdAt),
		updatedAt: laterTimestamp(existing.updatedAt, next.updatedAt),
		useCount: Math.max(existing.useCount, next.useCount),
	};
}

type ParsedHistoryText =
	| Readonly<{ kind: "ready"; history: PromptHistoryFile }>
	| Readonly<{ kind: "corrupt" }>
	| Readonly<{ kind: "unsupported_schema" }>;

function parseHistoryText(text: string): ParsedHistoryText {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { kind: "corrupt" };
	}
	// Unknown positive versions may be valid to newer code, so preserve them before validation.
	if (
		isRecord(raw) &&
		isPositiveInteger(raw.schemaVersion) &&
		raw.schemaVersion !== HISTORY_SCHEMA_VERSION
	) {
		return { kind: "unsupported_schema" };
	}
	const history = normalizeHistoryFile(raw);
	return history ? { kind: "ready", history } : { kind: "corrupt" };
}

function normalizeHistoryFile(raw: unknown): PromptHistoryFile | undefined {
	if (!isRecord(raw) || raw.schemaVersion !== HISTORY_SCHEMA_VERSION) return undefined;
	if (!Array.isArray(raw.entries)) return undefined;
	const base = normalizeHistoryBase(raw);
	const entries = normalizeEntries(raw.entries);
	if (!base || !entries) return undefined;
	if (raw.clearedAt !== undefined && typeof raw.clearedAt !== "string") return undefined;
	return withOptionalClearMarker({ ...base, entries }, raw.clearedAt);
}

function normalizeHistoryBase(
	raw: Record<string, unknown>,
): Omit<PromptHistoryFile, "entries" | "clearedAt"> | undefined {
	const { projectRoot, createdAt, updatedAt } = raw;
	if (typeof projectRoot !== "string") return undefined;
	if (typeof createdAt !== "string") return undefined;
	if (typeof updatedAt !== "string") return undefined;
	return {
		schemaVersion: HISTORY_SCHEMA_VERSION,
		projectRoot,
		createdAt,
		updatedAt,
	};
}

function withOptionalClearMarker(
	history: PromptHistoryFile,
	clearedAt: string | undefined,
): PromptHistoryFile {
	return clearedAt ? { ...history, clearedAt } : history;
}

function normalizeEntries(rawEntries: unknown[]): HistoryEntry[] | undefined {
	const entries: HistoryEntry[] = [];
	for (const rawEntry of rawEntries) {
		const entry = normalizeEntry(rawEntry);
		if (!entry) return undefined;
		entries.push(entry);
	}
	return entries;
}

function normalizeEntry(raw: unknown): HistoryEntry | undefined {
	if (!isRecord(raw)) return undefined;
	if (typeof raw.text !== "string") return undefined;
	if (typeof raw.createdAt !== "string") return undefined;
	if (typeof raw.updatedAt !== "string") return undefined;
	if (!isPositiveInteger(raw.useCount)) return undefined;
	return {
		text: raw.text,
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
		useCount: raw.useCount,
	};
}

async function writeHistoryFile(filePath: string, history: PromptHistoryFile): Promise<void> {
	await ensureHistoryDirectory(filePath);
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	const data = `${JSON.stringify(history, null, 2)}\n`;
	try {
		await writeFile(tempPath, data, {
			encoding: "utf8",
			mode: PRIVATE_FILE_MODE,
		});
		await chmod(tempPath, PRIVATE_FILE_MODE);
		await rename(tempPath, filePath);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

async function withHistoryFileLock<Result>(
	filePath: string,
	operation: () => Promise<Result>,
): Promise<Result> {
	await ensureHistoryDirectory(filePath);
	const lockPath = `${filePath}.lock`;
	await acquireHistoryLock(lockPath);
	try {
		return await operation();
	} finally {
		await rm(lockPath, { force: true, recursive: true });
	}
}

async function ensureHistoryDirectory(filePath: string): Promise<void> {
	const directory = path.dirname(filePath);
	await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
	await chmod(directory, PRIVATE_DIR_MODE);
}

async function acquireHistoryLock(lockPath: string): Promise<void> {
	const startedAt = Date.now();
	for (;;) {
		try {
			await mkdir(lockPath, { mode: PRIVATE_DIR_MODE });
			try {
				await chmod(lockPath, PRIVATE_DIR_MODE);
				await writeLockOwner(lockPath);
			} catch (error) {
				await rm(lockPath, { force: true, recursive: true });
				throw error;
			}
			return;
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST")) throw error;
			if (await reclaimStaleLock(lockPath)) continue;
			if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
				throw new Error(`timed out waiting for history lock ${lockPath}`);
			}
			await delay(LOCK_RETRY_DELAY_MS);
		}
	}
}

async function writeLockOwner(lockPath: string): Promise<void> {
	const owner: HistoryLockOwner = {
		pid: process.pid,
		host: hostname(),
		createdAt: currentIsoTimestamp(),
	};
	const ownerPath = path.join(lockPath, LOCK_OWNER_FILE);
	await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, {
		encoding: "utf8",
		mode: PRIVATE_FILE_MODE,
	});
	await chmod(ownerPath, PRIVATE_FILE_MODE);
}

async function reclaimStaleLock(lockPath: string): Promise<boolean> {
	const owner = await readLockOwner(lockPath);
	if (owner) {
		if (lockOwnerIsActive(owner)) return false;
		await rm(lockPath, { force: true, recursive: true });
		return true;
	}

	const stats = await stat(lockPath).catch(() => undefined);
	if (!stats || Date.now() - stats.mtimeMs <= LOCK_STALE_MS) return false;
	await rm(lockPath, { force: true, recursive: true });
	return true;
}

async function readLockOwner(lockPath: string): Promise<HistoryLockOwner | undefined> {
	try {
		return normalizeLockOwner(
			JSON.parse(await readFile(path.join(lockPath, LOCK_OWNER_FILE), "utf8")),
		);
	} catch {
		return undefined;
	}
}

function normalizeLockOwner(raw: unknown): HistoryLockOwner | undefined {
	if (!isRecord(raw)) return undefined;
	if (!isPositiveInteger(raw.pid)) return undefined;
	if (typeof raw.host !== "string") return undefined;
	if (typeof raw.createdAt !== "string") return undefined;
	return {
		pid: raw.pid,
		host: raw.host,
		createdAt: raw.createdAt,
	};
}

function lockOwnerIsActive(owner: HistoryLockOwner): boolean {
	const createdAtMs = Date.parse(owner.createdAt);
	if (!Number.isFinite(createdAtMs)) return false;
	if (Date.now() - createdAtMs > LOCK_STALE_MS) return false;
	if (owner.host !== hostname()) return true;
	try {
		process.kill(owner.pid, 0);
		return true;
	} catch {
		return false;
	}
}

function clearBlockResult(
	reason: HistoryBlockReason | undefined,
	warnings: string[],
): Extract<ClearHistoryResult, { kind: "blocked" }> | undefined {
	if (!reason || reason === "corrupt_history") return undefined;
	return { kind: "blocked", reason, warnings };
}

function blockedHistory(input: {
	identity: ProjectIdentity;
	now: string;
	reason: HistoryBlockReason;
	warning: string;
}): LoadHistoryResult {
	return {
		kind: "blocked",
		history: createEmptyHistory(input.identity.projectRoot, input.now),
		reason: input.reason,
		warnings: [input.warning],
	};
}

function currentIsoTimestamp(): string {
	return new Date().toISOString();
}

function earlierTimestamp(left: string, right: string): string {
	return left <= right ? left : right;
}

function laterTimestamp(left: string, right: string): string {
	return left >= right ? left : right;
}

function laterOptionalTimestamp(left: string | undefined, right: string): string {
	return left ? laterTimestamp(left, right) : right;
}
