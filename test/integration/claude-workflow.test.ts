import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadState, readHistory } from "../../src/core/state.ts";
import { DEFAULT_CODEX_TIMEOUT_MS } from "../../src/reviewers/codex.ts";
import { FakeCodex } from "../helpers/fake-codex.ts";
import {
	approved,
	changesRequested,
	finding,
} from "../helpers/fake-reviewer.ts";
import { makeTempDir, removeDir } from "../helpers/temp-dir.ts";
import { TemporaryGitRepository } from "../helpers/temp-git-repo.ts";

const pluginRoot = join(import.meta.dirname, "../..");

async function waitFor<T>(probe: () => Promise<T | undefined>): Promise<T> {
	for (let i = 0; i < 200; i++) {
		const value = await probe();
		if (value !== undefined) return value;
		await new Promise((r) => setTimeout(r, 25));
	}
	assert.fail("condition not reached");
}

async function assertGone(pid: number): Promise<void> {
	await waitFor(async () => {
		try {
			process.kill(pid, 0);
			return undefined;
		} catch {
			return true;
		}
	});
}

interface HookEntry {
	matcher?: string;
	hooks: { type: string; command: string; timeout?: number }[];
}
const hooksJson = JSON.parse(
	readFileSync(join(pluginRoot, "hooks/hooks.json"), "utf8"),
) as { hooks: Record<string, HookEntry[]> };

function hookCommand(event: string): string {
	const command = hooksJson.hooks[event]?.[0]?.hooks[0]?.command;
	assert.ok(command, `no ${event} hook`);
	return command;
}

/**
 * Claude Code's documented matcher rules (hooks reference, "Matcher
 * patterns"): only letters, digits, `_`, `-`, spaces, `,` and `|` means an
 * exact string or list of them; anything else is an unanchored RegExp test.
 */
function claudeCodeMatches(matcher: string, value: string): boolean {
	if (/^[A-Za-z0-9_\- ,|]*$/.test(matcher))
		return matcher.split(/[|,]/).some((m) => m.trim() === value);
	return new RegExp(matcher).test(value);
}

const PLUGIN_ROOT_VAR = "$" + "{CLAUDE_PLUGIN_ROOT}";

/**
 * Runs a hook exactly as registered in hooks/hooks.json, the way Claude Code
 * does: the command line via a shell, the payload on stdin.
 */
function spawnHook(event: string, stdin: string, env: Record<string, string>) {
	const command = hookCommand(event).replaceAll(PLUGIN_ROOT_VAR, pluginRoot);
	const run = spawnSync("/bin/sh", ["-c", command], {
		input: stdin,
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			// `node` in the hook command resolves to the Node running the tests.
			PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
			...env,
		},
	});
	assert.equal(run.error, undefined, `hook did not finish: ${run.error}`);
	assert.equal(run.status, 0, run.stderr);
	return run.stdout.trim() === "" ? undefined : JSON.parse(run.stdout);
}

const runPluginHook = (
	event: string,
	payload: object,
	env: Record<string, string>,
): Record<string, unknown> | undefined => {
	// Like Claude Code: a matcher group only runs when its matcher matches.
	const matcher = hooksJson.hooks[event]?.[0]?.matcher;
	const name = (payload as { command_name?: string }).command_name;
	if (matcher !== undefined && !claudeCodeMatches(matcher, name ?? ""))
		return undefined;
	return spawnHook(event, JSON.stringify(payload), env);
};

