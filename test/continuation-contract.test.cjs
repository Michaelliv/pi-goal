const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const indexSource = readFileSync(join(__dirname, "../.pi/extensions/pi-goal/index.ts"), "utf8");

test("persisting a non-active goal cancels any queued continuation and hold timer", () => {
	assert.match(
		indexSource,
		/if \(next\?\.status !== "active"\) \{\s*continuationQueued = false;\s*clearHoldRecheckTimer\(\);\s*\}/,
	);
});
