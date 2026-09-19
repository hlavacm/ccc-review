import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";

/** Polls `probe` (up to ~5 s) until it returns a value. */
export async function waitFor<T>(
	probe: () => Promise<T | undefined>,
): Promise<T> {
	for (let i = 0; i < 200; i++) {
		const value = await probe();
		if (value !== undefined) return value;
		await new Promise((r) => setTimeout(r, 25));
	}
	assert.fail("condition not reached");
}

/** Waits briefly for a killed process to disappear. */
export async function assertGone(pid: number): Promise<void> {
	await waitFor(async () => {
		try {
			process.kill(pid, 0);
			return undefined;
		} catch {
			return true;
		}
	});
}

/**
 * Test cleanup for a spawned hook. SIGTERM and wait, never SIGKILL: the
 * reviewer runs in its own process group, which only a hook that can still
 * handle the signal kills.
 */
export async function stopHook(hook: ChildProcess): Promise<void> {
	if (hook.exitCode !== null || hook.signalCode !== null) return;
	const exited = new Promise<void>((r) => hook.once("exit", () => r()));
	hook.kill("SIGTERM");
	await exited;
}
