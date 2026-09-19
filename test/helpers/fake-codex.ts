import type { FakeCodexStep } from "../fixtures/fake-codex.ts";
import { FakeCli } from "./fake-cli.ts";

export type { FakeCodexStep };

/** Fake `codex` executable; see test/fixtures/fake-codex.ts. */
export class FakeCodex extends FakeCli<FakeCodexStep> {
	static async create(...steps: FakeCodexStep[]): Promise<FakeCodex> {
		const fake = new FakeCodex(
			await FakeCli.tempDir("ccc-review-fake-codex-"),
			"codex",
		);
		return FakeCli.setup(fake, "fake-codex.ts", steps);
	}
}
