export const VERDICTS = [
	"APPROVED",
	"CHANGES_REQUESTED",
	"NEEDS_HUMAN",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export const SEVERITIES = ["high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
	id: string;
	severity: Severity;
	file?: string;
	line?: number;
	message: string;
}

/** One-line human/agent readable form, e.g. `CCC-001 [high] a.ts:3: msg`. */
export function formatFinding(f: Finding): string {
	const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : "";
	return `${f.id} [${f.severity}]${where}: ${f.message}`;
}

export interface ReviewResult {
	verdict: Verdict;
	summary: string;
	findings: Finding[];
}

export interface GitStatusEntry {
	/** Two-letter porcelain v1 status code, e.g. " M", "A ", "??", "R ". */
	code: string;
	path: string;
	/** Source path of a rename/copy. */
	origPath?: string;
}

export interface GitBaseline {
	root: string;
	/** null in a repository without commits. */
	headSha: string | null;
	/** null on detached HEAD. */
	branch: string | null;
	status: GitStatusEntry[];
}

export interface ReviewRequest {
	taskId: string;
	/** 1-based round being reviewed. */
	round: number;
	baseline: GitBaseline;
	previous?: ReviewResult;
	context?: ReviewContext;
}

/** Writer-side context the host can reliably supply. Never invented. */
export interface ReviewContext {
	/** Original user task. */
	task?: string;
	/** Writer's implementation report (e.g. its last message). */
	report?: string;
}

export interface Reviewer {
	/** Must reject on any infrastructure failure; never fabricate a result. */
	review(request: ReviewRequest): Promise<ReviewResult>;
	/** Optional fast readiness check (installed, authenticated) before activation. */
	check?(cwd: string): Promise<void>;
	/** Optional one-line description of the reviewer and its settings. */
	describe?(): string;
}

export class InvalidReviewResultError extends Error {
	override name = "InvalidReviewResultError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFinding(value: unknown, index: number): Finding {
	const fail = (why: string) => {
		throw new InvalidReviewResultError(`findings[${index}]: ${why}`);
	};
	if (!isRecord(value)) return fail("not an object");
	const { id, severity, file, line, message } = value;
	if (typeof id !== "string" || id === "") return fail("missing id");
	if (!SEVERITIES.includes(severity as Severity))
		return fail(`invalid severity ${JSON.stringify(severity)}`);
	if (typeof message !== "string" || message === "")
		return fail("missing message");
	if (file !== undefined && file !== null && typeof file !== "string")
		return fail("file must be a string");
	if (
		line !== undefined &&
		line !== null &&
		!(Number.isInteger(line) && (line as number) > 0)
	)
		return fail("line must be a positive integer");

	const finding: Finding = { id, severity: severity as Severity, message };
	if (typeof file === "string") finding.file = file;
	if (typeof line === "number") finding.line = line;
	return finding;
}

/** Strictly validates untrusted reviewer output. Throws on any mismatch. */
export function parseReviewResult(value: unknown): ReviewResult {
	if (!isRecord(value))
		throw new InvalidReviewResultError("result is not an object");
	const { verdict, summary, findings } = value;
	if (!VERDICTS.includes(verdict as Verdict))
		throw new InvalidReviewResultError(
			`invalid verdict ${JSON.stringify(verdict)}`,
		);
	if (typeof summary !== "string")
		throw new InvalidReviewResultError("summary must be a string");
	if (!Array.isArray(findings))
		throw new InvalidReviewResultError("findings must be an array");
	const parsed = findings.map(parseFinding);
	if (verdict === "CHANGES_REQUESTED" && parsed.length === 0)
		throw new InvalidReviewResultError(
			"CHANGES_REQUESTED requires at least one finding",
		);
	return { verdict: verdict as Verdict, summary, findings: parsed };
}
