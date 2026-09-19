// Fake `codex` executable. `codex exec` behaviour comes from
// $FAKE_CODEX_DIR/steps.json (a queue consumed one step per invocation); every
// exec invocation is recorded as $FAKE_CODEX_DIR/call-<n>.json with its argv,
// stdin and cwd. `codex login status` answers from $FAKE_CODEX_DIR/login.json
// (default: logged in) and is counted in login-calls.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { text } from "node:stream/consumers";

export interface FakeCodexStep {
	/** JSON value written to the --output-last-message file. */
	output?: unknown;
	/** Raw text written to the --output-last-message file (wins over output). */
	rawOutput?: string;
	stderr?: string;
	exit?: number;
	sleepMs?: number;
	/** Start a grandchild that inherits stderr and lives this long; pid → child.pid. */
	childSleepMs?: number;
}

const dir = process.env.FAKE_CODEX_DIR;
if (!dir) {
	process.stderr.write("FAKE_CODEX_DIR not set\n");
	process.exit(90);
}
const argv = process.argv.slice(2);

export interface FakeCodexLogin {
	exit: number;
	stdout?: string;
	stderr?: string;
	sleepMs?: number;
}

if (argv[0] === "--version") {
	process.stdout.write("codex-cli 0.0.0-fake\n");
	process.exit(0);
}

if (argv[0] === "login" && argv[1] === "status") {
	const countFile = join(dir, "login-calls");
	const count = existsSync(countFile)
		? Number(readFileSync(countFile, "utf8"))
		: 0;
	writeFileSync(countFile, String(count + 1));
	const loginFile = join(dir, "login.json");
	const login: FakeCodexLogin = existsSync(loginFile)
		? JSON.parse(readFileSync(loginFile, "utf8"))
		: { exit: 0, stdout: "Logged in using ChatGPT\n" };
	if (login.sleepMs) await new Promise((r) => setTimeout(r, login.sleepMs));
	if (login.stdout) process.stdout.write(login.stdout);
	if (login.stderr)
		await new Promise((r) => process.stderr.write(login.stderr as string, r));
	process.exit(login.exit);
}
const stdin = await text(process.stdin);

let n = 1;
while (existsSync(join(dir, `call-${n}.json`))) n++;
writeFileSync(
	join(dir, `call-${n}.json`),
	JSON.stringify({ argv, stdin, cwd: process.cwd() }),
);

const stepsFile = join(dir, "steps.json");
const steps = JSON.parse(readFileSync(stepsFile, "utf8")) as FakeCodexStep[];
const step = steps.shift();
writeFileSync(stepsFile, JSON.stringify(steps));
if (!step) {
	process.stderr.write("fake codex: no scripted step left\n");
	process.exit(91);
}

if (step.childSleepMs) {
	const child = spawn(
		process.execPath,
		["-e", `setTimeout(() => {}, ${step.childSleepMs})`],
		{ stdio: ["ignore", "ignore", "inherit"] },
	);
	writeFileSync(join(dir, "child.pid"), String(child.pid));
}
if (step.sleepMs) await new Promise((r) => setTimeout(r, step.sleepMs));
// process.exit() would drop a large pending pipe write, so wait for the flush.
if (step.stderr)
	await new Promise((r) => process.stderr.write(step.stderr as string, r));
const outIndex = argv.indexOf("--output-last-message");
const outFile = outIndex >= 0 ? argv[outIndex + 1] : undefined;
if (outFile && (step.rawOutput !== undefined || step.output !== undefined))
	writeFileSync(outFile, step.rawOutput ?? JSON.stringify(step.output));
process.exit(step.exit ?? 0);
