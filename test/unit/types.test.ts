import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	InvalidReviewResultError,
	parseReviewResult,
} from "../../src/core/types.ts";

describe("parseReviewResult", () => {
	it("accepts a valid approval", () => {
		const r = parseReviewResult({
			verdict: "APPROVED",
			summary: "ok",
			findings: [],
		});
		assert.deepEqual(r, { verdict: "APPROVED", summary: "ok", findings: [] });
	});

	it("accepts findings with optional file/line and drops unknown fields", () => {
		const r = parseReviewResult({
			verdict: "CHANGES_REQUESTED",
			summary: "s",
			extra: true,
			findings: [
				{
					id: "CCC-001",
					severity: "medium",
					file: "a.ts",
					line: 3,
					message: "m",
					junk: 1,
				},
				{
					id: "CCC-002",
					severity: "low",
					file: null,
					line: null,
					message: "n",
				},
			],
		});
		assert.deepEqual(r.findings, [
			{
				id: "CCC-001",
				severity: "medium",
				file: "a.ts",
				line: 3,
				message: "m",
			},
			{ id: "CCC-002", severity: "low", message: "n" },
		]);
		assert.equal("extra" in r, false);
	});

	const invalid: [string, unknown][] = [
		["null", null],
		["string", "APPROVED"],
		["array", []],
		["missing verdict", { summary: "", findings: [] }],
		["lowercase verdict", { verdict: "approved", summary: "", findings: [] }],
		["unknown verdict", { verdict: "LGTM", summary: "", findings: [] }],
		["missing summary", { verdict: "APPROVED", findings: [] }],
		["missing findings", { verdict: "APPROVED", summary: "" }],
		["findings not array", { verdict: "APPROVED", summary: "", findings: {} }],
		[
			"changes requested without findings",
			{ verdict: "CHANGES_REQUESTED", summary: "", findings: [] },
		],
		[
			"finding without id",
			{
				verdict: "CHANGES_REQUESTED",
				summary: "",
				findings: [{ severity: "high", message: "m" }],
			},
		],
		[
			"finding with bad severity",
			{
				verdict: "CHANGES_REQUESTED",
				summary: "",
				findings: [{ id: "CCC-001", severity: "critical", message: "m" }],
			},
		],
		[
			"finding without message",
			{
				verdict: "CHANGES_REQUESTED",
				summary: "",
				findings: [{ id: "CCC-001", severity: "high" }],
			},
		],
		[
			// Would become Infinity in lastFindingNumber and corrupt the state.
			"finding with an unsafe ID number",
			{
				verdict: "CHANGES_REQUESTED",
				summary: "",
				findings: [
					{ id: `CCC-${"9".repeat(309)}`, severity: "high", message: "m" },
				],
			},
		],
		[
			"finding with non-integer line",
			{
				verdict: "CHANGES_REQUESTED",
				summary: "",
				findings: [
					{ id: "CCC-001", severity: "high", message: "m", line: 1.5 },
				],
			},
		],
		[
			"finding with numeric file",
			{
				verdict: "CHANGES_REQUESTED",
				summary: "",
				findings: [{ id: "CCC-001", severity: "high", message: "m", file: 1 }],
			},
		],
	];
	for (const [name, value] of invalid) {
		it(`rejects ${name}`, () => {
			assert.throws(() => parseReviewResult(value), InvalidReviewResultError);
		});
	}
});
