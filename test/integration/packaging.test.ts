// Release hygiene: what a clone (and therefore a plugin install from Git)
// contains, that it runs without `pnpm install`, and that the README matches
// the package.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadState } from "../../src/core/state.ts";
import { FakeClaude } from "../helpers/fake-claude.ts";
import { FakeCodex } from "../helpers/fake-codex.ts";
import { approved } from "../helpers/fake-reviewer.ts";
import {
	completeArmedTurn,
	copyPackage,
	packagedFiles,
} from "../helpers/plugin-hooks.ts";
import { makeTempDir, removeDir } from "../helpers/temp-dir.ts";
import { TemporaryGitRepository } from "../helpers/temp-git-repo.ts";

const repoRoot = join(import.meta.dirname, "../..");
const readJson = (path: string) =>
	JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");

function sourceFiles(dir: string): string[] {
	return readdirSync(join(repoRoot, dir), {
		recursive: true,
		encoding: "utf8",
	})
		.filter((f) => f.endsWith(".ts"))
		.map((f) => join(dir, f));
}

describe("package contents", () => {
	const files = packagedFiles(repoRoot);

	it("has an MIT license and consistent versions", () => {
		assert.ok(files.includes("LICENSE"));
		assert.match(readFileSync(join(repoRoot, "LICENSE"), "utf8"), /MIT/);
		const version = readJson("package.json").version;
		assert.match(version, /^\d+\.\d+\.\d+$/);
		assert.equal(readJson(".claude-plugin/plugin.json").version, version);
		assert.equal(readJson(".codex-plugin/plugin.json").version, version);
		assert.equal(readJson("package.json").license, "MIT");
	});

	it("CI runs the suite on the minimum supported Node version", () => {
		const min = /^>=(\d+\.\d+)$/.exec(readJson("package.json").engines.node);
		assert.ok(min, "engines.node is >=<major.minor>");
		const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
		const matrix = /node: \[(.*)\]/.exec(ci)?.[1] ?? "";
		assert.ok(matrix.includes(`"${min[1]}"`), `CI node matrix: ${matrix}`);
	});

	it("contains no local state, build output, dependencies or secret files", () => {
		const forbidden = [
			/^node_modules\//,
			/^dist\//,
			/^coverage\//,
			/(^|\/)\.ccc-review\//,
			/(^|\/)\.env($|\.)/,
			/\.(pem|key|p12|pfx)$/,
			/^\.claude\/settings\.local\.json$/,
			/(^|\/)(tasks|sessions|history)\/[^/]+\.jsonl?$/,
			// Claims are extension-less: claims/<taskId>/<hash>.
			/(^|\/)claims\//,
		];
		for (const file of files)
			for (const pattern of forbidden)
				assert.doesNotMatch(file, pattern, `${file} must not be packaged`);
	});

	it("contains no credentials", () => {
		const secrets = [
			/sk-ant-[A-Za-z0-9_-]{20,}/,
			/\bsk-(proj-)?[A-Za-z0-9]{32,}/,
			/\bgh[pousr]_[A-Za-z0-9]{30,}/,
			/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
			/"(access|refresh|id)_token"\s*:\s*"[^"]{20,}/,
		];
		for (const file of files) {
			const text = readFileSync(join(repoRoot, file), "utf8");
			for (const pattern of secrets)
				assert.doesNotMatch(
					text,
					pattern,
					`${file} looks like it has a secret`,
				);
		}
	});

	it("runtime code depends only on node builtins and never on test code", () => {
		for (const file of sourceFiles("src")) {
			const source = readFileSync(join(repoRoot, file), "utf8");
			for (const [, spec] of source.matchAll(
				// `from "x"`, side-effect `import "x"`, dynamic `import("x")`.
				/\b(?:from|import)\s*\(?\s*["'`]([^"'`]+)["'`]/g,
			)) {
				assert.ok(spec, file);
				if (spec.startsWith("node:")) continue;
				assert.match(spec, /^\.\.?\//, `${file} imports package ${spec}`);
				const target = relative(
					join(repoRoot, "src"),
					resolve(repoRoot, file, "..", spec),
				);
				assert.ok(!target.startsWith(".."), `${file} imports ${spec}`);
			}
		}
	});

	it("keeps fake reviewer executables under test/ only", () => {
		const fakes = files.filter((f) => /fake/i.test(f));
		assert.ok(fakes.length > 0);
		for (const f of fakes) assert.match(f, /^test\//, f);
	});
});

describe("README", () => {
	it("opens with the logo, title and tagline before the first section", () => {
		const header = readme.slice(0, readme.indexOf("\n## "));
		assert.match(header, /<img [^>]*src="assets\/icon\/512x512\.png"/);
		assert.match(header, /\n# CCC Review\n/);
		assert.ok(header.includes("Claude Code ↔ Codex Review"));
		assert.ok(
			header.includes(
				"Use Claude Code to implement and Codex to review,\nor Codex to implement and Claude Code to review.\n",
			),
		);
	});

	it("links only to files that are packaged", () => {
		const packaged = packagedFiles(repoRoot);
		const targets = [
			...readme.matchAll(/\]\(([^)\s]+)\)|\bsrc="([^"]+)"/g),
		].map((m) => (m[1] ?? m[2] ?? "").split("#")[0] ?? "");
		const local = targets.filter((t) => t !== "" && !/^[a-z]+:/.test(t));
		assert.ok(local.includes("assets/icon/512x512.png"));
		for (const target of local) assert.ok(packaged.includes(target), target);
	});

	it("shows the released version, which the changelog describes", () => {
		const version = readJson("package.json").version;
		assert.ok(readme.includes(`badge/version-${version}-`), "version badge");
		assert.match(
			readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8"),
			new RegExp(
				`\\n## \\[${version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}\\n`,
			),
		);
	});

	it("documents every required topic", () => {
		for (const heading of [
			"## How it works",
			"## Requirements",
			"## Install",
			"## Usage",
			"## Configuration",
			"## Security and privacy",
			"## Upgrade",
			"## Uninstall",
			"## Testing",
			"## Known limitations",
			"## License",
		])
			assert.ok(readme.includes(`\n${heading}\n`), heading);
	});

	it("only mentions pnpm scripts that exist", () => {
		const scripts = Object.keys(readJson("package.json").scripts);
		const mentioned = [...readme.matchAll(/\bpnpm (?:run )?([a-z][\w:-]*)/g)]
			.map((m) => m[1] ?? "")
			.filter((s) => !["install", "exec"].includes(s));
		assert.ok(mentioned.includes("test:all"));
		for (const script of mentioned)
			assert.ok(scripts.includes(script), `pnpm ${script}`);
	});

	it("documents every CCC_REVIEW_* setting the code reads", () => {
		const settings = new Set(
			sourceFiles("src").flatMap((f) =>
				[
					...readFileSync(join(repoRoot, f), "utf8").matchAll(
						/CCC_REVIEW_[A-Z_]+/g,
					),
				].map((m) => m[0]),
			),
		);
		assert.ok(settings.size >= 8);
		for (const name of settings)
			assert.ok(readme.includes(`\`${name}\``), name);
	});

	// Regression: the README said `codex plugin add ccc-review`, which Codex rejects
	// ("plugin requires --marketplace unless passed as <plugin>@<marketplace>").
	it("install commands name the plugin and marketplace from the manifests", () => {
		const id = `${readJson(".claude-plugin/plugin.json").name}@${readJson(".claude-plugin/marketplace.json").name}`;
		for (const command of [
			`claude plugin install ${id}`,
			`claude plugin uninstall ${id}`,
			`codex plugin add ${id}`,
			`codex plugin remove ${id}`,
		])
			assert.ok(readme.includes(command), command);
		for (const [line] of readme.matchAll(/codex plugin (?:add|remove) \S+/g))
			assert.ok(line.endsWith(id), line);
	});
});

/**
 * A copy of exactly the packaged files — no node_modules, no dist — run the
 * way the hosts run an installed plugin: the hooks.json command lines.
 */
describe("installed plugin from a clean copy", () => {
	let pkg: string;
	let stateDir: string;
	let repo: TemporaryGitRepository;

	before(async () => {
		pkg = await makeTempDir("ccc-review-pkg-");
		copyPackage(repoRoot, pkg);
		assert.equal(existsSync(join(pkg, "node_modules")), false);
		stateDir = await makeTempDir("ccc-review-state-");
		repo = await TemporaryGitRepository.create();
		await repo.commitFile("app.ts", "export const x = 1;\n");
	});
	after(async () => {
		await removeDir(pkg);
		await removeDir(stateDir);
		await repo.dispose();
	});

	const claudeRound = (session: string, codex: FakeCodex) =>
		completeArmedTurn("claude", pkg, repo, session, {
			CCC_REVIEW_STATE_DIR: stateDir,
			CCC_REVIEW_CODEX_BIN: codex.bin,
		});
	const codexRound = (session: string, claude: FakeClaude) =>
		completeArmedTurn("codex", pkg, repo, session, {
			PLUGIN_DATA: stateDir,
			CCC_REVIEW_CLAUDE_BIN: claude.bin,
		});

	const task = async (session: string) => {
		const { taskId } = JSON.parse(
			readFileSync(join(stateDir, "sessions", `${session}.json`), "utf8"),
		) as { taskId: string };
		return loadState(join(stateDir, "tasks"), taskId);
	};

	it("Claude → Codex: approval", async () => {
		const codex = await FakeCodex.create({ output: approved() });
		try {
			const out = await claudeRound("claude-ok", codex);
			assert.equal(out?.decision, undefined);
			assert.match(String(out?.systemMessage), /APPROVED/);
			assert.equal((await codex.calls())[0]?.cwd, repo.root);
			assert.equal((await task("claude-ok"))?.lastResult?.verdict, "APPROVED");
		} finally {
			await codex.dispose();
		}
	});

	it("Claude → Codex: a failing reviewer is not approval", async () => {
		const codex = await FakeCodex.create({
			exit: 3,
			stderr: "boom\n",
			output: approved(),
		});
		try {
			const out = await claudeRound("claude-fail", codex);
			assert.equal(out?.decision, undefined);
			assert.doesNotMatch(String(out?.systemMessage), /APPROVED/);
			assert.match(String(out?.systemMessage), /exited with code 3/);
			const state = await task("claude-fail");
			assert.equal(state?.active, false);
			assert.equal(state?.lastResult, undefined);
		} finally {
			await codex.dispose();
		}
	});

	it("Codex → Claude: approval", async () => {
		const claude = await FakeClaude.create({ output: approved() });
		try {
			const out = await codexRound("codex-ok", claude);
			assert.equal(out?.decision, undefined);
			assert.match(String(out?.systemMessage), /APPROVED/);
			assert.equal((await claude.calls())[0]?.cwd, repo.root);
			assert.equal((await task("codex-ok"))?.lastResult?.verdict, "APPROVED");
		} finally {
			await claude.dispose();
		}
	});

	it("Codex → Claude: a failing reviewer is not approval", async () => {
		const claude = await FakeClaude.create({
			exit: 3,
			stderr: "boom\n",
			output: approved(),
		});
		try {
			const out = await codexRound("codex-fail", claude);
			assert.equal(out?.decision, undefined);
			assert.doesNotMatch(String(out?.systemMessage), /APPROVED/);
			assert.match(String(out?.systemMessage), /exited with code 3/);
			const state = await task("codex-fail");
			assert.equal(state?.active, false);
			assert.equal(state?.lastResult, undefined);
		} finally {
			await claude.dispose();
		}
	});
});
