import type { TaskState } from "./state.ts";
import {
	type Finding,
	findingNumber,
	parseReviewResult,
	type ReviewContext,
	type Reviewer,
	type ReviewRequest,
} from "./types.ts";

export type RoundOutcome =
	/** Reviewer approved; task finished. */
	| "approved"
	/** Findings must go back to the writer; the task stays active. */
	| "changes_requested"
	/** Reviewer asked for a human; task stopped. */
	| "needs_human"
	/** Round limit reached without approval; task stopped. */
	| "max_rounds"
	/** Reviewer failed or returned invalid output; task stopped, NOT approved. */
	| "reviewer_error"
	/** Task is not active; reviewer was not called. */
	| "inactive";

export interface RoundResult {
	state: TaskState;
	outcome: RoundOutcome;
}

/**
 * Runs at most one review round. The host calls this once per writer
 * completion. Never mutates `state`; the caller persists the returned state.
 */
export async function runReviewRound(
	state: TaskState,
	reviewer: Reviewer,
	context?: ReviewContext,
): Promise<RoundResult> {
	if (!state.active) return { state, outcome: "inactive" };
	if (state.round >= state.maxRounds)
		return { state: { ...state, active: false }, outcome: "max_rounds" };

	const round = state.round + 1;
	// A state saved before lastFindingNumber existed: use its last result.
	const used =
		state.lastFindingNumber ?? highest(state.lastResult?.findings ?? []);
	const request: ReviewRequest = {
		taskId: state.taskId,
		round,
		baseline: state.baseline,
		nextFindingNumber: used + 1,
	};
	if (state.lastResult) request.previous = state.lastResult;
	if (context) request.context = context;

	const { lastError: _, ...rest } = state;
	const next: TaskState = { ...rest, round };

	let result: ReturnType<typeof parseReviewResult>;
	try {
		// Re-validate: a reviewer adapter bug must not smuggle in an approval.
		result = parseReviewResult(await reviewer.review(request));
	} catch (error) {
		return {
			state: { ...next, active: false, lastError: errorMessage(error) },
			outcome: "reviewer_error",
		};
	}

	next.lastResult = result;
	next.lastFindingNumber = Math.max(used, highest(result.findings));
	switch (result.verdict) {
		case "APPROVED":
			return { state: { ...next, active: false }, outcome: "approved" };
		case "NEEDS_HUMAN":
			return { state: { ...next, active: false }, outcome: "needs_human" };
		case "CHANGES_REQUESTED":
			return round >= state.maxRounds
				? { state: { ...next, active: false }, outcome: "max_rounds" }
				: { state: next, outcome: "changes_requested" };
	}
}

const highest = (findings: Finding[]) =>
	Math.max(0, ...findings.map((f) => findingNumber(f.id)));

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
