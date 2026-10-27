const assert = require("node:assert/strict");
const { join } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename, {
	interopDefault: true,
	alias: {
		"@mariozechner/pi-tui": join(__dirname, "tui-stub.cjs"),
	},
});

function createExtensionApi() {
	const handlers = new Map();
	const tools = new Map();
	const messages = [];
	let activeTools = [];

	return {
		handlers,
		tools,
		messages,
		api: {
			registerMessageRenderer() {},
			registerTool(tool) {
				tools.set(tool.name, tool);
			},
			registerCommand() {},
			on(event, handler) {
				handlers.set(event, handler);
			},
			sendMessage(message, options) {
				messages.push({ message, options });
			},
			appendEntry() {},
			getActiveTools() {
				return activeTools;
			},
			setActiveTools(next) {
				activeTools = next;
			},
		},
	};
}

function createContext(goal) {
	const entries = goal
		? [{ type: "custom", customType: "pi-goal", data: { goal, statusBarEnabled: true } }]
		: [];
	return {
		sessionManager: {
			getBranch: () => entries,
			getEntries: () => entries,
		},
		ui: {
			setStatus() {},
			notify() {},
			async confirm() {
				return true;
			},
		},
		isIdle: () => false,
		hasPendingMessages: () => false,
	};
}

test("goal state and agent_end continuation stay within each extension instance", async () => {
	const piGoal = await jiti.import(join(__dirname, "../.pi/extensions/pi-goal/index.ts"), { default: true });
	const sessionA = createExtensionApi();
	const sessionB = createExtensionApi();
	const goalA = {
		version: 1,
		id: "session-a-goal",
		objective: "GLB/D1 Power Pool Nov '26",
		status: "active",
		tokenBudget: null,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 1,
		updatedAt: 1,
	};
	const contextA = createContext(goalA);
	const contextB = createContext(null);

	piGoal(sessionA.api);
	piGoal(sessionB.api);
	sessionA.handlers.get("session_start")({ reason: "startup" }, contextA);
	sessionB.handlers.get("session_start")({ reason: "startup" }, contextB);

	const goalFromA = JSON.parse((await sessionA.tools.get("get_goal").execute()).content[0].text).goal;
	const goalFromB = JSON.parse((await sessionB.tools.get("get_goal").execute()).content[0].text).goal;
	assert.equal(goalFromA.objective, goalA.objective);
	assert.equal(goalFromB, null);

	sessionB.handlers.get("agent_end")({}, contextB);
	await new Promise(setImmediate);
	assert.equal(sessionB.messages.length, 0);

	sessionA.handlers.get("agent_end")({}, contextA);
	await new Promise(setImmediate);
	assert.equal(sessionA.messages.length, 1);
	assert.equal(sessionA.messages[0].message.details.goal.objective, goalA.objective);
	assert.equal(sessionA.messages[0].options.deliverAs, "followUp");
});
