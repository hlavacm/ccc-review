import { randomUUID } from "node:crypto";
import {
	appendFile,
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
	type GitBaseline,
	parseReviewResult,
	type ReviewResult,
} from "./types.ts";

export const STATE_VERSION = 1;
export const DEFAULT_MAX_ROUNDS = 3;

export type Agent = "claude" | "codex";
const AGENTS: readonly string[] = ["claude", "codex"];

export interface TaskState {
	version: typeof STATE_VERSION;
	taskId: string;
	active: boolean;
	writer: Agent;
	reviewer: Agent;
	baseline: GitBaseline;
	/** Number of review rounds already started. 0 = not reviewed yet. */
	round: number;
	maxRounds: number;
	lastResult?: ReviewResult;
	/** Highest `CCC-###` number any round of this task has used. */
	lastFindingNumber?: number;
	/** Last reviewer infrastructure/validation failure. */
	lastError?: string;
}

export class StateError extends Error {
	override name = "StateError";
}

export function createTaskState(options: {
	writer: Agent;
	reviewer: Agent;
	baseline: GitBaseline;
	maxRounds?: number;
}): TaskState {
	const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
	if (!Number.isInteger(maxRounds) || maxRounds < 1)
		throw new StateError(`maxRounds must be a positive integer`);
	if (options.writer === options.reviewer)
		throw new StateError("writer and reviewer must differ");
	return {
		version: STATE_VERSION,
		taskId: randomUUID(),
		active: true,
		writer: options.writer,
		reviewer: options.reviewer,
		baseline: options.baseline,
		round: 0,
		maxRounds,
	};
}

function stateFile(dir: string, taskId: string, ext = ".json"): string {
	// taskId becomes a file name; refuse anything that could escape `dir`.
	if (!/^[A-Za-z0-9_-]+$/.test(taskId))
		throw new StateError(`invalid task id ${JSON.stringify(taskId)}`);
	return join(dir, `${taskId}${ext}`);
}

/**
 * State holds user prompts and findings: owner-only. `mkdir`'s mode applies
 * only to directories it creates, so an existing one is tightened too.
 */
export async function privateDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const { mode } = await stat(dir);
	// Only ever tightens: group/other bits go, the owner's stay as they are.
	if (mode & 0o077) await chmod(dir, mode & 0o700);
}

/** Atomic write: a crash never leaves a half-written state file. */
export async function saveState(dir: string, state: TaskState): Promise<void> {
	const file = stateFile(dir, state.taskId);
	await privateDir(dir);
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
		await rename(tmp, file);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}

/** Returns undefined when no state exists; throws StateError when it is unusable. */
export async function loadState(
	dir: string,
	taskId: string,
): Promise<TaskState | undefined> {
	const file = stateFile(dir, taskId);
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new StateError(`corrupt state file ${file}: invalid JSON`);
	}
	try {
		return parseTaskState(data, taskId);
	} catch (error) {
		throw new StateError(
			`corrupt state file ${file}: ${(error as Error).message}`,
		);
	}
}

function parseTaskState(data: unknown, taskId: string): TaskState {
	if (typeof data !== "object" || data === null || Array.isArray(data))
		throw new Error("not an object");
	const s = data as Record<string, unknown>;
	if (s.version !== STATE_VERSION)
		throw new Error(`unsupported version ${JSON.stringify(s.version)}`);
	if (s.taskId !== taskId) throw new Error("taskId mismatch");
	if (typeof s.active !== "boolean") throw new Error("invalid active");
	if (!AGENTS.includes(s.writer as string)) throw new Error("invalid writer");
	if (!AGENTS.includes(s.reviewer as string))
		throw new Error("invalid reviewer");
	if (s.writer === s.reviewer)
		throw new Error("writer and reviewer must differ");
	if (!Number.isInteger(s.maxRounds) || (s.maxRounds as number) < 1)
		throw new Error("invalid maxRounds");
	if (!Number.isInteger(s.round) || (s.round as number) < 0)
		throw new Error("invalid round");
	if (!isBaseline(s.baseline)) throw new Error("invalid baseline");
	if (s.lastError !== undefined && typeof s.lastError !== "string")
		throw new Error("invalid lastError");
	if (
		s.lastFindingNumber !== undefined &&
		!(
			Number.isInteger(s.lastFindingNumber) &&
			(s.lastFindingNumber as number) >= 0
		)
	)
		throw new Error("invalid lastFindingNumber");

	const state: TaskState = {
		version: STATE_VERSION,
		taskId,
		active: s.active,
		writer: s.writer as Agent,
		reviewer: s.reviewer as Agent,
		baseline: s.baseline,
		round: s.round as number,
		maxRounds: s.maxRounds as number,
	};
	if (s.lastResult !== undefined)
		state.lastResult = parseReviewResult(s.lastResult);
	if (s.lastError !== undefined) state.lastError = s.lastError;
	if (s.lastFindingNumber !== undefined)
		state.lastFindingNumber = s.lastFindingNumber as number;
	return state;
}

