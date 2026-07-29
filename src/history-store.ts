import { randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { BlockReason } from "./block-reason.ts";
import { hasErrorCode, isPositiveInteger, isRecord } from "./guards.ts";
import { removeLockDirectoryIf } from "./lock-directory.ts";
import {
	PRIVATE_DIR_MODE,
	PRIVATE_FILE_MODE,
	type ProjectIdentity,
	validateStoredProjectRoot,
} from "./project.ts";

export const HISTORY_SCHEMA_VERSION = 3;

const LEGACY_HISTORY_SCHEMA_VERSION = 1;
const GENERATION_HISTORY_SCHEMA_VERSION = 2;
const MAX_CLEAR_EPOCH_LENGTH = 128;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 30_000;
const LOCK_OWNER_FILE = "owner.json";
const ORPHAN_CLEANUP_MESSAGE = "unable to remove orphaned history artifacts";

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
	clearEpoch: string | null;
	clearedAt?: string;
	entries: HistoryEntry[];
};

export type HistoryLockOwner = {
	pid: number;
	host: string;
	createdAt: string;
	token: string;
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
	constructor(
		private readonly identity: ProjectIdentity,
		private readonly maxEntries: number,
		private loaded: LoadHistoryResult,
		private readonly now: Clock = currentIsoTimestamp,
	) {}

	get projectRoot(): string {
		return this.identity.projectRoot;
	}

	get historyFilePath(): string {
		return this.identity.historyFilePath;
	}

	get entries(): readonly HistoryEntry[] {
		return this.loaded.history.entries;
	}

	get entryCount(): number {
		return this.loaded.history.entries.length;
	}

	get writeBlocked(): boolean {
		return this.loaded.kind === "blocked";
	}

	get writeBlockedReason(): HistoryBlockReason | undefined {
		return this.loaded.kind === "blocked" ? this.loaded.reason : undefined;
	}

	get warnings(): readonly string[] {
		return this.loaded.warnings;
	}

	async recordPrompt(text: string): Promise<RecordPromptResult> {
		if (text.trim().length === 0) return { kind: "skipped", reason: "empty" };
		// A session blocked at load time returns from memory instead of re-reading
		// under the lock on every input: the file is unlikely to self-heal
		// mid-session, and the next session start restores freshness.
		if (this.loaded.kind === "blocked") {
			return {
				kind: "blocked",
				reason: this.loaded.reason,
				warnings: this.loaded.warnings,
			};
		}

		return withHistoryFileLock(this.identity.historyFilePath, async (fence) => {
			const timestamp = this.now();
			const latest = await loadHistoryFile({
				identity: this.identity,
				now: () => timestamp,
			});
			if (latest.kind === "blocked") {
				this.loaded = latest;
				return {
					kind: "blocked",
					reason: latest.reason,
					warnings: latest.warnings,
				};
			}

			const merged = mergeHistories({
				identity: this.identity,
				maxEntries: this.maxEntries,
				now: timestamp,
				latest: latest.history,
				memory:
					latest.history.clearEpoch === this.loaded.history.clearEpoch
						? this.loaded.history
						: undefined,
			});
			const nextHistory = upsertPrompt({
				history: merged,
				text,
				maxEntries: this.maxEntries,
				now: timestamp,
			});
			await writeHistoryFile(this.identity.historyFilePath, nextHistory, fence);
			this.loaded = { ...latest, history: nextHistory };
			return { kind: "recorded", entryCount: nextHistory.entries.length };
		});
	}

	async clear(): Promise<ClearHistoryResult> {
		// Same stale-safe short-circuit as recordPrompt: a blocked clear returns
		// from memory; the under-lock revalidation below catches a file that
		// became blocked after this session loaded ready.
		const existingBlock = clearBlockResult(
			this.loaded.kind === "blocked" ? this.loaded.reason : undefined,
			this.loaded.warnings,
		);
		if (existingBlock) return existingBlock;

		return withHistoryFileLock(this.identity.historyFilePath, async (fence) => {
			const timestamp = this.now();
			// Validate under the replacement lock so another version cannot race in a new schema.
			const latest = await loadHistoryFile({
				identity: this.identity,
				now: () => timestamp,
			});
			if (latest.kind === "blocked") {
				const latestBlock = clearBlockResult(latest.reason, latest.warnings);
				if (latestBlock) {
					this.loaded = latest;
					return latestBlock;
				}
			}

			// Orphaned temp copies hold prompt bytes; remove them while the lock
			// is held so a confirmed clear leaves no readable residue behind.
			await removeOrphanedTempArtifacts(this.identity.historyFilePath);
			// Every confirmed clear mints a fresh opaque epoch: causal order never
			// depends on wall-clock time or reusable counters, so no terminal
			// exhaustion state exists.
			const nextHistory = {
				...createEmptyHistory(this.identity.projectRoot, timestamp),
				clearEpoch: mintClearEpoch(),
				clearedAt: timestamp,
			};
			await writeHistoryFile(this.identity.historyFilePath, nextHistory, fence);
			this.loaded = { kind: "ready", history: nextHistory, warnings: [] };
			return { kind: "cleared" };
		});
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
		clearEpoch: null,
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
	latest: PromptHistoryFile;
	memory?: PromptHistoryFile;
}): PromptHistoryFile {
	const byText = new Map<string, HistoryEntry>();
	let createdAt = input.now;
	let updatedAt = input.now;
	let clearedAt: string | undefined;
	for (const history of input.memory ? [input.latest, input.memory] : [input.latest]) {
		createdAt = earlierTimestamp(createdAt, history.createdAt);
		updatedAt = laterTimestamp(updatedAt, history.updatedAt);
		if (history.clearedAt) {
			clearedAt = clearedAt ? laterTimestamp(clearedAt, history.clearedAt) : history.clearedAt;
		}
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
			// Merged histories share one lineage by construction; keep that epoch.
			clearEpoch: input.latest.clearEpoch,
			entries,
		},
		clearedAt,
	);
}

