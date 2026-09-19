// Opt-in smoke test against the REAL Codex CLI: consumes Codex usage and
// needs `codex login`. Not part of `pnpm test`; run with `pnpm test:smoke`.
// Only a disposable temporary repository is touched.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { captureBaseline } from "../../src/git.ts";
import { configFromEnv } from "../../src/hosts/claude-code/hooks.ts";
import { ClaudeHostHarness } from "../helpers/claude-host.ts";
import { makeTempDir, removeDir } from "../helpers/temp-dir.ts";
import { TemporaryGitRepository } from "../helpers/temp-git-repo.ts";

// Guarded here too: a bare `node --test` or an IDE "run all" also finds this file.
const optIn = process.env.CCC_REVIEW_SMOKE === "1";

describe("real Codex review of a Claude completion (smoke)", {
	skip: !optIn && "opt-in, consumes usage: pnpm test:smoke",
}, () => {
	let repo: TemporaryGitRepository;
	let stateDir: string;

	before(async () => {
		repo = await TemporaryGitRepository.create();
		await repo.commitFile("math.js", "export const add = (a, b) => a + b;\n");
		stateDir = await makeTempDir("ccc-review-smoke-state-");
	});
	after(async () => {
		await repo.dispose();
		await removeDir(stateDir);
	});

	it("finds a planted bug, returns it to Claude and never mutates Git", async () => {
		const host = new ClaudeHostHarness(
			configFromEnv({ ...process.env, CCC_REVIEW_STATE_DIR: stateDir }),
			repo.root,
		);
		const on = await host.command(
			"on Add a multiply(a, b) function to math.js",
		);
		assert.match(on?.reason ?? "", /enabled/, String(on?.reason));

		// The "writer" plants an obvious bug and claims success.
		await repo.write(
			"math.js",
			"export const add = (a, b) => a + b;\nexport const multiply = (a, b) => a + b;\n",
		);
		const before = await captureBaseline(repo.root);
		const out = await host.stop(
			"Added multiply(a, b) to math.js; it returns the product of a and b.",
		);
		console.log(JSON.stringify(out, null, 2));
		console.log((await host.command("status"))?.reason);

		assert.equal(out?.decision, "block", "expected CHANGES_REQUESTED");
		assert.match(out?.reason ?? "", /CCC-001/);
		assert.match(out?.reason ?? "", /math\.js/);
		assert.deepEqual(await captureBaseline(repo.root), before);
		assert.equal(repo.git("stash", "list"), "");
	});
});
