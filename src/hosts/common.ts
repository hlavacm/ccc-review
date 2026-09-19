// Host-side review workflow shared by the Claude Code and Codex adapters:
// per-session activation, Git baseline, completion claims, one review round
// per completion, history and the texts shown to the writer and the user.
// Each host maps its own hook payloads onto these functions.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type RoundOutcome, runReviewRound } from "../core/review-loop.ts";
import {
	type Agent,
	appendHistory,
	createTaskState,
	type HistoryEntry,
	loadState,
	readHistory,
	saveState,
	type TaskState,
} from "../core/state.ts";
import {
	type Finding,
	formatFinding,
	type GitStatusEntry,
	type ReviewContext,
	type Reviewer,
	type ReviewResult,
	SEVERITIES,
} from "../core/types.ts";
import { captureBaseline } from "../git.ts";

/**
 * Hook stdout JSON; the same keys mean the same in Claude Code and Codex.
 * `undefined` = print nothing (no effect). Codex rejects unknown keys.
 */
export interface HookOutput {
	decision?: "block";
	reason?: string;
	systemMessage?: string;
}

export interface HostConfig {
	stateDir: string;
	reviewer: Reviewer;
	/** Review rounds per task; core default (3) when absent. */
	maxRounds?: number;
}

/** Which agent writes in this host and which one reviews. */
export interface Roles {
	writer: Agent;
	reviewer: Agent;
}

export const agentName = (a: Agent) => (a === "claude" ? "Claude" : "Codex");

interface Session {
	taskId: string;
	/** User prompts submitted while review was active: the original task. */
	prompts: string[];
}

const MAX_PROMPTS = 20;
const MAX_PROMPT_CHARS = 8000;

export function positiveInt(
	env: NodeJS.ProcessEnv,
	name: string,
): number | undefined {
	const raw = env[name];
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (raw.trim() === "" || !Number.isInteger(value) || value <= 0)
		throw new Error(
			`invalid ${name} ${JSON.stringify(raw)}: expected a positive integer`,
		);
	return value;
}

/** One of `allowed`, or undefined when unset/empty. */
export function oneOf<T extends string>(
	env: NodeJS.ProcessEnv,
	name: string,
	allowed: readonly T[],
): T | undefined {
	const value = env[name] || undefined;
	if (value !== undefined && !(allowed as readonly string[]).includes(value))
		throw new Error(
			`invalid ${name} ${JSON.stringify(value)}: expected one of ${allowed.join(", ")}`,
		);
	return value as T | undefined;
}

const tasksDir = (c: HostConfig) => join(c.stateDir, "tasks");
const historyDir = (c: HostConfig) => join(c.stateDir, "history");
const claimsDir = (c: HostConfig, taskId: string) =>
	join(c.stateDir, "claims", taskId);

/** Claims only guard an active task; drop them once it has ended. */
const dropClaims = (c: HostConfig, taskId: string) =>
	rm(claimsDir(c, taskId), { recursive: true, force: true });

function sessionFile(c: HostConfig, sessionId: unknown): string {
	if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(sessionId))
		throw new Error(`invalid session_id ${JSON.stringify(sessionId)}`);
	return join(c.stateDir, "sessions", `${sessionId}.json`);
}

