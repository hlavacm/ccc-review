import { spawn } from "node:child_process";

export interface Exit {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** Everything written to stdout, up to STDOUT_LIMIT. */
	stdout: string;
	/** True when stdout exceeded STDOUT_LIMIT and was cut. */
	stdoutTruncated: boolean;
	/** The last OUTPUT_TAIL characters of stderr. */
	stderr: string;
}

export interface RunOptions {
	/** Tool name used in error messages, e.g. "codex". */
	name: string;
	bin: string;
	args: string[];
	cwd: string;
	input: string;
	timeoutMs: number;
	/** Hint appended to a missing-executable error. */
	missingHint: string;
	/** Setting named in a timeout error. */
	timeoutSetting: string;
}

const OUTPUT_TAIL = 4000;
export const STDOUT_LIMIT = 16 * 1024 * 1024;
const ABORT_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export const duration = (ms: number) =>
	ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms} ms`;

/** Last few stderr lines: enough to act on, without pages of retry noise. */
export function stderrTail(stderr: string): string {
	const tail = stderr.trim().split("\n").slice(-10).join("\n");
	return tail.length > 1000 ? tail.slice(-1000) : tail;
}

/**
 * Executable + argv, input on stdin; never a shell. Resolves with the exit
 * status; rejects only when the tool cannot run, misses the deadline or the
 * hook is aborted.
 */
export function runProcess(o: RunOptions): Promise<Exit> {
	return new Promise((resolve, reject) => {
		// Own process group, so the deadline also kills whatever the tool started.
		const child = spawn(o.bin, o.args, {
			cwd: o.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		const killGroup = () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		};
		// The hook being aborted must not orphan the detached group; the
		// review fails, so the host records it and the hook then exits.
		// ponytail: SIGKILL of the hook cannot be caught; the tool then outlives it.
		const onAbort = (signal: NodeJS.Signals) =>
			finish(
				new Error(
					`${o.name} review aborted (${signal}) — the change is NOT approved`,
				),
			);
		for (const s of ABORT_SIGNALS) process.on(s, onAbort);
		// Settles exactly once. The deadline does not wait for `close`: a
		// descendant holding a pipe open would delay it, and a result that
		// arrives after the deadline must not count.
		let settled = false;
		const finish = (outcome: Error | Exit) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			for (const s of ABORT_SIGNALS) process.removeListener(s, onAbort);
			killGroup();
			child.stdout.destroy();
			child.stderr.destroy();
			if (outcome instanceof Error) reject(outcome);
			else resolve(outcome);
		};
		// Own timer rather than spawn's `timeout`: that one is only cleared on
		// exit, so a spawn error (missing binary) would keep the hook alive.
		const timer = setTimeout(() => {
			const tail = stderrTail(stderr);
			finish(
				new Error(
					`${o.name} timed out after ${duration(o.timeoutMs)} — raise ${o.timeoutSetting} if reviews need longer${tail ? `: ${tail}` : ""}`,
				),
			);
		}, o.timeoutMs);
		let stdout = "";
		let stdoutTruncated = false;
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (stdout.length + chunk.length > STDOUT_LIMIT) {
				stdoutTruncated = true;
				stdout += chunk.slice(0, STDOUT_LIMIT - stdout.length);
			} else stdout += chunk;
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-OUTPUT_TAIL);
		});
		// The tool may exit before reading stdin; that surfaces as exit status.
		child.stdin.on("error", () => {});
		child.stdin.end(o.input);
		child.on("error", (error: NodeJS.ErrnoException) => {
			finish(
				new Error(
					error.code === "ENOENT"
						? `${o.name} executable not found: ${o.bin} — ${o.missingHint}`
						: `cannot run ${o.name}: ${error.message}`,
				),
			);
		});
		child.on("close", (code, signal) =>
			finish({ code, signal, stdout, stdoutTruncated, stderr }),
		);
	});
}
