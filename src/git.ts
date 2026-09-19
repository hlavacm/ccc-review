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

/** Read-only git invocation: argv only, no shell, no optional index locks/writes. */
async function git(cwd: string, args: string[]): Promise<GitRun> {
	try {
		const { stdout, stderr } = await execFileAsync(
			"git",
			["--no-optional-locks", ...args],
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
