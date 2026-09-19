import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Creates a fresh directory under the OS temp dir; returns its real path. */
export async function makeTempDir(prefix = "cccr-test-"): Promise<string> {
	return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export async function removeDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}
