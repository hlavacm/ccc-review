import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReviewRequest } from "../../src/core/types.ts";
import { buildReviewPrompt, REVIEW_SCHEMA } from "../../src/reviewers/codex.ts";
import { changesRequested, finding } from "../helpers/fake-reviewer.ts";

const request = (extra: Partial<ReviewRequest> = {}): ReviewRequest => ({
	taskId: "t",
	round: 1,
	baseline: { root: "/r", headSha: "abc123", branch: "main", status: [] },
	...extra,
});

describe("buildReviewPrompt", () => {
	it("states the read-only, material-issues-only contract and baseline", () => {
		const p = buildReviewPrompt(request());
		assert.match(p, /Do NOT modify, create or delete any files/);
		assert.match(p, /Do not commit, stash, reset, checkout/);
		assert.match(p, /Report only material issues/);
		assert.match(p, /Repository root: \/r/);
		assert.match(p, /HEAD at activation: abc123/);
		assert.match(p, /Branch at activation: main/);
		assert.match(p, /clean when review was activated/);
		assert.match(p, /Number new findings CCC-001/);
		assert.match(p, /JSON matching the provided output schema/);
	});

	it("does not invent task, plan or report when absent", () => {
		const p = buildReviewPrompt(request());
		assert.doesNotMatch(p, /Original task:/);
		assert.doesNotMatch(p, /implementation report:/);
		assert.doesNotMatch(p, /plan:/i);
		assert.doesNotMatch(p, /Previous findings/);
	});

	it("includes task and report when supplied", () => {
		const p = buildReviewPrompt(
			request({ context: { task: "TASK", report: "REPORT" } }),
		);
		assert.match(p, /Original task:\nTASK/);
		assert.match(p, /Writer's implementation report:\nREPORT/);
	});

	it("warns about pre-existing dirty state, including renames and odd names", () => {
		const p = buildReviewPrompt(
			request({
				baseline: {
					root: "/r",
					headSha: null,
					branch: null,
					status: [
						{ code: "??", path: "a file.txt" },
						{ code: "R ", path: "new.ts", origPath: "old.ts" },
					],
				},
			}),
		);
		assert.match(p, /ALREADY dirty/);
		assert.match(p, / {2}\?\? a file\.txt/);
		assert.match(p, /R {2}old\.ts -> new\.ts/);
		assert.match(p, /\(no commits\)/);
		assert.match(p, /\(detached HEAD\)/);
	});

	it("carries previous findings and continues ID numbering", () => {
		const p = buildReviewPrompt(
			request({
				round: 2,
				previous: changesRequested(
					{ ...finding("CCC-002", "leak"), file: "a.ts", line: 7 },
					finding("custom", "x"),
				),
			}),
		);
		assert.match(p, /CCC-002 \[high\] a\.ts:7: leak/);
		assert.match(p, /Reuse the same ID/);
		assert.match(p, /Number new findings CCC-003, CCC-004/);
	});
});

describe("buildReviewPrompt stabilization", () => {
	// Regression: the prompt only pointed at `git diff` (working tree), so
	// changes the writer had already committed were invisible to Codex.
	it("reviews everything since the activation commit, including new commits", () => {
		const p = buildReviewPrompt(request());
		assert.match(p, /`git diff abc123`/);
		assert.match(p, /`git log --oneline abc123\.\.HEAD`/);
		assert.match(p, /untracked/);
	});

	it("falls back to status and log when there were no commits", () => {
		const p = buildReviewPrompt(
			request({
				baseline: { root: "/r", headSha: null, branch: null, status: [] },
			}),
		);
		assert.doesNotMatch(p, /git diff null/);
		assert.match(p, /no commits at activation/);
		// Regression: only `git diff --cached` was suggested, which hides the
		// content of commits the writer made after activation.
		assert.match(p, /`git log -p`/);
		assert.match(p, /`git diff HEAD`/);
	});

	it("caps the pre-existing dirty path list", () => {
		const status = Array.from({ length: 120 }, (_, i) => ({
			code: "??",
			path: `f${i}.txt`,
		}));
		const p = buildReviewPrompt(
			request({
				baseline: { root: "/r", headSha: "abc", branch: "m", status },
			}),
		);
		assert.match(p, /f49\.txt/);
		assert.doesNotMatch(p, /f50\.txt/);
		assert.match(p, /… and 70 more/);
	});

	it("keeps the most recent part of an oversized task and report", () => {
		const p = buildReviewPrompt(
			request({
				context: {
					task: `OLD${"t".repeat(20_000)}NEWTASK`,
					report: `START${"r".repeat(20_000)}ENDREPORT`,
				},
			}),
		);
		assert.match(p, /NEWTASK/);
		assert.match(p, /ENDREPORT/);
		assert.doesNotMatch(p, /OLD/);
		assert.doesNotMatch(p, /START/);
		assert.match(p, /\[… \d+ earlier characters omitted\]/);
		assert.ok(p.length < 30_000, `prompt is ${p.length} chars`);
	});

	it("leaves short context untouched", () => {
		const p = buildReviewPrompt(
			request({ context: { task: "T", report: "R" } }),
		);
		assert.doesNotMatch(p, /omitted/);
	});
});

describe("REVIEW_SCHEMA", () => {
	// Codex --output-schema uses strict structured outputs.
	function checkStrict(node: unknown, path: string): void {
		if (typeof node !== "object" || node === null) return;
		const n = node as Record<string, unknown>;
		if (n.type === "object") {
			assert.equal(
				n.additionalProperties,
				false,
				`${path}: additionalProperties`,
			);
			assert.deepEqual(
				[...(n.required as string[])].sort(),
				Object.keys(n.properties as object).sort(),
				`${path}: every property required`,
			);
		}
		for (const [k, v] of Object.entries(n)) checkStrict(v, `${path}.${k}`);
	}

	it("is strict-mode compatible", () => checkStrict(REVIEW_SCHEMA, "$"));

	it("matches the core verdicts and severities", () => {
		const s = REVIEW_SCHEMA.properties;
		assert.deepEqual(s.verdict.enum, [
			"APPROVED",
			"CHANGES_REQUESTED",
			"NEEDS_HUMAN",
		]);
		assert.deepEqual(s.findings.items.properties.severity.enum, [
			"high",
			"medium",
			"low",
		]);
	});
});

describe("buildReviewPrompt with collected changes (reviewer without a shell)", () => {
	it("embeds the changes and tells the reviewer not to run commands", () => {
		const p = buildReviewPrompt(request(), { changes: "DIFF-TEXT" });
		assert.match(p, /you cannot run commands/);
		assert.match(p, /Read the changed and untracked files/);
		assert.match(p, /Git changes since activation:\nDIFF-TEXT$/);
		assert.doesNotMatch(p, /git diff abc123/);
		// The rest of the contract is unchanged.
		assert.match(p, /Do NOT modify, create or delete any files/);
		assert.match(p, /Number new findings CCC-001/);
	});

	it("without changes the reviewer inspects Git itself, as before", () => {
		assert.equal(
			buildReviewPrompt(request(), {}),
			buildReviewPrompt(request()),
		);
		assert.doesNotMatch(buildReviewPrompt(request()), /cannot run commands/);
	});
});

describe("buildReviewPrompt language", () => {
	it("answers in the language of the original task first", () => {
		// A Czech task with an English report: the task decides.
		const p = buildReviewPrompt(
			request({ context: { task: "Přidej násobení", report: "Done." } }),
		);
		assert.match(
			p,
			/Write the summary and finding messages in the language of the original task;/,
		);
	});

	it("uses the writer's report when there is no task", () => {
		const p = buildReviewPrompt(request({ context: { report: "Hotovo." } }));
		assert.match(p, /in the language of the writer's report;/);
		assert.doesNotMatch(p, /original task/);
	});

	it("falls back to English when there is neither task nor report", () => {
		const p = buildReviewPrompt(request());
		assert.match(p, /Write the summary and finding messages in English/);
		assert.doesNotMatch(p, /in the language of/);
	});
});
