import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	appendHistory,
	createTaskState,
	loadState,
	readHistory,
	StateError,
	saveState,
	type TaskState,
} from "../../src/core/state.ts";
import type { GitBaseline } from "../../src/core/types.ts";
import { changesRequested, finding } from "../helpers/fake-reviewer.ts";
import { makeTempDir, removeDir } from "../helpers/temp-dir.ts";

const baseline: GitBaseline = {
	root: "/repo",
	headSha: null,
	branch: null,
	status: [
		{ code: "R ", path: "new name.ts", origPath: "old.ts" },
		{ code: "??", path: "ünïcode.txt" },
	],
};

const newState = () =>
	createTaskState({ writer: "claude", reviewer: "codex", baseline });

describe("createTaskState", () => {
	it("creates an active round-0 task with default max rounds", () => {
		const s = newState();
		assert.equal(s.active, true);
		assert.equal(s.round, 0);
		assert.equal(s.maxRounds, 3);
		assert.match(s.taskId, /^[0-9a-f-]{36}$/);
		assert.notEqual(s.taskId, newState().taskId);
	});

	it("rejects invalid maxRounds and writer === reviewer", () => {
		for (const maxRounds of [0, -1, 1.5, Number.NaN])
			assert.throws(
				() =>
					createTaskState({
						writer: "claude",
						reviewer: "codex",
						baseline,
						maxRounds,
					}),
				StateError,
			);
		assert.throws(
			() => createTaskState({ writer: "codex", reviewer: "codex", baseline }),
			StateError,
		);
	});
});

describe("state persistence", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await makeTempDir();
	});
	afterEach(() => removeDir(dir));

	it("saves and loads an active task", async () => {
		const s = newState();
		await saveState(dir, s);
		assert.deepEqual(await loadState(dir, s.taskId), s);
	});

	it("saves and loads current round, last result and last error", async () => {
		const s: TaskState = {
			...newState(),
			round: 2,
			active: false,
			lastResult: changesRequested(
				{ ...finding("CCC-001"), file: "a.ts", line: 7 },
				finding("CCC-002"),
			),
			lastError: "timeout",
		};
		await saveState(join(dir, "nested", "dir"), s);
		assert.deepEqual(await loadState(join(dir, "nested", "dir"), s.taskId), s);
	});

	it("overwrites existing state and leaves no temp files", async () => {
		const s = newState();
		await saveState(dir, s);
		await saveState(dir, { ...s, round: 1 });
		assert.equal((await loadState(dir, s.taskId))?.round, 1);
		assert.deepEqual(await readdir(dir), [`${s.taskId}.json`]);
	});

	it("failed write keeps the previous state and leaves no temp file", async () => {
		const s = newState();
		await saveState(dir, s);
		const before = await readFile(join(dir, `${s.taskId}.json`), "utf8");
		await chmod(dir, 0o500);
		try {
			await assert.rejects(saveState(dir, { ...s, round: 2 }));
		} finally {
			await chmod(dir, 0o700);
		}
		assert.equal(await readFile(join(dir, `${s.taskId}.json`), "utf8"), before);
		assert.deepEqual(await readdir(dir), [`${s.taskId}.json`]);
	});

	it("failed rename removes the temp file", async () => {
		const s = newState();
		// A non-empty directory at the target path makes rename() fail.
		await mkdir(join(dir, `${s.taskId}.json`, "blocker"), { recursive: true });
		await assert.rejects(saveState(dir, s));
		assert.deepEqual(await readdir(dir), [`${s.taskId}.json`]);
	});

	it("returns undefined for an unknown task", async () => {
		assert.equal(await loadState(dir, "missing"), undefined);
		assert.equal(await loadState(join(dir, "nope"), "missing"), undefined);
	});

	it("rejects task ids that could escape the state dir", async () => {
		for (const id of ["../x", "a/b", "", "."]) {
			await assert.rejects(loadState(dir, id), StateError);
			await assert.rejects(
				saveState(dir, { ...newState(), taskId: id }),
				StateError,
			);
		}
	});

	describe("invalid/corrupt state fails safely", () => {
		const valid = newState();
		const json = (patch: Record<string, unknown>) =>
			JSON.stringify({ ...valid, ...patch });
		const corrupt: [string, string][] = [
			["empty file", ""],
			["truncated JSON", json({}).slice(0, 20)],
			["garbage", "not json at all"],
			["JSON null", "null"],
			["JSON array", "[]"],
			["unknown version", json({ version: 2 })],
			["missing version", json({ version: undefined })],
			["taskId mismatch", json({ taskId: "other" })],
			["active as string", json({ active: "true" })],
			["unknown writer", json({ writer: "gpt" })],
			["unknown reviewer", json({ reviewer: 1 })],
			["writer equals reviewer", json({ writer: "codex", reviewer: "codex" })],
			["negative round", json({ round: -1 })],
			["fractional round", json({ round: 1.5 })],
			["zero maxRounds", json({ maxRounds: 0 })],
			["missing baseline", json({ baseline: undefined })],
			[
				"bad baseline status",
				json({ baseline: { ...baseline, status: [{}] } }),
			],
			["bad baseline head", json({ baseline: { ...baseline, headSha: 1 } })],
			["numeric lastError", json({ lastError: 1 })],
			[
				"forged approval in lastResult",
				json({
					lastResult: { verdict: "approved", summary: "", findings: [] },
				}),
			],
		];
		for (const [name, content] of corrupt) {
			it(name, async () => {
				await writeFile(join(dir, `${valid.taskId}.json`), content);
				await assert.rejects(loadState(dir, valid.taskId), (error: Error) => {
					assert.ok(error instanceof StateError, error.message);
					assert.match(error.message, /corrupt state file/);
					return true;
				});
			});
		}

		it("does not overwrite a corrupt file when loading fails", async () => {
			const file = join(dir, `${valid.taskId}.json`);
			await writeFile(file, "{broken");
			await assert.rejects(loadState(dir, valid.taskId), StateError);
			assert.equal(await readFile(file, "utf8"), "{broken");
		});
	});
});

