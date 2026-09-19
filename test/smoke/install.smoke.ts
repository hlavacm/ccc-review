// Opt-in smoke test of the documented install / upgrade / uninstall commands
// against the REAL `claude` and `codex` CLIs. Uses no credentials and no
// model: everything goes into throwaway CLAUDE_CONFIG_DIR / CODEX_HOME
// directories, and the installed hooks run against fake reviewers.
// Not part of `pnpm test`; run with `pnpm test:smoke`.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FakeClaude } from "../helpers/fake-claude.ts";
import { FakeCodex } from "../helpers/fake-codex.ts";
import { approved } from "../helpers/fake-reviewer.ts";
import { completeArmedTurn, copyPackage } from "../helpers/plugin-hooks.ts";
import { makeTempDir, removeDir } from "../helpers/temp-dir.ts";
import { TemporaryGitRepository } from "../helpers/temp-git-repo.ts";

const repoRoot = join(import.meta.dirname, "../..");
const missing = ["claude", "codex"].filter(
	(bin) => spawnSync(bin, ["--version"]).status !== 0,
);

describe("install, upgrade and uninstall with the real CLIs (smoke)", {
	skip: missing.length > 0 && `not on PATH: ${missing.join(", ")}`,
}, () => {
	let tmp: string;
	let source: string;
	let env: NodeJS.ProcessEnv;
	let repo: TemporaryGitRepository;
	const id = "cccr@cccr-local";
	const version = JSON.parse(
		readFileSync(join(repoRoot, "package.json"), "utf8"),
	).version as string;

	const cli = (bin: string, ...args: string[]) =>
		execFileSync(bin, args, { env, encoding: "utf8", stdio: "pipe" });
	const commit = (message: string) => {
		for (const args of [
			["add", "-A"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message],
		])
			execFileSync("git", args, { cwd: source });
	};

	before(async () => {
		tmp = await makeTempDir("cccr-install-");
		// A clean clone of the current package (including uncommitted work).
		source = join(tmp, "cccr");
		copyPackage(repoRoot, source);
		execFileSync("git", ["init", "-q"], { cwd: source });
		commit("package");
		env = {
			...process.env,
			CLAUDE_CONFIG_DIR: join(tmp, "claude"),
			CODEX_HOME: join(tmp, "codex"),
		};
		for (const dir of [env.CLAUDE_CONFIG_DIR, env.CODEX_HOME])
			mkdirSync(String(dir), { recursive: true });
		repo = await TemporaryGitRepository.create();
		await repo.commitFile("app.ts", "export const x = 1;\n");
	});
	after(async () => {
		await repo?.dispose();
		await removeDir(tmp);
	});

	it("claude plugin validate accepts plugin and marketplace", () => {
		cli("claude", "plugin", "validate", source);
		cli(
			"claude",
			"plugin",
			"validate",
			join(source, ".claude-plugin/plugin.json"),
		);
	});

	it("Claude Code: install, run the installed hooks, upgrade, uninstall", async () => {
		const installed = join(
			String(env.CLAUDE_CONFIG_DIR),
			"plugins/cache/cccr-local/cccr",
			version,
		);
		cli("claude", "plugin", "marketplace", "add", source);
		cli("claude", "plugin", "install", id);
		assert.match(cli("claude", "plugin", "list"), /cccr@cccr-local/);
		assert.ok(existsSync(join(installed, "hooks/hooks.json")), installed);
		assert.equal(existsSync(join(installed, "node_modules")), false);

		const codex = await FakeCodex.create({ output: approved() });
		try {
			const out = await completeArmedTurn("claude", installed, repo, "cc", {
				CCCR_STATE_DIR: join(tmp, "state"),
				CCCR_CODEX_BIN: codex.bin,
			});
			assert.match(String(out?.systemMessage), /Codex APPROVED/);
		} finally {
			await codex.dispose();
		}

		// Same version: `update` keeps the cached copy; reinstall picks it up.
		writeFileSync(join(source, "UPGRADE_MARK"), "1\n");
		commit("upgrade");
		cli("claude", "plugin", "marketplace", "update", "cccr-local");
		cli("claude", "plugin", "update", id);
		assert.equal(existsSync(join(installed, "UPGRADE_MARK")), false);
		cli("claude", "plugin", "uninstall", id);
		cli("claude", "plugin", "install", id);
		assert.ok(existsSync(join(installed, "UPGRADE_MARK")));

		// The documented upgrade: a new version, then marketplace update + update.
		const manifest = join(source, ".claude-plugin/plugin.json");
		writeFileSync(
			manifest,
			readFileSync(manifest, "utf8").replace(
				`"version": "${version}"`,
				'"version": "99.0.0"',
			),
		);
		writeFileSync(join(source, "UPGRADE_MARK_2"), "1\n");
		commit("release 99.0.0");
		cli("claude", "plugin", "marketplace", "update", "cccr-local");
		cli("claude", "plugin", "update", id);
		const upgraded = join(installed, "..", "99.0.0");
		assert.ok(existsSync(join(upgraded, "UPGRADE_MARK_2")), upgraded);
		assert.match(cli("claude", "plugin", "list"), /Version: 99\.0\.0/);
		const codex2 = await FakeCodex.create({ output: approved() });
		try {
			const out = await completeArmedTurn("claude", upgraded, repo, "cc2", {
				CCCR_STATE_DIR: join(tmp, "state"),
				CCCR_CODEX_BIN: codex2.bin,
			});
			assert.match(String(out?.systemMessage), /Codex APPROVED/);
		} finally {
			await codex2.dispose();
		}

		cli("claude", "plugin", "uninstall", id);
		cli("claude", "plugin", "marketplace", "remove", "cccr-local");
		assert.doesNotMatch(cli("claude", "plugin", "list"), /cccr@cccr-local/);
	});

	it("Codex: install, run the installed hooks, upgrade, uninstall", async () => {
		cli("codex", "plugin", "marketplace", "add", source);
		const added = cli("codex", "plugin", "add", id);
		const installed = /Installed plugin root: (.+)/.exec(added)?.[1]?.trim();
		assert.ok(installed && existsSync(installed), added);
		assert.equal(existsSync(join(installed, "node_modules")), false);
		assert.match(cli("codex", "plugin", "list"), /installed, enabled/);

		const claude = await FakeClaude.create({ output: approved() });
		try {
			const out = await completeArmedTurn("codex", installed, repo, "cx", {
				PLUGIN_DATA: join(tmp, "state"),
				CCCR_CLAUDE_BIN: claude.bin,
			});
			assert.match(String(out?.systemMessage), /Claude APPROVED/);
		} finally {
			await claude.dispose();
		}

		// Upgrade as documented: pull, then `codex plugin add` again.
		writeFileSync(join(source, "UPGRADE_MARK_CODEX"), "1\n");
		commit("upgrade codex");
		cli("codex", "plugin", "add", id);
		assert.ok(existsSync(join(installed, "UPGRADE_MARK_CODEX")));

		cli("codex", "plugin", "remove", id);
		cli("codex", "plugin", "marketplace", "remove", "cccr-local");
		assert.doesNotMatch(
			readFileSync(join(String(env.CODEX_HOME), "config.toml"), "utf8"),
			/cccr/,
		);
	});
});
