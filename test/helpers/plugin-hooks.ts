import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { TemporaryGitRepository } from "./temp-git-repo.ts";

export interface HookEntry {
	matcher?: string;
	hooks: { type: string; command: string; timeout?: number }[];
}

export type HooksJson = { hooks: Record<string, HookEntry[]> };

export function readHooks(pluginRoot: string, hooksFile: string): HooksJson {
	return JSON.parse(
		readFileSync(join(pluginRoot, hooksFile), "utf8"),
	) as HooksJson;
}

export function hookCommand(hooks: HooksJson, event: string): string {
	const command = hooks.hooks[event]?.[0]?.hooks[0]?.command;
	assert.ok(command, `no ${event} hook`);
	return command;
}

/**
 * Runs a hook command line exactly as registered in a hooks.json, the way
 * Claude Code and Codex do: via a shell with the plugin root in the
 * environment (CLAUDE_PLUGIN_ROOT / PLUGIN_ROOT), the payload on stdin and
 * the session cwd as working directory. Returns the parsed JSON output.
 */
export function runHookCommand(
	command: string,
	pluginRoot: string,
	stdin: string,
	env: Record<string, string>,
	cwd = process.cwd(),
): Record<string, unknown> | undefined {
	const run = spawnSync("/bin/sh", ["-c", command], {
		input: stdin,
		cwd,
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			// `node` in the hook command resolves to the Node running the tests.
			PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
			CLAUDE_PLUGIN_ROOT: pluginRoot,
			PLUGIN_ROOT: pluginRoot,
			...env,
		},
	});
	assert.equal(run.error, undefined, `hook did not finish: ${run.error}`);
	assert.equal(run.status, 0, run.stderr);
	return run.stdout.trim() === "" ? undefined : JSON.parse(run.stdout);
}

/**
 * Files a clone of the repository gets (tracked plus untracked-but-not-ignored),
 * i.e. what a plugin install from Git contains. Read-only git.
 */
export function packagedFiles(root: string): string[] {
	return execFileSync(
		"git",
		[
			"--no-optional-locks",
			"ls-files",
			"-z",
			"--cached",
			"--others",
			"--exclude-standard",
		],
		{ cwd: root, encoding: "utf8" },
	)
		.split("\0")
		.filter((f) => f !== "" && existsSync(join(root, f)));
}

/** Copies exactly the packaged files of `root` to `dest`. */
export function copyPackage(root: string, dest: string): void {
	for (const file of packagedFiles(root))
		cpSync(join(root, file), join(dest, file));
}

/**
 * Through the hooks of the plugin installed at `pluginRoot`: turns review on
 * in `repo` (Claude Code `/ccc-review:ccc-review on`, Codex `$ccc-review on`), lets the writer
 * change a file and finish, and returns the Stop hook's output.
 */
export async function completeArmedTurn(
	host: "claude" | "codex",
	pluginRoot: string,
	repo: TemporaryGitRepository,
	session: string,
	env: Record<string, string>,
): Promise<Record<string, unknown> | undefined> {
	const hooks =
		host === "claude"
			? readHooks(pluginRoot, "hooks/hooks.json")
			: readHooks(
					pluginRoot,
					JSON.parse(
						readFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"),
					).hooks,
				);
	const common =
		host === "claude"
			? { transcript_path: `/tmp/${session}.jsonl` }
			: { turn_id: "turn-1", transcript_path: null, model: "gpt-5.5-codex" };
	const run = (event: string, payload: object) =>
		runHookCommand(
			hookCommand(hooks, event),
			pluginRoot,
			JSON.stringify({
				session_id: session,
				cwd: repo.root,
				permission_mode: "default",
				hook_event_name: event,
				...common,
				...payload,
			}),
			env,
			repo.root,
		);
	const on =
		host === "claude"
			? run("UserPromptExpansion", {
					expansion_type: "slash_command",
					command_name: "ccc-review:ccc-review",
					command_args: "on make x 2",
					command_source: "plugin",
					prompt: "/ccc-review:ccc-review on make x 2",
				})
			: run("UserPromptSubmit", { prompt: "$ccc-review on make x 2" });
	assert.match(String(on?.reason), /enabled/);
	await repo.write("app.ts", `export const x = 2; // ${session}\n`);
	return run("Stop", {
		stop_hook_active: false,
		last_assistant_message: `Set x to 2 (${session}).`,
	});
}
