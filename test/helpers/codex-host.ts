import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadState, type TaskState } from "../../src/core/state.ts";
import {
	type HookOutput,
	type HostConfig,
	runHook,
} from "../../src/hosts/codex/hooks.ts";

/**
 * Drives the Codex host through realistic hook payloads (the JSON Codex
 * writes to a hook's stdin, codex-rs hooks/src/schema.rs) for one thread.
 * Every submitted prompt starts a new turn; Stop reports the current one.
 */
export class CodexHostHarness {
	readonly sessionId: string;
	readonly config: HostConfig;
	readonly cwd: string;
	turnId = randomUUID();

	constructor(
		config: HostConfig,
		cwd: string,
		sessionId = "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b",
	) {
		this.config = config;
		this.cwd = cwd;
		this.sessionId = sessionId;
	}

	private common(event: string) {
		return {
			session_id: this.sessionId,
			turn_id: this.turnId,
			transcript_path: `/home/u/.codex/sessions/2026/09/19/rollout-${this.sessionId}.jsonl`,
			cwd: this.cwd,
			hook_event_name: event,
			model: "gpt-5.5-codex",
			permission_mode: "default",
		};
	}

	/** The user types a prompt; a new turn starts. */
	prompt(prompt: string, extra: object = {}): Promise<HookOutput | undefined> {
		this.turnId = randomUUID();
		return this.send("prompt-submit", {
			...this.common("UserPromptSubmit"),
			prompt,
			...extra,
		});
	}

	/** `$cccr <args>` typed by the user. */
	command(args: string, mention = "$cccr"): Promise<HookOutput | undefined> {
		return this.prompt(`${mention} ${args}`);
	}

	/** Codex finished the current turn. */
	stop(
		lastMessage: string | null,
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
