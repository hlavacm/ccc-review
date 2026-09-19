import {
	parseReviewResult,
	type Reviewer,
	type ReviewRequest,
	type ReviewResult,
} from "../core/types.ts";
import { describeChanges } from "../git.ts";
import { duration, type Exit, runProcess, stderrTail } from "./process.ts";
import { buildReviewPrompt, REVIEW_SCHEMA } from "./prompt.ts";

export const DEFAULT_CLAUDE_TIMEOUT_MS = 20 * 60 * 1000;

export const CLAUDE_EFFORTS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

/**
 * File tools only. No Bash: even a `git diff` allow rule would permit
 * `git diff --output=<file>`, so CCC Review collects the Git changes itself.
 */
export const REVIEWER_TOOLS = "Read,Grep,Glob";

export interface ClaudeReviewerOptions {
	bin?: string;
	timeoutMs?: number;
	/** `--model`; Claude Code's configured default when absent. */
	model?: string;
	/** `--effort`; Claude Code's configured default when absent. */
	effort?: ClaudeEffort;
	/** Environment used to decide on the login preflight (default process.env). */
	env?: NodeJS.ProcessEnv;
}

const LOGIN_HINT = "Claude Code is not logged in — run `claude auth login`";
const AUTH_ERROR = /not logged in|authenticat|\/login|401/i;
/** `auth status` is local; it never needs the full review deadline. */
const LOGIN_TIMEOUT_MS = 60_000;

export class ClaudeReviewer implements Reviewer {
	private readonly options: ClaudeReviewerOptions;

	constructor(options: ClaudeReviewerOptions = {}) {
		this.options = options;
	}

	private get bin() {
		return this.options.bin ?? "claude";
	}

	private get timeoutMs() {
		return this.options.timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS;
	}

	describe(): string {
		const o = this.options;
		return `claude (bin ${this.bin}, timeout ${duration(this.timeoutMs)}, model ${o.model ?? "default"}, effort ${o.effort ?? "default"})`;
	}

	/**
	 * Fails fast when claude is missing or not logged in. With
	 * ANTHROPIC_API_KEY (which `auth status` may not reflect) only the
	 * executable is checked.
	 */
	async check(cwd = process.cwd()): Promise<void> {
		const apiKey = Boolean((this.options.env ?? process.env).ANTHROPIC_API_KEY);
		const args = apiKey ? ["--version"] : ["auth", "status"];
		const exit = await this.run(
			cwd,
			"",
			args,
			Math.min(this.timeoutMs, LOGIN_TIMEOUT_MS),
		);
		if (exit.code === 0) return;
		const detail = stderrTail(`${exit.stdout}\n${exit.stderr}`);
		const what = apiKey ? `\`claude ${args.join(" ")}\` failed` : LOGIN_HINT;
		throw new Error(`${what}${detail ? ` (${detail})` : ""}`);
	}

	async review(request: ReviewRequest): Promise<ReviewResult> {
		const root = request.baseline.root;
		await this.check(root);
		const changes = await describeChanges(request.baseline);
		const { model, effort } = this.options;
		const exit = await this.run(
			root,
			buildReviewPrompt(request, { changes }),
			[
				"-p",
				// No CLAUDE.md, plugins, hooks, skills or MCP: a hermetic reviewer
				// that cannot re-enter CCC Review's own Claude Code hooks.
				"--safe-mode",
				"--no-session-persistence",
				"--output-format",
				"json",
				"--json-schema",
				JSON.stringify(REVIEW_SCHEMA),
				"--tools",
				REVIEWER_TOOLS,
				// Anything not pre-approved is denied; nobody is asked.
				"--permission-mode",
				"dontAsk",
				"--permission-prompts",
				"none",
				...(model ? ["--model", model] : []),
				...(effort ? ["--effort", effort] : []),
			],
			this.timeoutMs,
		);
		return parseClaudeOutput(exit);
	}

	private run(
		cwd: string,
		input: string,
		args: string[],
		timeoutMs: number,
	): Promise<Exit> {
		return runProcess({
			name: "claude",
			bin: this.bin,
			args,
			cwd,
			input,
			timeoutMs,
			missingHint: "install Claude Code or set CCC_REVIEW_CLAUDE_BIN",
			timeoutSetting: "CCC_REVIEW_CLAUDE_TIMEOUT_MS",
		});
	}
}

/** `claude -p --output-format json` result → validated review, or throws. */
export function parseClaudeOutput(exit: Exit): ReviewResult {
	if (exit.stdoutTruncated) throw new Error("claude output is too large");
	let data: Record<string, unknown> | undefined;
	try {
		const parsed: unknown = JSON.parse(exit.stdout);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
			data = parsed as Record<string, unknown>;
	} catch {
		// Reported below, with the exit status when there is one.
	}
	// In-run failures (e.g. authentication) are printed as the result.
	const said = typeof data?.result === "string" ? data.result : "";
	if (exit.code !== 0) {
		const tail = stderrTail(`${said}\n${exit.stderr}`);
		const how = exit.signal
			? `killed by ${exit.signal}`
			: `exited with code ${exit.code}`;
		const hint = AUTH_ERROR.test(tail) ? `\n${LOGIN_HINT}` : "";
		throw new Error(`claude ${how}${tail ? `: ${tail}` : ""}${hint}`);
	}
	if (!data) {
		const excerpt = exit.stdout.trim().slice(0, 200);
		throw new Error(
			excerpt
				? `claude returned invalid JSON: ${excerpt}`
				: "claude returned no output",
		);
	}
	if (data.is_error === true || data.subtype !== "success") {
		const detail = stderrTail(
			[said, ...(Array.isArray(data.errors) ? data.errors.map(String) : [])]
				.filter(Boolean)
				.join("\n"),
		);
		throw new Error(
			`claude review failed (${String(data.subtype)})${detail ? `: ${detail}` : ""}`,
		);
	}
	if (data.structured_output === undefined || data.structured_output === null)
		throw new Error("claude returned no structured review");
	try {
		return parseReviewResult(data.structured_output);
	} catch (error) {
		throw new Error(
			`claude returned an invalid review: ${(error as Error).message}`,
		);
	}
}
