const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const indexSource = readFileSync(join(__dirname, "../.pi/extensions/pi-goal/index.ts"), "utf8");

test("persisting a non-active goal cancels any queued continuation", () => {
	assert.match(
		indexSource,
		/if \(next\?\.status !== "active"\) \{\s*continuationQueued = false;\s*\}/,
	);
});

// Automatic agent_end continuations queue one new full-size continuationPrompt()
// per turn while a goal stays active (queueContinuation -> emitGoalEvent(pi,
// "continuation", ...)). Left unbounded, a long-running autonomous goal appends
// hundreds of byte-identical copies of that prompt, which by itself can push a
// session past its context window regardless of compaction settings. Automatic
// continuations must stay on the short reminder; only genuine
// activation/resume should pay for the full audit essay.
test("automatic continuation events use the short reminder, not the full audit essay", () => {
	assert.match(
		indexSource,
		/case "continuation":\s*return shortContinuationPrompt\(state\);/,
	);
	assert.doesNotMatch(
		indexSource,
		/case "active":\s*case "continuation":/,
	);
});

test("shortContinuationPrompt still carries the objective and current budget every turn", () => {
	assert.match(indexSource, /function shortContinuationPrompt\(state: GoalState\): string \{/);
	assert.match(indexSource, /<untrusted_objective>\$\{state\.objective\}<\/untrusted_objective>|<untrusted_objective>\n\$\{state\.objective\}\n<\/untrusted_objective>/);
});
