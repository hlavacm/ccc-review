import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { captureBaseline, GitError, parsePorcelainZ } from "../../src/git.ts";
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
		await captureBaseline(repo.root);
		assert.deepEqual(await snapshot(), before);
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
		const xdg = await makeTempDir("cccr-xdg-");
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