async function loadSession(
	c: HostConfig,
	sessionId: unknown,
): Promise<Session | undefined> {
	let raw: string;
	try {
		raw = await readFile(sessionFile(c, sessionId), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const data = JSON.parse(raw) as Partial<Session>;
	if (typeof data.taskId !== "string" || !Array.isArray(data.prompts))
		throw new Error("corrupt CCC Review session file");
	return { taskId: data.taskId, prompts: data.prompts.map(String) };
}

async function saveSession(c: HostConfig, sessionId: unknown, s: Session) {
	const file = sessionFile(c, sessionId);
	await mkdir(join(c.stateDir, "sessions"), { recursive: true });
	// ponytail: plain overwrite; prompt-submit and command never race in one session.
	await writeFile(file, `${JSON.stringify(s, null, 2)}\n`);
}

/**
 * The session's task, if this host's writer owns it. Both hosts may share a
 * state directory (Codex also sets CLAUDE_PLUGIN_DATA), and a session one
 * host armed must never be driven by the other host's hooks.
 */
async function currentTask(c: HostConfig, roles: Roles, sessionId: unknown) {
	const session = await loadSession(c, sessionId);
	const state = session && (await loadState(tasksDir(c), session.taskId));
	return state && state.writer === roles.writer
		? { session, state }
		: { session: undefined, state: undefined };
}

/** `on [task] | off | status`. Returns the text to show the user. */
export async function runCommand(
	c: HostConfig,
	roles: Roles,
	sessionId: unknown,
	cwd: unknown,
	args: string,
): Promise<string> {
	const reply = (text: string) => `CCC Review: ${text}`;
	const action = args.split(/\s+/)[0] || "status";
	// Unreadable state must not wedge the session: `on` replaces it and `off`
	// resets the session; anything else reports it with the way out.
	sessionFile(c, sessionId); // an invalid session id is never recoverable
	let state: TaskState | undefined;
	let broken = "";
	try {
		({ state } = await currentTask(c, roles, sessionId));
	} catch (error) {
		if (action !== "on" && action !== "off")
			throw new Error(
				`${(error as Error).message} — use "on" to start a fresh task or "off" to reset this session`,
			);
		broken = (error as Error).message;
	}

	switch (action) {
		case "on": {
			if (state?.active) return reply(`already active.\n${describe(state)}`);
			if (typeof cwd !== "string") throw new Error("missing cwd");
			let baseline: TaskState["baseline"];
			try {
				baseline = await captureBaseline(cwd);
			} catch (error) {
				return reply(
					`not enabled: ${cwd} is not a usable Git repository (${(error as Error).message}).`,
				);
			}
			try {
				await c.reviewer.check?.(baseline.root);
			} catch (error) {
				return reply(`not enabled: ${(error as Error).message}`);
			}
			const task = createTaskState({
				...roles,
				baseline,
				...(c.maxRounds === undefined ? {} : { maxRounds: c.maxRounds }),
			});
			await saveState(tasksDir(c), task);
			await appendHistory(historyDir(c), task.taskId, { event: "on" });
			const taskText = args.slice(action.length).trim();
			await saveSession(c, sessionId, {
				taskId: task.taskId,
				prompts: taskText ? [taskText] : [],
			});
			return reply(
				[
					`enabled. ${agentName(roles.reviewer)} will review when ${agentName(roles.writer)} finishes.`,
					...(broken
						? [
								`The previous state was unreadable and was replaced (${broken}).`,
							]
						: []),
					...dirtyWarning(task),
					describe(task),
				].join("\n"),
			);
		}
		case "off":
			if (broken) {
				await rm(sessionFile(c, sessionId), { force: true });
				return reply(
					`disabled. The state was unreadable, so this session was reset (${broken}).`,
				);
			}
			if (!state?.active) return reply("already off.");
			await saveState(tasksDir(c), { ...state, active: false });
			await appendHistory(historyDir(c), state.taskId, {
				event: "off",
				round: state.round,
			});
			await dropClaims(c, state.taskId);
			return reply(
				`disabled (task ${state.taskId}, ${state.round} round(s) run).`,
			);
		case "status":
			return reply(
				state
					? await statusText(c, state)
					: "off (never enabled in this session).",
			);
		default:
			return reply(
				`unknown action ${JSON.stringify(action)}. Use: on [task description] | off | status`,
			);
	}
}

const statusLine = (e: GitStatusEntry) =>
	`  ${e.code} ${e.origPath === undefined ? "" : `${e.origPath} -> `}${e.path}`;

const MAX_LISTED_PATHS = 10;

function dirtyWarning(s: TaskState): string[] {
	const status = s.baseline.status;
	if (status.length === 0) return [];
	const more = status.length - MAX_LISTED_PATHS;
	return [
		`Warning: the working tree already has ${status.length} uncommitted change(s). ${agentName(s.reviewer)} is told they may not be ${agentName(s.writer)}'s, but review is clearer from a clean tree:`,
		...status.slice(0, MAX_LISTED_PATHS).map(statusLine),
		...(more > 0 ? [`  … and ${more} more`] : []),
	];
}

async function statusText(c: HostConfig, s: TaskState): Promise<string> {
	const history = await readHistory(historyDir(c), s.taskId);
	return [
		describe(s),
		...(c.reviewer.describe ? [`reviewer: ${c.reviewer.describe()}`] : []),
		"history:",
		...(history.length > 0 ? history.map(historyLine) : ["  (none)"]),
		`state: ${join(tasksDir(c), `${s.taskId}.json`)}`,
		`log: ${join(historyDir(c), `${s.taskId}.jsonl`)}`,
	].join("\n");
}

function historyLine(e: HistoryEntry): string {
	const at = e.at.slice(0, 19).replace("T", " ");
	if (e.event !== "round") return `  ${at} ${e.event}`;
	const r = e.result;
	const what = r
		? `${r.verdict}${r.findings.length > 0 ? ` — ${r.findings.length} finding(s): ${r.findings.map((f) => f.id).join(", ")}` : ""}`
		: `${e.outcome ?? "?"}${e.error ? ` — ${e.error.split("\n")[0]}` : ""}`;
	const stop = e.outcome === "max_rounds" ? " (max rounds reached)" : "";
	return `  ${at} round ${e.round}: ${what}${stop}`;
}

function describe(s: TaskState): string {
	const b = s.baseline;
	const lines = [
		`status: ${s.active ? "active" : "inactive"}`,
		`task: ${s.taskId}`,
		`round: ${s.round}/${s.maxRounds}`,
		`baseline: ${b.root} @ ${b.branch ?? "(detached)"} ${b.headSha?.slice(0, 12) ?? "(no commits)"}, ${b.status.length} pre-existing dirty path(s)`,
	];
	if (s.lastResult)
		lines.push(
			`last verdict: ${s.lastResult.verdict} — ${s.lastResult.summary}`,
		);
	if (s.lastError) lines.push(`last error: ${s.lastError}`);
	return lines.join("\n");
}

/** Remembers a user prompt as task context while review is active. */
export async function recordPrompt(
	c: HostConfig,
	roles: Roles,
	sessionId: unknown,
	prompt: string,
): Promise<void> {
	const { session, state } = await currentTask(c, roles, sessionId);
	if (!session || !state?.active) return;
	session.prompts = [
		...session.prompts,
		prompt.slice(0, MAX_PROMPT_CHARS),
	].slice(-MAX_PROMPTS);
	await saveSession(c, sessionId, session);
}

/**
 * One logical writer completion → at most one review round. `claimKey`
 * identifies the completion: an equal key never starts a second round.
 */
export async function reviewCompletion(
	c: HostConfig,
	roles: Roles,
	sessionId: unknown,
	claimKey: string,
	report: string,
): Promise<HookOutput | undefined> {
	const { session, state } = await currentTask(c, roles, sessionId);
	if (!session || !state?.active) return undefined;

	// Exclusive create claims the event atomically, so duplicate or concurrent
	// deliveries of it never start a second round.
	const claims = claimsDir(c, state.taskId);
	await mkdir(claims, { recursive: true });
	try {
		await writeFile(join(claims, claimKey), "", { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
		throw error;
	}
	// Claims are dropped when a task ends, so a duplicate that read the state
	// before that could claim again: only review if nothing moved meanwhile.
	const fresh = await loadState(tasksDir(c), state.taskId);
	if (!fresh?.active || fresh.round !== state.round) return undefined;

	const context: ReviewContext = {};
	if (session.prompts.length > 0) context.task = session.prompts.join("\n\n");
	if (report) context.report = report;
	const { state: next, outcome } = await runReviewRound(
		state,
		c.reviewer,
		context,
	);
	await saveState(tasksDir(c), next);
	const entry: Omit<HistoryEntry, "at"> = {
		event: "round",
		round: next.round,
		outcome,
	};
	if (next.lastError !== undefined && outcome === "reviewer_error")
		entry.error = next.lastError;
	else if (next.lastResult) entry.result = next.lastResult;
	await appendHistory(historyDir(c), next.taskId, entry);
	if (!next.active) await dropClaims(c, next.taskId);
	return stopOutput(outcome, next);
}

export function stopOutput(
	outcome: RoundOutcome,
	s: TaskState,
): HookOutput | undefined {
	const r = s.lastResult;
	const reviewer = agentName(s.reviewer);
	switch (outcome) {
		case "changes_requested":
			return {
				decision: "block",
				reason: writerFeedback(
					r as ReviewResult,
					s.round,
					s.maxRounds,
					s.reviewer,
				),
			};
		case "approved":
			return {
				systemMessage:
					`CCC Review: ${reviewer} APPROVED (round ${s.round}/${s.maxRounds}). ${r?.summary ?? ""}`.trim(),
			};
		case "needs_human":
			return {
				systemMessage: `CCC Review: ${reviewer} needs a human decision (round ${s.round}/${s.maxRounds}). Review stopped.\n${resultText(r)}`,
			};
		case "max_rounds":
			return {
				systemMessage: `CCC Review: max ${s.maxRounds} review rounds reached WITHOUT approval. Review stopped.\n${resultText(r)}`,
			};
		case "reviewer_error":
			return {
				systemMessage:
					`CCC Review: ${reviewer} review FAILED — the change is NOT approved. Review stopped.\n${s.lastError ?? ""}`.trim(),
			};
		case "inactive":
			return undefined;
	}
}

/** Most severe first; continuation lines of a multi-line message indented. */
export function findingLines(findings: Finding[]): string[] {
	return [...findings]
		.sort(
			(a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity),
		)
		.map((f) => `- ${formatFinding(f).replace(/\n/g, "\n    ")}`);
}

function resultText(r: ReviewResult | undefined): string {
	if (!r) return "";
	return [r.summary, ...findingLines(r.findings)].join("\n");
}

export function writerFeedback(
	r: ReviewResult,
	round: number,
	maxRounds: number,
	reviewer: Agent,
): string {
	return [
		`CCC Review round ${round}/${maxRounds}: ${agentName(reviewer)} requested changes.`,
		"",
		`Summary: ${r.summary}`,
		"",
		"Findings:",
		...findingLines(r.findings),
		"",
		"Instructions:",
		"1. Evaluate every finding independently; the reviewer can be wrong.",
		"2. Fix valid findings.",
		"3. Reject invalid findings with concrete reasoning.",
		"4. Run relevant verification (tests, typecheck, lint).",
		"5. Finish with an updated implementation report that keeps the finding IDs, e.g.:",
		"   CCC-001: fixed — Reason: … Verification: …",
		"   CCC-002: rejected — Reason: …",
		`${agentName(reviewer)} will review again when you finish.`,
	].join("\n");
}
