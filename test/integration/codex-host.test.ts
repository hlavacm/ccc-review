import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadState } from "../../src/core/state.ts";
import type { HookOutput } from "../../src/hosts/codex/hooks.ts";
import { configFromEnv, runHook } from "../../src/hosts/codex/hooks.ts";
import { ClaudeReviewer } from "../../src/reviewers/claude.ts";
import { CodexReviewer } from "../../src/reviewers/codex.ts";
import { ClaudeHostHarness } from "../helpers/claude-host.ts";
import { CodexHostHarness } from "../helpers/codex-host.ts";
import { FakeClaude, type FakeClaudeStep } from "../helpers/fake-claude.ts";
import { FakeCodex } from "../helpers/fake-codex.ts";
import { approved, changesRequested } from "../helpers/fake-reviewer.ts";
import { makeTempDir, removeDir } from "../helpers/temp-dir.ts";
import { TemporaryGitRepository } from "../helpers/temp-git-repo.ts";

/**
 * Codex parses Stop/UserPromptSubmit output with deny_unknown_fields
 * (codex-rs hooks/src/schema.rs): an extra key fails the hook, and a block
 * needs a non-empty reason.
 */
const CODEX_OUTPUT_KEYS = [
	"continue",
	"stopReason",
	"suppressOutput",
	"systemMessage",
	"decision",
	"reason",
	"hookSpecificOutput",
];

function assertCodexOutput(out: HookOutput | undefined): void {
	if (out === undefined) return;
	for (const key of Object.keys(out))
		assert.ok(CODEX_OUTPUT_KEYS.includes(key), `unknown output key ${key}`);
	if (out.decision !== undefined) {
		assert.equal(out.decision, "block");
		assert.ok(out.reason?.trim(), "block without a reason");
	}
}

