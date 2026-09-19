// Workflow scenarios every writer → reviewer direction must satisfy. Each
// direction supplies its real host adapter (driven by a harness with
// realistic hook payloads) and its real reviewer adapter spawning a fake CLI.
import assert from "node:assert/strict";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { TaskState } from "../../src/core/state.ts";
import type { ReviewResult } from "../../src/core/types.ts";
import { captureBaseline } from "../../src/git.ts";
import type { HookOutput } from "../../src/hosts/common.ts";
import type { FakeCall } from "./fake-cli.ts";
import {
	approved,
	changesRequested,
	finding,
	needsHuman,
} from "./fake-reviewer.ts";
import { makeTempDir, removeDir } from "./temp-dir.ts";
import { TemporaryGitRepository } from "./temp-git-repo.ts";

/** What the fake reviewer CLI does for one review, in direction-neutral terms. */
export type ScenarioStep =
	| ReviewResult
	| { fail: "malformed" | "shape" | "nonzero" | "timeout" };

/** The harness API both ClaudeHostHarness and CodexHostHarness offer. */
export interface ScenarioHost {
	command(args: string): Promise<HookOutput | undefined>;
	prompt(prompt: string): Promise<HookOutput | undefined>;
	stop(
		lastMessage: string,
		stopHookActive?: boolean,
	): Promise<HookOutput | undefined>;
	state(): Promise<TaskState | undefined>;
}

export interface Direction {
	name: string;
	writer: string;
	reviewer: string;
	/** Scripts the fake reviewer CLI and builds a host for one session. */
	setup(options: {
		stateDir: string;
		cwd: string;
		steps: ScenarioStep[];
		timeoutMs: number;
		maxRounds?: number;
	}): Promise<{
		host: ScenarioHost;
		calls(): Promise<FakeCall[]>;
		dispose(): Promise<void>;
	}>;
}

