import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ReviewRequest } from "../../src/core/types.ts";
import { captureBaseline } from "../../src/git.ts";
import {
	ClaudeReviewer,
	type ClaudeReviewerOptions,
} from "../../src/reviewers/claude.ts";
import { STDOUT_LIMIT } from "../../src/reviewers/process.ts";
import { REVIEW_SCHEMA } from "../../src/reviewers/prompt.ts";
import { FakeClaude, type FakeClaudeStep } from "../helpers/fake-claude.ts";
import {
	approved,
	changesRequested,
	finding,
	needsHuman,
} from "../helpers/fake-reviewer.ts";
import { TemporaryGitRepository } from "../helpers/temp-git-repo.ts";

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

// Real subprocess path: ClaudeReviewer spawns a fake `claude` executable.
describe("ClaudeReviewer", () => {
	let repo: TemporaryGitRepository;
	let request: ReviewRequest;
	let claude: FakeClaude | undefined;

	beforeEach(async () => {
		repo = await TemporaryGitRepository.create();
		await repo.commitFile("a.ts", "export const a = 1;\n");
		request = {
			taskId: "t1",
			round: 1,
			baseline: await captureBaseline(repo.root),
			context: { task: "make a 2", report: "set a to 2" },
		};
		await repo.write("a.ts", "export const a = 2;\n");
	});
	afterEach(async () => {
		await repo.dispose();
		await claude?.dispose();
		claude = undefined;
	});

	async function review(
		step: FakeClaudeStep,
		timeoutMs = 10_000,
		options: ClaudeReviewerOptions = {},
	) {
		claude = await FakeClaude.create(step);
		return new ClaudeReviewer({
			bin: claude.bin,
			timeoutMs,
			env: {},
			...options,
		}).review(request);
	}

	const firstCall = async () => {
		const [call] = (await claude?.calls()) ?? [];
		assert.ok(call);
		return call;
	};

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

	it("runs claude -p read-only: file tools only, dontAsk, schema, prompt on stdin", async () => {
		await review({ output: approved() });
		const { argv, cwd, stdin } = await firstCall();
		const value = (flag: string) => argv[argv.indexOf(flag) + 1];
		assert.equal(argv[0], "-p");
		assert.equal(value("--tools"), "Read,Grep,Glob");
		assert.equal(value("--permission-mode"), "dontAsk");
		assert.equal(value("--permission-prompts"), "none");
		assert.equal(value("--output-format"), "json");
		assert.deepEqual(JSON.parse(value("--json-schema") ?? ""), REVIEW_SCHEMA);
		assert.ok(argv.includes("--safe-mode"), "no plugins/hooks: no re-entry");
		assert.ok(argv.includes("--no-session-persistence"));
		for (const arg of argv) {
			assert.doesNotMatch(arg, /Bash|Edit|Write|dangerously|bypass/);
			assert.notEqual(arg, "plan");
		}
		// The prompt travels only on stdin, never as an argument.
		assert.ok(!argv.some((a) => a.includes("make a 2")));
		assert.equal(cwd, repo.root);
		assert.match(stdin, /Do NOT modify/);
		assert.match(stdin, /make a 2/);
		assert.match(stdin, /set a to 2/);
	});

	it("hands the Git changes to the reviewer, which cannot run git itself", async () => {
		await repo.write("new file.ts", "export const b = 1;\n");
		await review({ output: approved() });
		const { stdin } = await firstCall();
		assert.match(stdin, /you cannot run commands/);
		assert.match(stdin, /Git changes since activation:/);
		assert.match(stdin, /-export const a = 1;\n\+export const a = 2;/);
		assert.match(stdin, /Untracked files[^\n]*\n {2}new file\.ts/);
		assert.doesNotMatch(stdin, /Inspect the actual repository and the Git/);
	});

	it("passes previous findings so IDs can be preserved", async () => {
		request.previous = changesRequested(finding("CCC-004", "off by one"));
		await review({ output: approved() });
		const { stdin } = await firstCall();
		assert.match(stdin, /CCC-004 \[high\]: off by one/);
		assert.match(stdin, /CCC-005/);
	});

	it("passes model and effort only when configured", async () => {
		await review({ output: approved() });
		let { argv } = await firstCall();
		assert.ok(!argv.includes("--model"));
		assert.ok(!argv.includes("--effort"));
		await claude?.dispose();
		await review({ output: approved() }, 10_000, {
			model: "opus",
			effort: "high",
		});
		({ argv } = await firstCall());
		assert.equal(argv[argv.indexOf("--model") + 1], "opus");
		assert.equal(argv[argv.indexOf("--effort") + 1], "high");
	});

	it("never mutates the repository", async () => {
		const before = await captureBaseline(repo.root);
		await review({ output: approved() });
		assert.deepEqual(await captureBaseline(repo.root), before);
	});

	describe("failures are errors, never approval", () => {
		const cases: [string, FakeClaudeStep, RegExp][] = [
			["malformed JSON", { rawStdout: '{"type": "result",' }, /invalid JSON/],
			["no output", {}, /returned no output/],
			[
				"schema/shape mismatch",
				{ output: { verdict: "LGTM", summary: "", findings: [] } },
				/invalid review: invalid verdict/,
			],
			[
				"approval smuggled without findings array",
				{ output: { verdict: "APPROVED", summary: "ok" } },
				/findings must be an array/,
			],
			[
				"success without structured output",
				{ result: { result: "Looks good to me!" } },
				/no structured review/,
			],
			[
				"structured output retries exhausted",
				{
					result: {
						subtype: "error_max_structured_output_retries",
						is_error: true,
						structured_output: approved(),
					},
				},
				/review failed \(error_max_structured_output_retries\)/,
			],
			[
				"is_error on a success subtype",
				{
					output: approved(),
					result: { is_error: true, result: "API Error: overloaded" },
				},
				/review failed \(success\): API Error: overloaded/,
			],
			[
				"error during execution",
				{
					result: {
						subtype: "error_during_execution",
						is_error: true,
						errors: ["tool crashed"],
					},
				},
				/error_during_execution\): tool crashed/,
			],
			[
				"non-zero exit with stderr, even with an approval on stdout",
				{ exit: 3, stderr: "boom happened\n", output: approved() },
				/exited with code 3: boom happened/,
			],
			[
				"authentication-like failure printed as the result",
				{
					exit: 1,
					result: {
						is_error: true,
						result: "Not logged in · Please run /login",
					},
				},
				/exited with code 1: Not logged in[\s\S]*claude auth login/,
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
				/claude timed out after 1000 ms — raise CCCR_CLAUDE_TIMEOUT_MS/,
			);
			assert.ok(Date.now() - started < 10_000);
		});

		it("a result arriving after the deadline is not approval; the group is killed", async () => {
			const started = Date.now();
			await assert.rejects(
				review({ output: approved(), childSleepMs: 30_000 }, 500),
				/timed out after 500 ms/,
			);
			assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
			assert.ok(claude);
			await assertGone(await claude.childPid());
		});

		it("missing executable", async () => {
			const reviewer = new ClaudeReviewer({
				bin: join(repo.root, "no-such-claude"),
				env: {},
			});
			await assert.rejects(
				reviewer.review(request),
				/claude executable not found: .*set CCCR_CLAUDE_BIN/,
			);
		});

		it("excessive stdout is refused, not buffered without limit", async () => {
			await assert.rejects(
				review({ rawStdout: "x".repeat(STDOUT_LIMIT + 10) }),
				/output is too large/,
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
		it("not logged in fails fast with a login hint and never runs -p", async () => {
			claude = await FakeClaude.create({ output: approved() });
			await claude.login({ exit: 1, stdout: '{"loggedIn":false}\n' });
			const reviewer = new ClaudeReviewer({ bin: claude.bin, env: {} });
			await assert.rejects(
				reviewer.review(request),
				/not logged in — run `claude auth login`/,
			);
			assert.equal((await claude.calls()).length, 0);
			assert.equal(await claude.loginCalls(), 1);
		});

		it("runs before every review when logged in", async () => {
			await review({ output: approved() });
			assert.equal(await claude?.loginCalls(), 1);
		});

		it("with ANTHROPIC_API_KEY only the executable is checked", async () => {
			claude = await FakeClaude.create({ output: approved() });
			await claude.login({ exit: 1 });
			const reviewer = new ClaudeReviewer({
				bin: claude.bin,
				env: { ANTHROPIC_API_KEY: "sk-test" },
			});
			assert.equal((await reviewer.review(request)).verdict, "APPROVED");
			assert.equal(await claude.loginCalls(), 0);
		});

		it("check() reports a missing binary and a missing login", async () => {
			await assert.rejects(
				new ClaudeReviewer({ bin: join(repo.root, "nope"), env: {} }).check(
					repo.root,
				),
				/not found/,
			);
			claude = await FakeClaude.create();
			await claude.login({ exit: 1 });
			await assert.rejects(
				new ClaudeReviewer({ bin: claude.bin, env: {} }).check(repo.root),
				/not logged in/,
			);
		});

		it("a hanging login check is bounded by the timeout", async () => {
			claude = await FakeClaude.create();
			await claude.login({ exit: 0, sleepMs: 30_000 });
			await assert.rejects(
				new ClaudeReviewer({ bin: claude.bin, timeoutMs: 500, env: {} }).check(
					repo.root,
				),
				/timed out/,
			);
		});
	});

	it("describe() names the reviewer settings", () => {
		assert.equal(
			new ClaudeReviewer({
				bin: "c",
				timeoutMs: 60_000,
				model: "opus",
			}).describe(),
			"claude (bin c, timeout 1 min, model opus, effort default)",
		);
	});
});
