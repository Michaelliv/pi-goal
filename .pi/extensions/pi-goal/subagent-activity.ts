import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Background sub-agent awareness for the goal continuation loop.
 *
 * The pi-subagents package announces background runs on the inter-extension
 * event bus:
 *
 *   - `subagent:async-started`  { id, sessionId, asyncDir, ... }
 *   - `subagent:async-complete` { runId, status, ... }
 *
 * While any run started by this session is in flight, the session is
 * idle-but-not-done: the real work lives in the child, and each child
 * completion wakes the session on its own. The goal loop must hold in that
 * window — a continuation tick would reach an idle parent with nothing to
 * do, end within seconds, and re-trigger itself, producing a rapid no-op
 * prompt loop while children work.
 *
 * The hold is deliberately local: an agent's loop only tracks runs launched
 * by its own session. Nested runs need no special handling, because a run
 * completes only once everything it owns has settled, so busy-ness
 * propagates upward through run completion and each completion wake lets the
 * parent re-evaluate.
 *
 * Detection is event-driven, with two safety nets so a missed completion
 * event can delay the loop but never stall a goal:
 *
 *   1. Status verification — a tracked run's `<asyncDir>/status.json` is
 *      checked lazily; a terminal state retires the run immediately.
 *   2. Age ceiling — an entry that cannot be verified expires after
 *      MAX_IN_FLIGHT_AGE_MS.
 */

/** Emitted by pi-subagents when a background run starts. */
export const ASYNC_STARTED_EVENT = "subagent:async-started";

/** Emitted by pi-subagents when a background run delivers its result. */
export const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

/** Run states that mean the run can still wake the session by itself. */
const IN_FLIGHT_STATES = new Set(["queued", "running"]);

/** Known states that mean the run is done or parked; the parent should act. */
const SETTLED_STATES = new Set(["complete", "failed", "partial", "paused", "stopped"]);

const STATUS_FILE = "status.json";

/** Matches the stale-marker TTL pi-subagents uses for active-run bookkeeping. */
const MAX_IN_FLIGHT_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A status file can legitimately be absent for the first moments of a fresh
 * run dir; only treat a prolonged absence as proof the run is gone.
 */
const MISSING_STATUS_GRACE_MS = 10_000;

export interface SubagentEventBus {
	/** Subscribe to an event channel; returns an unsubscribe function. */
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface SubagentActivityOptions {
	/** Clock used for age accounting; injectable for tests. */
	now?: () => number;
}

export interface SubagentActivity {
	/**
	 * True while at least one plausibly-live background run is tracked.
	 * Lazily prunes entries that verification or the age ceiling retires.
	 */
	hasActiveRuns(): boolean;
	/** Number of currently tracked run ids (unpruned); for tests and debug. */
	trackedCount(): number;
	/** Drop all tracked state without unsubscribing (used on session start). */
	forget(): void;
	/** Unsubscribe from both events and drop all state. */
	dispose(): void;
}

interface TrackedRun {
	startedAt: number;
	asyncDir?: string;
}

/** Collect string values under run-id-shaped keys, bounded-depth walk. */
function collectRunIds(data: unknown, out: string[], depth: number): void {
	if (data === null || typeof data !== "object" || depth > 4) return;
	for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
		if (typeof value === "string" && value.length > 0 && (key === "runId" || key === "id")) {
			out.push(value);
		} else {
			collectRunIds(value, out, depth + 1);
		}
	}
}

function runIdFrom(data: unknown): string | undefined {
	if (data === null || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	const id = record.runId ?? record.id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Track background sub-agent runs from the pi-subagents event contract.
 *
 * Events are the primary signal, so the tracker only ever adds on
 * `async-started` and removes on `async-complete`; everything else is
 * verification to retire state that missed events would otherwise leak.
 */
export function trackSubagentActivity(
	events: SubagentEventBus,
	options: SubagentActivityOptions = {},
): SubagentActivity {
	const now = options.now ?? Date.now;
	const inFlight = new Map<string, TrackedRun>();

	const onStarted = (data: unknown) => {
		try {
			const runId = runIdFrom(data);
			if (!runId) return;
			const record = data as Record<string, unknown>;
			const asyncDir = typeof record.asyncDir === "string" && record.asyncDir.length > 0 ? record.asyncDir : undefined;
			const existing = inFlight.get(runId);
			inFlight.set(runId, {
				startedAt: existing?.startedAt ?? now(),
				asyncDir: asyncDir ?? existing?.asyncDir,
			});
		} catch {
			// A malformed payload must never break the host's event dispatch.
		}
	};

	const onComplete = (data: unknown) => {
		try {
			const ids: string[] = [];
			collectRunIds(data, ids, 0);
			for (const id of ids) inFlight.delete(id);
		} catch {
			// A malformed payload must never break the host's event dispatch.
		}
	};

	const offStarted = events.on(ASYNC_STARTED_EVENT, onStarted);
	const offComplete = events.on(ASYNC_COMPLETE_EVENT, onComplete);

	function entryIsAlive(entry: TrackedRun): boolean {
		if (entry.asyncDir) {
			try {
				const parsed = JSON.parse(readFileSync(join(entry.asyncDir, STATUS_FILE), "utf8")) as { state?: unknown };
				if (typeof parsed?.state === "string") {
					if (IN_FLIGHT_STATES.has(parsed.state)) return true;
					// Known settled states release immediately. Unknown future states
					// fail safe toward holding: the age ceiling bounds any stall.
					return !SETTLED_STATES.has(parsed.state);
				}
				// Status exists without a usable state field: fall through to the age ceiling.
			} catch (error) {
				const code = (error as NodeJS.ErrnoException)?.code;
				if (code === "ENOENT" && now() - entry.startedAt > MISSING_STATUS_GRACE_MS) return false;
				// Unreadable or corrupt status: fall through to the age ceiling.
			}
		}
		return now() - entry.startedAt < MAX_IN_FLIGHT_AGE_MS;
	}

	return {
		hasActiveRuns() {
			for (const [runId, entry] of inFlight) {
				if (!entryIsAlive(entry)) inFlight.delete(runId);
			}
			return inFlight.size > 0;
		},
		trackedCount() {
			return inFlight.size;
		},
		forget() {
			inFlight.clear();
		},
		dispose() {
			offStarted();
			offComplete();
			inFlight.clear();
		},
	};
}