export function hostScenarios(d: Direction): void {
	describe(`${d.name} shared workflow scenarios`, () => {
		let repo: TemporaryGitRepository;
		let stateDir: string;
		let env: Awaited<ReturnType<Direction["setup"]>> | undefined;
		let host: ScenarioHost;

		async function setup(
			steps: ScenarioStep[],
			options: { timeoutMs?: number; maxRounds?: number } = {},
		) {
			await env?.dispose();
			env = await d.setup({
				stateDir,
				cwd: repo.root,
				steps,
				timeoutMs: options.timeoutMs ?? 10_000,
				...(options.maxRounds === undefined
					? {}
					: { maxRounds: options.maxRounds }),
			});
			host = env.host;
		}
		const calls = async () => (await env?.calls())?.length ?? 0;

		beforeEach(async () => {
			repo = await TemporaryGitRepository.create();
			await repo.commitFile("app.ts", "export const x = 1;\n");
			stateDir = await makeTempDir("ccc-review-state-");
			await setup([]);
		});
		afterEach(async () => {
			await env?.dispose();
			env = undefined;
			await repo.dispose();
			await removeDir(stateDir);
		});

		it("inactive session: completions and prompts pass through, reviewer never runs", async () => {
			assert.equal(await host.prompt("do something"), undefined);
			assert.equal(await host.stop("done"), undefined);
			assert.equal(await calls(), 0);
			assert.match(
				(await host.command("status"))?.reason ?? "",
				/off \(never enabled/,
			);
		});

		it("activation records the Git baseline, including dirty state", async () => {
			await repo.write("dirty.txt", "pre-existing\n");
			const on = await host.command("on");
			assert.equal(on?.decision, "block");
			assert.match(
				on?.reason ?? "",
				new RegExp(`enabled\\. ${d.reviewer} will review when ${d.writer}`),
			);
			assert.match(on?.reason ?? "", /Warning: .*1 uncommitted change/);
			const state = await host.state();
			assert.equal(state?.active, true);
			assert.equal(state?.round, 0);
			assert.deepEqual(state?.baseline, {
				root: repo.root,
				headSha: repo.git("rev-parse", "HEAD").trim(),
				branch: "main",
				status: [{ code: "??", path: "dirty.txt" }],
			});
			assert.match(
				(await host.command("status"))?.reason ?? "",
				/status: active[\s\S]*round: 0\/3/,
			);
			assert.equal(await calls(), 0);
		});

		it("first-round approval ends the loop", async () => {
			await setup([approved()]);
			await host.command("on Make x 2");
			await repo.write("app.ts", "export const x = 2;\n");
			const out = await host.stop("Set x to 2.");
			assert.equal(out?.decision, undefined);
			assert.match(
				out?.systemMessage ?? "",
				new RegExp(`${d.reviewer} APPROVED \\(round 1/3\\)`),
			);
			const state = await host.state();
			assert.equal(state?.active, false);
			assert.equal(state?.round, 1);
			assert.equal(state?.lastResult?.verdict, "APPROVED");
			assert.equal(await host.stop("anything else"), undefined);
			assert.equal(await calls(), 1);
		});

		it("findings continue the writer; the second round approves and keeps IDs", async () => {
			await setup([
				changesRequested(finding("CCC-001", "x must be 3")),
				approved(),
			]);
			await host.command("on add feature x");
			await host.prompt("make x 3");
			await repo.write("app.ts", "export const x = 2;\n");

			const first = await host.stop("Set x to 2.");
			assert.equal(first?.decision, "block");
			assert.match(
				first?.reason ?? "",
				new RegExp(`round 1/3: ${d.reviewer} requested changes`),
			);
			assert.match(first?.reason ?? "", /- CCC-001 \[high\]: x must be 3/);
			assert.match(first?.reason ?? "", /Evaluate every finding independently/);
			assert.equal((await host.state())?.active, true);
			assert.equal((await host.state())?.round, 1);

			// The continuation: the writer fixes and finishes again.
			await repo.write("app.ts", "export const x = 3;\n");
			const second = await host.stop("CCC-001: fixed — x is 3.", true);
			assert.equal(second?.decision, undefined);
			assert.match(second?.systemMessage ?? "", /APPROVED \(round 2\/3\)/);
			const state = await host.state();
			assert.equal(state?.round, 2);
			assert.equal(state?.active, false);

			const [one, two] = (await env?.calls()) ?? [];
			assert.equal(one?.cwd, repo.root);
			assert.match(
				one?.stdin ?? "",
				/Original task:\nadd feature x\n\nmake x 3/,
			);
			assert.match(one?.stdin ?? "", /Set x to 2\./);
			assert.match(two?.stdin ?? "", /Review round: 2/);
			assert.match(two?.stdin ?? "", /CCC-001 \[high\]: x must be 3/);
			assert.match(two?.stdin ?? "", /Reuse the same ID/);
			assert.match(two?.stdin ?? "", /CCC-001: fixed/);
		});

		it("stops after max 3 rounds without approval", async () => {
			await setup([
				changesRequested(finding("CCC-001")),
				changesRequested(finding("CCC-001")),
				changesRequested(finding("CCC-001", "still broken")),
				approved(),
			]);
			await host.command("on");
			assert.equal((await host.stop("r1"))?.decision, "block");
			assert.equal((await host.stop("r2", true))?.decision, "block");
			const third = await host.stop("r3", true);
			assert.equal(third?.decision, undefined);
			assert.match(
				third?.systemMessage ?? "",
				/max 3 review rounds reached WITHOUT approval[\s\S]*still broken/,
			);
			assert.equal(await host.stop("r4", true), undefined);
			assert.equal(await calls(), 3);
			const state = await host.state();
			assert.equal(state?.active, false);
			assert.equal(state?.round, 3);
		});

		it("finding IDs are not reused within a task", async () => {
			await setup([
				changesRequested(
					finding("CCC-001"),
					finding("CCC-002"),
					finding("CCC-003"),
				),
				changesRequested(finding("CCC-001")),
				approved(),
			]);
			await host.command("on");
			await host.stop("r1");
			await host.stop("r2", true);
			await host.stop("r3", true);
			const third = (await env?.calls())?.[2]?.stdin ?? "";
			assert.match(third, /Number new findings CCC-004, CCC-005/);
			assert.equal((await host.state())?.lastFindingNumber, 3);
		});

		it("a configured max-round limit is honoured", async () => {
			await setup([changesRequested(), approved()], { maxRounds: 1 });
			await host.command("on");
			assert.match(
				(await host.stop("r1"))?.systemMessage ?? "",
				/max 1 review rounds/,
			);
			assert.equal(await calls(), 1);
		});

		it("needs human stops the review", async () => {
			await setup([needsHuman()]);
			await host.command("on");
			const out = await host.stop("done");
			assert.equal(out?.decision, undefined);
			assert.match(out?.systemMessage ?? "", /needs a human decision/);
			assert.equal((await host.state())?.active, false);
		});

		it("the same completion delivered twice runs one review round", async () => {
			await setup([changesRequested(), approved()]);
			await host.command("on");
			assert.equal((await host.stop("same report"))?.decision, "block");
			assert.equal(await host.stop("same report"), undefined);
			assert.equal(await host.stop("same report", true), undefined);
			assert.equal(await calls(), 1);
			assert.equal((await host.state())?.round, 1);
		});

		it("concurrent duplicate deliveries run one review round", async () => {
			await setup([changesRequested(), approved()]);
			await host.command("on");
			const outs = await Promise.all([
				host.stop("report"),
				host.stop("report"),
				host.stop("report"),
			]);
			assert.equal(outs.filter((o) => o?.decision === "block").length, 1);
			assert.equal(outs.filter((o) => o === undefined).length, 2);
			assert.equal(await calls(), 1);
			assert.equal((await host.state())?.round, 1);
		});

		it("off disarms; later completions are not reviewed", async () => {
			await setup([approved()]);
			await host.command("on");
			assert.match((await host.command("off"))?.reason ?? "", /disabled/);
			assert.equal(await host.stop("done"), undefined);
			assert.equal(await calls(), 0);
			assert.match((await host.command("status"))?.reason ?? "", /inactive/);
			assert.match((await host.command("off"))?.reason ?? "", /already off/);
		});

		describe("reviewer failure is never approval", () => {
			const cases: [Extract<ScenarioStep, { fail: string }>, RegExp][] = [
				[{ fail: "malformed" }, /invalid JSON/],
				[{ fail: "shape" }, /invalid verdict/],
				[{ fail: "nonzero" }, /exited with code 1: boom/],
				[{ fail: "timeout" }, /timed out/],
			];
			for (const [step, error] of cases)
				it(step.fail, async () => {
					const timeout = step.fail === "timeout";
					await setup([step], { timeoutMs: timeout ? 1000 : 10_000 });
					await host.command("on");
					const out = await host.stop("done");
					assert.equal(out?.decision, undefined);
					assert.match(
						out?.systemMessage ?? "",
						new RegExp(
							`${d.reviewer} review FAILED — the change is NOT approved`,
						),
					);
					assert.match(out?.systemMessage ?? "", error);
					assert.doesNotMatch(out?.systemMessage ?? "", /APPROVED/);
					const state = await host.state();
					assert.equal(state?.active, false);
					assert.equal(state?.lastResult, undefined);
					assert.match(state?.lastError ?? "", error);
					assert.match(
						(await host.command("status"))?.reason ?? "",
						/last error/,
					);
					assert.equal(await host.stop("done again"), undefined);
				});
		});

		it("state directories (prompts, findings) are private to the user", async () => {
			await setup([changesRequested()]);
			// An older version created them with the default umask.
			await mkdir(join(stateDir, "sessions"), { mode: 0o755 });
			await mkdir(join(stateDir, "claims"), { mode: 0o755 });
			await host.command("on secret task");
			await host.stop("done");
			const dirs = await readdir(stateDir);
			assert.deepEqual(dirs.sort(), ["claims", "history", "sessions", "tasks"]);
			for (const dir of dirs) {
				const mode = (await stat(join(stateDir, dir))).mode & 0o777;
				assert.equal(mode, 0o700, `${dir}: ${mode.toString(8)}`);
			}
		});

		// A wedged session must be recoverable with the commands the user has.
		for (const kind of ["sessions", "tasks"] as const)
			describe(`corrupt ${kind} state is recoverable`, () => {
				async function corrupt() {
					const dir = join(stateDir, kind);
					for (const file of await readdir(dir))
						await writeFile(join(dir, file), "{broken");
				}

				it("is reported, never reviewed or approved, and status says how to recover", async () => {
					await setup([approved()]);
					await host.command("on");
					await corrupt();
					const out = await host.stop("done");
					assert.equal(out?.decision, undefined);
					assert.match(out?.systemMessage ?? "", /CCC Review error/);
					assert.doesNotMatch(out?.systemMessage ?? "", /APPROVED/);
					assert.equal(await calls(), 0);
					const status = await host.command("status");
					assert.equal(status?.decision, "block");
					assert.match(status?.reason ?? "", /CCC Review error/);
					assert.match(status?.reason ?? "", /"on".*"off"/);
				});

				it("on starts a fresh task that is reviewed normally", async () => {
					await setup([approved()]);
					await host.command("on");
					const broken = (await host.state())?.taskId;
					await corrupt();
					const out = await host.command("on");
					assert.match(out?.reason ?? "", /CCC Review: enabled/);
					assert.match(out?.reason ?? "", /unreadable/);
					const state = await host.state();
					assert.equal(state?.active, true);
					assert.equal(state?.round, 0);
					assert.notEqual(state?.taskId, broken);
					assert.match(
						(await host.stop("done"))?.systemMessage ?? "",
						/APPROVED/,
					);
					assert.equal(await calls(), 1);
				});

				it("off resets the session; hooks go quiet", async () => {
					await setup([approved()]);
					await host.command("on");
					await corrupt();
					const out = await host.command("off");
					assert.match(out?.reason ?? "", /CCC Review: disabled/);
					assert.match(out?.reason ?? "", /unreadable/);
					assert.equal(await host.prompt("next task"), undefined);
					assert.equal(await host.stop("done"), undefined);
					assert.equal(await calls(), 0);
					assert.match(
						(await host.command("status"))?.reason ?? "",
						/off \(never enabled/,
					);
				});
			});

		it("the whole flow never mutates Git state", async () => {
			await setup([changesRequested(), approved()]);
			await repo.write("dirty.txt", "x\n");
			await repo.write("app.ts", "export const x = 5;\n");
			repo.git("add", "app.ts");
			const before = await captureBaseline(repo.root);
			const stash = repo.git("stash", "list");
			await host.command("on");
			await host.stop("r1");
			await host.stop("r2", true);
			assert.deepEqual(await captureBaseline(repo.root), before);
			assert.equal(repo.git("stash", "list"), stash);
		});
	});
}
