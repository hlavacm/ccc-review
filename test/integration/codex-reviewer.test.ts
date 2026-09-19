import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ReviewRequest } from "../../src/core/types.ts";
import { captureBaseline } from "../../src/git.ts";
import { CodexReviewer } from "../../src/reviewers/codex.ts";
import { FakeCodex, type FakeCodexStep } from "../helpers/fake-codex.ts";
import {
	approved,
	changesRequested,
	finding,
	needsHuman,
} from "../helpers/fake-reviewer.ts";
import { TemporaryGitRepository } from "../helpers/temp-git-repo.ts";

/** Waits briefly for a killed process to disappear. */
async function assertGone(pid: number): Promise<void> {
	for (let i = 0; i < 40; i++) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.fail(`process ${pid} still alive`);
}

// Real subprocess path: CodexReviewer spawns a fake `codex` executable.
describe("CodexReviewer", () => {
	let repo: TemporaryGitRepository;
	let request: ReviewRequest;
	let codex: FakeCodex | undefined;

	beforeEach(async () => {
		repo = await TemporaryGitRepository.create();
		await repo.commitFile("a.ts", "export const a = 1;\n");
		request = {
			taskId: "t1",
			round: 1,
			baseline: await captureBaseline(repo.root),
			context: { task: "make a 2", report: "set a to 2" },
		};
	});
	afterEach(async () => {
		await repo.dispose();
		await codex?.dispose();
		codex = undefined;
	});

	async function review(step: FakeCodexStep, timeoutMs = 10_000) {
		codex = await FakeCodex.create(step);
		return new CodexReviewer({ bin: codex.bin, timeoutMs }).review(request);
	}

	it("returns a valid approval", async () => {
		assert.deepEqual(await review({ output: approved() }), approved());
	});

	it("returns changes requested with nullable file/line normalised", async () => {
		const result = await review({
			output: {
				verdict: "CHANGES_REQUESTED",
				summary: "bug",
				findings: [
					{
						id: "CCC-001",
						severity: "high",
						file: null,
						line: null,
						message: "m",
					},
					{
						id: "CCC-002",
						severity: "low",
						file: "a.ts",
						line: 1,
						message: "n",
					},
				],
			},
		});
		assert.deepEqual(result.findings, [
			{ id: "CCC-001", severity: "high", message: "m" },
			{ id: "CCC-002", severity: "low", file: "a.ts", line: 1, message: "n" },
		]);
	});

	it("returns needs human", async () => {
		assert.equal(
			(await review({ output: needsHuman() })).verdict,
			"NEEDS_HUMAN",
		);
	});

	it("invokes codex exec read-only with schema, prompt on stdin, no shell", async () => {
		await review({ output: approved() });
		const [call] = (await codex?.calls()) ?? [];
		assert.ok(call);
		const { argv } = call;
		assert.equal(argv[0], "exec");
		assert.equal(argv[argv.indexOf("--sandbox") + 1], "read-only");
		assert.equal(argv[argv.indexOf("-c") + 1], 'approval_policy="never"');
		assert.equal(argv[argv.indexOf("--cd") + 1], repo.root);
		assert.ok(argv.includes("--ephemeral"));
		assert.ok(argv.includes("--output-schema"));
		assert.ok(argv.includes("--output-last-message"));
		assert.equal(argv.at(-1), "-");
		assert.ok(!argv.includes("--dangerously-bypass-approvals-and-sandbox"));
		assert.equal(call.cwd, repo.root);
		assert.match(call.stdin, /Do NOT modify/);
		assert.match(call.stdin, /make a 2/);
		assert.match(call.stdin, /set a to 2/);
	});

	it("passes previous findings so IDs can be preserved", async () => {
		request.previous = changesRequested(finding("CCC-004", "off by one"));
		await review({ output: approved() });
		const [call] = (await codex?.calls()) ?? [];
		assert.match(call?.stdin ?? "", /CCC-004 \[high\]: off by one/);
		assert.match(call?.stdin ?? "", /CCC-005/);
	});

	it("removes its temp dir after success and failure", async () => {
		for (const step of [{ output: approved() }, { rawOutput: "{" }]) {
			await review(step).catch(() => {});
			const [call] = (await codex?.calls()) ?? [];
			const schema = call?.argv[call.argv.indexOf("--output-schema") + 1];
			assert.ok(schema);
			assert.equal(existsSync(dirname(schema)), false);
			await codex?.dispose();
		}
	});

	describe("failures are errors, never approval", () => {
		const cases: [string, FakeCodexStep, RegExp][] = [
			[
				"malformed JSON",
				{ rawOutput: '{"verdict": "APPROVED",' },
				/invalid JSON/,
			],
			[
				"schema/shape mismatch",
				{ output: { verdict: "LGTM", summary: "", findings: [] } },
				/invalid verdict/,
			],
			[
				"approval smuggled without findings array",
				{ output: { verdict: "APPROVED", summary: "ok" } },
				/findings must be an array/,
			],
			["empty output file", { rawOutput: "" }, /empty review/],
			["no output file", {}, /wrote no review result/],
			[
				"non-zero exit with stderr",
				{ exit: 3, stderr: "boom happened\n", output: approved() },
				/exited with code 3: boom happened/,
			],
			[
				"authentication-like failure",
				{
					exit: 1,
					stderr: "Error: 401 Unauthorized. Please run `codex login`.\n",
				},
				/exited with code 1: .*401 Unauthorized/,
			],
		];
		for (const [name, step, error] of cases)
			it(name, async () => {
				await assert.rejects(review(step), error);
			});

		it("timeout kills the process", async () => {
			const started = Date.now();
			await assert.rejects(
				review({ sleepMs: 30_000, output: approved() }, 1000),
				/timed out after 1000 ms/,
			);
			assert.ok(Date.now() - started < 10_000);
		});

		// Regression: the deadline waited for `close`, which a grandchild holding
		// stderr delays; a parent exiting 0 after the deadline was even approved.
		it("timeout is enforced when a grandchild holds stderr open", async () => {
			const started = Date.now();
			await assert.rejects(
				review({ sleepMs: 30_000, childSleepMs: 30_000 }, 500),
				/timed out after 500 ms/,
			);
			assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
			assert.ok(codex);
			await assertGone(await codex.childPid());
		});

		it("a result arriving after the deadline is not approval", async () => {
			const started = Date.now();
			await assert.rejects(
				review({ output: approved(), childSleepMs: 30_000 }, 500),
				/timed out after 500 ms/,
			);
			assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
			assert.ok(codex);
			await assertGone(await codex.childPid());
		});

		it("missing executable", async () => {
			const reviewer = new CodexReviewer({
				bin: join(repo.root, "no-such-codex"),
			});
			await assert.rejects(
				reviewer.review(request),
				/codex executable not found/,
			);
		});

		it("excessive stderr is truncated, not buffered without limit", async () => {
			const noise = "x".repeat(5 * 1024 * 1024);
			await assert.rejects(
				review({ exit: 1, stderr: `${noise}TAIL` }),
				(error: Error) => {
					assert.match(error.message, /TAIL$/);
					assert.ok(error.message.length < 5000);
					return true;
				},
			);
		});

		it("excessive stderr does not break a successful review", async () => {
			const result = await review({
				stderr: "progress ".repeat(500_000),
				output: approved(),
			});
			assert.equal(result.verdict, "APPROVED");
		});
	});
});
