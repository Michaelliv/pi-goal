# pi-goal

![pi-goal](docs/assets/pi-goal-poster.png)

Persistent autonomous goals for [pi](https://github.com/badlogic/pi-mono).

`pi-goal` adds a `/goal` command and goal tools so Pi can keep working toward a long-running, thread-scoped objective until the goal is complete, paused, cleared, token-budget-limited, or waiting for an external event.

## Install

```bash
pi install npm:pi-goal
```

Or from git:

```bash
pi install git:github.com/Michaelliv/pi-goal
```

## Usage

```text
/goal improve benchmark coverage until the suite has strong evidence
/goal --tokens 50k finish the migration and verify tests
/goal
/goal status
/goal pause
/goal resume
/goal clear
/goal statusbar off
```

When a goal is active, the extension shows compact visible lifecycle markers like `Goal active` and `Goal continuing`; expand them with `ctrl+o` to inspect the objective and usage. The full continuation instructions ride along as the content of that custom message, so the model always has the objective and audit guidance in the transcript while the renderer keeps the visible UI compact.

The same Pi agent keeps running normal turns in the same session context until it calls `update_goal({ status: "complete" })`, marks the goal `waiting`, or the user pauses/clears it, or the token budget is reached. Reloading Pi pauses an active goal instead of silently resuming it; use `/goal resume` to continue.

## What it adds

- `pi-goal-writer` skill: draft and review strong `/goal` objectives with evidence-based success criteria
- `/goal [--tokens 50k] <objective>`: set or replace a goal
- `/goal` or `/goal status`: show the current goal
- `/goal pause`: stop autonomous continuation without deleting the goal
- `/goal resume`: reactivate a paused goal
- `/goal clear`: remove the goal
- `/goal statusbar on|off`: show or hide the footer status line
- `create_goal` tool: model can set or replace the current goal only when explicitly requested
- `get_goal` tool: read current goal state
- `update_goal` tool: model can mark the goal `complete`, or mark it `waiting` to end the turn without a scheduled continuation while passively waiting for an external event (e.g. a background task notification)
- `get_goal` and `update_goal` are only exposed to the model while a goal is `active`; waiting, paused, cleared, complete, and budget-limited goals hide them so unrelated sessions are not tempted to call them
- footer status: `Pursuing goal`, `Goal waiting for external event (auto-resumes)`, `Goal paused`, `Goal achieved`, or `Goal unmet`

## Flow

```text
/goal <objective>
  -> persist goal in the current Pi session
  -> show compact Goal marker and footer status
  -> deliver continuation instructions as the marker's message content
  -> trigger an agent turn
  -> account time/tokens on turn_end
  -> queue another continuation on agent_end while active
  -> `update_goal({ status: "waiting" })` suspends continuation until the next real turn (user message or event notification), which auto-resumes the goal
  -> stop when update_goal marks complete, user pauses/clears, or budget is hit
```

## Completion behavior

The model is instructed to audit completion against real evidence before calling `update_goal`. The `update_goal` tool accepts only `status: "complete"` and `status: "waiting"`; pausing, resuming, clearing, and budget limiting are controlled by the user or extension runtime. `waiting` is a scheduling hint, not lifecycle control: it suppresses the agent_end continuation so the agent can end its turn and passively wait for an external wake (background task notification, user input) instead of burning API calls on no-op turns; the next real turn automatically returns the goal to `active`. The final turn is still accounted even when the model completes the goal mid-turn.

## State

Goal state is stored as Pi custom session entries with `customType: "pi-goal"`. It follows the active session branch, survives reloads, and does not require an external database.

## License

MIT
