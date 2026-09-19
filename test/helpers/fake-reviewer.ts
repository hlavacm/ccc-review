import type {
	Finding,
	Reviewer,
	ReviewRequest,
	ReviewResult,
} from "../../src/core/types.ts";

/** A scripted step: a result to return, or an Error to throw. */
export type FakeStep = ReviewResult | Error | unknown;

export class FakeReviewer implements Reviewer {
	readonly requests: ReviewRequest[] = [];
	private readonly steps: FakeStep[];

	constructor(...steps: FakeStep[]) {
		this.steps = steps;
	}

	async review(request: ReviewRequest): Promise<ReviewResult> {
		this.requests.push(structuredClone(request));
		if (this.steps.length === 0)
			throw new Error("FakeReviewer: no scripted step left");
		const step = this.steps.shift();
		if (step instanceof Error) throw step;
		return step as ReviewResult;
	}
}

export const finding = (id = "CCC-001", message = "bug"): Finding => ({
	id,
	severity: "high",
	message,
});

export const approved = (): ReviewResult => ({
	verdict: "APPROVED",
	summary: "looks good",
	findings: [],
});

export const changesRequested = (...findings: Finding[]): ReviewResult => ({
	verdict: "CHANGES_REQUESTED",
	summary: "fix things",
	findings: findings.length > 0 ? findings : [finding()],
});

export const needsHuman = (): ReviewResult => ({
	verdict: "NEEDS_HUMAN",
	summary: "ambiguous requirement",
	findings: [],
});