describe("plugin manifest", () => {
	it("plugin.json, marketplace and skill exist and are well-formed", () => {
		const plugin = JSON.parse(
			readFileSync(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8"),
		);
		assert.equal(plugin.name, "cccr");
		const market = JSON.parse(
			readFileSync(join(pluginRoot, ".claude-plugin/marketplace.json"), "utf8"),
		);
		assert.equal(market.plugins[0].name, "cccr");
		assert.equal(market.plugins[0].source, "./");
		const skill = readFileSync(
			join(pluginRoot, "skills/cccr/SKILL.md"),
			"utf8",
		);
		assert.match(
			skill,
			/^---\n[\s\S]*disable-model-invocation: true[\s\S]*\n---\n/,
		);
	});

	it("hooks point at existing entry points with expected events", () => {
		assert.deepEqual(Object.keys(hooksJson.hooks).sort(), [
			"Stop",
			"UserPromptExpansion",
			"UserPromptSubmit",
		]);
		for (const event of Object.keys(hooksJson.hooks)) {
			const [, script] =
				/"\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(hookCommand(event)) ?? [];
			assert.ok(script && existsSync(join(pluginRoot, script)), event);
		}
	});

	// Regression: the bare `cccr` matcher is an exact-string match in Claude
	// Code, so the namespaced `/cccr:cccr` never reached the command hook.
	it("command matcher selects both command names and nothing else", () => {
		const matcher = hooksJson.hooks.UserPromptExpansion?.[0]?.matcher;
		assert.ok(matcher);
		for (const name of ["cccr", "cccr:cccr"])
			assert.ok(claudeCodeMatches(matcher, name), name);
		for (const name of [
			"deploy",
			"cccr:on",
			"other:cccr",
			"cccrx",
			"mycccr",
			"cccr-x",
		])
			assert.ok(!claudeCodeMatches(matcher, name), name);
	});

	it("matcher evaluation follows the documented rules", () => {
		assert.ok(claudeCodeMatches("cccr", "cccr"));
		assert.ok(!claudeCodeMatches("cccr", "cccr:cccr"));
		assert.ok(claudeCodeMatches("Edit|Write", "Write"));
		assert.ok(claudeCodeMatches("Edit.*", "NotebookEdit"));
	});

	it("Stop hook timeout outlasts the Codex timeout", () => {
		const timeout = hooksJson.hooks.Stop?.[0]?.hooks[0]?.timeout ?? 600;
		assert.ok(timeout * 1000 > DEFAULT_CODEX_TIMEOUT_MS);
	});
});

describe("Claude → Codex workflow through the plugin hooks", () => {
	let repo: TemporaryGitRepository;
	let stateDir: string;
	let codex: FakeCodex;
	let env: Record<string, string>;
	const session = "0b6c1a2e-5d4f-4c3b-8a79-6e5d4c3b2a10";
	const base = (event: string) => ({
		session_id: session,
		transcript_path: `/home/u/.claude/projects/p/${session}.jsonl`,
		cwd: repo.root,
		permission_mode: "default",
		hook_event_name: event,
	});

	beforeEach(async () => {
		repo = await TemporaryGitRepository.create("my repo");
		await repo.commitFile("app.ts", "export const x = 1;\n");
		stateDir = await makeTempDir("cccr-state-");
		codex = await FakeCodex.create();
		env = { CCCR_STATE_DIR: stateDir, CCCR_CODEX_BIN: codex.bin };
	});
	afterEach(async () => {
		await repo.dispose();
		await codex.dispose();
		await removeDir(stateDir);
	});

	it("repo → armed host → completion → fake codex → block → fix → approve → persisted state", async () => {
		await codex.script(
			{ output: changesRequested(finding("CCC-001", "x must be 3")) },
			{ output: approved() },
		);
		const stop = (message: string, active: boolean) =>
			runPluginHook(
				"Stop",
				{
					...base("Stop"),
					stop_hook_active: active,
					last_assistant_message: message,
				},
				env,
			);

		// Inactive session: completion passes straight through.
		assert.equal(stop("hello", false), undefined);

		const on = runPluginHook(
			"UserPromptExpansion",
			{
				...base("UserPromptExpansion"),
				expansion_type: "slash_command",
				command_name: "cccr:cccr",
				command_args: "on",
				command_source: "plugin",
				prompt: "/cccr:cccr on",
			},
			env,
		);
		assert.equal(on?.decision, "block");
		assert.match(String(on?.reason), /enabled/);

		assert.equal(
			runPluginHook(
				"UserPromptSubmit",
				{ ...base("UserPromptSubmit"), prompt: "make x 3" },
				env,
			),
			undefined,
		);

		await repo.write("app.ts", "export const x = 2;\n");
		const first = stop("Set x to 2.", false);
		assert.equal(first?.decision, "block");
		assert.match(String(first?.reason), /CCC-001/);

		const sessionFile = JSON.parse(
			readFileSync(join(stateDir, "sessions", `${session}.json`), "utf8"),
		) as { taskId: string };
		const persisted = await loadState(
			join(stateDir, "tasks"),
			sessionFile.taskId,
		);
		assert.equal(persisted?.round, 1);
		assert.equal(persisted?.active, true);

		await repo.write("app.ts", "export const x = 3;\n");
		const second = stop("CCC-001: fixed.", true);
		assert.equal(second?.decision, undefined);
		assert.match(String(second?.systemMessage), /APPROVED/);

		const final = await loadState(join(stateDir, "tasks"), sessionFile.taskId);
		assert.equal(final?.round, 2);
		assert.equal(final?.active, false);
		assert.equal(final?.lastResult?.verdict, "APPROVED");

		const calls = await codex.calls();
		assert.equal(calls.length, 2);
		assert.equal(calls[0]?.cwd, repo.root);
		assert.match(calls[0]?.stdin ?? "", /make x 3/);
		assert.equal(stop("CCC-001: fixed. again", false), undefined);
		assert.equal((await codex.calls()).length, 2);
	});

	// Regression: a spawn error left Node's spawn `timeout` timer armed, so the
	// Stop hook hung for the whole Codex timeout (20 min) when codex was missing.
	it("missing codex binary fails fast with default timeout and is not approval", () => {
		const e = {
			CCCR_STATE_DIR: stateDir,
			CCCR_CODEX_BIN: join(stateDir, "missing-codex"),
		};
		// Enabled while codex was available; it is gone by the time Claude stops.
		runPluginHook(
			"UserPromptExpansion",
			{
				...base("UserPromptExpansion"),
				command_name: "cccr:cccr",
				command_args: "on",
			},
			env,
		);
		const started = Date.now();
		const out = runPluginHook(
			"Stop",
			{
				...base("Stop"),
				stop_hook_active: false,
				last_assistant_message: "done",
			},
			e,
		);
		assert.ok(Date.now() - started < 20_000);
		assert.equal(out?.decision, undefined);
		assert.match(String(out?.systemMessage), /NOT approved[\s\S]*not found/);
	});

	// Regression: codex runs in its own process group, so killing the Stop hook
	// (user interrupt, Claude Code giving up) left codex and its children running.
	it("aborting the Stop hook kills the whole codex process group", async () => {
		await codex.script({ sleepMs: 30_000, childSleepMs: 30_000 });
		runPluginHook(
			"UserPromptExpansion",
			{
				...base("UserPromptExpansion"),
				command_name: "cccr:cccr",
				command_args: "on",
			},
			env,
		);
		const hook = spawn(
			process.execPath,
			[join(pluginRoot, "src/hosts/claude-code/cli.ts"), "stop"],
			{ env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] },
		);
		hook.stdin.end(
			JSON.stringify({
				...base("Stop"),
				stop_hook_active: false,
				last_assistant_message: "done",
			}),
		);
		// Wait until codex and its grandchild are running.
		const childPid = await waitFor(async () => {
			try {
				return await codex.childPid();
			} catch {
				return undefined;
			}
		});
		const codexPid = await waitFor(async () =>
			(await codex.calls()).length > 0 ? true : undefined,
		);
		assert.ok(codexPid);
		const exited = new Promise<void>((r) => hook.on("exit", () => r()));
		hook.kill("SIGTERM");
		await exited;
		await assertGone(childPid);
		assert.equal(
			(await codex.calls()).length,
			1,
			"codex must not be started again",
		);
		// Regression: the aborted round left the task active with its claim
		// held and nothing in the history, so it could only be recovered by
		// off → on. It is now a recorded reviewer error: stopped, NOT approved.
		const tasks = join(stateDir, "tasks");
		const taskId = (
			JSON.parse(
				readFileSync(join(stateDir, "sessions", `${session}.json`), "utf8"),
			) as { taskId: string }
		).taskId;
		const state = await loadState(tasks, taskId);
		assert.equal(state?.active, false);
		assert.equal(state?.lastResult, undefined);
		assert.match(state?.lastError ?? "", /aborted \(SIGTERM\)/);
		const history = await readHistory(join(stateDir, "history"), taskId);
		assert.equal(history.at(-1)?.outcome, "reviewer_error");
		assert.match(history.at(-1)?.error ?? "", /aborted/);
		assert.equal(existsSync(join(stateDir, "claims", taskId)), false);

		// Recovery: a plain `on` starts a fresh task that reviews the same completion.
		await codex.script({ output: approved() });
		const on = runPluginHook(
			"UserPromptExpansion",
			{
				...base("UserPromptExpansion"),
				command_name: "cccr:cccr",
				command_args: "on",
			},
			env,
		);
		assert.match(String(on?.reason), /enabled/);
		const again = runPluginHook(
			"Stop",
			{
				...base("Stop"),
				stop_hook_active: false,
				last_assistant_message: "done",
			},
			env,
		);
		assert.match(String(again?.systemMessage), /APPROVED/);
	});

	it("garbage stdin and bad config never block or crash the hook", () => {
		const out = spawnHook("Stop", "garbage", {
			CCCR_STATE_DIR: stateDir,
			CCCR_CODEX_TIMEOUT_MS: "soon",
		});
		assert.equal(out.decision, undefined);
		assert.match(out.systemMessage, /CCC Review error/);
	});
});
