import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ReviewRequest } from "../../src/core/types.ts";
import { captureBaseline } from "../../src/git.ts";
import {
	CodexReviewer,
	type CodexReviewerOptions,
} from "../../src/reviewers/codex.ts";
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
			nextFindingNumber: 1,
			context: { task: "make a 2", report: "set a to 2" },
		};
	});
	afterEach(async () => {
		await repo.dispose();
		await codex?.dispose();
		codex = undefined;
	});

	async function review(
		step: FakeCodexStep,
		timeoutMs = 10_000,
		options: CodexReviewerOptions = {},
	) {
		codex = await FakeCodex.create(step);
		return new CodexReviewer({ bin: codex.bin, timeoutMs, ...options }).review(
			request,
		);
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
		request.nextFindingNumber = 5;
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

	describe("login preflight", () => {
		// Regression: an unauthenticated `codex exec` does not fail, it retries
		// the 401 ("Reconnecting... waiting for network") until the 20 min
		// timeout, so the Stop hook hung. `codex login status` fails fast.
		it("not logged in fails fast with a login hint and never runs exec", async () => {
			codex = await FakeCodex.create({ output: approved() });
			await codex.login({ exit: 1, stdout: "Not logged in\n" });
			const started = Date.now();
			await assert.rejects(
				new CodexReviewer({ bin: codex.bin, timeoutMs: 60_000 }).review(
					request,
				),
				/Codex is not logged in — run `codex login`/,
			);
			assert.ok(Date.now() - started < 10_000);
			assert.equal((await codex.calls()).length, 0);
			assert.equal(await codex.loginCalls(), 1);
		});

		it("runs before every review when logged in", async () => {
			await review({ output: approved() });
			assert.equal(await codex?.loginCalls(), 1);
			assert.equal((await codex?.calls())?.length, 1);
		});

		it("is skipped when CODEX_API_KEY authenticates exec", async () => {
			codex = await FakeCodex.create({ output: approved() });
			await codex.login({ exit: 1, stdout: "Not logged in\n" });
			const result = await new CodexReviewer({
				bin: codex.bin,
				env: { CODEX_API_KEY: "sk-test" },
			}).review(request);
			assert.equal(result.verdict, "APPROVED");
			assert.equal(await codex.loginCalls(), 0);
		});

		// Regression: with CODEX_API_KEY the whole check was skipped, so a
		// missing codex binary still let `on` enable review.
		it("with CODEX_API_KEY a missing binary is still reported", async () => {
			await assert.rejects(
				new CodexReviewer({
					bin: join(repo.root, "nope"),
					env: { CODEX_API_KEY: "sk-test" },
				}).check(repo.root),
				/codex executable not found/,
			);
			codex = await FakeCodex.create();
			await new CodexReviewer({
				bin: codex.bin,
				env: { CODEX_API_KEY: "sk-test" },
			}).check(repo.root);
			assert.equal(await codex.loginCalls(), 0);
			assert.equal((await codex.calls()).length, 0);
		});

		it("a hanging login check is bounded by the timeout", async () => {
			codex = await FakeCodex.create({ output: approved() });
			await codex.login({ exit: 0, sleepMs: 30_000 });
			await assert.rejects(
				new CodexReviewer({ bin: codex.bin, timeoutMs: 500 }).review(request),
				/timed out after 500 ms/,
			);
			assert.equal((await codex.calls()).length, 0);
		});

		it("check() reports a missing binary and a missing login", async () => {
			await assert.rejects(
				new CodexReviewer({ bin: join(repo.root, "nope") }).check(),
				/codex executable not found: .*nope — install the Codex CLI or set CCC_REVIEW_CODEX_BIN/,
			);
			codex = await FakeCodex.create();
			await new CodexReviewer({ bin: codex.bin }).check();
			await codex.login({ exit: 1, stdout: "Not logged in\n" });
			await assert.rejects(
				new CodexReviewer({ bin: codex.bin }).check(),
				/not logged in/,
			);
		});
	});

	describe("actionable error messages", () => {
		it("an auth failure during exec gets a login hint", async () => {
			await assert.rejects(
				review({
					exit: 1,
					stderr:
						"ERROR codex_api: failed to connect: HTTP error: 401 Unauthorized\n",
				}),
				/exited with code 1: .*401 Unauthorized[\s\S]*run `codex login`/,
			);
		});

		it("only the last stderr lines are kept", async () => {
			const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
			await assert.rejects(
				review({ exit: 2, stderr: `${lines.join("\n")}\n` }),
				(error: Error) => {
					assert.match(error.message, /line 49$/);
					assert.doesNotMatch(error.message, /line 39\b/);
					return true;
				},
			);
		});

		it("invalid JSON shows an excerpt of the output", async () => {
			await assert.rejects(
				review({ rawOutput: `Sure! Here is my review: ${"z".repeat(1000)}` }),
				(error: Error) => {
					assert.match(error.message, /invalid JSON: Sure! Here is my review/);
					assert.ok(error.message.length < 400);
					return true;
				},
			);
		});

		it("a timeout in whole minutes names the setting to raise", async () => {
			const reviewer = new CodexReviewer({ timeoutMs: 20 * 60_000 });
			assert.equal(
				reviewer.describe(),
				"codex (bin codex, timeout 20 min, model default, reasoning default)",
			);
			await assert.rejects(
				review({ sleepMs: 30_000 }, 500),
				/timed out after 500 ms — raise CCC_REVIEW_CODEX_TIMEOUT_MS/,
			);
		});
	});

	describe("model options", () => {
		it("passes model and reasoning effort only when configured", async () => {
			await review({ output: approved() });
			let [call] = (await codex?.calls()) ?? [];
			assert.ok(!call?.argv.includes("-m"));
			assert.ok(
				!call?.argv.some((a) => a.startsWith("model_reasoning_effort")),
			);
			await codex?.dispose();

			await review({ output: approved() }, 10_000, {
				model: "gpt-test",
				reasoningEffort: "high",
			});
			[call] = (await codex?.calls()) ?? [];
			const argv = call?.argv ?? [];
			assert.equal(argv[argv.indexOf("-m") + 1], "gpt-test");
			assert.ok(argv.includes('model_reasoning_effort="high"'));
			assert.equal(argv.at(-1), "-");
		});
	});
});
