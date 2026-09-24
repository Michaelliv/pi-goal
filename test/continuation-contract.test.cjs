const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const indexSource = readFileSync(join(__dirname, "../.pi/extensions/pi-goal/index.ts"), "utf8");

test("persisting a non-active goal cancels any queued continuation", () => {
	assert.match(
		indexSource,
		/if \(next\?\.status !== "active"\) \{\s*continuationQueued = false;/,
	);
});

// A goal auto-re-queues a continuation on every agent_end with no cap. If the
// model keeps landing on the same blocker, that runs forever unattended --
// measured on a real goal: ~5 hours and ~$494 spent re-asking an
// already-unanswered question with zero progress. Consecutive *automatic*
// continuations (not a real user message, a manual resume, or a replaced
// goal) must be capped, and persisting a non-active goal must reset the
// streak so a fresh resume/replace always gets a full budget again.
test("consecutive automatic continuations are capped and reset on non-active persist", () => {
	assert.match(indexSource, /const MAX_CONSECUTIVE_AUTO_CONTINUATIONS = \d+;/);
	assert.match(
		indexSource,
		/if \(next\?\.status !== "active"\) \{\s*continuationQueued = false;\s*consecutiveAutoContinuations = 0;\s*autoContinuationPending = false;\s*\}/,
	);
	assert.match(
		indexSource,
		/if \(consecutiveAutoContinuations >= MAX_CONSECUTIVE_AUTO_CONTINUATIONS\) \{/,
	);
});

// The cap only fires for continuations *we* triggered automatically -- it must
// not fire for turns started by a real user message, a manual /goal resume,
// or a freshly (re)created goal, or it would block legitimate work.
test("only auto-triggered continuations count toward the streak", () => {
	assert.match(indexSource, /autoContinuationPending = true;\s*emitGoalEvent\(pi, "continuation", goal/);
	assert.match(
		indexSource,
		/if \(autoContinuationPending\) \{\s*consecutiveAutoContinuations \+= 1;\s*autoContinuationPending = false;\s*\} else \{/,
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
