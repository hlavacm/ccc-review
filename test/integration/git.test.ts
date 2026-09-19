import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	captureBaseline,
	describeChanges,
	GitError,
	parsePorcelainZ,
} from "../../src/git.ts";
import { makeTempDir, removeDir } from "../helpers/temp-dir.ts";
import { TemporaryGitRepository } from "../helpers/temp-git-repo.ts";

describe("captureBaseline (real temporary repositories)", () => {
	let repo: TemporaryGitRepository;
	beforeEach(async () => {
		repo = await TemporaryGitRepository.create();
	});
	afterEach(() => repo.dispose());

	const head = () => repo.git("rev-parse", "HEAD").trim();

	it("clean repository", async () => {
		await repo.commitFile("a.txt", "a\n");
		const b = await captureBaseline(repo.root);
		assert.deepEqual(b, {
			root: repo.root,
			headSha: head(),
			branch: "main",
			status: [],
		});
		assert.match(b.headSha ?? "", /^[0-9a-f]{40,64}$/);
	});

	it("dirty tracked file", async () => {
		await repo.commitFile("a.txt", "a\n");
		await repo.write("a.txt", "changed\n");
		const b = await captureBaseline(repo.root);
		assert.deepEqual(b.status, [{ code: " M", path: "a.txt" }]);
	});

	it("staged, untracked, deleted and renamed files", async () => {
		await repo.commitFile("keep.txt", "k\n");
		await repo.commitFile("del.txt", "d\n");
		await repo.commitFile("old.txt", "same content for rename detection\n");
		await repo.write("staged.txt", "s\n");
		repo.git("add", "staged.txt");
		await repo.write("dir/untracked.txt", "u\n");
		await rm(join(repo.root, "del.txt"));
		repo.git("mv", "old.txt", "new.txt");

		const b = await captureBaseline(repo.root);
		const byPath = Object.fromEntries(b.status.map((e) => [e.path, e]));
		assert.deepEqual(byPath["staged.txt"], { code: "A ", path: "staged.txt" });
		assert.deepEqual(byPath["dir/untracked.txt"], {
			code: "??",
			path: "dir/untracked.txt",
		});
		assert.deepEqual(byPath["del.txt"], { code: " D", path: "del.txt" });
		assert.deepEqual(byPath["new.txt"], {
			code: "R ",
			path: "new.txt",
			origPath: "old.txt",
		});
		assert.equal(b.status.length, 4);
	});

	it("unusual filenames are reported verbatim", async () => {
		await repo.commitFile("base.txt", "b\n");
		const names = [
			"with space.txt",
			"ünïcødé.txt",
			'quo"te.txt',
			"tab\there.txt",
		];
		for (const name of names) await repo.write(name, "x\n");
		const b = await captureBaseline(repo.root);
		assert.deepEqual(b.status.map((e) => e.path).sort(), [...names].sort());
		assert.ok(b.status.every((e) => e.code === "??"));
	});

	it("repository without commits", async () => {
		await repo.write("first.txt", "1\n");
		const b = await captureBaseline(repo.root);
		assert.equal(b.headSha, null);
		assert.equal(b.branch, "main");
		assert.deepEqual(b.status, [{ code: "??", path: "first.txt" }]);
	});

	it("detached HEAD has no branch", async () => {
		await repo.commitFile("a.txt", "a\n");
		repo.git("checkout", "-q", "--detach");
		const b = await captureBaseline(repo.root);
		assert.equal(b.branch, null);
		assert.equal(b.headSha, head());
	});

	it("non-default branch", async () => {
		await repo.commitFile("a.txt", "a\n");
		repo.git("checkout", "-q", "-b", "feature/x");
		assert.equal((await captureBaseline(repo.root)).branch, "feature/x");
	});

	it("preserves significant whitespace in the repository root path", async () => {
		const spaced = await TemporaryGitRepository.create(" spaced repo ");
		try {
			await spaced.commitFile("a.txt", "a\n");
			const b = await captureBaseline(spaced.root);
			assert.equal(b.root, spaced.root);
			assert.equal(b.branch, "main");
		} finally {
			await spaced.dispose();
		}
	});

	it("resolves the root from a subdirectory", async () => {
		await repo.commitFile("sub/dir/a.txt", "a\n");
		const b = await captureBaseline(join(repo.root, "sub", "dir"));
		assert.equal(b.root, repo.root);
	});

	it("baseline capture does not mutate the repository", async () => {
		await repo.commitFile("a.txt", "a\n");
		await repo.write("a.txt", "dirty\n");
		await repo.write("b.txt", "untracked\n");
		await repo.write("c.txt", "staged\n");
		repo.git("add", "c.txt");

		const index = join(repo.root, ".git", "index");
		const snapshot = async () => ({
			status: repo.git(
				"--no-optional-locks",
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=all",
			),
			head: repo.git("rev-parse", "HEAD"),
			refs: repo.git("for-each-ref"),
			stash: repo.git("stash", "list"),
			indexHash: createHash("sha256")
				.update(await readFile(index))
				.digest("hex"),
			indexMtime: (await stat(index)).mtimeMs,
			a: await readFile(join(repo.root, "a.txt"), "utf8"),
		});

		const before = await snapshot();
		await captureBaseline(repo.root);
		await describeChanges(await captureBaseline(repo.root));
		assert.deepEqual(await snapshot(), before);
	});
});

