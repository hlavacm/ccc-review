import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeLogin } from "../fixtures/fake-cli-lib.ts";
import { makeTempDir, removeDir } from "./temp-dir.ts";

export interface FakeCall {
	argv: string[];
	stdin: string;
	cwd: string;
}

/**
 * A real executable standing in for a reviewer CLI, run through the
 * production subprocess path. Steps are scripted per invocation.
 */
export class FakeCli<Step> {
	readonly dir: string;
	readonly bin: string;

	protected constructor(dir: string, name: string) {
		this.dir = dir;
		this.bin = join(dir, name);
	}

	protected static async setup<T extends FakeCli<S>, S>(
		fake: T,
		fixture: string,
		steps: S[],
	): Promise<T> {
		// Pin the Node binary running the tests; the fake inherits the env.
		await writeFile(
			fake.bin,
			`#!/bin/sh\nFAKE_CLI_DIR='${fake.dir}' exec '${process.execPath}' '${join(import.meta.dirname, "../fixtures", fixture)}' "$@"\n`,
		);
		await chmod(fake.bin, 0o755);
		await fake.script(...steps);
		return fake;
	}

	protected static tempDir(prefix: string): Promise<string> {
		return makeTempDir(prefix);
	}

	async script(...steps: Step[]): Promise<void> {
		await writeFile(join(this.dir, "steps.json"), JSON.stringify(steps));
	}

	/** How the login check answers from now on. */
	async login(login: FakeLogin): Promise<void> {
		await writeFile(join(this.dir, "login.json"), JSON.stringify(login));
	}

	async loginCalls(): Promise<number> {
		try {
			return Number(await readFile(join(this.dir, "login-calls"), "utf8"));
		} catch {
			return 0;
		}
	}

	/** Recorded review invocations. */
	async calls(): Promise<FakeCall[]> {
		const files = (await readdir(this.dir))
			.filter((f) => /^call-\d+\.json$/.test(f))
			.sort((a, b) => Number(a.slice(5, -5)) - Number(b.slice(5, -5)));
		return Promise.all(
			files.map(
				async (f) =>
					JSON.parse(await readFile(join(this.dir, f), "utf8")) as FakeCall,
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
