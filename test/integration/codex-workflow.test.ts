import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadState, readHistory } from "../../src/core/state.ts";
import { DEFAULT_CLAUDE_TIMEOUT_MS } from "../../src/reviewers/claude.ts";
import { FakeClaude } from "../helpers/fake-claude.ts";
import {
	approved,
	changesRequested,
	finding,
} from "../helpers/fake-reviewer.ts";
import {
	hookCommand as hookCommand_,
	readHooks,
	runHookCommand,
} from "../helpers/plugin-hooks.ts";
import { makeTempDir, removeDir } from "../helpers/temp-dir.ts";
import { TemporaryGitRepository } from "../helpers/temp-git-repo.ts";
import { assertGone, stopHook, waitFor } from "../helpers/wait.ts";

const pluginRoot = join(import.meta.dirname, "../..");
const manifest = JSON.parse(
	readFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"),
) as { name: string; skills: string; hooks: string };

const hooksJson = readHooks(pluginRoot, manifest.hooks);
const hookCommand = (event: string) => hookCommand_(hooksJson, event);

/** Runs a hook exactly as registered in codex/hooks.json, in the session cwd. */
const runPluginHook = (
	event: string,
	payload: { cwd: string; [key: string]: unknown },
	env: Record<string, string>,
) =>
	runHookCommand(
		hookCommand(event),
		pluginRoot,
		JSON.stringify(payload),
		env,
		payload.cwd,
	);

describe("Codex plugin manifest", () => {
	it("points at an existing hooks file and skill", () => {
		assert.equal(manifest.name, "ccc-review");
		const skill = readFileSync(
			join(pluginRoot, manifest.skills, "ccc-review/SKILL.md"),
			"utf8",
		);
		assert.match(skill, /^---\nname: ccc-review\ndescription: .+\n---\n/);
		assert.match(
			readFileSync(
				join(pluginRoot, manifest.skills, "ccc-review/agents/openai.yaml"),
				"utf8",
			),
			/allow_implicit_invocation: false/,
		);
	});

	it("hooks point at existing entry points with expected events", () => {
		assert.deepEqual(Object.keys(hooksJson.hooks).sort(), [
			"Stop",
			"UserPromptSubmit",
		]);
		for (const event of Object.keys(hooksJson.hooks)) {
			const [, script] =
				/"\$\{PLUGIN_ROOT\}\/([^"]+)"/.exec(hookCommand(event)) ?? [];
			assert.ok(script && existsSync(join(pluginRoot, script)), event);
		}
	});

	it("Stop hook timeout outlasts the Claude reviewer timeout", () => {
		const timeout = hooksJson.hooks.Stop?.[0]?.hooks[0]?.timeout ?? 600;
		assert.ok(timeout * 1000 > DEFAULT_CLAUDE_TIMEOUT_MS);
	});

	it("does not replace the Claude Code plugin", () => {
		const claudeHooks = readHooks(pluginRoot, "hooks/hooks.json");
		assert.ok(claudeHooks.hooks.UserPromptExpansion);
		assert.ok(
			existsSync(join(pluginRoot, ".claude-plugin/plugin.json")),
			"Claude Code manifest",
		);
	});
});

