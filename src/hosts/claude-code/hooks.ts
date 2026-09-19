import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type RoundOutcome, runReviewRound } from "../../core/review-loop.ts";
import {
	createTaskState,
	loadState,
	saveState,
	type TaskState,
} from "../../core/state.ts";
import {
	formatFinding,
	type Reviewer,
	type ReviewResult,
} from "../../core/types.ts";
import { captureBaseline } from "../../git.ts";
import {
	CodexReviewer,
	DEFAULT_CODEX_TIMEOUT_MS,
} from "../../reviewers/codex.ts";

/** Claude Code hook stdout JSON. `undefined` = print nothing (no effect). */
export interface HookOutput {
	decision?: "block";
	reason?: string;
	systemMessage?: string;
}

export interface HostConfig {
	stateDir: string;
	reviewer: Reviewer;
}

/** Hook payload fields we rely on (Claude Code sends more). */
export interface HookInput {
	session_id?: unknown;
	cwd?: unknown;
	command_name?: unknown;
	command_args?: unknown;
	prompt?: unknown;
	last_assistant_message?: unknown;
	/** Present only when the hook fires inside a subagent. */
	agent_id?: unknown;
}

interface Session {
	taskId: string;
	/** User prompts submitted while review was active: the original task. */
	prompts: string[];
}

const MAX_PROMPTS = 20;
const MAX_PROMPT_CHARS = 8000;

export function configFromEnv(env: NodeJS.ProcessEnv): HostConfig {
	const timeout = env.CCCR_CODEX_TIMEOUT_MS;
	const timeoutMs =
		timeout === undefined ? DEFAULT_CODEX_TIMEOUT_MS : Number(timeout);
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
		throw new Error(
			`invalid CCCR_CODEX_TIMEOUT_MS ${JSON.stringify(timeout)}: expected a positive integer`,
		);
	return {
		stateDir:
			env.CCCR_STATE_DIR || env.CLAUDE_PLUGIN_DATA || join(homedir(), ".cccr"),
		reviewer: new CodexReviewer({
			bin: env.CCCR_CODEX_BIN || "codex",
			timeoutMs,
		}),
	};
}

const tasksDir = (c: HostConfig) => join(c.stateDir, "tasks");

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

async function currentTask(c: HostConfig, sessionId: unknown) {
	const session = await loadSession(c, sessionId);
	const state = session && (await loadState(tasksDir(c), session.taskId));
	return { session, state };
}

const reply = (text: string): HookOutput => ({
	decision: "block",
	reason: `CCC Review: ${text}`,
});

