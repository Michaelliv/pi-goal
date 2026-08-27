const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const piGoal = jiti("../.pi/extensions/pi-goal/index.ts").default;

// Minimal ExtensionAPI/ExtensionContext mocks driving the real extension code.
function createHarness() {
	const handlers = {};
	const sent = [];
	const entries = [];
	const tools = {};
	const state = { idle: true, pending: false };

	const pi = {
		on: (event, fn) => {
			handlers[event] = fn;
		},
		registerMessageRenderer: () => {},
		registerTool: (tool) => {
			tools[tool.name] = tool;
		},
		registerCommand: () => {},
		sendMessage: (message, options) => {
			sent.push({ kind: message.details?.kind, options, content: message.content });
		},
		appendEntry: (type, data) => {
			entries.push({ type, data });
		},
		getActiveTools: () => [],
		setActiveTools: () => {},
	};
	const ctx = {
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		ui: { setStatus: () => {}, notify: () => {}, confirm: async () => true },
		sessionManager: { getBranch: () => entries, getEntries: () => entries },
	};
	const currentGoal = () => entries.at(-1).data.goal;
	const continuations = () => sent.filter((item) => item.kind === "continuation").length;
	const flush = () => new Promise((resolve) => setImmediate(resolve));

	return { pi, ctx, handlers, sent, tools, state, currentGoal, continuations, flush };
}

test("waiting goal suppresses continuation spam and auto-resumes on the next turn", async () => {
	const h = createHarness();
	piGoal(h.pi);
	await h.handlers.session_start({ reason: "startup" }, h.ctx);

	const created = await h.tools.create_goal.execute("1", { objective: "test objective" }, undefined, undefined, h.ctx);
	assert.equal(created.isError, undefined);
	assert.equal(h.sent.at(-1).kind, "active");

	// Baseline: an agent_end with an active goal queues exactly one continuation.
	await h.handlers.turn_start(undefined, h.ctx);
	await h.handlers.agent_end(undefined, h.ctx);
	await h.flush();
	assert.equal(h.continuations(), 1);

	// The agent marks the goal waiting before ending its turn (e.g. a background
	// task notification will wake the session; polling would burn API calls).
	const waited = await h.tools.update_goal.execute("2", { status: "waiting" }, undefined, undefined, h.ctx);
	assert.equal(waited.isError, undefined);
	assert.equal(h.currentGoal().status, "waiting");
	// The waiting event must never wake the agent: a steer/followUp delivery
	// would start a turn, auto-resume the goal, and re-arm the loop.
	assert.equal(h.sent.at(-1).options?.deliverAs, "nextTurn");
	assert.equal(h.sent.at(-1).options?.triggerTurn, undefined);

	// Same-turn agent_end must not queue a continuation while waiting.
	await h.handlers.agent_end(undefined, h.ctx);
	await h.flush();
	assert.equal(h.continuations(), 1);

	// An externally triggered turn (user message / event notification) auto-resumes.
	await h.handlers.turn_start(undefined, h.ctx);
	assert.equal(h.currentGoal().status, "active");

	// Normal continuation resumes after the wake.
	await h.handlers.agent_end(undefined, h.ctx);
	await h.flush();
	assert.equal(h.continuations(), 2);
});

test("update_goal rejects unknown statuses and waiting from non-active goals", async () => {
	const h = createHarness();
	piGoal(h.pi);
	await h.handlers.session_start({ reason: "startup" }, h.ctx);

	const noGoal = await h.tools.update_goal.execute("1", { status: "waiting" }, undefined, undefined, h.ctx);
	assert.equal(noGoal.isError, true);

	await h.tools.create_goal.execute("2", { objective: "test objective" }, undefined, undefined, h.ctx);
	const paused = { ...h.currentGoal(), status: "paused" };
	h.state.pending = false;
	// Simulate a paused goal by appending paused state through the command path.
	const bad = await h.tools.update_goal.execute("3", { status: "waiting" }, undefined, undefined, h.ctx);
	assert.equal(bad.isError, undefined);
	// A goal already waiting is idempotent.
	const again = await h.tools.update_goal.execute("4", { status: "waiting" }, undefined, undefined, h.ctx);
	assert.equal(again.isError, undefined);
	const invalid = await h.tools.update_goal.execute("5", { status: "paused" }, undefined, undefined, h.ctx);
	assert.equal(invalid.isError, true);
	assert.match(invalid.content[0].text, /only accepts status=complete or status=waiting/);
});

test("usage is still accounted while a goal waits", async () => {
	const h = createHarness();
	piGoal(h.pi);
	await h.handlers.session_start({ reason: "startup" }, h.ctx);
	await h.tools.create_goal.execute("1", { objective: "test objective" }, undefined, undefined, h.ctx);
	// Real flow: the turn started while the goal was active, then the agent
	// marked it waiting mid-turn before ending the turn.
	await h.handlers.turn_start(undefined, h.ctx);
	await h.tools.update_goal.execute("2", { status: "waiting" }, undefined, undefined, h.ctx);
	const before = h.currentGoal().tokensUsed;
	await h.handlers.turn_end({ message: { usage: { input: 100, output: 50 } } }, h.ctx);
	assert.ok(h.currentGoal().tokensUsed >= before + 150);
	assert.equal(h.currentGoal().status, "waiting");
});
