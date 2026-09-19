import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

function stateFile(dir: string, taskId: string): string {
	// taskId becomes a file name; refuse anything that could escape `dir`.
	if (!/^[A-Za-z0-9_-]+$/.test(taskId))
		throw new StateError(`invalid task id ${JSON.stringify(taskId)}`);
	return join(dir, `${taskId}.json`);
}

/** Atomic write: a crash never leaves a half-written state file. */
export async function saveState(dir: string, state: TaskState): Promise<void> {
	const file = stateFile(dir, state.taskId);
	await mkdir(dir, { recursive: true });
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
