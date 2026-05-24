const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const { tokenDeltaFromUsage } = jiti("../.pi/extensions/pi-goal/usage.ts");

test("tokenDeltaFromUsage counts input, output, and cache tokens", () => {
	assert.equal(tokenDeltaFromUsage({ input: 100, output: 25, cacheRead: 50, cacheWrite: 75 }), 250);
});

test("tokenDeltaFromUsage prefers totalTokens to avoid double-counting cache tokens", () => {
	assert.equal(tokenDeltaFromUsage({ totalTokens: 123, input: 100, output: 25, cacheRead: 50, cacheWrite: 75 }), 123);
});

test("tokenDeltaFromUsage clamps negative totals to zero", () => {
	assert.equal(tokenDeltaFromUsage({ input: -100, output: 25, cacheRead: 50 }), 0);
});

test("tokenDeltaFromUsage treats missing usage as zero", () => {
	assert.equal(tokenDeltaFromUsage(undefined), 0);
	assert.equal(tokenDeltaFromUsage(null), 0);
});
