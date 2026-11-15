const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const {
	accountGoalTurn,
	createGoalState,
	formatElapsed,
	formatTokens,
	goalEventStatus,
	goalUsage,
	normalizeTokenBudget,
	parseTokenBudget,
	statusLine,
	truncateObjective,
	turnMadeProgress,
	stallStreakStep,
	GOAL_TOOL_NAMES,
} = jiti("../.pi/extensions/pi-goal/goal-state.ts");

const asstWith = (...blocks) => [{ role: "assistant", content: blocks }];

test("turnMadeProgress: true when a non-goal tool was called", () => {
	assert.equal(turnMadeProgress(asstWith({ type: "toolCall", name: "bash" })), true);
	assert.equal(turnMadeProgress(asstWith({ type: "text", text: "ok" }, { type: "toolCall", name: "edit" })), true);
});

test("turnMadeProgress: false for text-only or goal-tool-only loops (the runaway signature)", () => {
	assert.equal(turnMadeProgress(asstWith({ type: "text", text: "still blocked, no change" })), false);
	for (const name of GOAL_TOOL_NAMES) {
		assert.equal(turnMadeProgress(asstWith({ type: "toolCall", name })), false);
	}
	assert.equal(turnMadeProgress([]), false);
});

test("turnMadeProgress: thinking-only turn is not progress", () => {
	// ThinkingContent blocks must not be mistaken for tool calls
	assert.equal(turnMadeProgress(asstWith({ type: "thinking", thinking: "I will plan..." })), false);
	// Thinking + goal-tool-only is still no progress
	assert.equal(turnMadeProgress(asstWith({ type: "thinking", thinking: "ok" }, { type: "toolCall", name: "get_goal" })), false);
});

test("turnMadeProgress: fails open on unknown/malformed shapes", () => {
	assert.equal(turnMadeProgress(undefined), true);
	assert.equal(turnMadeProgress(null), true);
	assert.equal(turnMadeProgress("nope"), true);
	assert.equal(turnMadeProgress([{ role: "assistant" }]), false); // no content array → no progress found
});

test("stallStreakStep: progress resets streak and returns continue", () => {
	assert.deepEqual(stallStreakStep(0, true, 3), { next: 0, action: "continue" });
	assert.deepEqual(stallStreakStep(2, true, 3), { next: 0, action: "continue" }); // reset mid-streak
});

test("stallStreakStep: no-progress increments and continues below limit", () => {
	assert.deepEqual(stallStreakStep(0, false, 3), { next: 1, action: "continue" });
	assert.deepEqual(stallStreakStep(1, false, 3), { next: 2, action: "continue" });
});

test("stallStreakStep: no-progress at limit triggers pause", () => {
	assert.deepEqual(stallStreakStep(2, false, 3), { next: 3, action: "pause" }); // next === limit
	assert.deepEqual(stallStreakStep(5, false, 3), { next: 6, action: "pause" }); // already past limit
});

test("stallStreakStep: limit=1 pauses on the very first no-progress turn", () => {
	assert.deepEqual(stallStreakStep(0, false, 1), { next: 1, action: "pause" });
});

test("parseTokenBudget returns trimmed objective with no budget", () => {
	assert.deepEqual(parseTokenBudget("  finish the migration  "), {
		objective: "finish the migration",
		tokenBudget: null,
	});
});

test("parseTokenBudget accepts equals, spaces, decimals, k, and m", () => {
	assert.deepEqual(parseTokenBudget("--tokens=50k finish migration"), {
		objective: "finish migration",
		tokenBudget: 50_000,
	});
	assert.deepEqual(parseTokenBudget("finish --tokens 1.5m migration"), {
		objective: "finish migration",
		tokenBudget: 1_500_000,
	});
	assert.deepEqual(parseTokenBudget("finish --tokens 250 migration"), {
		objective: "finish migration",
		tokenBudget: 250,
	});
});

test("parseTokenBudget preserves objective and reports invalid budget", () => {
	assert.deepEqual(parseTokenBudget("ship --tokens 0 now"), {
		objective: "ship --tokens 0 now",
		tokenBudget: null,
		error: "Token budget must be positive.",
	});
});

test("parseTokenBudget reports invalid explicit token flag values", () => {
	assert.deepEqual(parseTokenBudget("ship --tokens soon"), {
		objective: "ship --tokens soon",
		tokenBudget: null,
		error: "Token budget must be positive.",
	});
	assert.deepEqual(parseTokenBudget("ship --tokens -5 now"), {
		objective: "ship --tokens -5 now",
		tokenBudget: null,
		error: "Token budget must be positive.",
	});
});