describe("Codex → Claude workflow through the plugin hooks", () => {
	let repo: TemporaryGitRepository;
	let stateDir: string;
	let claude: FakeClaude;
	let env: Record<string, string>;
	const session = "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b";
	let turn = 0;
	const base = (event: string) => ({
		session_id: session,
		turn_id: `turn-${turn}`,
		transcript_path: null,
		cwd: repo.root,
		hook_event_name: event,
		model: "gpt-5.5-codex",
		permission_mode: "default",
	});
	const prompt = (text: string, e = env) => {
		turn++;
		return runPluginHook(
			"UserPromptSubmit",
			{ ...base("UserPromptSubmit"), prompt: text },
			e,
		);
	};
	const stop = (message: string, active = false, e = env) =>
		runPluginHook(
			"Stop",
			{
				...base("Stop"),
				stop_hook_active: active,
				last_assistant_message: message,
			},
			e,
		);
	const taskId = () =>
		(
			JSON.parse(
				readFileSync(join(stateDir, "sessions", `${session}.json`), "utf8"),
			) as { taskId: string }
		).taskId;

	beforeEach(async () => {
		repo = await TemporaryGitRepository.create("my repo");
		await repo.commitFile("app.ts", "export const x = 1;\n");
		stateDir = await makeTempDir("ccc-review-state-");
		claude = await FakeClaude.create();
		// PLUGIN_DATA is where Codex wants plugin state; no CCC_REVIEW_STATE_DIR here.
		env = { PLUGIN_DATA: stateDir, CCC_REVIEW_CLAUDE_BIN: claude.bin };
	});
	afterEach(async () => {
		await repo.dispose();
		await claude.dispose();
		await removeDir(stateDir);
	});

	it("repo → $ccc-review on → completion → fake claude → continuation → fix → approve → persisted state", async () => {
		await claude.script(
			{ output: changesRequested(finding("CCC-001", "x must be 3")) },
			{ output: approved() },
		);

		// Inactive thread: prompts and completions pass straight through.
		assert.equal(prompt("hello"), undefined);
		assert.equal(stop("hello"), undefined);

		const on = prompt("$ccc-review on");
		assert.equal(on?.decision, "block");
		assert.match(String(on?.reason), /enabled\. Claude will review/);
		assert.equal(prompt("make x 3"), undefined);

		await repo.write("app.ts", "export const x = 2;\n");
		const first = stop("Set x to 2.");
		assert.deepEqual(Object.keys(first ?? {}).sort(), ["decision", "reason"]);
		assert.equal(first?.decision, "block");
		assert.match(String(first?.reason), /Claude requested changes/);
		assert.match(String(first?.reason), /CCC-001/);
		const persisted = await loadState(join(stateDir, "tasks"), taskId());
		assert.equal(persisted?.round, 1);
		assert.equal(persisted?.active, true);

		// Codex continues the turn with the findings as a new prompt.
		await repo.write("app.ts", "export const x = 3;\n");
		const second = stop("CCC-001: fixed.", true);
		assert.equal(second?.decision, undefined);
		assert.match(String(second?.systemMessage), /Claude APPROVED/);

		const final = await loadState(join(stateDir, "tasks"), taskId());
		assert.equal(final?.round, 2);
		assert.equal(final?.active, false);
		assert.equal(final?.writer, "codex");
		assert.equal(final?.lastResult?.verdict, "APPROVED");

		const calls = await claude.calls();
		assert.equal(calls.length, 2);
		assert.equal(calls[0]?.cwd, repo.root);
		assert.equal(calls[0]?.argv[0], "-p");
		assert.match(calls[0]?.stdin ?? "", /make x 3/);
		assert.match(calls[0]?.stdin ?? "", /\+export const x = 2;/);
		assert.equal(stop("CCC-001: fixed.", true), undefined);
		assert.equal((await claude.calls()).length, 2);

		const status = prompt("$ccc-review status");
		assert.match(String(status?.reason), /round 2: APPROVED/);
	});

	it("missing claude binary fails fast with the default timeout and is not approval", () => {
		prompt("$ccc-review on");
		const started = Date.now();
		const out = stop("done", false, {
			PLUGIN_DATA: stateDir,
			CCC_REVIEW_CLAUDE_BIN: join(stateDir, "missing-claude"),
		});
		assert.ok(Date.now() - started < 20_000);
		assert.equal(out?.decision, undefined);
		assert.match(String(out?.systemMessage), /NOT approved[\s\S]*not found/);
	});

	it("aborting the Stop hook kills the whole claude process group", async (t) => {
		await claude.script({ sleepMs: 30_000, childSleepMs: 30_000 });
		prompt("$ccc-review on");
		const hook = spawn(
			process.execPath,
			[join(pluginRoot, "src/hosts/codex/cli.ts"), "stop"],
			{ env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] },
		);
		// A failing assertion below must not leave the hook and its group running.
		t.after(() => stopHook(hook));
		hook.stdin.end(
			JSON.stringify({
				...base("Stop"),
				stop_hook_active: false,
				last_assistant_message: "done",
			}),
		);
		const childPid = await waitFor(async () => {
			try {
				return await claude.childPid();
			} catch {
				return undefined;
			}
		});
		const exited = new Promise<void>((r) => hook.on("exit", () => r()));
		hook.kill("SIGTERM");
		await exited;
		await assertGone(childPid);
		const state = await loadState(join(stateDir, "tasks"), taskId());
		assert.equal(state?.active, false);
		assert.equal(state?.lastResult, undefined);
		assert.match(state?.lastError ?? "", /claude review aborted \(SIGTERM\)/);
		const history = await readHistory(join(stateDir, "history"), taskId());
		assert.equal(history.at(-1)?.outcome, "reviewer_error");
		assert.equal(existsSync(join(stateDir, "claims", taskId())), false);
	});

	it("garbage stdin and bad config never block or crash the hook", () => {
		const out = runHookCommand(
			hookCommand("Stop"),
			pluginRoot,
			"garbage",
			{ PLUGIN_DATA: stateDir, CCC_REVIEW_CLAUDE_TIMEOUT_MS: "soon" },
			repo.root,
		);
		assert.ok(out);
		assert.deepEqual(Object.keys(out), ["systemMessage"]);
		assert.match(String(out.systemMessage), /CCC Review error/);
	});
});