/** UserPromptExpansion: `/cccr:cccr on [task] | off | status`. */
export async function handleCommand(
	c: HostConfig,
	input: HookInput,
): Promise<HookOutput | undefined> {
	if (input.command_name !== "cccr" && input.command_name !== "cccr:cccr")
		return undefined;
	const args =
		typeof input.command_args === "string" ? input.command_args.trim() : "";
	const action = args.split(/\s+/)[0] || "status";
	const { state } = await currentTask(c, input.session_id);

	switch (action) {
		case "on": {
			if (state?.active) return reply(`already active.\n${describe(state)}`);
			if (typeof input.cwd !== "string") throw new Error("missing cwd");
			let baseline: TaskState["baseline"];
			try {
				baseline = await captureBaseline(input.cwd);
			} catch (error) {
				return reply(
					`not enabled: ${input.cwd} is not a usable Git repository (${(error as Error).message}).`,
				);
			}
			const task = createTaskState({
				writer: "claude",
				reviewer: "codex",
				baseline,
			});
			await saveState(tasksDir(c), task);
			const taskText = args.slice(action.length).trim();
			await saveSession(c, input.session_id, {
				taskId: task.taskId,
				prompts: taskText ? [taskText] : [],
			});
			return reply(
				`enabled. Codex will review when Claude finishes.\n${describe(task)}`,
			);
		}
		case "off":
			if (!state?.active) return reply("already off.");
			await saveState(tasksDir(c), { ...state, active: false });
			return reply(
				`disabled (task ${state.taskId}, ${state.round} round(s) run).`,
			);
		case "status":
			return reply(
				state ? describe(state) : "off (never enabled in this session).",
			);
		default:
			return reply(
				`unknown action ${JSON.stringify(action)}. Use: on [task description] | off | status`,
			);
	}
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

/** UserPromptSubmit: remember the user's task text while review is active. */
export async function handlePromptSubmit(
	c: HostConfig,
	input: HookInput,
): Promise<HookOutput | undefined> {
	const { session, state } = await currentTask(c, input.session_id);
	if (!session || !state?.active) return undefined;
	const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	if (!prompt || prompt.startsWith("/")) return undefined;
	session.prompts = [
		...session.prompts,
		prompt.slice(0, MAX_PROMPT_CHARS),
	].slice(-MAX_PROMPTS);
	await saveSession(c, input.session_id, session);
	return undefined;
}

/** Stop: one logical completion → at most one review round. */
export async function handleStop(
	c: HostConfig,
	input: HookInput,
): Promise<HookOutput | undefined> {
	// Only the main writer's completion is reviewed, never a subagent's.
	if (input.agent_id !== undefined) return undefined;
	const { session, state } = await currentTask(c, input.session_id);
	if (!session || !state?.active) return undefined;

	const report =
		typeof input.last_assistant_message === "string"
			? input.last_assistant_message
			: "";
	// Claude Code sends no event id; the same final message is the same completion.
	// Exclusive create claims the event atomically, so duplicate or concurrent
	// deliveries of it never start a second round.
	const claims = join(c.stateDir, "claims", state.taskId);
	await mkdir(claims, { recursive: true });
	const key = createHash("sha256").update(report).digest("hex");
	try {
		await writeFile(join(claims, key), "", { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
		throw error;
	}

	const context: { task?: string; report?: string } = {};
	if (session.prompts.length > 0) context.task = session.prompts.join("\n\n");
	if (report) context.report = report;
	const { state: next, outcome } = await runReviewRound(
		state,
		c.reviewer,
		context,
	);
	await saveState(tasksDir(c), next);
	return stopOutput(outcome, next);
}

export function stopOutput(
	outcome: RoundOutcome,
	s: TaskState,
): HookOutput | undefined {
	const r = s.lastResult;
	switch (outcome) {
		case "changes_requested":
			return {
				decision: "block",
				reason: writerFeedback(r as ReviewResult, s.round, s.maxRounds),
			};
		case "approved":
			return {
				systemMessage:
					`CCC Review: Codex APPROVED (round ${s.round}/${s.maxRounds}). ${r?.summary ?? ""}`.trim(),
			};
		case "needs_human":
			return {
				systemMessage: `CCC Review: Codex needs a human decision (round ${s.round}/${s.maxRounds}). Review stopped.\n${resultText(r)}`,
			};
		case "max_rounds":
			return {
				systemMessage: `CCC Review: max ${s.maxRounds} review rounds reached WITHOUT approval. Review stopped.\n${resultText(r)}`,
			};
		case "reviewer_error":
			return {
				systemMessage:
					`CCC Review: Codex review FAILED — the change is NOT approved. Review stopped.\n${s.lastError ?? ""}`.trim(),
			};
		case "inactive":
			return undefined;
	}
}

function resultText(r: ReviewResult | undefined): string {
	if (!r) return "";
	return [r.summary, ...r.findings.map((f) => `- ${formatFinding(f)}`)].join(
		"\n",
	);
}

export function writerFeedback(
	r: ReviewResult,
	round: number,
	maxRounds: number,
): string {
	return [
		`CCC Review round ${round}/${maxRounds}: Codex requested changes.`,
		"",
		`Summary: ${r.summary}`,
		"",
		"Findings:",
		...r.findings.map((f) => `- ${formatFinding(f)}`),
		"",
		"Instructions:",
		"1. Evaluate every finding independently; the reviewer can be wrong.",
		"2. Fix valid findings.",
		"3. Reject invalid findings with concrete reasoning.",
		"4. Run relevant verification (tests, typecheck, lint).",
		"5. Finish with an updated implementation report that keeps the finding IDs, e.g.:",
		"   CCC-001: fixed — Reason: … Verification: …",
		"   CCC-002: rejected — Reason: …",
		"Codex will review again when you finish.",
	].join("\n");
}

const HANDLERS = {
	command: handleCommand,
	"prompt-submit": handlePromptSubmit,
	stop: handleStop,
};

/**
 * Entry point for one hook invocation. Any failure (bad payload, bad config,
 * corrupt state) is reported to the user and never blocks or approves.
 */
export async function runHook(
	event: string | undefined,
	stdin: string,
	getConfig: () => HostConfig,
): Promise<HookOutput | undefined> {
	try {
		const handler = HANDLERS[event as keyof typeof HANDLERS];
		if (!handler)
			throw new Error(`unknown hook event ${JSON.stringify(event)}`);
		const input: unknown = JSON.parse(stdin);
		if (typeof input !== "object" || input === null)
			throw new Error("hook input is not a JSON object");
		return await handler(getConfig(), input as HookInput);
	} catch (error) {
		const message = `CCC Review error: ${(error as Error).message}`;
		// A failed /cccr command must not fall through to the model.
		return event === "command"
			? { decision: "block", reason: message }
			: { systemMessage: message };
	}
}
