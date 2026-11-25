const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const indexSource = readFileSync(join(__dirname, "../.pi/extensions/pi-goal/index.ts"), "utf8");

test("persisting a non-active goal cancels queued and scheduled continuation", () => {
	assert.match(
		indexSource,
		/if \(next\?\.status !== "active"\) \{\s*continuationQueued = false;\s*continuationTurnPending = false;\s*clearContinuationTimer\(\);\s*\}/,
	);
});

test("agent_end parks a stalled loop instead of re-feeding the objective", () => {
	assert.match(
		indexSource,
		/if \(step\.action === "pause"\) \{\s*parkGoal\(pi, ctx, "stall"\);\s*return;\s*\}/,
	);
});

test("a status-poll loop is bounded by the self-started turn limit", () => {
	// The stall brake cannot see this shape: a cheap tool call per turn counts as progress, so
	// the run counter is the only bound.
	assert.match(indexSource, /if \(runStreak >= RUN_LIMIT\) \{\s*parkGoal\(pi, ctx, "run"\);\s*return;\s*\}/);
	assert.match(indexSource, /if \(turnIsContinuation\) runStreak \+= 1;/);
	assert.match(indexSource, /process\.env\.PI_GOAL_RUN_LIMIT/);
});

test("a self-started loop backs off instead of spinning", () => {
	assert.match(indexSource, /const delay = continuationDelayMs\(stallStreak\);/);
	assert.match(indexSource, /else continuationTimer = setTimeout\(fire, delay\);/);
});

test("a turn the loop did not start resumes a parked goal and clears the timer", () => {
	// Keyed on the framework turn, not on any tool's message shape, so parking and resuming
	// work with no background-subagent package installed.
	assert.match(indexSource, /turnIsContinuation = continuationTurnPending;/);
	assert.match(indexSource, /if \(!turnIsContinuation\) \{/);
	assert.match(indexSource, /clearContinuationTimer\(\);\s*runStreak = 0;/);
	assert.match(indexSource, /if \(goal\?\.status === "waiting"\) \{/);
	assert.doesNotMatch(indexSource, /role !== "user"/);
});

test("parking records the reason and emits a transcript event", () => {
	assert.match(indexSource, /status: "waiting", waitReason: reason, updatedAt: Date\.now\(\)/);
	assert.match(indexSource, /emitGoalEvent\(pi, "waiting", next\);/);
});

test("goal_wait parks the goal and is exposed only while a goal is active", () => {
	assert.match(indexSource, /name: "goal_wait"/);
	assert.match(indexSource, /const ACTIVE_GOAL_TOOL_NAMES = \["get_goal", "update_goal", "goal_wait"\];/);
	assert.match(indexSource, /status: "waiting",\s*waitReason: "model",/);
});

test("a user abort pauses the goal instead of letting the loop restart it", () => {
	// Credits the unmerged upstream fix on fix/pause-on-escape (3078686).
	assert.match(indexSource, /if \(message\?\.stopReason === "aborted"\) \{/);
	assert.match(indexSource, /status: "paused", updatedAt: Date\.now\(\) \};\s*persist\(pi, ctx, aborted\);/);
	assert.match(indexSource, /emitGoalEvent\(pi, "paused", aborted, \{ deliverAs: "nextTurn" \}\);/);
});

test("the continuation prompt offers goal_wait instead of a status-poll turn", () => {
	assert.match(
		indexSource,
		/If the only pending work is outside this session \(a dispatched job, a background run, another person's decision\), call goal_wait with the reason\./,
	);
});