describe("describeChanges (real temporary repositories)", () => {
	let repo: TemporaryGitRepository;
	beforeEach(async () => {
		repo = await TemporaryGitRepository.create();
	});
	afterEach(() => repo.dispose());

	it("lists commits, the diff since activation and untracked files", async () => {
		await repo.commitFile("a.txt", "one\n");
		await repo.commitFile("gone.txt", "bye\n");
		const baseline = await captureBaseline(repo.root);
		await repo.commitFile(
			"b.txt",
			"committed after activation\n",
			"writer commit",
		);
		await repo.write("a.txt", "two\n");
		repo.git("rm", "-q", "gone.txt");
		await repo.write("dir/new file ü.txt", "untracked\n");

		const text = await describeChanges(baseline);
		assert.match(
			text,
			/Commits since activation[^\n]*\n[0-9a-f]+ writer commit/,
		);
		assert.match(text, /Untracked files[^\n]*\n {2}dir\/new file ü\.txt/);
		assert.match(text, /-one\n\+two/);
		assert.match(text, /\+committed after activation/);
		assert.match(text, /deleted file mode[\s\S]*-bye/);
		assert.match(text, new RegExp(`git diff ${baseline.headSha}`));
	});

	it("a clean tree has no changes", async () => {
		await repo.commitFile("a.txt", "a\n");
		const text = await describeChanges(await captureBaseline(repo.root));
		assert.match(text, /Commits[^\n]*\n\(none\)/);
		assert.match(text, /Untracked files[^\n]*\n\(none\)/);
		assert.match(text, /\(empty\)$/);
	});

	it("a repository without commits shows staged and unstaged changes", async () => {
		const baseline = await captureBaseline(repo.root);
		await repo.write("s.txt", "staged\n");
		repo.git("add", "s.txt");
		await repo.write("s.txt", "staged\nand more\n");
		await repo.write("u.txt", "untracked\n");
		const text = await describeChanges(baseline);
		assert.match(text, /\+staged/);
		assert.match(text, /\+and more/);
		assert.match(text, /Untracked files[^\n]*\n {2}u\.txt/);
		assert.match(text, /Commits[^\n]*\n\(none\)/);
	});

	// Regression: with no commits at activation only staged + unstaged changes
	// were diffed, so the writer's first commit vanished from the diff.
	it("a first commit after activation without commits is in the diff", async () => {
		const baseline = await captureBaseline(repo.root);
		await repo.commitFile("first.txt", "committed content\n", "first commit");
		await repo.write("first.txt", "committed content\nedited later\n");
		await repo.write("second.txt", "staged\n");
		repo.git("add", "second.txt");
		const text = await describeChanges(baseline);
		assert.match(text, /Commits[^\n]*\n[0-9a-f]+ first commit/);
		assert.match(text, /\+committed content/);
		assert.match(text, /\+edited later/);
		assert.match(text, /\+staged/);
		assert.match(text, /Changed files[^\n]*\n {2}first\.txt\n {2}second\.txt/);
	});

	// Regression: truncating the diff could cut every later file, and nothing
	// else listed which files had changed.
	it("lists every changed file even when the diff is truncated", async () => {
		await repo.commitFile("a.txt", "a\n");
		await repo.commitFile("z last.txt", "z\n");
		const baseline = await captureBaseline(repo.root);
		await repo.write("a.txt", "y".repeat(10_000));
		await repo.write("z last.txt", "changed\n");
		await repo.commitFile("new.txt", "n\n");
		const text = await describeChanges(baseline, 3000);
		assert.match(text, /diff truncated/);
		assert.doesNotMatch(text, /\+changed/);
		assert.match(
			text,
			/Changed files[^\n]*\n {2}a\.txt\n {2}new\.txt\n {2}z last\.txt\n/,
		);
	});

	it("truncates an oversized diff with a note", async () => {
		await repo.commitFile("big.txt", "x\n");
		const baseline = await captureBaseline(repo.root);
		await repo.write("big.txt", "y".repeat(10_000));
		const text = await describeChanges(baseline, 2000);
		assert.ok(text.length < 2200, String(text.length));
		assert.match(
			text,
			/diff truncated: \d+ more characters; read the changed files directly/,
		);
	});

	it("never runs external diff drivers or textconv filters", async () => {
		// Inside the repository's own temp parent, which dispose() removes.
		await repo.dispose();
		repo = await TemporaryGitRepository.create("repo");
		const marker = join(repo.root, "..", "ext-diff-ran");
		const script = join(repo.root, "..", "ext-diff.sh");
		await writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
		repo.git("config", "diff.external", script);
		repo.git("config", "diff.t.textconv", script);
		await repo.write(".gitattributes", "*.txt diff=t\n");
		await repo.commitFile("a.txt", "a\n");
		const baseline = await captureBaseline(repo.root);
		await repo.write("a.txt", "b\n");
		assert.match(await describeChanges(baseline), /-a\n\+b/);
		await assert.rejects(stat(marker));
	});

	it("never runs the repository's fsmonitor program", async () => {
		await repo.dispose();
		repo = await TemporaryGitRepository.create("repo");
		const marker = join(repo.root, "..", "fsmonitor-ran");
		const script = join(repo.root, "..", "fsmonitor.sh");
		await writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
		await repo.commitFile("a.txt", "a\n");
		await repo.write("a.txt", "b\n");
		// Last: the helper's own git commands would run it too.
		repo.git("config", "core.fsmonitor", script);
		const baseline = await captureBaseline(repo.root);
		assert.match(await describeChanges(baseline), /-a\n\+b/);
		await assert.rejects(stat(marker));
	});

	it("throws GitError when the activation commit is gone", async () => {
		await repo.commitFile("a.txt", "a\n");
		const baseline = await captureBaseline(repo.root);
		await assert.rejects(
			describeChanges({ ...baseline, headSha: "0".repeat(40) }),
			GitError,
		);
	});
});

