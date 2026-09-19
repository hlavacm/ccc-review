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