function isBaseline(value: unknown): value is GitBaseline {
	if (typeof value !== "object" || value === null) return false;
	const b = value as Record<string, unknown>;
	const nullableString = (v: unknown) => v === null || typeof v === "string";
	return (
		typeof b.root === "string" &&
		nullableString(b.headSha) &&
		nullableString(b.branch) &&
		Array.isArray(b.status) &&
		b.status.every(
			(e) =>
				typeof e === "object" &&
				e !== null &&
				typeof e.code === "string" &&
				typeof e.path === "string" &&
				(e.origPath === undefined || typeof e.origPath === "string"),
		)
	);
}

/** One line of a task's review history log. */
export interface HistoryEntry {
	/** ISO timestamp. */
	at: string;
	/** "audit": a one-round review of the current changes was armed. */
	event: "on" | "audit" | "round" | "off";
	round?: number;
	/** Round outcome, e.g. "approved" or "reviewer_error". */
	outcome?: string;
	result?: ReviewResult;
	error?: string;
}

const HISTORY_EVENTS: readonly string[] = ["on", "audit", "round", "off"];

/** Appends one line to `<dir>/<taskId>.jsonl`; the log is only ever appended. */
export async function appendHistory(
	dir: string,
	taskId: string,
	entry: Omit<HistoryEntry, "at">,
): Promise<void> {
	const file = stateFile(dir, taskId, ".jsonl");
	await privateDir(dir);
	const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
	await appendFile(file, `${line}\n`);
}

/** Returns [] when there is no history; throws StateError when it is corrupt. */
export async function readHistory(
	dir: string,
	taskId: string,
): Promise<HistoryEntry[]> {
	const file = stateFile(dir, taskId, ".jsonl");
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return raw
		.split("\n")
		.filter((line) => line !== "")
		.map((line, i) => {
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				throw new StateError(
					`corrupt history file ${file}: line ${i + 1}: invalid JSON`,
				);
			}
			try {
				return parseHistoryEntry(entry);
			} catch (error) {
				throw new StateError(
					`corrupt history file ${file}: line ${i + 1}: ${(error as Error).message}`,
				);
			}
		});
}

function parseHistoryEntry(data: unknown): HistoryEntry {
	if (typeof data !== "object" || data === null || Array.isArray(data))
		throw new Error("not an object");
	const e = data as Record<string, unknown>;
	if (typeof e.at !== "string") throw new Error("invalid at");
	if (!HISTORY_EVENTS.includes(e.event as string))
		throw new Error("invalid event");
	const entry: HistoryEntry = {
		at: e.at,
		event: e.event as HistoryEntry["event"],
	};
	if (e.round !== undefined) {
		if (!Number.isInteger(e.round) || (e.round as number) < 0)
			throw new Error("invalid round");
		entry.round = e.round as number;
	}
	for (const key of ["outcome", "error"] as const) {
		if (e[key] === undefined) continue;
		if (typeof e[key] !== "string") throw new Error(`invalid ${key}`);
		entry[key] = e[key];
	}
	if (e.result !== undefined) entry.result = parseReviewResult(e.result);
	return entry;
}