function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

describe("test isolation", () => {
	// Production git calls inherit process.env; the whole test run must not
	// read the developer's global/system git config (test/setup.ts).
	it("runs with isolated git configuration", () => {
		assert.equal(process.env.GIT_CONFIG_GLOBAL, "/dev/null");
		assert.equal(process.env.GIT_CONFIG_NOSYSTEM, "1");
	});

	it("ignores the developer's global excludes file", async () => {
		const repo = await TemporaryGitRepository.create();
		const xdg = await makeTempDir("ccc-review-xdg-");
		const saved = { xdg: process.env.XDG_CONFIG_HOME, home: process.env.HOME };
		try {
			await mkdir(join(xdg, "git"));
			await writeFile(join(xdg, "git", "ignore"), "*.txt\n");
			process.env.XDG_CONFIG_HOME = xdg;
			process.env.HOME = xdg;
			await repo.write("first.txt", "1\n");
			assert.deepEqual((await captureBaseline(repo.root)).status, [
				{ code: "??", path: "first.txt" },
			]);
		} finally {
			restoreEnv("XDG_CONFIG_HOME", saved.xdg);
			restoreEnv("HOME", saved.home);
			await removeDir(xdg);
			await repo.dispose();
		}
	});
});

describe("captureBaseline failures", () => {
	it("throws GitError outside a repository", async () => {
		const dir = await makeTempDir();
		try {
			await assert.rejects(captureBaseline(dir), GitError);
		} finally {
			await removeDir(dir);
		}
	});

	it("throws GitError when the git executable is missing", async () => {
		const repo = await TemporaryGitRepository.create();
		const path = process.env.PATH;
		process.env.PATH = "";
		try {
			await assert.rejects(captureBaseline(repo.root), /cannot run git/);
		} finally {
			process.env.PATH = path;
			await repo.dispose();
		}
	});

	it("throws GitError for a missing directory", async () => {
		const dir = await makeTempDir();
		try {
			await assert.rejects(
				captureBaseline(join(dir, "does-not-exist")),
				GitError,
			);
		} finally {
			await removeDir(dir);
		}
	});
});

describe("parsePorcelainZ", () => {
	it("parses empty output", () => {
		assert.deepEqual(parsePorcelainZ(""), []);
	});

	it("parses renames, copies and plain entries", () => {
		assert.deepEqual(
			parsePorcelainZ(" M a b.txt\0R  new\0old\0C  copy\0src\0?? x\0"),
			[
				{ code: " M", path: "a b.txt" },
				{ code: "R ", path: "new", origPath: "old" },
				{ code: "C ", path: "copy", origPath: "src" },
				{ code: "??", path: "x" },
			],
		);
	});
});