test("normalizeTokenBudget accepts absent and positive numeric values", () => {
	assert.deepEqual(normalizeTokenBudget(undefined), { tokenBudget: null });
	assert.deepEqual(normalizeTokenBudget(null), { tokenBudget: null });
	assert.deepEqual(normalizeTokenBudget("1500.4"), { tokenBudget: 1500 });
	assert.deepEqual(normalizeTokenBudget(1500.6), { tokenBudget: 1501 });
});

test("normalizeTokenBudget rejects non-positive and non-numeric values", () => {
	assert.deepEqual(normalizeTokenBudget(0), {
		tokenBudget: null,
		error: "tokenBudget must be a positive number when provided.",
	});
	assert.deepEqual(normalizeTokenBudget("nope"), {
		tokenBudget: null,
		error: "tokenBudget must be a positive number when provided.",
	});
});

test("formatTokens uses compact K and M suffixes", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1_000), "1K");
	assert.equal(formatTokens(12_340), "12.3K");
	assert.equal(formatTokens(1_250_000), "1.3M");
});

test("formatElapsed keeps seconds, minutes, and hours readable", () => {
	assert.equal(formatElapsed(59), "59s");
	assert.equal(formatElapsed(60), "1m");
	assert.equal(formatElapsed(3_599), "59m");
	assert.equal(formatElapsed(3_600), "1h");
	assert.equal(formatElapsed(5_460), "1h 31m");
});

test("statusLine covers all lifecycle states", () => {
	assert.equal(statusLine(null), undefined);
	assert.equal(statusLine({ status: "active", tokenBudget: 1000, tokensUsed: 500, timeUsedSeconds: 10 }), "Pursuing goal (500 / 1K)");
	assert.equal(statusLine({ status: "paused", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 10 }), "Goal paused (/goal resume)");
	assert.equal(statusLine({ status: "budget_limited", tokenBudget: 1000, tokensUsed: 1000, timeUsedSeconds: 10 }), "Goal unmet (1K / 1K)");
	assert.equal(statusLine({ status: "budget_limited", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 10 }), "Goal abandoned");
	assert.equal(statusLine({ status: "complete", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 61 }), "Goal achieved (1m)");
});

test("goalUsage prefers token budget usage when budgeted", () => {
	assert.equal(goalUsage({ tokenBudget: 1000, tokensUsed: 250, timeUsedSeconds: 99 }), "250 / 1K tokens");
	assert.equal(goalUsage({ tokenBudget: null, tokensUsed: 250, timeUsedSeconds: 99 }), "1m");
});

test("truncateObjective collapses whitespace and truncates at max", () => {
	assert.equal(truncateObjective("  one\n two\tthree  "), "one two three");
	assert.equal(truncateObjective("abcdef", 4), "abc…");
});

test("goalEventStatus maps event kinds to display labels", () => {
	assert.equal(goalEventStatus("active"), "active");
	assert.equal(goalEventStatus("continuation"), "continuing");
	assert.equal(goalEventStatus("budget_limited"), "budget reached");
	assert.equal(goalEventStatus("complete"), "achieved");
});

test("createGoalState creates a deterministic active goal when time and random are supplied", () => {
	assert.deepEqual(createGoalState("ship it", 123, 42, 0.5), {
		version: 1,
		id: "42-8",
		objective: "ship it",
		status: "active",
		tokenBudget: 123,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 42,
		updatedAt: 42,
	});
});

test("accountGoalTurn adds usage and marks active budgeted goals budget-limited", () => {
	const goal = createGoalState("ship it", 100, 42, 0.5);
	assert.deepEqual(accountGoalTurn(goal, 70, 5, 50), {
		...goal,
		tokensUsed: 70,
		timeUsedSeconds: 5,
		updatedAt: 50,
		status: "active",
	});
	assert.equal(accountGoalTurn(goal, 100, 5, 50).status, "budget_limited");
});

test("accountGoalTurn preserves complete status while charging final turn usage", () => {
	const completed = { ...createGoalState("ship it", 100, 42, 0.5), status: "complete" };
	assert.deepEqual(accountGoalTurn(completed, 25, 7, 55), {
		...completed,
		tokensUsed: 25,
		timeUsedSeconds: 7,
		updatedAt: 55,
		status: "complete",
	});
});

test("accountGoalTurn clamps negative usage deltas", () => {
	const goal = createGoalState("ship it", null, 42, 0.5);
	assert.deepEqual(accountGoalTurn(goal, -25, -7, 55), {
		...goal,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		updatedAt: 55,
	});
});
