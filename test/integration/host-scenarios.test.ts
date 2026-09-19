// The same workflow scenarios, run in both directions through the real host
// adapters, real reviewer adapters, fake reviewer executables, real state and
// real temporary Git repositories.
import { ClaudeReviewer } from "../../src/reviewers/claude.ts";
import { CodexReviewer } from "../../src/reviewers/codex.ts";
import { ClaudeHostHarness } from "../helpers/claude-host.ts";
import { CodexHostHarness } from "../helpers/codex-host.ts";
import { FakeClaude, type FakeClaudeStep } from "../helpers/fake-claude.ts";
import { FakeCodex, type FakeCodexStep } from "../helpers/fake-codex.ts";
import { approved } from "../helpers/fake-reviewer.ts";
import { hostScenarios, type ScenarioStep } from "../helpers/host-scenarios.ts";

const TIMEOUT_STEP = { sleepMs: 30_000, output: approved() };

function codexStep(step: ScenarioStep): FakeCodexStep {
	if (!("fail" in step)) return { output: step };
	switch (step.fail) {
		case "malformed":
			return { rawOutput: "not json" };
		case "shape":
			return { output: { verdict: "OK", summary: "", findings: [] } };
		case "nonzero":
			return { exit: 1, stderr: "boom\n" };
		case "timeout":
			return TIMEOUT_STEP;
	}
}

function claudeStep(step: ScenarioStep): FakeClaudeStep {
	if (!("fail" in step)) return { output: step };
	switch (step.fail) {
		case "malformed":
			return { rawStdout: "not json" };
		case "shape":
			return { output: { verdict: "OK", summary: "", findings: [] } };
		case "nonzero":
			return { exit: 1, stderr: "boom\n" };
		case "timeout":
			return TIMEOUT_STEP;
	}
}

hostScenarios({
	name: "Claude Code writer → Codex reviewer",
	writer: "Claude",
	reviewer: "Codex",
	async setup({ stateDir, cwd, steps, timeoutMs, maxRounds }) {
		const codex = await FakeCodex.create(...steps.map(codexStep));
		const reviewer = new CodexReviewer({ bin: codex.bin, timeoutMs, env: {} });
		return {
			host: new ClaudeHostHarness(
				{ stateDir, reviewer, ...(maxRounds ? { maxRounds } : {}) },
				cwd,
			),
			calls: () => codex.calls(),
			dispose: () => codex.dispose(),
		};
	},
});

hostScenarios({
	name: "Codex writer → Claude Code reviewer",
	writer: "Codex",
	reviewer: "Claude",
	async setup({ stateDir, cwd, steps, timeoutMs, maxRounds }) {
		const claude = await FakeClaude.create(...steps.map(claudeStep));
		const reviewer = new ClaudeReviewer({
			bin: claude.bin,
			timeoutMs,
			env: {},
		});
		return {
			host: new CodexHostHarness(
				{ stateDir, reviewer, ...(maxRounds ? { maxRounds } : {}) },
				cwd,
			),
			calls: () => claude.calls(),
			dispose: () => claude.dispose(),
		};
	},
});
