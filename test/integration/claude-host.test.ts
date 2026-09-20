import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readHistory } from "../../src/core/state.ts";
import { captureBaseline } from "../../src/git.ts";
import { configFromEnv, runHook } from "../../src/hosts/claude-code/hooks.ts";
import { CodexReviewer } from "../../src/reviewers/codex.ts";
import { ClaudeHostHarness } from "../helpers/claude-host.ts";
import { FakeCodex, type FakeCodexStep } from "../helpers/fake-codex.ts";
import {
	approved,
	changesRequested,
	finding,
} from "../helpers/fake-reviewer.ts";
import { makeTempDir, removeDir } from "../helpers/temp-dir.ts";
import { TemporaryGitRepository } from "../helpers/temp-git-repo.ts";

// Host harness + real Codex adapter spawning a fake codex + real state + real git.
describe("Claude Code host", () => {
	let repo: TemporaryGitRepository;
	let stateDir: string;
	let codex: FakeCodex;
	let host: ClaudeHostHarness;

	async function setup(
		steps: FakeCodexStep[],
		timeoutMs = 10_000,
		maxRounds?: number,
	) {
		await codex.script(...steps);
		host = new ClaudeHostHarness(
			{
				stateDir,
				reviewer: new CodexReviewer({ bin: codex.bin, timeoutMs, env: {} }),
				...(maxRounds === undefined ? {} : { maxRounds }),
			},
			repo.root,
		);
	}

	beforeEach(async () => {
		repo = await TemporaryGitRepository.create();
		await repo.commitFile("app.ts", "export const x = 1;\n");
		stateDir = await makeTempDir("ccc-review-state-");
		codex = await FakeCodex.create();
		await setup([]);
	});
	afterEach(async () => {
		await repo.dispose();
		await codex.dispose();
		await removeDir(stateDir);
	});

	const calls = async () => (await codex.calls()).length;
	const history = async () =>
		readHistory(join(stateDir, "history"), (await host.taskId()) ?? "");
	const claims = async () => {
		try {
			return await readdir(
				join(stateDir, "claims", (await host.taskId()) ?? ""),
			);
		} catch {
			return undefined;
		}
	};

	describe("inactive session", () => {
		// Observed in Claude Code 2.1.278: a plugin skill always arrives as
		// `<plugin>:<skill>`; a bare `on` or `status` is someone else's command.
		it("other commands are ignored, including bare and look-alike names", async () => {
			for (const name of [
				"deploy",
				"on",
				"status",
				"ccc-review",
				"ccc-review:ccc-review",
				"ccc-review:bogus",
				"ccc-review:currently",
				"other:on",
				"ccc-review:on ",
			])
				assert.equal(await host.command("on", name), undefined, name);
			assert.equal(await host.taskId(), undefined);
		});

		it("another session's activation does not affect this session", async () => {
			const other = new ClaudeHostHarness(
				host.config,
				repo.root,
				"other-session",
			);
			await other.command("on");
			assert.equal(await host.stop("done"), undefined);
			assert.equal(await calls(), 0);
		});
	});

	describe("activation", () => {
		it("records a Git baseline including pre-existing dirty state", async () => {
			await repo.write("dirty.txt", "before\n");
			const out = await host.command("on");
			assert.equal(out?.decision, "block"); // handled in the hook, not by the model
			assert.match(out?.reason ?? "", /enabled/);
			const state = await host.state();
			assert.equal(state?.active, true);
			assert.equal(state?.round, 0);
			assert.equal(state?.maxRounds, 3);
			assert.equal(state?.writer, "claude");
			assert.equal(state?.reviewer, "codex");
			assert.deepEqual(state?.baseline, await captureBaseline(repo.root));
			assert.deepEqual(state?.baseline.status, [
				{ code: "??", path: "dirty.txt" },
			]);
		});

		it("off and status ignore trailing arguments", async () => {
			await host.command("on");
			assert.match(
				(await host.command("status now please"))?.reason ?? "",
				/status: active/,
			);
			assert.match(
				(await host.command("off thanks"))?.reason ?? "",
				/disabled/,
			);
		});

		it("outside a Git repository nothing is enabled", async () => {
			const notRepo = await makeTempDir("ccc-review-norepo-");
			try {
				const h = new ClaudeHostHarness(host.config, notRepo);
				const out = await h.command("on");
				assert.equal(out?.decision, "block");
				assert.match(out?.reason ?? "", /not enabled/);
				assert.equal(await h.taskId(), undefined);
			} finally {
				await removeDir(notRepo);
			}
		});

		it("on twice keeps the same task", async () => {
			await host.command("on");
			const first = await host.taskId();
			assert.match((await host.command("on"))?.reason ?? "", /already active/);
			assert.equal(await host.taskId(), first);
		});

		it("status shows active state and current round", async () => {
			await setup([{ output: changesRequested() }]);
			await host.command("on");
			await host.stop("implemented");
			const reason = (await host.command("status"))?.reason ?? "";
			assert.match(reason, /status: active/);
			assert.match(reason, /round: 1\/3/);
			assert.match(reason, /last verdict: CHANGES_REQUESTED/);
		});

		it("on after a finished task starts a fresh task", async () => {
			await setup([{ output: approved() }]);
			await host.command("on");
			const first = await host.taskId();
			await host.stop("done");
			await host.command("on");
			assert.notEqual(await host.taskId(), first);
			assert.equal((await host.state())?.round, 0);
		});
	});

	describe("review rounds", () => {
		it("a subagent's Stop is not reviewed", async () => {
			await setup([{ output: approved() }]);
			await host.command("on");
			const out = await host.send("stop", {
				session_id: host.sessionId,
				cwd: repo.root,
				hook_event_name: "Stop",
				agent_id: "agent-abc123",
				agent_type: "Explore",
				last_assistant_message: "explored",
			});
			assert.equal(out, undefined);
			assert.equal(await calls(), 0);
			assert.equal((await host.state())?.round, 0);
		});

		it("slash commands are not recorded as the task", async () => {
			await setup([{ output: approved() }]);
			await host.command("on");
			await host.prompt("/ccc-review:status");
			await host.stop("done");
			const [call] = await codex.calls();
			assert.match(call?.stdin ?? "", /Writer's implementation report/);
			assert.doesNotMatch(call?.stdin ?? "", /Original task/);
		});
	});

	// The scripted failure cases run for both directions in host-scenarios.ts.
	describe("reviewer failure is never approval", () => {
		it("codex executable disappearing after activation", async () => {
			await host.command("on");
			host = new ClaudeHostHarness(
				{
					stateDir,
					reviewer: new CodexReviewer({ bin: join(stateDir, "nope") }),
				},
				repo.root,
			);
			const out = await host.stop("done");
			assert.match(out?.systemMessage ?? "", /not found/);
			assert.equal((await host.state())?.lastResult, undefined);
		});
	});

	describe("infrastructure errors", () => {
		it("corrupt task state is reported, not blocked or approved", async () => {
			await host.command("on");
			const taskId = await host.taskId();
			await writeFile(join(stateDir, "tasks", `${taskId}.json`), "{broken");
			const out = await host.stop("done");
			assert.equal(out?.decision, undefined);
			assert.match(
				out?.systemMessage ?? "",
				/CCC Review error: corrupt state file/,
			);
			assert.equal(await calls(), 0);
		});

		it("corrupt command state blocks the command with an error", async () => {
			await host.command("on");
			await writeFile(
				join(stateDir, "sessions", `${host.sessionId}.json`),
				"[]",
			);
			const out = await host.command("status");
			assert.equal(out?.decision, "block");
			assert.match(out?.reason ?? "", /CCC Review error/);
			assert.match(out?.reason ?? "", /use "on" .* or "off"/);
		});

		it("on with an invalid session id is an error and creates no task", async () => {
			const out = await host.send("command", {
				session_id: "../x",
				cwd: repo.root,
				command_name: "ccc-review:on",
				command_args: "",
			});
			assert.equal(out?.decision, "block");
			assert.match(out?.reason ?? "", /invalid session_id/);
			assert.deepEqual(await readdir(stateDir), []);
		});

		it("invalid hook payloads are reported", async () => {
			const cfg = () => host.config;
			assert.match(
				(await runHook("stop", "not json", cfg))?.systemMessage ?? "",
				/error/,
			);
			assert.match(
				(await runHook("stop", "null", cfg))?.systemMessage ?? "",
				/not a JSON object/,
			);
			assert.match(
				(await runHook("nope", "{}", cfg))?.systemMessage ?? "",
				/unknown hook event/,
			);
			assert.match(
				(await runHook("stop", JSON.stringify({ session_id: "../x" }), cfg))
					?.systemMessage ?? "",
				/invalid session_id/,
			);
		});

		it("the whole flow never mutates Git state", async () => {
			await repo.write("dirty.txt", "x\n");
			await repo.write("app.ts", "export const x = 5;\n");
			repo.git("add", "app.ts");
			const before = await captureBaseline(repo.root);
			await setup([{ output: changesRequested() }, { rawOutput: "bad" }]);
			host.simulateWork = false;
			await host.command("on");
			await host.stop("a");
			await host.stop("b");
			await host.command("status");
			await host.command("off");
			assert.deepEqual(await captureBaseline(repo.root), before);
			assert.equal(repo.git("stash", "list"), "");
		});
	});

	describe("configuration", () => {
		it("reads state dir, codex binary and timeout from the environment", () => {
			const c = configFromEnv({
				CCC_REVIEW_STATE_DIR: "/s",
				CLAUDE_PLUGIN_DATA: "/p",
			});
			assert.equal(c.stateDir, "/s");
			assert.equal(configFromEnv({ CLAUDE_PLUGIN_DATA: "/p" }).stateDir, "/p");
			assert.match(
				configFromEnv({
					CCC_REVIEW_CODEX_BIN: "/x/codex",
					CCC_REVIEW_CODEX_TIMEOUT_MS: "5",
				}).reviewer.describe?.() ?? "",
				/bin \/x\/codex, timeout 5 ms/,
			);
		});

		it("reads max rounds, model and reasoning effort", () => {
			const c = configFromEnv({
				CCC_REVIEW_MAX_ROUNDS: "5",
				CCC_REVIEW_CODEX_MODEL: "gpt-x",
				CCC_REVIEW_CODEX_REASONING_EFFORT: "high",
				CCC_REVIEW_CODEX_TIMEOUT_MS: "120000",
			});
			assert.equal(c.maxRounds, 5);
			assert.equal(
				c.reviewer.describe?.(),
				"codex (bin codex, timeout 2 min, model gpt-x, reasoning high)",
			);
			const d = configFromEnv({});
			assert.equal(d.maxRounds, undefined);
			assert.equal(
				d.reviewer.describe?.(),
				"codex (bin codex, timeout 20 min, model default, reasoning default)",
			);
		});

		const invalid: [string, string, RegExp][] = [
			["CCC_REVIEW_MAX_ROUNDS", "0", /invalid CCC_REVIEW_MAX_ROUNDS/],
			["CCC_REVIEW_MAX_ROUNDS", "two", /invalid CCC_REVIEW_MAX_ROUNDS/],
			["CCC_REVIEW_MAX_ROUNDS", " ", /invalid CCC_REVIEW_MAX_ROUNDS/],
			[
				"CCC_REVIEW_CODEX_REASONING_EFFORT",
				"extreme",
				/invalid CCC_REVIEW_CODEX_REASONING_EFFORT "extreme": expected one of minimal, low, medium, high, xhigh/,
			],
		];
		for (const [name, value, error] of invalid)
			it(`rejects ${name}=${JSON.stringify(value)} without approving`, async () => {
				assert.throws(() => configFromEnv({ [name]: value }), error);
				const out = await runHook("stop", "{}", () =>
					configFromEnv({ [name]: value }),
				);
				assert.equal(out?.decision, undefined);
				assert.match(out?.systemMessage ?? "", error);
			});

		for (const bad of ["0", "-1", "1.5", "abc", ""])
			it(`rejects CCC_REVIEW_CODEX_TIMEOUT_MS=${JSON.stringify(bad)}`, async () => {
				assert.throws(
					() => configFromEnv({ CCC_REVIEW_CODEX_TIMEOUT_MS: bad }),
					/invalid CCC_REVIEW_CODEX_TIMEOUT_MS/,
				);
				const out = await runHook("stop", "{}", () =>
					configFromEnv({ CCC_REVIEW_CODEX_TIMEOUT_MS: bad }),
				);
				assert.match(
					out?.systemMessage ?? "",
					/invalid CCC_REVIEW_CODEX_TIMEOUT_MS/,
				);
			});
	});

	describe("activation preflight", () => {
		it("a missing codex binary refuses activation with an actionable message", async () => {
			const h = new ClaudeHostHarness(
				{
					stateDir,
					reviewer: new CodexReviewer({ bin: join(stateDir, "nope"), env: {} }),
				},
				repo.root,
			);
			const out = await h.command("on");
			assert.equal(out?.decision, "block");
			assert.match(
				out?.reason ?? "",
				/not enabled: codex executable not found: .*CCC_REVIEW_CODEX_BIN/,
			);
			assert.equal(await h.taskId(), undefined);
		});

		it("`current` with a missing codex binary is refused too, and blocked", async () => {
			const h = new ClaudeHostHarness(
				{
					stateDir,
					reviewer: new CodexReviewer({ bin: join(stateDir, "nope"), env: {} }),
				},
				repo.root,
			);
			await repo.write("app.ts", "export const x = 2;\n");
			const out = await h.command("current");
			assert.equal(out?.decision, "block");
			assert.match(
				out?.reason ?? "",
				/not enabled: codex executable not found/,
			);
			assert.equal(await h.taskId(), undefined);
		});

		it("with CODEX_API_KEY a missing binary still refuses activation", async () => {
			const h = new ClaudeHostHarness(
				{
					stateDir,
					reviewer: new CodexReviewer({
						bin: join(stateDir, "nope"),
						env: { CODEX_API_KEY: "sk-test" },
					}),
				},
				repo.root,
			);
			assert.match(
				(await h.command("on"))?.reason ?? "",
				/not enabled: codex executable not found/,
			);
			assert.equal(await h.taskId(), undefined);
		});

		it("codex not logged in refuses activation", async () => {
			await codex.login({ exit: 1, stdout: "Not logged in\n" });
			const out = await host.command("on");
			assert.match(
				out?.reason ?? "",
				/not enabled: Codex is not logged in — run `codex login`/,
			);
			assert.equal(await host.taskId(), undefined);
			assert.equal(await calls(), 0);
		});

		it("logging out after activation fails the review fast, never approval", async () => {
			await setup([{ output: approved() }]);
			await host.command("on");
			await codex.login({ exit: 1, stdout: "Not logged in\n" });
			const out = await host.stop("done");
			assert.match(out?.systemMessage ?? "", /NOT approved[\s\S]*codex login/);
			assert.equal(await calls(), 0);
			const state = await host.state();
			assert.equal(state?.active, false);
			assert.equal(state?.lastResult, undefined);
		});
	});

	describe("dirty repository warning", () => {
		it("a clean tree gets no warning", async () => {
			const reason = (await host.command("on"))?.reason ?? "";
			assert.match(reason, /CCC Review: enabled/);
			assert.doesNotMatch(reason, /Warning/);
		});

		it("pre-existing changes are listed for the user, capped", async () => {
			await repo.write("app.ts", "export const x = 9;\n");
			for (let i = 0; i < 11; i++) await repo.write(`u${i}.txt`, "x\n");
			const reason = (await host.command("on"))?.reason ?? "";
			assert.match(reason, /enabled/);
			assert.match(
				reason,
				/Warning: the working tree already has 12 uncommitted change\(s\)/,
			);
			assert.match(reason, / M app\.ts/);
			assert.match(reason, /… and 2 more/);
			assert.match(reason, /12 pre-existing dirty path\(s\)/);
		});
	});

	describe("history and status", () => {
		it("records every round and shows it in status", async () => {
			await setup([
				{
					output: changesRequested(finding("CCC-001"), {
						...finding("CCC-002"),
						severity: "low",
					}),
				},
				{ rawOutput: "nope" },
			]);
			await host.command("on");
			await host.stop("r1");
			await host.stop("r2", true);
			const events = (await history()).map((e) => [
				e.event,
				e.round,
				e.outcome,
			]);
			assert.deepEqual(events, [
				["on", undefined, undefined],
				["round", 1, "changes_requested"],
				["round", 2, "reviewer_error"],
			]);
			const [, r1, r2] = await history();
			assert.equal(r1?.result?.findings.length, 2);
			assert.match(r2?.error ?? "", /invalid JSON/);
			assert.equal(r2?.result, undefined);

			const status = (await host.command("status"))?.reason ?? "";
			assert.match(status, /status: inactive/);
			assert.match(status, /round: 2\/3/);
			assert.match(
				status,
				/reviewer: codex \(bin .*codex, timeout 10000 ms, model default, reasoning default\)/,
			);
			assert.match(status, /history:\n {2}\S+ \S+ on\n/);
			assert.match(
				status,
				/round 1: CHANGES_REQUESTED — 2 finding\(s\): CCC-001, CCC-002/,
			);
			assert.match(
				status,
				/round 2: reviewer_error — codex returned invalid JSON: nope/,
			);
			assert.match(
				status,
				new RegExp(`state: .*tasks/${await host.taskId()}\\.json`),
			);
			assert.match(
				status,
				new RegExp(`log: .*history/${await host.taskId()}\\.jsonl`),
			);
		});

		it("off is logged", async () => {
			await host.command("on");
			await host.command("off");
			assert.deepEqual(
				(await history()).map((e) => e.event),
				["on", "off"],
			);
			assert.match((await host.command("status"))?.reason ?? "", / off\n/);
		});

		it("a corrupt history file is reported by status, not ignored", async () => {
			await host.command("on");
			await writeFile(
				join(stateDir, "history", `${await host.taskId()}.jsonl`),
				"garbage\n",
			);
			const out = await host.command("status");
			assert.equal(out?.decision, "block");
			assert.match(out?.reason ?? "", /CCC Review error: corrupt history file/);
		});
	});

	describe("cleanup and abort", () => {
		it("off drops the task's claims; later completions are ignored", async () => {
			await setup([{ output: changesRequested() }]);
			await host.command("on");
			await host.stop("r1");
			assert.equal((await claims())?.length, 1);
			await host.command("off");
			assert.equal(await claims(), undefined);
			assert.equal(await host.stop("r1"), undefined);
			assert.equal(await host.stop("r2"), undefined);
			assert.equal(await calls(), 1);
		});

		it("a finished task drops its claims and a duplicate does not re-review", async () => {
			await setup([{ output: approved() }, { output: approved() }]);
			await host.command("on");
			await host.stop("done");
			assert.equal(await claims(), undefined);
			assert.equal(await host.stop("done"), undefined);
			assert.equal(await calls(), 1);
		});

		it("an active task keeps its claims", async () => {
			await setup([{ output: changesRequested() }]);
			await host.command("on");
			await host.stop("r1");
			assert.equal(await host.stop("r1"), undefined);
			assert.equal(await calls(), 1);
			assert.equal((await claims())?.length, 1);
		});
	});

	describe("configured max rounds", () => {
		it("CCC_REVIEW_MAX_ROUNDS limits the loop", async () => {
			await setup(
				[{ output: changesRequested() }, { output: approved() }],
				10_000,
				1,
			);
			await host.command("on");
			assert.match((await host.command("status"))?.reason ?? "", /round: 0\/1/);
			const out = await host.stop("r1");
			assert.equal(out?.decision, undefined);
			assert.match(
				out?.systemMessage ?? "",
				/max 1 review rounds reached WITHOUT approval/,
			);
			assert.equal(await host.stop("r2", true), undefined);
			assert.equal(await calls(), 1);
			assert.match(
				(await host.command("status"))?.reason ?? "",
				/round 1: CHANGES_REQUESTED — 1 finding\(s\): CCC-001 \(max rounds reached\)/,
			);
		});
	});
});