// Codex-specific behaviour; shared workflow scenarios live in
// host-scenarios.test.ts.
describe("Codex host", () => {
	let repo: TemporaryGitRepository;
	let stateDir: string;
	let claude: FakeClaude;
	let host: CodexHostHarness;
	const outputs: (HookOutput | undefined)[] = [];

	function harness(
		reviewer = new ClaudeReviewer({ bin: claude.bin, env: {} }),
	) {
		const h = new CodexHostHarness({ stateDir, reviewer }, repo.root);
		// Every output any test sees is checked against Codex's parser rules.
		const send = h.send.bind(h);
		h.send = async (event, payload) => {
			const out = await send(event, payload);
			outputs.push(out);
			return out;
		};
		return h;
	}

	async function setup(...steps: FakeClaudeStep[]) {
		await claude.script(...steps);
		host = harness();
	}

	beforeEach(async () => {
		repo = await TemporaryGitRepository.create();
		await repo.commitFile("app.ts", "export const x = 1;\n");
		stateDir = await makeTempDir("ccc-review-state-");
		claude = await FakeClaude.create();
		await setup();
	});
	afterEach(async () => {
		for (const out of outputs.splice(0)) assertCodexOutput(out);
		await repo.dispose();
		await claude.dispose();
		await removeDir(stateDir);
	});

	const calls = async () => (await claude.calls()).length;

	describe("$ccc-review command", () => {
		it("the plugin-namespaced mention works too", async () => {
			const on = await host.command("on", "$ccc-review:ccc-review");
			assert.match(on?.reason ?? "", /enabled\. Claude will review/);
			assert.equal((await host.state())?.active, true);
		});

		it("bare $ccc-review shows status", async () => {
			assert.match(
				(await host.prompt("$ccc-review"))?.reason ?? "",
				/off \(never enabled/,
			);
		});

		it("text after `on` becomes the task", async () => {
			await setup({ output: approved() });
			await host.command("on Add multiply to math.js");
			await host.stop("done");
			const [call] = await claude.calls();
			assert.match(
				call?.stdin ?? "",
				/Original task:\nAdd multiply to math\.js/,
			);
		});

		it("`current` reaches the model (its skill writes the report); the rest stays blocked", async () => {
			await repo.write("app.ts", "export const x = 2;\n");
			// Real use: Codex did not load the skill text for a typed mention
			// ("skill is not available"), so the hook hands over the instructions.
			const armed = await host.command("current check the maths");
			assert.deepEqual(Object.keys(armed ?? {}), ["hookSpecificOutput"]);
			assert.equal(
				armed?.hookSpecificOutput?.hookEventName,
				"UserPromptSubmit",
			);
			const context = armed?.hookSpecificOutput?.additionalContext ?? "";
			for (const needle of [
				/independent reviewer \(Claude Code\)/,
				/\*\*Task\*\*/,
				/\*\*Plan\*\*/,
				/\*\*Report\*\*/,
				/Do not modify any files/,
				/not a review of your own/,
			])
				assert.match(context, needle);
			assert.equal((await host.state())?.maxRounds, 1);
			assert.equal((await host.command("status"))?.decision, "block");
			assert.equal((await host.command("off"))?.decision, "block");
			// The plugin-namespaced mention works as well.
			assert.ok(
				(await host.command("current", "$ccc-review:ccc-review"))
					?.hookSpecificOutput,
			);
			await host.command("off");
			// Refused: blocked, so the skill never asks Codex for a report.
			repo.git("checkout", "--", "app.ts");
			const clean = await host.command("current");
			assert.deepEqual(Object.keys(clean ?? {}).sort(), ["decision", "reason"]);
			assert.match(clean?.reason ?? "", /nothing to audit/);
		});

		it("unknown action is reported and blocked", async () => {
			const out = await host.command("maybe");
			assert.equal(out?.decision, "block");
			assert.match(out?.reason ?? "", /unknown action "maybe"/);
		});

		it("similar prompts are not commands and never blocked", async () => {
			for (const prompt of [
				"$ccc-reviewx on",
				"$ccc-review-foo on",
				"please $ccc-review on",
				"$other:ccc-review on",
				"ccc-review on",
			])
				assert.equal(await host.prompt(prompt), undefined, prompt);
			assert.equal(await host.state(), undefined);
		});

		it("on twice keeps the same task", async () => {
			await host.command("on");
			const first = await host.state();
			assert.match((await host.command("on"))?.reason ?? "", /already active/);
			assert.equal((await host.state())?.taskId, first?.taskId);
		});

		it("outside a Git repository nothing is enabled", async () => {
			const dir = await makeTempDir("ccc-review-nogit-");
			try {
				const h = new CodexHostHarness(
					{
						stateDir,
						reviewer: new ClaudeReviewer({ bin: claude.bin, env: {} }),
					},
					dir,
				);
				const out = await h.command("on");
				assert.equal(out?.decision, "block");
				assert.match(out?.reason ?? "", /not enabled: .*not a usable Git/);
				assert.equal(await h.state(), undefined);
			} finally {
				await removeDir(dir);
			}
		});

		it("claude not logged in refuses activation", async () => {
			await claude.login({ exit: 1, stdout: '{"loggedIn":false}' });
			const out = await host.command("on");
			assert.match(
				out?.reason ?? "",
				/not enabled: Claude Code is not logged in/,
			);
			assert.equal(await host.state(), undefined);
		});

		it("a missing claude binary refuses activation", async () => {
			host = harness(
				new ClaudeReviewer({ bin: join(stateDir, "no-claude"), env: {} }),
			);
			const out = await host.command("on");
			assert.match(
				out?.reason ?? "",
				/not enabled: claude executable not found/,
			);
		});
	});

	describe("task context", () => {
		it("records user prompts, but not subagent prompts or commands", async () => {
			await setup({ output: approved() });
			await host.command("on");
			await host.prompt("implement feature A");
			await host.prompt("spawned work", {
				agent_id: "agent-1",
				agent_type: "worker",
			});
			await host.prompt("$ccc-review status");
			await host.stop("done");
			const [call] = await claude.calls();
			assert.match(call?.stdin ?? "", /Original task:\nimplement feature A\n/);
			assert.doesNotMatch(call?.stdin ?? "", /spawned work|\$ccc-review/);
		});

		it("a missing final message is reviewed without a report", async () => {
			await setup({ output: approved() });
			await host.command("on");
			assert.match((await host.stop(null))?.systemMessage ?? "", /APPROVED/);
			const [call] = await claude.calls();
			assert.doesNotMatch(call?.stdin ?? "", /implementation report/);
		});
	});

	describe("completion identity", () => {
		it("the same final message in a later turn is a new completion", async () => {
			await setup({ output: changesRequested() }, { output: approved() });
			await host.command("on");
			assert.equal((await host.stop("done"))?.decision, "block");
			await host.prompt("keep going");
			assert.match((await host.stop("done"))?.systemMessage ?? "", /APPROVED/);
			assert.equal(await calls(), 2);
		});

		it("a redelivered Stop of the same turn and message is ignored, also re-entrant", async () => {
			await setup({ output: changesRequested() }, { output: approved() });
			await host.command("on");
			assert.equal((await host.stop("r1"))?.decision, "block");
			assert.equal(await host.stop("r1", true), undefined);
			assert.equal(await calls(), 1);
		});
	});

	describe("host isolation (shared state directory)", () => {
		it("Claude Code hooks never drive a task Codex armed", async () => {
			await setup({ output: approved() });
			await host.command("on");
			// Codex also sets CLAUDE_PLUGIN_*: the Claude hooks may see its events.
			const codexReviewer = await FakeCodex.create({ output: approved() });
			try {
				const claudeSide = new ClaudeHostHarness(
					{
						stateDir,
						reviewer: new CodexReviewer({ bin: codexReviewer.bin, env: {} }),
					},
					repo.root,
					host.sessionId,
				);
				assert.equal(await claudeSide.stop("done"), undefined);
				assert.equal(await claudeSide.prompt("x"), undefined);
				assert.match(
					(await claudeSide.command("status"))?.reason ?? "",
					/off \(never enabled/,
				);
				assert.equal((await codexReviewer.calls()).length, 0);
			} finally {
				await codexReviewer.dispose();
			}
			assert.equal((await host.state())?.round, 0);
		});

		it("Codex hooks never drive a task Claude Code armed", async () => {
			const codexReviewer = await FakeCodex.create();
			try {
				const claudeSide = new ClaudeHostHarness(
					{
						stateDir,
						reviewer: new CodexReviewer({ bin: codexReviewer.bin, env: {} }),
					},
					repo.root,
					host.sessionId,
				);
				await claudeSide.command("on");
				await setup({ output: approved() });
				assert.equal(await host.stop("done"), undefined);
				assert.match(
					(await host.command("status"))?.reason ?? "",
					/off \(never enabled/,
				);
				assert.equal(await calls(), 0);
				assert.equal((await claudeSide.state())?.writer, "claude");
				assert.equal((await claudeSide.state())?.round, 0);
			} finally {
				await codexReviewer.dispose();
			}
		});
	});

	describe("infrastructure errors never block the writer or approve", () => {
		it("corrupt task state is reported on Stop", async () => {
			await host.command("on");
			const taskId = (await host.state())?.taskId ?? "";
			await writeFile(join(stateDir, "tasks", `${taskId}.json`), "{");
			const out = await host.stop("done");
			assert.equal(out?.decision, undefined);
			assert.match(out?.systemMessage ?? "", /CCC Review error: corrupt state/);
			assert.equal(await calls(), 0);
		});

		it("a failing $ccc-review command is blocked with the error", async () => {
			await host.command("on");
			const taskId = (await host.state())?.taskId ?? "";
			await writeFile(join(stateDir, "tasks", `${taskId}.json`), "{");
			const out = await host.command("status");
			assert.equal(out?.decision, "block");
			assert.match(out?.reason ?? "", /CCC Review error/);
		});

		it("a failing ordinary prompt is only reported", async () => {
			await host.command("on");
			await mkdir(join(stateDir, "sessions"), { recursive: true });
			await writeFile(
				join(stateDir, "sessions", `${host.sessionId}.json`),
				"garbage",
			);
			const out = await host.prompt("keep going");
			assert.equal(out?.decision, undefined);
			assert.match(out?.systemMessage ?? "", /CCC Review error/);
		});

		it("invalid hook payloads are reported", async () => {
			const cfg = () => host.config;
			// Only a failed $ccc-review command is blocked; everything else is reported.
			for (const [event, stdin, error, key] of [
				["stop", "not json", /error/, "systemMessage"],
				["prompt-submit", "not json", /error/, "systemMessage"],
				["stop", "null", /not a JSON object/, "systemMessage"],
				["nope", "{}", /unknown hook event/, "systemMessage"],
				[
					"stop",
					JSON.stringify({ session_id: "../x" }),
					/invalid session_id/,
					"systemMessage",
				],
				[
					"prompt-submit",
					JSON.stringify({ session_id: "../x", prompt: "hi" }),
					/invalid session_id/,
					"systemMessage",
				],
				[
					"prompt-submit",
					JSON.stringify({ session_id: "../x", prompt: "$ccc-review on" }),
					/invalid session_id/,
					"reason",
				],
			] as const) {
				const out = await runHook(event, stdin, cfg);
				outputs.push(out);
				assert.match(out?.[key] ?? "", error, stdin);
				assert.equal(out?.decision, key === "reason" ? "block" : undefined);
			}
		});

		it("invalid configuration never approves", async () => {
			const out = await runHook(
				"stop",
				JSON.stringify({ session_id: "s", last_assistant_message: "x" }),
				() =>
					configFromEnv({
						CCC_REVIEW_STATE_DIR: stateDir,
						CCC_REVIEW_CLAUDE_EFFORT: "huge",
					}),
			);
			outputs.push(out);
			assert.equal(out?.decision, undefined);
			assert.match(
				out?.systemMessage ?? "",
				/invalid CCC_REVIEW_CLAUDE_EFFORT "huge"/,
			);
		});

		it("the reviewer disappearing after activation fails the round, not approval", async () => {
			await host.command("on");
			host = harness(
				new ClaudeReviewer({ bin: join(stateDir, "gone"), env: {} }),
			);
			const out = await host.stop("done");
			assert.match(out?.systemMessage ?? "", /NOT approved[\s\S]*not found/);
			assert.equal((await host.state())?.lastResult, undefined);
			// Recovery: a fresh `on` starts a new task.
			await setup({ output: approved() });
			assert.match((await host.command("on"))?.reason ?? "", /enabled/);
			assert.match((await host.stop("done"))?.systemMessage ?? "", /APPROVED/);
		});
	});

	describe("configuration", () => {
		it("state dir: CCC_REVIEW_STATE_DIR, then PLUGIN_DATA, then ~/.ccc-review", () => {
			assert.equal(
				configFromEnv({ CCC_REVIEW_STATE_DIR: "/a", PLUGIN_DATA: "/b" })
					.stateDir,
				"/a",
			);
			assert.equal(configFromEnv({ PLUGIN_DATA: "/b" }).stateDir, "/b");
			assert.equal(configFromEnv({}).stateDir, join(homedir(), ".ccc-review"));
		});

		it("reads claude binary, timeout, model, effort and max rounds", () => {
			const c = configFromEnv({
				CCC_REVIEW_CLAUDE_BIN: "/x/claude",
				CCC_REVIEW_CLAUDE_TIMEOUT_MS: "60000",
				CCC_REVIEW_CLAUDE_MODEL: "opus",
				CCC_REVIEW_CLAUDE_EFFORT: "high",
				CCC_REVIEW_MAX_ROUNDS: "2",
			});
			assert.equal(
				c.reviewer.describe?.(),
				"claude (bin /x/claude, timeout 1 min, model opus, effort high)",
			);
			assert.equal(c.maxRounds, 2);
			assert.equal(
				configFromEnv({}).reviewer.describe?.(),
				"claude (bin claude, timeout 20 min, model default, effort default)",
			);
		});

		for (const [name, value] of [
			["CCC_REVIEW_CLAUDE_TIMEOUT_MS", "soon"],
			["CCC_REVIEW_CLAUDE_TIMEOUT_MS", "0"],
			["CCC_REVIEW_MAX_ROUNDS", "-1"],
			["CCC_REVIEW_CLAUDE_EFFORT", "ultra"],
		] as const)
			it(`rejects ${name}=${JSON.stringify(value)}`, () => {
				assert.throws(() => configFromEnv({ [name]: value }), /invalid/);
			});
	});

	it("the round is persisted where the harness reads it", async () => {
		await setup({ output: approved() });
		await host.command("on");
		await host.stop("done");
		const taskId = (await host.state())?.taskId ?? "";
		const state = await loadState(join(stateDir, "tasks"), taskId);
		assert.equal(state?.writer, "codex");
		assert.equal(state?.reviewer, "claude");
		assert.equal(state?.round, 1);
	});
});
