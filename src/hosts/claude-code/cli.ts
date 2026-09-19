// Claude Code hook entry: `node cli.ts <command|prompt-submit|stop>`,
// hook JSON on stdin, hook output JSON on stdout. Always exits 0.
import { text } from "node:stream/consumers";
import { configFromEnv, runHook } from "./hooks.ts";

const output = await runHook(process.argv[2], await text(process.stdin), () =>
	configFromEnv(process.env),
);
if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
