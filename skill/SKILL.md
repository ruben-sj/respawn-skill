---
name: respawn
description: Sets up automatic revival of this session after Claude's 5-hour usage limit is hit — waits until the window reopens, notifies the user, and resumes automatically unless the user cancels within 5 minutes. Use when the user says "respawn", "set up respawn", "auto-resume", "revive this session", or wants to avoid having to remember to come back after a rate-limit cutoff. MUST be invoked proactively, BEFORE the account is actually blocked — does not work reactively after a cutoff. v0.1.0, not an officially supported Anthropic feature.
---

# respawn

Gaming metaphor: the session "dies" (gets blocked by the 5-hour usage limit), waits, and respawns automatically once the window reopens.

**Critical precondition:** this must be set up BEFORE the account gets blocked. After a cutoff, no new message can be sent in any session until the window reopens — so there is no reactive way in. The user must invoke `/respawn` proactively (at the start of a heavy/long session, or when they notice they're approaching the limit).

**Known limitations** (tell the user this when the skill is activated, and again if they ask):
- Requires this app/session to stay open for the entire waiting period. Believed (not independently confirmed) that `CronCreate` jobs are in-memory only ("session-only") and disappear without a trace if the session ends or the app is closed.
- Jobs only fire while the session is idle. If the 30-minute or 5-minute mark lands while the user is actively interacting (or another turn is in flight), that firing is delayed or effectively skipped — this especially undermines the "resuming in 5 min" promise in the push notification.
- Believed (not independently confirmed): recurring `CronCreate` jobs auto-expire after 7 days. If true and the usage-limit window doesn't reopen within a week of setup, polling would silently stop with no notice — treat `/respawn` as covering at most a 7-day wait until this is verified.
- Unverified whether a recurring `CronCreate` job actually survives repeated rate-limit rejections without something in the harness stopping it — the mechanism described below ("On each 30-minute firing") is the working assumption, not a confirmed fact. This is NOT an officially supported Anthropic feature — auto-resume after a rate limit is an open, unimplemented feature request (GitHub issues anthropics/claude-code #26775 and #36320).
- Unverified actual token cost of rejected attempts while the window is closed.
- The first time the skill actually triggers from a real rate-limit cutoff should be treated as a live test — watch to confirm it behaves as expected.

## On invocation

`/respawn` here refers to whatever phrase triggers this skill (see the trigger phrases in the frontmatter `description` above) — it is not necessarily a registered slash command; treat it as shorthand for "when this skill fires."

1. Briefly confirm with the user what's about to happen, and remind them of the limitations above if this is the first time they've used the skill in this session.
2. Call `CronCreate`:
   - `recurring: true`
   - `cron`: every 30 minutes, offset from the hour/half-hour — e.g. `"13,43 * * * *"`
   - `prompt`: the instructions under "On each 30-minute firing"
3. Note the job ID from the response (needed for `CronDelete` later).
4. Briefly confirm it's set up and polling every 30 minutes until the window reopens.

## On each 30-minute firing

Working assumption, not a confirmed fact (see limitations above): if the account is still blocked by the usage limit when the job fires, the turn never runs at all (rejected before any model turn starts), so the fact that this prompt actually runs is treated as evidence the window is open. Behave accordingly, but this hasn't been independently verified.

When the prompt does run, check the conversation history for an unhandled rate-limit cutoff — a visible error message about the usage limit (e.g. mentioning a reset time) that appeared after `/respawn` was activated and that no later message in the session has already acted on:

- **No unhandled rate-limit block found**: do nothing visible. Leave the recurring job in place — a cutoff could come later.
- **An unhandled cutoff found**:
  1. Send a `PushNotification` (delivered via whatever channel the harness's `PushNotification` tool uses, typically a mobile push to the user's device): "Window is open again — resuming [brief description of the interrupted work] in 5 min. Reply CANCEL to stop."
  2. Create a new ONE-TIME `CronCreate` job (`recurring: false`) 5 minutes out, prompt: see "On the 5-minute follow-up" below.
  3. Delete the original 30-minute job with `CronDelete` — the 5-minute job takes over the rest of the flow. If the session ends before this delete completes, both jobs may end up live; the 5-minute job firing twice is harmless (step 1 of the follow-up is idempotent), so this is not handled specially.

## On the 5-minute follow-up

1. Check whether the user has replied CANCEL (or similar — "stop", "cancel", "no") in the conversation since the notification was sent.
2. **Cancelled:** briefly confirm it was stopped. Done, no jobs left running.
3. **Not cancelled:** continue the original, interrupted work directly in this session, right where it left off — as if the cutoff never happened. If the session's context was compacted or otherwise lost during the wait, say so and ask the user how to proceed rather than guessing at the interrupted task.

## About the tools this skill uses

`CronCreate`, `CronDelete`, and `PushNotification` are harness-provided tools (part of the Claude Code / Claude app scheduling system this skill runs in), not something this skill implements. If your environment doesn't expose them, this skill can't function as written.
