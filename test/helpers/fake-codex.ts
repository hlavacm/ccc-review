import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeCodexStep } from "../fixtures/fake-codex.ts";
import { makeTempDir, removeDir } from "./temp-dir.ts";

export type { FakeCodexStep };

export interface FakeCodexCall {
	argv: string[];
	stdin: string;
	cwd: string;
}

const script = join(import.meta.dirname, "../fixtures/fake-codex.ts");

/**
 * A real executable standing in for `codex`, run through the production
 * subprocess path. Steps are scripted per invocation.
 */
export class FakeCodex {
	readonly dir: string;
	readonly bin: string;

	private constructor(dir: string) {
		this.dir = dir;
		this.bin = join(dir, "codex");
	}

	static async create(...steps: FakeCodexStep[]): Promise<FakeCodex> {
		const fake = new FakeCodex(await makeTempDir("cccr-fake-codex-"));
		// Pin the Node binary running the tests; the fake inherits the env.
		await writeFile(
			fake.bin,
			`#!/bin/sh\nFAKE_CODEX_DIR='${fake.dir}' exec '${process.execPath}' '${script}' "$@"\n`,
		);
		await chmod(fake.bin, 0o755);
		await fake.script(...steps);
		return fake;
	}

	async script(...steps: FakeCodexStep[]): Promise<void> {
		await writeFile(join(this.dir, "steps.json"), JSON.stringify(steps));
	}

	async calls(): Promise<FakeCodexCall[]> {
		const files = (await readdir(this.dir))
			.filter((f) => /^call-\d+\.json$/.test(f))
			.sort((a, b) => Number(a.slice(5, -5)) - Number(b.slice(5, -5)));
		return Promise.all(
			files.map(
				async (f) =>
					JSON.parse(
						await readFile(join(this.dir, f), "utf8"),
					) as FakeCodexCall,
			),
		);
	}

	/** Pid of the grandchild started by a `childSleepMs` step. */
	async childPid(): Promise<number> {
		return Number(await readFile(join(this.dir, "child.pid"), "utf8"));
	}

	async dispose(): Promise<void> {
		await removeDir(this.dir);
	}
}
