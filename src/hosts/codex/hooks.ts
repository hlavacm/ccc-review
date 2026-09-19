import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	CLAUDE_EFFORTS,
	ClaudeReviewer,
	DEFAULT_CLAUDE_TIMEOUT_MS,
} from "../../reviewers/claude.ts";
import {
	type HookOutput,
	type HostConfig,
	oneOf,
	positiveInt,
	type Roles,
	recordPrompt,
	reviewCompletion,
	runCommand,
} from "../common.ts";

export type { HookOutput, HostConfig };

const ROLES: Roles = { writer: "codex", reviewer: "claude" };

/** Codex hook payload fields we rely on (Codex sends more). */
export interface HookInput {
	session_id?: unknown;
	turn_id?: unknown;
	cwd?: unknown;
	prompt?: unknown;
	last_assistant_message?: unknown;
	/** Present only when the prompt belongs to a subagent. */
	agent_id?: unknown;
}

/**
 * `$cccr …` (explicit skill mention) or the plugin-namespaced `$cccr:cccr …`.
 * Group 1 = the arguments.
 */
const COMMAND = /^\$cccr(?::cccr)?(?:\s+([\s\S]*))?$/;

export function configFromEnv(env: NodeJS.ProcessEnv): HostConfig {
	const effort = oneOf(env, "CCCR_CLAUDE_EFFORT", CLAUDE_EFFORTS);
	const config: HostConfig = {
		// Codex gives plugin hooks PLUGIN_DATA (and CLAUDE_PLUGIN_DATA too).
		stateDir: env.CCCR_STATE_DIR || env.PLUGIN_DATA || join(homedir(), ".cccr"),
		reviewer: new ClaudeReviewer({
			bin: env.CCCR_CLAUDE_BIN || "claude",
			timeoutMs:
				positiveInt(env, "CCCR_CLAUDE_TIMEOUT_MS") ?? DEFAULT_CLAUDE_TIMEOUT_MS,
			...(env.CCCR_CLAUDE_MODEL ? { model: env.CCCR_CLAUDE_MODEL } : {}),
			...(effort ? { effort } : {}),
			env,
		}),
	};
	const maxRounds = positiveInt(env, "CCCR_MAX_ROUNDS");
	if (maxRounds !== undefined) config.maxRounds = maxRounds;
	return config;
}

const promptText = (input: HookInput) =>
	typeof input.prompt === "string" ? input.prompt.trim() : "";

/**
 * UserPromptSubmit sees every prompt. `$cccr on [task] | off | status` is
 * handled here and blocked, so it never reaches the model; while review is
 * active any other main-agent prompt is recorded as the task.
 */
export async function handlePromptSubmit(
	c: HostConfig,
	input: HookInput,
): Promise<HookOutput | undefined> {
	const prompt = promptText(input);
	const command = COMMAND.exec(prompt);
	if (command)
		return {
			decision: "block",
			reason: await runCommand(
				c,
				ROLES,
				input.session_id,
				input.cwd,
				(command[1] ?? "").trim(),
			),
		};
	if (!prompt || input.agent_id !== undefined) return undefined;
	await recordPrompt(c, ROLES, input.session_id, prompt);
	return undefined;
}

/** Stop: one logical completion → at most one review round. */
export async function handleStop(
	c: HostConfig,
	input: HookInput,
): Promise<HookOutput | undefined> {
	const report =
		typeof input.last_assistant_message === "string"
			? input.last_assistant_message
			: "";
	// A redelivered Stop repeats turn and message. The message is part of the
	// key because a continuation may keep its turn_id.
	const turn = typeof input.turn_id === "string" ? input.turn_id : "";
	const key = createHash("sha256").update(`${turn}\0${report}`).digest("hex");
	return reviewCompletion(c, ROLES, input.session_id, key, report);
}

const HANDLERS = {
	"prompt-submit": handlePromptSubmit,
	stop: handleStop,
};

function isCommand(stdin: string): boolean {
	try {
		return COMMAND.test(promptText(JSON.parse(stdin) as HookInput));
	} catch {
		return false;
	}
}

/**
 * Entry point for one hook invocation. Any failure (bad payload, bad config,
 * corrupt state) is reported to the user and never blocks the writer or
 * approves.
 */
export async function runHook(
	event: string | undefined,
	stdin: string,
	getConfig: () => HostConfig,
): Promise<HookOutput | undefined> {
	try {
		const handler = HANDLERS[event as keyof typeof HANDLERS];
		if (!handler)
			throw new Error(`unknown hook event ${JSON.stringify(event)}`);
		const input: unknown = JSON.parse(stdin);
		if (typeof input !== "object" || input === null)
			throw new Error("hook input is not a JSON object");
		return await handler(getConfig(), input as HookInput);
	} catch (error) {
		const message = `CCC Review error: ${(error as Error).message}`;
		// A failed $cccr command must not fall through to the model.
		return event === "prompt-submit" && isCommand(stdin)
			? { decision: "block", reason: message }
			: { systemMessage: message };
	}
}
