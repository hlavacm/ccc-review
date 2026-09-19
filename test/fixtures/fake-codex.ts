// Fake `codex` executable (see fake-cli-lib.ts). `codex exec` writes the
// step's output to the --output-last-message file; `codex login status`
// answers from login.json (default: logged in).
import { writeFileSync } from "node:fs";
import { text } from "node:stream/consumers";
import {
	answerLogin,
	type FakeLogin,
	type FakeProcessStep,
	play,
	takeStep,
} from "./fake-cli-lib.ts";

export type FakeCodexLogin = FakeLogin;

export interface FakeCodexStep extends FakeProcessStep {
	/** JSON value written to the --output-last-message file. */
	output?: unknown;
	/** Raw text written to the --output-last-message file (wins over output). */
	rawOutput?: string;
}

const argv = process.argv.slice(2);

if (argv[0] === "--version") {
	process.stdout.write("codex-cli 0.0.0-fake\n");
	process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status")
	await answerLogin({ exit: 0, stdout: "Logged in using ChatGPT\n" });

const step = takeStep<FakeCodexStep>(argv, await text(process.stdin));
await play(step, () => {
	const outIndex = argv.indexOf("--output-last-message");
	const outFile = outIndex >= 0 ? argv[outIndex + 1] : undefined;
	if (outFile && (step.rawOutput !== undefined || step.output !== undefined))
		writeFileSync(outFile, step.rawOutput ?? JSON.stringify(step.output));
	return undefined;
});
