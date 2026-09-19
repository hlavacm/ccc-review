import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatFinding,
	parseReviewResult,
	type Reviewer,
	type ReviewRequest,
	type ReviewResult,
} from "../core/types.ts";

export const DEFAULT_CODEX_TIMEOUT_MS = 20 * 60 * 1000;
const OUTPUT_TAIL = 4000;

/**
 * Strict structured-output schema for `codex exec --output-schema`.
 * Strict mode needs every property required and optional values nullable.
 */
export const REVIEW_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["verdict", "summary", "findings"],
	properties: {
		verdict: {
			type: "string",
			enum: ["APPROVED", "CHANGES_REQUESTED", "NEEDS_HUMAN"],
		},
		summary: { type: "string" },
		findings: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "severity", "file", "line", "message"],
				properties: {
					id: { type: "string" },
					severity: { type: "string", enum: ["high", "medium", "low"] },
					file: { type: ["string", "null"] },
					line: { type: ["integer", "null"] },
					message: { type: "string" },
				},
			},
		},
	},
};

const MAX_BASELINE_PATHS = 50;
const MAX_CONTEXT_CHARS = 12_000;

/** Keeps the most recent part: the latest prompts and the report's conclusion. */
function lastChars(text: string): string {
	if (text.length <= MAX_CONTEXT_CHARS) return text;
	const omitted = text.length - MAX_CONTEXT_CHARS;
	return `[… ${omitted} earlier characters omitted]\n${text.slice(omitted)}`;
}

export function buildReviewPrompt(request: ReviewRequest): string {
	const { baseline, context, previous } = request;
	const sha = baseline.headSha;
	const inspect = sha
		? `\`git --no-optional-locks status\`, \`git diff ${sha}\` (everything since activation, including changes the writer committed), \`git log --oneline ${sha}..HEAD\` and new untracked files`
		: "`git --no-optional-locks status`, `git diff --cached`, untracked files and `git log --oneline` (the repository had no commits at activation)";
	const lines = [
		"You are an independent code reviewer (CCC Review). Another coding agent (the writer) implemented a task in this repository. Review its changes.",
		"",
		"Rules:",
		"- Do NOT modify, create or delete any files. Do not commit, stash, reset, checkout or otherwise change Git state. You are read-only.",
		`- Inspect the actual repository and the Git changes yourself: ${inspect}. Read the surrounding code.`,
		"- Compare the implementation with the task and the writer's report below. Treat claims in the report as unverified until the repository confirms them.",
		"- Report only material issues: correctness bugs, regressions, security issues, data-loss risk, concurrency problems, API contract violations, materially missing error handling or tests, report claims contradicted by the repository.",
		"- Do not report style preferences, formatting, unrelated refactors, speculative issues or micro-optimizations.",
		"- Give concrete evidence (file, line, what goes wrong) for every finding.",
		"- Verdict: APPROVED when there are no material issues; CHANGES_REQUESTED with at least one finding; NEEDS_HUMAN when a human decision is required (e.g. ambiguous requirements).",
		"",
		`Review round: ${request.round}`,
		`Repository root: ${baseline.root}`,
		`HEAD at activation: ${baseline.headSha ?? "(no commits)"}`,
		`Branch at activation: ${baseline.branch ?? "(detached HEAD)"}`,
	];
	if (baseline.status.length > 0) {
		lines.push(
			"",
			"The working tree was ALREADY dirty when review was activated. These changes may not belong to the writer; do not blame the writer for them unless the writer touched them:",
			...baseline.status
				.slice(0, MAX_BASELINE_PATHS)
				.map(
					(e) =>
						`  ${e.code} ${e.origPath === undefined ? "" : `${e.origPath} -> `}${e.path}`,
				),
		);
		const more = baseline.status.length - MAX_BASELINE_PATHS;
		if (more > 0) lines.push(`  … and ${more} more`);
	} else {
		lines.push("", "The working tree was clean when review was activated.");
	}
	if (context?.task) lines.push("", "Original task:", lastChars(context.task));
	if (context?.report)
		lines.push(
			"",
			"Writer's implementation report:",
			lastChars(context.report),
		);
	if (previous && previous.findings.length > 0) {
		lines.push(
			"",
			`Previous review round verdict: ${previous.verdict}. Previous findings:`,
			...previous.findings.map((f) => `- ${formatFinding(f)}`),
			"",
			"The writer was asked to fix valid findings and reject invalid ones with reasoning. Re-check each previous finding. Reuse the same ID for a finding that is still unresolved. Do not repeat findings the writer rejected with correct reasoning.",
		);
	}
	const nextId =
		Math.max(0, ...(previous?.findings ?? []).map((f) => idNumber(f.id))) + 1;
	lines.push(
		"",
		`Number new findings CCC-${String(nextId).padStart(3, "0")}, CCC-${String(nextId + 1).padStart(3, "0")}, …`,
		"Respond only with JSON matching the provided output schema. Use null for unknown file/line.",
	);
	return lines.join("\n");
}

