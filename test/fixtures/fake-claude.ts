// Fake `claude` executable (see fake-cli-lib.ts). `claude -p` prints a
// `--output-format json` result object on stdout; `claude auth status`
// answers from login.json (default: logged in).
import { text } from "node:stream/consumers";
import {
	answerLogin,
	type FakeProcessStep,
	play,
	takeStep,
	writeStdout,
} from "./fake-cli-lib.ts";

export interface FakeClaudeStep extends FakeProcessStep {
	/** `structured_output` of a successful result. */
	output?: unknown;
	/** Fields merged over the successful result, e.g. an error subtype. */
	result?: Record<string, unknown>;
	/** Raw stdout (wins over output/result). */
	rawStdout?: string;
}

const argv = process.argv.slice(2);

if (argv[0] === "--version") {
	process.stdout.write("0.0.0-fake (Claude Code)\n");
	process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status")
	await answerLogin({ exit: 0, stdout: '{"loggedIn":true}\n' });

const step = takeStep<FakeClaudeStep>(argv, await text(process.stdin));
await play(step, () => {
	if (step.rawStdout !== undefined) return writeStdout(step.rawStdout);
	if (step.output === undefined && step.result === undefined) return undefined;
	return writeStdout(
		JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "",
			session_id: "00000000-fake",
			num_turns: 3,
			...(step.output === undefined ? {} : { structured_output: step.output }),
			...step.result,
		}),
	);
});