function tempArtifactPattern(filePath: string): RegExp {
	const base = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${base}\\.\\d+\\.\\d+\\.tmp$`);
}

export async function removeOrphanedTempArtifacts(filePath: string): Promise<void> {
	const directory = path.dirname(filePath);
	const pattern = tempArtifactPattern(filePath);
	for (const entry of await readdir(directory)) {
		if (!pattern.test(entry)) continue;
		const candidate = path.join(directory, entry);
		try {
			// lstat never follows: symlinks and non-regular entries stay untouched.
			const stats = await lstat(candidate);
			if (stats.isSymbolicLink() || !stats.isFile()) continue;
			await rm(candidate, { force: true });
		} catch {
			// Path-free by contract: clear failures surface this message to users.
			throw new Error(ORPHAN_CLEANUP_MESSAGE);
		}
	}
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
	if (!isRecord(raw) || !isPositiveInteger(raw.schemaVersion)) return { kind: "corrupt" };
	// Unknown positive versions may be valid to newer code, so preserve them.
	switch (raw.schemaVersion) {
		case HISTORY_SCHEMA_VERSION:
		case GENERATION_HISTORY_SCHEMA_VERSION:
		case LEGACY_HISTORY_SCHEMA_VERSION:
			break;
		default:
			return { kind: "unsupported_schema" };
	}
	const history = normalizeHistoryFile(raw);
	return history ? { kind: "ready", history } : { kind: "corrupt" };
}

function normalizeHistoryFile(raw: Record<string, unknown>): PromptHistoryFile | undefined {
	if (!Array.isArray(raw.entries)) return undefined;
	const base = normalizeHistoryBase(raw);
	const entries = normalizeEntries(raw.entries);
	if (!base || !entries) return undefined;
	if (raw.clearedAt !== undefined && typeof raw.clearedAt !== "string") return undefined;
	const clearEpoch = normalizeClearEpoch(raw);
	if (clearEpoch === undefined) return undefined;
	return withOptionalClearMarker({ ...base, clearEpoch, entries }, raw.clearedAt);
}

// Legacy formats cannot name a stable lineage across reads: any clear marker
// (schema-1) or nonzero generation (schema-2) mints a fresh epoch per read, so
// revalidated disk always wins over session memory and distinct legacy clears
// never collapse into one lineage. Schema-2 stays strict because it is this
// extension's own shipped format.
function normalizeClearEpoch(raw: Record<string, unknown>): string | null | undefined {
	if (raw.schemaVersion === HISTORY_SCHEMA_VERSION) {
		const { clearEpoch } = raw;
		if (clearEpoch === null) return null;
		if (
			typeof clearEpoch === "string" &&
			clearEpoch.length > 0 &&
			clearEpoch.length <= MAX_CLEAR_EPOCH_LENGTH
		) {
			return clearEpoch;
		}
		return undefined;
	}
	if (raw.schemaVersion === GENERATION_HISTORY_SCHEMA_VERSION) {
		const generation = raw.clearGeneration;
		if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
			return undefined;
		}
		return generation === 0 ? null : mintClearEpoch();
	}
	return raw.clearedAt === undefined ? null : mintClearEpoch();
}

function mintClearEpoch(): string {
	return randomUUID();
}

function normalizeHistoryBase(
	raw: Record<string, unknown>,
): Omit<PromptHistoryFile, "entries" | "clearEpoch" | "clearedAt"> | undefined {
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

async function writeHistoryFile(
	filePath: string,
	history: PromptHistoryFile,
	fence: HistoryLockFence,
): Promise<void> {
	await ensureHistoryDirectory(filePath);
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	const data = `${JSON.stringify(history, null, 2)}\n`;
	try {
		await writeFile(tempPath, data, {
			encoding: "utf8",
			mode: PRIVATE_FILE_MODE,
		});
		await chmod(tempPath, PRIVATE_FILE_MODE);
		// Fence before rename: a displaced writer must not publish over newer state.
		await fence();
		await rename(tempPath, filePath);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

export type HistoryLockFence = () => Promise<void>;

export async function withHistoryFileLock<Result>(
	filePath: string,
	operation: (fence: HistoryLockFence) => Promise<Result>,
): Promise<Result> {
	await ensureHistoryDirectory(filePath);
	const lockPath = `${filePath}.lock`;
	const owner = await acquireHistoryLock(lockPath);
	const fence = () => assertLockOwnership(lockPath, owner.token);
	try {
		return await operation(fence);
	} finally {
		await releaseHistoryLock(lockPath, owner.token);
	}
}

async function ensureHistoryDirectory(filePath: string): Promise<void> {
	const directory = path.dirname(filePath);
	await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
	await chmod(directory, PRIVATE_DIR_MODE);
}

async function acquireHistoryLock(lockPath: string): Promise<HistoryLockOwner> {
	const startedAt = Date.now();
	for (;;) {
		try {
			await mkdir(lockPath, { mode: PRIVATE_DIR_MODE });
			try {
				await chmod(lockPath, PRIVATE_DIR_MODE);
				return await writeLockOwner(lockPath);
			} catch (error) {
				await rm(lockPath, { force: true, recursive: true });
				throw error;
			}
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

// The token fences this lock instance: release and publication must match it,
// so a displaced owner can never delete or overwrite a successor's lock.
async function writeLockOwner(lockPath: string): Promise<HistoryLockOwner> {
	const owner: HistoryLockOwner = {
		pid: process.pid,
		host: hostname(),
		createdAt: currentIsoTimestamp(),
		token: randomUUID(),
	};
	const ownerPath = path.join(lockPath, LOCK_OWNER_FILE);
	await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, {
		encoding: "utf8",
		mode: PRIVATE_FILE_MODE,
	});
	await chmod(ownerPath, PRIVATE_FILE_MODE);
	return owner;
}

async function assertLockOwnership(lockPath: string, token: string): Promise<void> {
	const owner = await readLockOwner(lockPath);
	if (owner?.token !== token) {
		throw new Error("history lock ownership lost");
	}
}

async function releaseHistoryLock(lockPath: string, token: string): Promise<void> {
	await removeLockDirectoryIf(lockPath, async () => {
		const owner = await readLockOwner(lockPath);
		return owner?.token === token;
	});
}

async function reclaimStaleLock(lockPath: string): Promise<boolean> {
	const owner = await readLockOwner(lockPath);
	if (owner) {
		if (lockOwnerIsActive(owner)) return false;
		return removeLockDirectoryIf(lockPath, async () => {
			const current = await readLockOwner(lockPath);
			return current?.token === owner.token && !lockOwnerIsActive(current);
		});
	}

	const stats = await stat(lockPath).catch(() => undefined);
	if (!stats || Date.now() - stats.mtimeMs <= LOCK_STALE_MS) return false;
	return removeLockDirectoryIf(lockPath, async () => !(await readLockOwner(lockPath)));
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
	if (typeof raw.token !== "string" || raw.token.length === 0) return undefined;
	return {
		pid: raw.pid,
		host: raw.host,
		createdAt: raw.createdAt,
		token: raw.token,
	};
}

function lockOwnerIsActive(owner: HistoryLockOwner): boolean {
	// Same-host liveness is decidable, so a live owner is never evicted by age.
	if (owner.host === hostname()) {
		try {
			process.kill(owner.pid, 0);
			return true;
		} catch {
			return false;
		}
	}
	// Cross-host liveness is undecidable locally; bound takeover by owner age.
	const createdAtMs = Date.parse(owner.createdAt);
	if (!Number.isFinite(createdAtMs)) return false;
	return Date.now() - createdAtMs <= LOCK_STALE_MS;
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
