// Opt-in smoke test against the REAL Claude Code CLI: consumes Claude usage
// and needs `claude auth login` (or ANTHROPIC_API_KEY). Not part of
// `pnpm test`; run with `pnpm test:smoke`. Only a disposable temporary
// repository is touched.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { captureBaseline } from "../../src/git.ts";
import { configFromEnv } from "../../src/hosts/codex/hooks.ts";
import { CodexHostHarness } from "../helpers/codex-host.ts";
import { makeTempDir, removeDir } from "../helpers/temp-dir.ts";
import { TemporaryGitRepository } from "../helpers/temp-git-repo.ts";

// Guarded here too: a bare `node --test` or an IDE "run all" also finds this file.
const optIn = process.env.CCC_REVIEW_SMOKE === "1";

describe("real Claude review of a Codex completion (smoke)", {
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

	it("finds a planted bug, returns it to Codex and never mutates Git", async () => {
		const host = new CodexHostHarness(
			configFromEnv({ ...process.env, CCC_REVIEW_STATE_DIR: stateDir }),
			repo.root,
		);
		// Czech task, English report: findings must come back in the task's language.
		const on = await host.command(
			"on Přidej do math.js funkci multiply(a, b), která vrací součin",
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
		const findings =
			(out?.reason ?? "").split("Findings:")[1]?.split("Instructions:")[0] ??
			"";
		assert.match(
			findings,
			/[ěščřžýáíéůú]/i,
			"findings are not in the task's language (Czech)",
		);
		assert.deepEqual(await captureBaseline(repo.root), before);
		assert.equal(repo.git("stash", "list"), "");
	});
});
