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
const STDERR_TAIL = 4000;

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

export function buildReviewPrompt(request: ReviewRequest): string {
	const { baseline, context, previous } = request;
	const lines = [
		"You are an independent code reviewer (CCC Review). Another coding agent (the writer) implemented a task in this repository. Review its changes.",
		"",
		"Rules:",
		"- Do NOT modify, create or delete any files. Do not commit, stash, reset, checkout or otherwise change Git state. You are read-only.",
		"- Inspect the actual repository and the relevant Git changes yourself (e.g. `git --no-optional-locks status`, `git diff`, `git diff --cached`, new untracked files), and read the surrounding code.",
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
			...baseline.status.map(
				(e) =>
					`  ${e.code} ${e.origPath === undefined ? "" : `${e.origPath} -> `}${e.path}`,
			),
		);
	} else {
		lines.push("", "The working tree was clean when review was activated.");
	}
	if (context?.task) lines.push("", "Original task:", context.task);
	if (context?.report)
		lines.push("", "Writer's implementation report:", context.report);
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

export class CodexReviewer implements Reviewer {
	private readonly options: { bin?: string; timeoutMs?: number };

	constructor(options: { bin?: string; timeoutMs?: number } = {}) {
		this.options = options;
	}

	async review(request: ReviewRequest): Promise<ReviewResult> {
		const dir = await mkdtemp(join(tmpdir(), "cccr-codex-"));
		try {
			const schemaFile = join(dir, "schema.json");
			const outFile = join(dir, "result.json");
			await writeFile(schemaFile, JSON.stringify(REVIEW_SCHEMA));
			await this.run(request.baseline.root, buildReviewPrompt(request), [
				"exec",
				"--sandbox",
				"read-only",
				"-c",
				'approval_policy="never"',
				"--cd",
				request.baseline.root,
				"--ephemeral",
				"--color",
				"never",
				"--output-schema",
				schemaFile,
				"--output-last-message",
				outFile,
				"-",
			]);
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
				throw new Error("codex returned invalid JSON");
			}
			return parseReviewResult(data);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	/** Executable + argv, prompt on stdin; never a shell. */
	private run(cwd: string, prompt: string, args: string[]): Promise<void> {
		const bin = this.options.bin ?? "codex";
		const timeoutMs = this.options.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
		return new Promise((resolve, reject) => {
			// Own process group, so the deadline also kills whatever codex started.
			const child = spawn(bin, args, {
				cwd,
				stdio: ["pipe", "ignore", "pipe"],
				detached: true,
			});
			const killGroup = () => {
				try {
					if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			};
			// Settles exactly once. The deadline does not wait for `close`: a
			// descendant holding stderr open would delay it, and a result that
			// arrives after the deadline must not count.
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				killGroup();
				child.stderr.destroy();
				if (error) reject(error);
				else resolve();
			};
			// Own timer rather than spawn's `timeout`: that one is only cleared on
			// exit, so a spawn error (missing binary) would keep the hook alive.
			const timer = setTimeout(() => {
				const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
				finish(new Error(`codex timed out after ${timeoutMs} ms${detail}`));
			}, timeoutMs);
			let stderr = "";
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				stderr = (stderr + chunk).slice(-STDERR_TAIL);
			});
			// Codex may exit before reading stdin; that surfaces as exit status.
			child.stdin.on("error", () => {});
			child.stdin.end(prompt);
			child.on("error", (error: NodeJS.ErrnoException) => {
				finish(
					new Error(
						error.code === "ENOENT"
							? `codex executable not found: ${bin}`
							: `cannot run codex: ${error.message}`,
					),
				);
			});
			child.on("close", (code, signal) => {
				if (code === 0) return finish();
				const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
				finish(
					new Error(
						signal
							? `codex killed by ${signal}${detail}`
							: `codex exited with code ${code}${detail}`,
					),
				);
			});
		});
	}
}
