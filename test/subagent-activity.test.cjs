const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const {
	ASYNC_STARTED_EVENT,
	ASYNC_COMPLETE_EVENT,
	trackSubagentActivity,
} = jiti("../.pi/extensions/pi-goal/subagent-activity.ts");

const indexSource = readFileSync(join(__dirname, "../.pi/extensions/pi-goal/index.ts"), "utf8");
const readme = readFileSync(join(__dirname, "../README.md"), "utf8");

function createFakeBus() {
	const handlers = new Map();
	return {
		emit(channel, data) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
		on(channel, handler) {
			const list = handlers.get(channel) ?? [];
			list.push(handler);
			handlers.set(channel, list);
			return () => {
				handlers.set(channel, (handlers.get(channel) ?? []).filter((entry) => entry !== handler));
			};
		},
	};
}

function createTracker(overrides = {}) {
	const bus = createFakeBus();
	let clock = 1_700_000_000_000;
	const tracker = trackSubagentActivity(bus, { now: () => clock, ...overrides });
	return {
		bus,
		tracker,
		advance(ms) {
			clock += ms;
		},
	};
}

function tempAsyncDir(state) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-async-"));
	if (state) writeFileSync(join(dir, "status.json"), JSON.stringify(state));
	return dir;
}

const DAY = 24 * 60 * 60 * 1000;

test("started then completed runs track and release", () => {
	const { bus, tracker } = createTracker();
	bus.emit(ASYNC_STARTED_EVENT, { id: "run-1" });
	assert.equal(tracker.hasActiveRuns(), true);
	bus.emit(ASYNC_COMPLETE_EVENT, { runId: "run-1", status: "completed" });
	assert.equal(tracker.hasActiveRuns(), false);
});

test("completion events for unknown runs are ignored", () => {
	const { bus, tracker } = createTracker();
	bus.emit(ASYNC_COMPLETE_EVENT, { runId: "never-started" });
	assert.equal(tracker.hasActiveRuns(), false);
	assert.equal(tracker.trackedCount(), 0);
});

test("a missed completion event is caught by status verification", () => {
	const { bus, tracker } = createTracker();
	const asyncDir = tempAsyncDir({ state: "running" });
	bus.emit(ASYNC_STARTED_EVENT, { id: "run-2", asyncDir });
	assert.equal(tracker.hasActiveRuns(), true);
	// The run finishes and writes its terminal status, but no complete event
	// ever arrives; the finished status retires the run on the next check.
	writeFileSync(join(asyncDir, "status.json"), JSON.stringify({ state: "complete" }));
	assert.equal(tracker.hasActiveRuns(), false);
});

test("a running status file keeps the hold", () => {
	const { bus, tracker } = createTracker();
	const asyncDir = tempAsyncDir({ state: "running" });
	bus.emit(ASYNC_STARTED_EVENT, { id: "run-3", asyncDir });
	assert.equal(tracker.hasActiveRuns(), true);
	assert.equal(tracker.hasActiveRuns(), true);
});

test("a queued run still counts as in flight", () => {
	const { bus, tracker } = createTracker();
	const asyncDir = tempAsyncDir({ state: "queued" });
	bus.emit(ASYNC_STARTED_EVENT, { id: "run-4", asyncDir });
	assert.equal(tracker.hasActiveRuns(), true);
});

test("paused runs do not hold the loop", () => {
	const { bus, tracker } = createTracker();
	const asyncDir = tempAsyncDir({ state: "paused" });
	bus.emit(ASYNC_STARTED_EVENT, { id: "run-5", asyncDir });
	assert.equal(tracker.hasActiveRuns(), false);
});

test("unknown future states fail safe toward holding", () => {
	const { bus, tracker } = createTracker();
	const asyncDir = tempAsyncDir({ state: "some-future-state" });
	bus.emit(ASYNC_STARTED_EVENT, { id: "run-5b", asyncDir });
	assert.equal(tracker.hasActiveRuns(), true);
});

test("a missing status file retires the run after the grace window", () => {
	const { bus, tracker, advance } = createTracker();
	const asyncDir = mkdtempSync(join(tmpdir(), "pi-goal-async-"));
	bus.emit(ASYNC_STARTED_EVENT, { id: "run-6", asyncDir });
	assert.equal(tracker.hasActiveRuns(), true);
	advance(10_000);
	assert.equal(tracker.hasActiveRuns(), true);
	advance(1);
	assert.equal(tracker.hasActiveRuns(), false);
});

