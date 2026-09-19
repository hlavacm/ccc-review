import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitBaseline, GitStatusEntry } from "./core/types.ts";

const execFileAsync = promisify(execFile);

export class GitError extends Error {
	override name = "GitError";
}

interface GitRun {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Read-only git invocation: argv only, no shell, no optional index locks/writes,
 * and never the program a repository's `core.fsmonitor` names.
 */
async function git(cwd: string, args: string[]): Promise<GitRun> {
	try {
		const { stdout, stderr } = await execFileAsync(
			"git",
			["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
			{
				cwd,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
				maxBuffer: 64 * 1024 * 1024,
			},
		);
		return { code: 0, stdout, stderr };
	} catch (error) {
		const e = error as NodeJS.ErrnoException & {
			code?: number | string;
			stdout?: string;
			stderr?: string;
		};
		if (typeof e.code !== "number")
			throw new GitError(`cannot run git: ${e.message}`);
		return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
	}
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
	const run = await git(cwd, args);
	if (run.code !== 0)
		throw new GitError(
			`git ${args.join(" ")} failed (${run.code}): ${run.stderr.trim()}`,
		);
	return run.stdout;
}

/** Captures repository root, HEAD, branch and status without mutating the repo. */
export async function captureBaseline(cwd: string): Promise<GitBaseline> {
	const root = stripEol(await gitOk(cwd, ["rev-parse", "--show-toplevel"]));

	// Exit 1 with -q means "no such ref" (unborn HEAD / detached), not a failure.
	const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
	if (head.code > 1) throw new GitError(`git rev-parse HEAD failed`);
	const branch = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
	if (branch.code > 1) throw new GitError(`git symbolic-ref HEAD failed`);

	const status = await gitOk(root, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
	]);

	return {
		root,
		headSha: head.code === 0 ? stripEol(head.stdout) : null,
		branch: branch.code === 0 ? stripEol(branch.stdout) : null,
		status: parsePorcelainZ(status),
	};
}

/** Removes only the trailing newline; paths may legitimately contain spaces. */
function stripEol(output: string): string {
	return output.replace(/\r?\n$/, "");
}

/** Parses `git status --porcelain=v1 -z`. Paths are verbatim (no quoting). */
export function parsePorcelainZ(output: string): GitStatusEntry[] {
	const parts = output.split("\0");
	const entries: GitStatusEntry[] = [];
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (!part) continue;
		const code = part.slice(0, 2);
		const entry: GitStatusEntry = { code, path: part.slice(3) };
		// Renames/copies are followed by the original path as a separate field.
		if (code.includes("R") || code.includes("C")) {
			const orig = parts[++i];
			if (orig) entry.origPath = orig;
		}
		entries.push(entry);
	}
	return entries;
}

export const MAX_CHANGES_CHARS = 200_000;

/**
 * The changes since `baseline`, as text for a reviewer that cannot run
 * commands: commits, the changed files, the diff against the activation
 * HEAD and untracked files. Read-only; diff drivers and textconv filters are not run.
 */
export async function describeChanges(
	baseline: GitBaseline,
	limit = MAX_CHANGES_CHARS,
): Promise<string> {
	const root = baseline.root;
	const sha = baseline.headSha;
	const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
	const status = parsePorcelainZ(
		await gitOk(root, [
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
		]),
	);
	// Without commits at activation everything is the writer's, including
	// commits made since: diff against the empty tree (not written anywhere).
	const base =
		sha ??
		stripEol(await gitOk(root, ["hash-object", "-t", "tree", "/dev/null"]));
	const diff = await gitOk(root, [...diffArgs, base, "--"]);
	// Listed in full: a truncated diff must not hide which files changed.
	const changed = (
		await gitOk(root, [...diffArgs, "--name-only", "-z", base, "--"])
	)
		.split("\0")
		.filter(Boolean);
	// Fails harmlessly while the repository still has no commits.
	const log = await git(root, [
		"log",
		"--oneline",
		"--no-color",
		...(sha ? [`${sha}..HEAD`] : []),
	]);
	const untracked = status.filter((e) => e.code === "??").map((e) => e.path);

	const sections = [
		`Commits since activation (git log --oneline${sha ? ` ${sha}..HEAD` : ""}):`,
		log.code === 0 && log.stdout.trim() ? log.stdout.trimEnd() : "(none)",
		"",
		`Changed files (git diff --name-only ${sha ?? "<empty tree>"}):`,
		...(changed.length > 0 ? changed.map((p) => `  ${p}`) : ["(none)"]),
		"",
		"Untracked files (not in the diff; read them directly):",
		...(untracked.length > 0 ? untracked.map((p) => `  ${p}`) : ["(none)"]),
		"",
		`Diff (git diff ${sha ?? "<empty tree>"}):`,
	];
	const head = sections.join("\n");
	const room = Math.max(0, limit - head.length);
	const body =
		diff.length <= room
			? diff.trimEnd() || "(empty)"
			: `${diff.slice(0, room)}\n[… diff truncated: ${diff.length - room} more characters; read the changed files directly]`;
	return `${head}\n${body}`;
}