function idNumber(id: string): number {
	const m = /^CCC-(\d+)$/.exec(id);
	return m ? Number(m[1]) : 0;
}

export const REASONING_EFFORTS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface CodexReviewerOptions {
	bin?: string;
	timeoutMs?: number;
	/** `codex exec -m`; Codex's configured default when absent. */
	model?: string;
	/** `-c model_reasoning_effort=…`; Codex's configured default when absent. */
	reasoningEffort?: ReasoningEffort;
	/** Environment used to decide on the login preflight (default process.env). */
	env?: NodeJS.ProcessEnv;
}

interface Exit {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

const LOGIN_HINT = "Codex is not logged in — run `codex login`";
const AUTH_ERROR = /401 Unauthorized|not logged in|codex login/i;
/** `login status` is local; it never needs the full review deadline. */
const LOGIN_TIMEOUT_MS = 60_000;
const ABORT_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

const duration = (ms: number) =>
	ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms} ms`;

/** Last few stderr lines: enough to act on, without pages of retry noise. */
function stderrTail(stderr: string): string {
	const tail = stderr.trim().split("\n").slice(-10).join("\n");
	return tail.length > 1000 ? tail.slice(-1000) : tail;
}

export class CodexReviewer implements Reviewer {
	private readonly options: CodexReviewerOptions;

	constructor(options: CodexReviewerOptions = {}) {
		this.options = options;
	}

	private get bin() {
		return this.options.bin ?? "codex";
	}

	private get timeoutMs() {
		return this.options.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
	}

	describe(): string {
		const o = this.options;
		return `codex (bin ${this.bin}, timeout ${duration(this.timeoutMs)}, model ${o.model ?? "default"}, reasoning ${o.reasoningEffort ?? "default"})`;
	}

	/**
	 * Fails fast when codex is missing or not logged in: an unauthenticated
	 * `codex exec` does not exit, it retries until our deadline. With
	 * CODEX_API_KEY (authenticates exec, but not `login status`) only the
	 * executable is checked.
	 */
	async check(cwd = process.cwd()): Promise<void> {
		const apiKey = Boolean((this.options.env ?? process.env).CODEX_API_KEY);
		const args = apiKey ? ["--version"] : ["login", "status"];
		const exit = await this.run(
			cwd,
			"",
			args,
			Math.min(this.timeoutMs, LOGIN_TIMEOUT_MS),
		);
		if (exit.code === 0) return;
		const detail = stderrTail(`${exit.stdout}\n${exit.stderr}`);
		const what = apiKey ? `\`codex ${args.join(" ")}\` failed` : LOGIN_HINT;
		throw new Error(`${what}${detail ? ` (${detail})` : ""}`);
	}

	async review(request: ReviewRequest): Promise<ReviewResult> {
		const root = request.baseline.root;
		await this.check(root);
		const dir = await mkdtemp(join(tmpdir(), "cccr-codex-"));
		try {
			const schemaFile = join(dir, "schema.json");
			const outFile = join(dir, "result.json");
			await writeFile(schemaFile, JSON.stringify(REVIEW_SCHEMA));
			const { model, reasoningEffort } = this.options;
			const exit = await this.run(
				root,
				buildReviewPrompt(request),
				[
					"exec",
					"--sandbox",
					"read-only",
					"-c",
					'approval_policy="never"',
					...(reasoningEffort
						? ["-c", `model_reasoning_effort="${reasoningEffort}"`]
						: []),
					...(model ? ["-m", model] : []),
					"--cd",
					root,
					"--ephemeral",
					"--color",
					"never",
					"--output-schema",
					schemaFile,
					"--output-last-message",
					outFile,
					"-",
				],
				this.timeoutMs,
			);
			if (exit.code !== 0) {
				const tail = stderrTail(exit.stderr);
				const how = exit.signal
					? `killed by ${exit.signal}`
					: `exited with code ${exit.code}`;
				const hint = AUTH_ERROR.test(tail) ? `\n${LOGIN_HINT}` : "";
				throw new Error(`codex ${how}${tail ? `: ${tail}` : ""}${hint}`);
			}
			let raw: string;
			try {
				raw = await readFile(outFile, "utf8");
			} catch {
				throw new Error("codex wrote no review result");
			}
			if (raw.trim() === "") throw new Error("codex returned an empty review");
			let data: unknown;
			try {
				data = JSON.parse(raw);
			} catch {
				const excerpt = raw.trim().slice(0, 200);
				throw new Error(`codex returned invalid JSON: ${excerpt}`);
			}
			try {
				return parseReviewResult(data);
			} catch (error) {
				throw new Error(
					`codex returned an invalid review: ${(error as Error).message}`,
				);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	/**
	 * Executable + argv, input on stdin; never a shell. Resolves with the exit
	 * status; rejects only when codex cannot run or misses the deadline.
	 */
	private run(
		cwd: string,
		input: string,
		args: string[],
		timeoutMs: number,
	): Promise<Exit> {
		const bin = this.bin;
		return new Promise((resolve, reject) => {
			// Own process group, so the deadline also kills whatever codex started.
			const child = spawn(bin, args, {
				cwd,
				stdio: ["pipe", "pipe", "pipe"],
				detached: true,
			});
			const killGroup = () => {
				try {
					if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			};
			// The hook being aborted must not orphan the detached codex group; the
			// review fails, so the host records it and the hook then exits.
			// ponytail: SIGKILL of the hook cannot be caught; codex then outlives it.
			const onAbort = (signal: NodeJS.Signals) =>
				finish(
					new Error(
						`codex review aborted (${signal}) — the change is NOT approved`,
					),
				);
			for (const s of ABORT_SIGNALS) process.on(s, onAbort);
			// Settles exactly once. The deadline does not wait for `close`: a
			// descendant holding a pipe open would delay it, and a result that
			// arrives after the deadline must not count.
			let settled = false;
			const finish = (outcome: Error | Exit) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				for (const s of ABORT_SIGNALS) process.removeListener(s, onAbort);
				killGroup();
				child.stdout.destroy();
				child.stderr.destroy();
				if (outcome instanceof Error) reject(outcome);
				else resolve(outcome);
			};
			// Own timer rather than spawn's `timeout`: that one is only cleared on
			// exit, so a spawn error (missing binary) would keep the hook alive.
			const timer = setTimeout(() => {
				const tail = stderrTail(stderr);
				finish(
					new Error(
						`codex timed out after ${duration(timeoutMs)} — raise CCCR_CODEX_TIMEOUT_MS if reviews need longer${tail ? `: ${tail}` : ""}`,
					),
				);
			}, timeoutMs);
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout = (stdout + chunk).slice(-OUTPUT_TAIL);
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				stderr = (stderr + chunk).slice(-OUTPUT_TAIL);
			});
			// Codex may exit before reading stdin; that surfaces as exit status.
			child.stdin.on("error", () => {});
			child.stdin.end(input);
			child.on("error", (error: NodeJS.ErrnoException) => {
				finish(
					new Error(
						error.code === "ENOENT"
							? `codex executable not found: ${bin} — install the Codex CLI or set CCCR_CODEX_BIN`
							: `cannot run codex: ${error.message}`,
					),
				);
			});
			child.on("close", (code, signal) =>
				finish({ code, signal, stdout, stderr }),
			);
		});
	}
}