test("entries without an asyncDir expire at the age ceiling", () => {
	const { bus, tracker, advance } = createTracker();
	bus.emit(ASYNC_STARTED_EVENT, { id: "run-7" });
	assert.equal(tracker.hasActiveRuns(), true);
	advance(DAY - 1);
	assert.equal(tracker.hasActiveRuns(), true);
	advance(1);
	assert.equal(tracker.hasActiveRuns(), false);
});

test("workflow completions release nested child runs", () => {
	const { bus, tracker } = createTracker();
	bus.emit(ASYNC_STARTED_EVENT, { id: "wf-1" });
	bus.emit(ASYNC_STARTED_EVENT, { id: "child-1" });
	assert.equal(tracker.hasActiveRuns(), true);
	bus.emit(ASYNC_COMPLETE_EVENT, {
		runId: "wf-1",
		status: "completed",
		results: [{ runId: "child-1", status: "completed" }],
	});
	assert.equal(tracker.hasActiveRuns(), false);
	assert.equal(tracker.trackedCount(), 0);
});

test("multiple runs hold until the last one completes", () => {
	const { bus, tracker } = createTracker();
	bus.emit(ASYNC_STARTED_EVENT, { id: "a" });
	bus.emit(ASYNC_STARTED_EVENT, { id: "b" });
	bus.emit(ASYNC_COMPLETE_EVENT, { runId: "a" });
	assert.equal(tracker.hasActiveRuns(), true);
	bus.emit(ASYNC_COMPLETE_EVENT, { runId: "b" });
	assert.equal(tracker.hasActiveRuns(), false);
});

test("malformed payloads never throw", () => {
	const { bus, tracker } = createTracker();
	assert.doesNotThrow(() => bus.emit(ASYNC_STARTED_EVENT, undefined));
	assert.doesNotThrow(() => bus.emit(ASYNC_STARTED_EVENT, "garbage"));
	assert.doesNotThrow(() => bus.emit(ASYNC_STARTED_EVENT, {}));
	assert.doesNotThrow(() => bus.emit(ASYNC_STARTED_EVENT, { id: "" }));
	assert.doesNotThrow(() => bus.emit(ASYNC_COMPLETE_EVENT, null));
	assert.doesNotThrow(() => bus.emit(ASYNC_COMPLETE_EVENT, 42));
	assert.equal(tracker.hasActiveRuns(), false);
});

test("forget clears state without unsubscribing", () => {
	const { bus, tracker } = createTracker();
	bus.emit(ASYNC_STARTED_EVENT, { id: "run-8" });
	tracker.forget();
	assert.equal(tracker.hasActiveRuns(), false);
	bus.emit(ASYNC_STARTED_EVENT, { id: "run-9" });
	assert.equal(tracker.hasActiveRuns(), true);
});

test("dispose stops tracking entirely", () => {
	const { bus, tracker } = createTracker();
	tracker.dispose();
	bus.emit(ASYNC_STARTED_EVENT, { id: "run-10" });
	assert.equal(tracker.hasActiveRuns(), false);
	assert.equal(tracker.trackedCount(), 0);
});

test("the continuation loop holds while runs are in flight", () => {
	assert.match(
		indexSource,
		/if \(inFlightRuns\(\)\) \{\s*\/\/ Idle-but-not-done[\s\S]*?armHoldRecheck\(pi, ctx\);\s*return;\s*\}/,
	);
});

test("resuming an idle goal skips the tick while runs are in flight", () => {
	assert.match(indexSource, /if \(inFlightRuns\(\)\) armHoldRecheck\(pi, ctx\);\s*else queueContinuation\(pi, next\);/);
});

test("the hold re-check timer is cleared with the goal and on session start", () => {
	assert.match(indexSource, /if \(next\?\.status !== "active"\) \{[\s\S]*?clearHoldRecheckTimer\(\);/);
	assert.match(indexSource, /subagentActivity\?\.forget\(\);\s*clearHoldRecheckTimer\(\);/);
});

test("the tracker is bound to the session event bus on extension load", () => {
	assert.match(indexSource, /subagentActivity = trackSubagentActivity\(pi\.events\);/);
});

test("README documents the background sub-agent hold", () => {
	assert.match(readme, /## Background sub-agents/);
	assert.match(readme, /holds while any background run/);
	assert.match(readme, /never stall the goal/);
});
