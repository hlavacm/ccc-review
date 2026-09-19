import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";

const coreDir = join(import.meta.dirname, "../../src/core");

it("core imports only node builtins and sibling core modules", async () => {
	for (const file of await readdir(coreDir)) {
		const source = await readFile(join(coreDir, file), "utf8");
		for (const [, specifier] of source.matchAll(/from\s+"([^"]+)"/g))
			assert.match(
				specifier ?? "",
				/^(node:|\.\/[^/]+$)/,
				`${file} imports ${specifier}`,
			);
	}
});
