// Shared plumbing for the fake reviewer executables: invocations are
// recorded as $FAKE_CLI_DIR/call-<n>.json (argv, stdin, cwd), behaviour comes
// from $FAKE_CLI_DIR/steps.json (a queue consumed one step per invocation)
// and the login check answers from $FAKE_CLI_DIR/login.json.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeLogin {
	exit: number;
	stdout?: string;
	stderr?: string;
	sleepMs?: number;
}

export interface FakeProcessStep {
	stderr?: string;
	exit?: number;
	sleepMs?: number;
	/** Start a grandchild that inherits stderr and lives this long; pid → child.pid. */
	childSleepMs?: number;
}

const envDir = process.env.FAKE_CLI_DIR;
if (!envDir) {
	process.stderr.write("FAKE_CLI_DIR not set\n");
	process.exit(90);
}
export const dir: string = envDir;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// process.exit() would drop a large pending pipe write, so wait for the flush.
const write = (stream: NodeJS.WriteStream, text: string) =>
	new Promise((r) => stream.write(text, r));

/** Answers the login check from login.json (default `fallback`) and exits. */
export async function answerLogin(fallback: FakeLogin): Promise<never> {
	const countFile = join(dir, "login-calls");
	const count = existsSync(countFile)
		? Number(readFileSync(countFile, "utf8"))
		: 0;
	writeFileSync(countFile, String(count + 1));
	const loginFile = join(dir, "login.json");
	const login: FakeLogin = existsSync(loginFile)
		? JSON.parse(readFileSync(loginFile, "utf8"))
		: fallback;
	if (login.sleepMs) await sleep(login.sleepMs);
	if (login.stdout) await write(process.stdout, login.stdout);
	if (login.stderr) await write(process.stderr, login.stderr);
	process.exit(login.exit);
}

/** Records this invocation and returns its scripted step (exits 91 if none). */
export function takeStep<T>(argv: string[], stdin: string): T {
	let n = 1;
	while (existsSync(join(dir, `call-${n}.json`))) n++;
	writeFileSync(
		join(dir, `call-${n}.json`),
		JSON.stringify({ argv, stdin, cwd: process.cwd() }),
	);
	const stepsFile = join(dir, "steps.json");
	const steps = JSON.parse(readFileSync(stepsFile, "utf8")) as T[];
	const step = steps.shift();
	writeFileSync(stepsFile, JSON.stringify(steps));
	if (!step) {
		process.stderr.write("fake cli: no scripted step left\n");
		process.exit(91);
	}
	return step;
}

/** Runs the process part of a step; `emit` writes the tool's result. */
export async function play(
	step: FakeProcessStep,
	emit: () => Promise<unknown> | undefined,
): Promise<never> {
	if (step.childSleepMs) {
		const child = spawn(
			process.execPath,
			["-e", `setTimeout(() => {}, ${step.childSleepMs})`],
			{ stdio: ["ignore", "ignore", "inherit"] },
		);
		writeFileSync(join(dir, "child.pid"), String(child.pid));
	}
	if (step.sleepMs) await sleep(step.sleepMs);
	if (step.stderr) await write(process.stderr, step.stderr);
	await emit();
	process.exit(step.exit ?? 0);
}

export const writeStdout = (text: string) => write(process.stdout, text);