describe("review history", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await makeTempDir();
	});
	afterEach(() => removeDir(dir));

	it("appends entries in order with a timestamp and reads them back", async () => {
		const result = changesRequested(finding("CCC-001"));
		await appendHistory(join(dir, "nested"), "t1", { event: "on" });
		await appendHistory(join(dir, "nested"), "t1", {
			event: "round",
			round: 1,
			outcome: "changes_requested",
			result,
		});
		await appendHistory(join(dir, "nested"), "t1", {
			event: "round",
			round: 2,
			outcome: "reviewer_error",
			error: "boom",
		});
		const history = await readHistory(join(dir, "nested"), "t1");
		assert.deepEqual(
			history.map(({ at: _, ...e }) => e),
			[
				{ event: "on" },
				{ event: "round", round: 1, outcome: "changes_requested", result },
				{ event: "round", round: 2, outcome: "reviewer_error", error: "boom" },
			],
		);
		for (const e of history) assert.ok(!Number.isNaN(Date.parse(e.at)));
		assert.equal(
			(await readFile(join(dir, "nested", "t1.jsonl"), "utf8")).split("\n")
				.length,
			4,
		);
	});

	it("returns an empty history for an unknown task", async () => {
		assert.deepEqual(await readHistory(dir, "missing"), []);
	});

	it("rejects task ids that could escape the history dir", async () => {
		await assert.rejects(
			appendHistory(dir, "../x", { event: "on" }),
			StateError,
		);
		await assert.rejects(readHistory(dir, "a/b"), StateError);
	});

	const corrupt: [string, string][] = [
		["garbage line", '{"at":"x","event":"on"}\nnot json\n'],
		["unknown event", '{"at":"x","event":"boom"}\n'],
		["not an object", "[]\n"],
		// Regression: accepted, then status crashed on `at.slice`.
		["missing timestamp", '{"event":"on"}\n'],
		["numeric timestamp", '{"at":1,"event":"on"}\n'],
		["fractional round", '{"at":"x","event":"round","round":1.5}\n'],
		["numeric outcome", '{"at":"x","event":"round","round":1,"outcome":2}\n'],
		["numeric error", '{"at":"x","event":"round","round":1,"error":2}\n'],
		[
			"forged result",
			'{"at":"x","event":"round","round":1,"result":{"verdict":"OK"}}\n',
		],
	];
	for (const [name, content] of corrupt)
		it(`corrupt history (${name}) is an error, not silently dropped`, async () => {
			await writeFile(join(dir, "t1.jsonl"), content);
			await assert.rejects(readHistory(dir, "t1"), (error: Error) => {
				assert.ok(error instanceof StateError);
				assert.match(error.message, /corrupt history file/);
				return true;
			});
		});
});
