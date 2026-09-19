import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runReviewRound } from "../../src/core/review-loop.ts";
import { createTaskState, type TaskState } from "../../src/core/state.ts";
import type { GitBaseline } from "../../src/core/types.ts";
import {
	approved,
	changesRequested,
	FakeReviewer,
	finding,
	needsHuman,
} from "../helpers/fake-reviewer.ts";

const baseline: GitBaseline = {
	root: "/repo",
	headSha: "abc",
	branch: "main",
	status: [],
};

const newState = (maxRounds?: number): TaskState =>
	createTaskState({
		writer: "claude",
		reviewer: "codex",
		baseline,
		...(maxRounds === undefined ? {} : { maxRounds }),
	});

describe("runReviewRound", () => {
	it("approval on first review finishes the task", async () => {
		const reviewer = new FakeReviewer(approved());
		const { state, outcome } = await runReviewRound(newState(), reviewer);
		assert.equal(outcome, "approved");
		assert.equal(state.active, false);
		assert.equal(state.round, 1);
		assert.deepEqual(state.lastResult, approved());
		assert.equal(reviewer.requests.length, 1);
		assert.equal(reviewer.requests[0]?.round, 1);
		assert.equal(reviewer.requests[0]?.previous, undefined);
	});

	it("changes requested then approval", async () => {
		const reviewer = new FakeReviewer(changesRequested(), approved());
		const first = await runReviewRound(newState(), reviewer);
		assert.equal(first.outcome, "changes_requested");
		assert.equal(first.state.active, true);
		assert.equal(first.state.round, 1);

		const second = await runReviewRound(first.state, reviewer);
		assert.equal(second.outcome, "approved");
		assert.equal(second.state.active, false);
		assert.equal(second.state.round, 2);
		// Previous findings are handed to the next round so IDs can be preserved.
		assert.deepEqual(reviewer.requests[1]?.previous, changesRequested());
		assert.equal(reviewer.requests[1]?.round, 2);
	});

	it("needs human stops the task without approval", async () => {
		const { state, outcome } = await runReviewRound(
			newState(),
			new FakeReviewer(needsHuman()),
		);
		assert.equal(outcome, "needs_human");
		assert.equal(state.active, false);
		assert.equal(state.lastResult?.verdict, "NEEDS_HUMAN");
	});

	it("terminates at max rounds (default 3) and never calls the reviewer again", async () => {
		const reviewer = new FakeReviewer(
			changesRequested(finding("CCC-001")),
			changesRequested(finding("CCC-001")),
			changesRequested(finding("CCC-001")),
			approved(), // must never be reached
		);
		let state = newState();
		const outcomes: string[] = [];
		for (let i = 0; i < 5; i++) {
			const r = await runReviewRound(state, reviewer);
			outcomes.push(r.outcome);
			state = r.state;
		}
		assert.deepEqual(outcomes, [
			"changes_requested",
			"changes_requested",
			"max_rounds",
			"inactive",
			"inactive",
		]);
		assert.equal(reviewer.requests.length, 3);
		assert.equal(state.round, 3);
		assert.equal(state.active, false);
		assert.equal(state.lastResult?.verdict, "CHANGES_REQUESTED");
	});

	it("honours a custom maxRounds", async () => {
		const reviewer = new FakeReviewer(changesRequested());
		const r = await runReviewRound(newState(1), reviewer);
		assert.equal(r.outcome, "max_rounds");
		assert.equal(r.state.active, false);
	});

	it("stops an active state whose round is already at the limit without calling the reviewer", async () => {
		const reviewer = new FakeReviewer(approved());
		const r = await runReviewRound({ ...newState(), round: 3 }, reviewer);
		assert.equal(r.outcome, "max_rounds");
		assert.equal(r.state.active, false);
		assert.equal(reviewer.requests.length, 0);
	});

	it("does nothing for an inactive task", async () => {
		const reviewer = new FakeReviewer(approved());
		const inactive = { ...newState(), active: false };
		const r = await runReviewRound(inactive, reviewer);
		assert.equal(r.outcome, "inactive");
		assert.equal(r.state, inactive);
		assert.equal(reviewer.requests.length, 0);
	});

	describe("reviewer failure is never approval", () => {
		const failures: [string, unknown][] = [
			["thrown error", new Error("codex exited with 1")],
			["undefined result", undefined],
			["lowercase verdict", { verdict: "approved", summary: "", findings: [] }],
			["verdict only", { verdict: "APPROVED" }],
			["string result", "APPROVED"],
			[
				"empty changes request",
				{ verdict: "CHANGES_REQUESTED", summary: "", findings: [] },
			],
		];
		for (const [name, step] of failures) {
			it(name, async () => {
				const { state, outcome } = await runReviewRound(
					newState(),
					new FakeReviewer(step),
				);
				assert.equal(outcome, "reviewer_error");
				assert.equal(state.active, false);
				assert.equal(state.round, 1);
				assert.equal(state.lastResult, undefined);
				assert.ok(state.lastError);
			});
		}

		it("keeps the previous result but does not approve on a later-round error", async () => {
			const reviewer = new FakeReviewer(
				changesRequested(),
				new Error("timeout"),
			);
			const first = await runReviewRound(newState(), reviewer);
			const second = await runReviewRound(first.state, reviewer);
			assert.equal(second.outcome, "reviewer_error");
			assert.equal(second.state.lastError, "timeout");
			assert.equal(second.state.lastResult?.verdict, "CHANGES_REQUESTED");
			assert.equal(second.state.active, false);
		});

		it("handles non-Error throws", async () => {
			const reviewer: FakeReviewer = new FakeReviewer();
			reviewer.review = () => Promise.reject("boom");
			const r = await runReviewRound(newState(), reviewer);
			assert.equal(r.outcome, "reviewer_error");
			assert.equal(r.state.lastError, "boom");
		});
	});

	it("clears a stale lastError on a successful round", async () => {
		const r = await runReviewRound(
			{ ...newState(), lastError: "old" },
			new FakeReviewer(changesRequested()),
		);
		assert.equal(r.state.lastError, undefined);
		assert.equal("lastError" in r.state, false);
	});

	it("does not mutate the input state", async () => {
		const input = newState();
		const snapshot = structuredClone(input);
		await runReviewRound(input, new FakeReviewer(changesRequested()));
		await runReviewRound(input, new FakeReviewer(new Error("x")));
		assert.deepEqual(input, snapshot);
	});
});
