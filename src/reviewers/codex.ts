import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseReviewResult,
	type Reviewer,
	type ReviewRequest,
	type ReviewResult,
} from "../core/types.ts";
import { duration, type Exit, runProcess, stderrTail } from "./process.ts";
import { buildReviewPrompt, REVIEW_SCHEMA } from "./prompt.ts";

export { buildReviewPrompt, REVIEW_SCHEMA };

export const DEFAULT_CODEX_TIMEOUT_MS = 20 * 60 * 1000;

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

const LOGIN_HINT = "Codex is not logged in — run `codex login`";
const AUTH_ERROR = /401 Unauthorized|not logged in|codex login/i;
/** `login status` is local; it never needs the full review deadline. */
const LOGIN_TIMEOUT_MS = 60_000;

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
		const dir = await mkdtemp(join(tmpdir(), "ccc-review-codex-"));
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

	private run(
		cwd: string,
		input: string,
		args: string[],
		timeoutMs: number,
	): Promise<Exit> {
		return runProcess({
			name: "codex",
			bin: this.bin,
			args,
			cwd,
			input,
			timeoutMs,
			missingHint: "install the Codex CLI or set CCC_REVIEW_CODEX_BIN",
			timeoutSetting: "CCC_REVIEW_CODEX_TIMEOUT_MS",
		});
	}
}
