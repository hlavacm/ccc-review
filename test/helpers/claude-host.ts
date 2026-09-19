import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadState, type TaskState } from "../../src/core/state.ts";
import {
	type HookOutput,
	type HostConfig,
	runHook,
} from "../../src/hosts/claude-code/hooks.ts";

/**
 * Drives the Claude Code host through realistic hook payloads (the JSON
 * Claude Code writes to a hook's stdin) for one session.
 */
export class ClaudeHostHarness {
	readonly sessionId: string;
	readonly config: HostConfig;
	readonly cwd: string;

	constructor(
		config: HostConfig,
		cwd: string,
		sessionId = "5f1c2d3e-0000-4a4a-9b9b-000000000001",
	) {
		this.config = config;
		this.cwd = cwd;
		this.sessionId = sessionId;
	}

	private common(event: string) {
		return {
			session_id: this.sessionId,
			transcript_path: `/home/u/.claude/projects/x/${this.sessionId}.jsonl`,
			cwd: this.cwd,
			permission_mode: "default",
			hook_event_name: event,
		};
	}

	/** `/ccc-review:ccc-review <args>` typed by the user. */
	command(
		args: string,
		commandName = "ccc-review:ccc-review",
	): Promise<HookOutput | undefined> {
		return this.send("command", {
			...this.common("UserPromptExpansion"),
			expansion_type: "slash_command",
			command_name: commandName,
			command_args: args,
			command_source: "plugin",
			prompt: `/${commandName} ${args}`,
		});
	}

	prompt(prompt: string): Promise<HookOutput | undefined> {
		return this.send("prompt-submit", {
			...this.common("UserPromptSubmit"),
			prompt,
		});
	}

	/** Claude finished a turn. */
	stop(
		lastMessage: string,
		stopHookActive = false,
	): Promise<HookOutput | undefined> {
		return this.send("stop", {
			...this.common("Stop"),
			stop_hook_active: stopHookActive,
			last_assistant_message: lastMessage,
		});
	}

	send(event: string, payload: unknown): Promise<HookOutput | undefined> {
		return runHook(event, JSON.stringify(payload), () => this.config);
	}

	async state(): Promise<TaskState | undefined> {
		const taskId = await this.taskId();
		return taskId === undefined
			? undefined
			: loadState(join(this.config.stateDir, "tasks"), taskId);
	}

	async taskId(): Promise<string | undefined> {
		try {
			const raw = await readFile(
				join(this.config.stateDir, "sessions", `${this.sessionId}.json`),
				"utf8",
			);
			return (JSON.parse(raw) as { taskId: string }).taskId;
		} catch {
			return undefined;
		}
	}
}
