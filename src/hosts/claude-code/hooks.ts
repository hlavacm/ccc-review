import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	CodexReviewer,
	DEFAULT_CODEX_TIMEOUT_MS,
	REASONING_EFFORTS,
} from "../../reviewers/codex.ts";
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

const ROLES: Roles = { writer: "claude", reviewer: "codex" };

/** Hook payload fields we rely on (Claude Code sends more). */
export interface HookInput {
	session_id?: unknown;
	cwd?: unknown;
	command_name?: unknown;
	command_args?: unknown;
	prompt?: unknown;
	last_assistant_message?: unknown;
	/** Present only when the hook fires inside a subagent. */
	agent_id?: unknown;
}

export function configFromEnv(env: NodeJS.ProcessEnv): HostConfig {
	const effort = oneOf(
		env,
		"CCC_REVIEW_CODEX_REASONING_EFFORT",
		REASONING_EFFORTS,
	);
	const config: HostConfig = {
		stateDir:
			env.CCC_REVIEW_STATE_DIR ||
			env.CLAUDE_PLUGIN_DATA ||
			join(homedir(), ".ccc-review"),
		reviewer: new CodexReviewer({
			bin: env.CCC_REVIEW_CODEX_BIN || "codex",
			timeoutMs:
				positiveInt(env, "CCC_REVIEW_CODEX_TIMEOUT_MS") ??
				DEFAULT_CODEX_TIMEOUT_MS,
			...(env.CCC_REVIEW_CODEX_MODEL
				? { model: env.CCC_REVIEW_CODEX_MODEL }
				: {}),
			...(effort ? { reasoningEffort: effort } : {}),
			env,
		}),
	};
	const maxRounds = positiveInt(env, "CCC_REVIEW_MAX_ROUNDS");
	if (maxRounds !== undefined) config.maxRounds = maxRounds;
	return config;
}

/** UserPromptExpansion: `/ccc-review:ccc-review on [task] | off | status`. */
export async function handleCommand(
	c: HostConfig,
	input: HookInput,
): Promise<HookOutput | undefined> {
	if (
		input.command_name !== "ccc-review" &&
		input.command_name !== "ccc-review:ccc-review"
	)
		return undefined;
	const args =
		typeof input.command_args === "string" ? input.command_args.trim() : "";
	return {
		decision: "block",
		reason: await runCommand(c, ROLES, input.session_id, input.cwd, args),
	};
}

/** UserPromptSubmit: remember the user's task text while review is active. */
export async function handlePromptSubmit(
	c: HostConfig,
	input: HookInput,
): Promise<HookOutput | undefined> {
	const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	if (!prompt || prompt.startsWith("/")) return undefined;
	await recordPrompt(c, ROLES, input.session_id, prompt);
	return undefined;
}

/** Stop: one logical completion → at most one review round. */
export async function handleStop(
	c: HostConfig,
	input: HookInput,
): Promise<HookOutput | undefined> {
	// Only the main writer's completion is reviewed, never a subagent's.
	if (input.agent_id !== undefined) return undefined;
	const report =
		typeof input.last_assistant_message === "string"
			? input.last_assistant_message
			: "";
	// Claude Code sends no event id; the same final message is the same completion.
	const key = createHash("sha256").update(report).digest("hex");
	return reviewCompletion(c, ROLES, input.session_id, key, report);
}

const HANDLERS = {
	command: handleCommand,
	"prompt-submit": handlePromptSubmit,
	stop: handleStop,
};

/**
 * Entry point for one hook invocation. Any failure (bad payload, bad config,
 * corrupt state) is reported to the user and never blocks or approves.
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
		// A failed /ccc-review command must not fall through to the model.
		return event === "command"
			? { decision: "block", reason: message }
			: { systemMessage: message };
	}
}
