import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RoundOutcome } from "../../src/core/review-loop.ts";
import { createTaskState, type TaskState } from "../../src/core/state.ts";
import {
	stopOutput,
	writerFeedback,
} from "../../src/hosts/claude-code/hooks.ts";
import {
	approved,
	changesRequested,
	finding,
	needsHuman,
} from "../helpers/fake-reviewer.ts";

const state = (extra: Partial<TaskState>): TaskState => ({
	...createTaskState({
		writer: "claude",
		reviewer: "codex",
		baseline: { root: "/r", headSha: null, branch: null, status: [] },
	}),
	...extra,
});

describe("writerFeedback", () => {
	it("lists findings and tells Claude how to respond", () => {
		const text = writerFeedback(
			changesRequested({
				...finding("CCC-001", "null deref"),
				file: "a.ts",
				line: 3,
			}),
			1,
			3,
		);
		assert.match(text, /round 1\/3/);
		assert.match(text, /- CCC-001 \[high\] a\.ts:3: null deref/);
		for (const needle of [
			/Evaluate every finding independently/,
			/Fix valid findings/,
			/Reject invalid findings with concrete reasoning/,
			/Run relevant verification/,
			/updated implementation report that keeps the finding IDs/,
			/CCC-001: fixed/,
			/CCC-002: rejected/,
		])
			assert.match(text, needle);
	});
});

describe("stopOutput", () => {
	it("blocks only on changes_requested", () => {
		const cases: [RoundOutcome, Partial<TaskState>][] = [
			["approved", { round: 1, lastResult: approved() }],
			["needs_human", { round: 1, lastResult: needsHuman() }],
			["max_rounds", { round: 3, lastResult: changesRequested() }],
			["reviewer_error", { round: 1, lastError: "boom" }],
		];
		for (const [outcome, extra] of cases) {
			const out = stopOutput(outcome, state(extra));
			assert.equal(out?.decision, undefined, outcome);
			assert.ok(out?.systemMessage, outcome);
		}
		assert.equal(stopOutput("inactive", state({})), undefined);
		const block = stopOutput(
			"changes_requested",
			state({ round: 1, lastResult: changesRequested() }),
		);
		assert.equal(block?.decision, "block");
		assert.match(block?.reason ?? "", /CCC-001/);
	});

	it("never presents a reviewer error as approval", () => {
		const out = stopOutput("reviewer_error", state({ lastError: "timeout" }));
		assert.doesNotMatch(out?.systemMessage ?? "", /APPROVED/);
		assert.match(out?.systemMessage ?? "", /NOT approved/);
	});

	it("reports max-rounds findings to the user", () => {
		const out = stopOutput(
			"max_rounds",
			state({
				round: 3,
				lastResult: changesRequested(finding("CCC-009", "still broken")),
			}),
		);
		assert.match(out?.systemMessage ?? "", /CCC-009 \[high\]: still broken/);
	});
});
