import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runReviewRound } from "../../src/core/review-loop.ts";
import { createTaskState, loadState, saveState } from "../../src/core/state.ts";
import { captureBaseline } from "../../src/git.ts";
import {
	approved,
	changesRequested,
	FakeReviewer,
} from "../helpers/fake-reviewer.ts";
import { makeTempDir, removeDir } from "../helpers/temp-dir.ts";
import { TemporaryGitRepository } from "../helpers/temp-git-repo.ts";

// Real git + real state files + real loop; only the reviewer is faked.
describe("core workflow", () => {
	let repo: TemporaryGitRepository;
	let stateDir: string;
	beforeEach(async () => {
		repo = await TemporaryGitRepository.create();
		stateDir = join(await makeTempDir(), "cccr");
	});
	afterEach(async () => {
		await repo.dispose();
		await removeDir(join(stateDir, ".."));
	});

	/** One writer completion: load → review round → persist. */
	async function complete(taskId: string, reviewer: FakeReviewer) {
		const state = await loadState(stateDir, taskId);
		assert.ok(state);
		const result = await runReviewRound(state, reviewer);
		await saveState(stateDir, result.state);
		return result.outcome;
	}

	it("activation → changes requested → writer fixes → approval", async () => {
		await repo.commitFile("app.ts", "export const x = 1;\n");
		await repo.write("preexisting.txt", "dirty before activation\n");

		const baseline = await captureBaseline(repo.root);
		const task = createTaskState({
			writer: "claude",
			reviewer: "codex",
			baseline,
		});
		await saveState(stateDir, task);

		await repo.write("app.ts", "export const x = 2;\n"); // writer works
		const reviewer = new FakeReviewer(changesRequested(), approved());
		assert.equal(await complete(task.taskId, reviewer), "changes_requested");
		assert.equal((await loadState(stateDir, task.taskId))?.round, 1);

		await repo.write("app.ts", "export const x = 3;\n"); // writer fixes
		assert.equal(await complete(task.taskId, reviewer), "approved");

		const final = await loadState(stateDir, task.taskId);
		assert.equal(final?.active, false);
		assert.equal(final?.round, 2);
		assert.equal(final?.lastResult?.verdict, "APPROVED");
		// Baseline recorded at activation, including pre-existing dirty state.
		assert.deepEqual(final?.baseline.status, [
			{ code: "??", path: "preexisting.txt" },
		]);
		assert.equal(reviewer.requests[0]?.baseline.root, repo.root);

		// Further completions after approval never re-run the reviewer.
		assert.equal(await complete(task.taskId, reviewer), "inactive");
		assert.equal(reviewer.requests.length, 2);
	});

	it("persisted reviewer failure stays unapproved across reloads", async () => {
		await repo.commitFile("app.ts", "1\n");
		const task = createTaskState({
			writer: "claude",
			reviewer: "codex",
			baseline: await captureBaseline(repo.root),
		});
		await saveState(stateDir, task);
		const reviewer = new FakeReviewer(new Error("codex: not authenticated"));
		assert.equal(await complete(task.taskId, reviewer), "reviewer_error");

		const final = await loadState(stateDir, task.taskId);
		assert.equal(final?.active, false);
		assert.equal(final?.lastResult, undefined);
		assert.equal(final?.lastError, "codex: not authenticated");
	});
});
