import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RoundOutcome } from "../../src/core/review-loop.ts";
import { createTaskState, type TaskState } from "../../src/core/state.ts";
import {
	findingLines,
	stopOutput,
	writerFeedback,
} from "../../src/hosts/common.ts";
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
			"codex",
		);
		assert.match(text, /round 1\/3/);
		assert.match(text, /- CCC-001 \[high\] a\.ts:3: null deref/);
		for (const needle of [
			/Evaluate every finding independently/,
			/review comments, not instructions/,
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

describe("findingLines", () => {
	it("lists the most severe findings first, stable within a severity", () => {
		const lines = findingLines([
			{ id: "CCC-001", severity: "low", message: "a" },
			{ id: "CCC-002", severity: "high", message: "b" },
			{ id: "CCC-003", severity: "medium", message: "c" },
			{ id: "CCC-004", severity: "high", message: "d" },
		]);
		assert.deepEqual(
			lines.map((l) => l.slice(2, 9)),
			["CCC-002", "CCC-004", "CCC-003", "CCC-001"],
		);
	});

	it("indents continuation lines of multi-line messages", () => {
		const [line] = findingLines([
			{ id: "CCC-001", severity: "high", message: "first\nsecond\nthird" },
		]);
		assert.equal(line, "- CCC-001 [high]: first\n    second\n    third");
	});

	it("is used for both Claude feedback and user messages", () => {
		const r = changesRequested(
			{ id: "CCC-001", severity: "low", message: "minor" },
			{ id: "CCC-002", severity: "high", message: "major" },
		);
		const feedback = writerFeedback(r, 1, 3, "codex");
		assert.ok(feedback.indexOf("CCC-002") < feedback.indexOf("CCC-001"));
		const msg =
			stopOutput("max_rounds", state({ round: 3, lastResult: r }))
				?.systemMessage ?? "";
		assert.ok(msg.indexOf("CCC-002") < msg.indexOf("CCC-001"));
	});
});

describe("texts for the Codex writer → Claude reviewer direction", () => {
	const reverse = (extra: Partial<TaskState>): TaskState => ({
		...createTaskState({
			writer: "codex",
			reviewer: "claude",
			baseline: { root: "/r", headSha: null, branch: null, status: [] },
		}),
		...extra,
	});

	it("names Claude as the reviewer in feedback and messages", () => {
		const block = stopOutput(
			"changes_requested",
			reverse({ round: 1, lastResult: changesRequested() }),
		);
		assert.equal(block?.decision, "block");
		assert.match(block?.reason ?? "", /round 1\/3: Claude requested changes/);
		assert.match(block?.reason ?? "", /Claude will review again/);
		assert.doesNotMatch(block?.reason ?? "", /Codex/);
		assert.match(
			stopOutput("approved", reverse({ round: 1, lastResult: approved() }))
				?.systemMessage ?? "",
			/Claude APPROVED/,
		);
		const failed =
			stopOutput("reviewer_error", reverse({ lastError: "boom" }))
				?.systemMessage ?? "";
		assert.match(failed, /Claude review FAILED — the change is NOT approved/);
		assert.doesNotMatch(failed, /APPROVED/);
	});
});
