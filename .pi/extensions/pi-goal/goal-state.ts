export type GoalStatus = "active" | "waiting" | "paused" | "budget_limited" | "complete";

/** Why a goal is parked. Only set while status is waiting. */
export type GoalWaitReason = "stall" | "run" | "model";

export type GoalState = {
	version: 1;
	id: string;
	objective: string;
	status: GoalStatus;
	waitReason?: GoalWaitReason;
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
};

export type GoalEventKind = "active" | "continuation" | "waiting" | "paused" | "resumed" | "cleared" | "budget_limited" | "complete";

export function parseTokenBudget(input: string): { objective: string; tokenBudget: number | null; error?: string } {
	const match = input.match(/(?:^|\s)--tokens(?:=|\s+)(\S+\s*[kKmM]?)(?:\s|$)/);
	if (!match) return { objective: input.trim(), tokenBudget: null };

	const raw = match[1].replace(/\s+/g, "");
	const suffix = raw.slice(-1).toLowerCase();
	const numeric = suffix === "k" || suffix === "m" ? raw.slice(0, -1) : raw;
	const value = Number(numeric);
	if (!Number.isFinite(value) || value <= 0) {
		return { objective: input.trim(), tokenBudget: null, error: "Token budget must be positive." };
	}
	const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
	const tokenBudget = Math.round(value * multiplier);
	const objective = (input.slice(0, match.index) + " " + input.slice((match.index ?? 0) + match[0].length)).trim();
	return { objective, tokenBudget };
}

export function normalizeTokenBudget(value: unknown): { tokenBudget: number | null; error?: string } {
	if (value == null) return { tokenBudget: null };
	const tokenBudget = Math.round(Number(value));
	if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
		return { tokenBudget: null, error: "tokenBudget must be a positive number when provided." };
	}
	return { tokenBudget };
}

export function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
	if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
	return String(value);
}

export function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

export function statusLine(state: GoalState | null): string | undefined {
	if (!state) return undefined;
	const budget = state.tokenBudget ? ` (${formatTokens(state.tokensUsed)} / ${formatTokens(state.tokenBudget)})` : ` (${formatElapsed(state.timeUsedSeconds)})`;
	if (state.status === "active") return `Pursuing goal${budget}`;
	if (state.status === "waiting") return "Goal waiting for input (/goal resume)";
	if (state.status === "paused") return "Goal paused (/goal resume)";
	if (state.status === "budget_limited") return state.tokenBudget ? `Goal unmet${budget}` : "Goal abandoned";
	return `Goal achieved${budget}`;
}

export function goalUsage(state: GoalState): string {
	if (state.tokenBudget != null) return `${formatTokens(state.tokensUsed)} / ${formatTokens(state.tokenBudget)} tokens`;
	return formatElapsed(state.timeUsedSeconds);
}

export function truncateObjective(objective: string, max = 96): string {
	const singleLine = objective.replace(/\s+/g, " ").trim();
	return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

export function goalEventStatus(kind: GoalEventKind): string {
	const labels: Record<GoalEventKind, string> = {
		active: "active",
		continuation: "continuing",
		waiting: "waiting for input",
		paused: "paused",
		resumed: "resumed",
		cleared: "cleared",
		budget_limited: "budget reached",
		complete: "achieved",
	};
	return labels[kind];
}

export function createGoalState(objective: string, tokenBudget: number | null, now = Date.now(), random = Math.random()): GoalState {
	return {
		version: 1,
		id: `${now}-${random.toString(16).slice(2)}`,
		objective,
		status: "active",
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: now,
		updatedAt: now,
	};
}

// Goal-management tool calls are not progress: a runaway can spam get_goal/create_goal/update_goal
// without doing real work. Only non-goal tool calls (edit/bash/write/read/...) count.
export const GOAL_TOOL_NAMES: ReadonlySet<string> = new Set([
	"get_goal",
	"create_goal",
	"update_goal",
	"goal_wait",
]);

export const CONTINUATION_RUN_LIMIT_DEFAULT = 40;
export const CONTINUATION_BACKOFF_BASE_MS = 5_000;
export const CONTINUATION_BACKOFF_MAX_MS = 60_000;

/** Delay before the next self-started turn. Zero while the loop still makes progress. */
export function continuationDelayMs(stallStreak: number): number {
	if (stallStreak <= 0) return 0;
	return Math.min(CONTINUATION_BACKOFF_MAX_MS, CONTINUATION_BACKOFF_BASE_MS * 2 ** (stallStreak - 1));
}

// A continuation agent loop "made progress" if it called any tool other than the goal-management
// tools. The runaway failure mode is the model narrating text (or only re-reading the goal) turn
// after turn while the continuation prompt re-fires, burning tokens without acting.
// Top-level non-array input fails open (return true) so a legitimate goal is never falsely paused.
// A malformed per-message shape contributes no progress (fail-closed) — the SDK guarantees
// content is an array on assistant messages, so the degenerate case does not occur in the field.
export function turnMadeProgress(messages: unknown, goalToolNames: ReadonlySet<string> = GOAL_TOOL_NAMES): boolean {
	if (!Array.isArray(messages)) return true;
	for (const message of messages) {
		const content = (message as { content?: unknown })?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const b = block as { type?: unknown; name?: unknown };
			if (b?.type === "toolCall" && typeof b.name === "string" && !goalToolNames.has(b.name)) {
				return true;
			}
		}
	}
	return false;
}

export type StallAction = "continue" | "pause";

// Pure state machine for the stall-brake counter. Returns the next streak value and whether
// to pause. Extracted so the full breaker logic (increment, threshold comparison, reset) is
// unit-tested independent of the agent_end wiring.
export function stallStreakStep(
	streak: number,
	madeProgress: boolean,
	limit: number,
): { next: number; action: StallAction } {
	if (madeProgress) return { next: 0, action: "continue" };
	const next = streak + 1;
	return { next, action: next >= limit ? "pause" : "continue" };
}

export function accountGoalTurn(state: GoalState, tokenDelta: number, elapsedSeconds: number, now = Date.now()): GoalState {
	let next: GoalState = {
		...state,
		tokensUsed: state.tokensUsed + Math.max(0, tokenDelta),
		timeUsedSeconds: state.timeUsedSeconds + Math.max(0, elapsedSeconds),
		updatedAt: now,
	};
	if (next.status === "active" && next.tokenBudget != null && next.tokensUsed >= next.tokenBudget) {
		next = { ...next, status: "budget_limited" };
	}
	return next;
}
