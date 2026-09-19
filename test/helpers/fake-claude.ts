import type { FakeClaudeStep } from "../fixtures/fake-claude.ts";
import { FakeCli } from "./fake-cli.ts";

export type { FakeClaudeStep };

/** Fake `claude` executable; see test/fixtures/fake-claude.ts. */
export class FakeClaude extends FakeCli<FakeClaudeStep> {
	static async create(...steps: FakeClaudeStep[]): Promise<FakeClaude> {
		const fake = new FakeClaude(
			await FakeCli.tempDir("ccc-review-fake-claude-"),
			"claude",
		);
		return FakeCli.setup(fake, "fake-claude.ts", steps);
	}
}
