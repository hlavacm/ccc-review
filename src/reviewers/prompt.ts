import { formatFinding, type ReviewRequest } from "../core/types.ts";

/**
 * Structured-output schema shared by both reviewer CLIs. OpenAI strict mode
 * needs every property required and optional values nullable.
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

export interface PromptOptions {
	/**
	 * The Git changes, collected by CCC Review, for a reviewer that cannot run
	 * commands. Absent: the reviewer inspects Git itself.
	 */
	changes?: string;
}

export function buildReviewPrompt(
	request: ReviewRequest,
	options: PromptOptions = {},
): string {
	const { baseline, context, previous } = request;
	const sha = baseline.headSha;
	const inspect =
		options.changes !== undefined
			? "Inspect the actual repository: the Git changes since activation are listed at the end of this prompt (you cannot run commands). Read the changed and untracked files and the surrounding code with your file tools"
			: `Inspect the actual repository and the Git changes yourself: ${
					sha
						? `\`git --no-optional-locks status\`, \`git diff ${sha}\` (everything since activation, including changes the writer committed), \`git log --oneline ${sha}..HEAD\` and new untracked files`
						: "`git --no-optional-locks status`, `git log -p` (the repository had no commits at activation, so every commit is the writer's), `git diff HEAD` (`git diff --cached` while there is still no commit) and untracked files"
				}. Read the surrounding code`;
	const lines = [
		"You are an independent code reviewer (CCC Review). Another coding agent (the writer) implemented a task in this repository. Review its changes.",
		"",
		"Rules:",
		"- Do NOT modify, create or delete any files. Do not commit, stash, reset, checkout or otherwise change Git state. You are read-only.",
		`- ${inspect}.`,
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
			context?.audit
				? "This is a one-off audit requested after the work was done. Review ALL uncommitted changes (staged, unstaged and untracked files); they are the writer's work:"
				: "The working tree was ALREADY dirty when review was activated. These changes may not belong to the writer; do not blame the writer for them unless the writer touched them:",
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
	const nextId = request.nextFindingNumber;
	lines.push(
		"",
		`Number new findings CCC-${String(nextId).padStart(3, "0")}, CCC-${String(nextId + 1).padStart(3, "0")}, …`,
		"Respond only with JSON matching the provided output schema. Use null for unknown file/line.",
		// The user reads the findings too: their task's language wins.
		`Write the summary and finding messages in ${
			context?.task
				? "the language of the original task"
				: context?.report
					? "the language of the writer's report"
					: "English"
		}; keep IDs, verdicts, code and paths as they are.`,
	);
	if (options.changes !== undefined)
		lines.push("", "Git changes since activation:", options.changes);
	return lines.join("\n");
}
