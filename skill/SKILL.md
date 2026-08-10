---
name: respawn
description: Sets up automatic revival of this session after Claude's 5-hour usage limit is hit — waits until the window reopens, notifies the user, and resumes automatically unless the user cancels within a configurable grace window (default 5 min). Use when the user says "respawn", "set up respawn", "auto-resume", "revive this session", or wants to avoid having to remember to come back after a rate-limit cutoff. MUST be invoked proactively, BEFORE the account is actually blocked — does not work reactively after a cutoff. v0.2.0, field-tested through multiple overnight multi-window multi-session runs; not an officially supported Anthropic feature.
---

# respawn

Gaming metaphor: the session "dies" (gets blocked by the 5-hour usage limit), waits, and respawns automatically once the window reopens.

**Critical precondition:** this must be set up BEFORE the account gets blocked. After a cutoff, no new message can be sent in any session until the window reopens — so there is no reactive way in. The user must invoke `/respawn` proactively (at the start of a heavy/long session, or when they notice they're approaching the limit).

**Confirmed by repeated real-world use** (multiple overnight runs, multiple sessions running `/respawn` in parallel, multiple consecutive windows in a single run): a recurring `CronCreate` job does survive repeated rate-limit rejections and fires correctly once the window reopens, the detect → notify → cancel-window → resume flow works end to end (tested with the then-fixed 5-minute cancel window), and this holds across several concurrent sessions without interference. Still not an officially supported Anthropic feature — auto-resume after a rate limit is an open, unimplemented feature request (GitHub issues anthropics/claude-code #26775 and #36320) — but the core mechanism is no longer just a working assumption.

**Known limitations** (tell the user this when the skill is activated, and again if they ask):
- Requires this app/session to stay open for the entire waiting period. Believed (not independently confirmed) that `CronCreate` jobs are in-memory only ("session-only") and disappear without a trace if the session ends or the app is closed.
- Jobs only fire while the session is idle. If the polling check or the cancel-window deadline lands while the user is actively interacting (or another turn is in flight), that firing is delayed or effectively skipped — this especially undermines the "resuming in N min" promise in the push notification.
- Believed (not independently confirmed): recurring `CronCreate` jobs auto-expire after 7 days. Not yet tested against a wait that long — treat `/respawn` as covering at most a 7-day wait until this is verified.
- Unverified actual token cost of rejected attempts while the window is closed.

## On invocation

`/respawn` here refers to whatever phrase triggers this skill (see the trigger phrases in the frontmatter `description` above) — it is not necessarily a registered slash command; treat it as shorthand for "when this skill fires."

**Shorthand arguments** — if invoked with arguments (e.g. `/respawn 3`, `/respawn 22:15`, `/respawn 3 22:15 cancel=10`, `/respawn nocancel`), parse instead of asking conversationally:
- A bare integer token → `windows` (`0` = indefinite).
- A token matching `H:MM`/`HH:MM` (24h) → known reset time.
- `until-cancelled` or `inf` → `windows: 0`.
- `cancel=N` → cancel-window length in minutes (see below).
- `nocancel` → shorthand for `cancel=0`.
- Any combination of the above, in any order. Anything that doesn't parse cleanly, or no arguments at all → fall back to asking conversationally (step 1 below).

1. If no valid arguments were given, briefly confirm with the user what's about to happen (see **Activation message** below), and remind them of the limitations above if this is the first time they've used the skill in this session. Ask:
   - How many consecutive 5-hour cutoffs to auto-resume through (`windows`): default `1` (resume once, then stop) if they don't say. `0` or "until cancelled" means keep re-arming indefinitely.
   - Whether they already know the reset time for this cutoff (the app UI often shows it). Optional — most people won't know it yet if they're setting this up pre-emptively.
   - How long the cancel window should be once a cutoff is detected (`cancel_window`, minutes): default `5` if they don't say. `0` means resume immediately with no cancel window at all — only a heads-up notification after the fact.
2. Call `CronCreate`. **If a reset time is known** (given by the user, or auto-computed for a later window — see follow-up step 4), use the timed path; **otherwise** use the blind poll:
   - **Timed path:** first job is ONE-TIME (`recurring: false`), scheduled ~1 minute after the known reset time, prompt: the instructions under "On each 30-minute firing" (same detection logic applies to a one-time job). This is the actual dynamic-scheduling win — the user's (or the auto-computed) reset time replaces the blind 30-minute cadence for the first check, since the harness can't read a live reset time from inside a blocked job itself (see limitations). Safety net if the estimate was off: if this job fires and finds no unhandled cutoff, schedule one more ONE-TIME recheck 15 minutes later; if *that* also finds nothing, fall through to the blind 30-minute recurring poll from there.
   - **Blind path (no reset time known):** `recurring: true`, `cron`: every 30 minutes, offset from the hour/half-hour — e.g. `"13,43 * * * *"`, prompt: the instructions under "On each 30-minute firing"
   - Either way: include the current `windows` count AND `cancel_window` value in the prompt text itself (state isn't persisted anywhere else, so it must travel inside the job's prompt)
3. Note the job ID from the response (needed for `CronDelete` later).
4. Briefly confirm it's set up (see **Setup-complete message** below) — mention whether it's checking once near the given reset time (plus the 15-min safety recheck) or polling every 30 minutes, the `windows` count if not the default, and the `cancel_window` if not the default 5 minutes.

**Activation message** — cover these points, adapted to the user's language and phrasing, not a literal script:
> Setting up respawn: I'll watch for the usage-limit cutoff and auto-resume once the window reopens ([windows] window(s), [cancel_window]-min cancel grace / no cancel grace). [First time only: one-line limitations summary — requires this session to stay open, unofficial workaround, see full list if asked.]

**Setup-complete message** — cover these points:
> Respawn is armed: [checking once around HH:MM (+ 15-min safety recheck) | polling every 30 min] until the window reopens[, repeating for up to N windows]. [If cancel_window > 0: you'll get [cancel_window] min to cancel once it fires. | If cancel_window = 0: it'll resume immediately on detection, no cancel window — you'll just get a heads-up after the fact.]

## On each 30-minute firing

Confirmed by repeated use: if the account is still blocked by the usage limit when the job fires, the turn never runs at all (rejected before any model turn starts), so the fact that this prompt actually runs is evidence the window is open. Behave accordingly.

When the prompt does run, check the conversation history for an unhandled rate-limit cutoff — a visible error message about the usage limit (e.g. mentioning a reset time) that appeared after `/respawn` was activated and that no later message in the session has already acted on:

- **No unhandled rate-limit block found**: do nothing visible. Leave the recurring job in place — a cutoff could come later.
- **An unhandled cutoff found**, branch on `cancel_window` (carried in this job's prompt; default `5` if absent — jobs created before this option existed):
  - **`cancel_window > 0`:** send a `PushNotification`: "Window is open again — resuming [brief description of the interrupted work] in [cancel_window] min. Reply CANCEL to stop." Create a new ONE-TIME `CronCreate` job (`recurring: false`) `cancel_window` minutes out, prompt: see "On the cancel-window follow-up" below, carrying `windows` and `cancel_window` forward in the prompt text. Delete the original polling job with `CronDelete` — the follow-up job takes over the rest of the flow. If the session ends before this delete completes, both jobs may end up live; the follow-up job firing twice is harmless (step 1 of the follow-up is idempotent), so this is not handled specially.
  - **`cancel_window == 0`:** no waiting, no cancel opportunity. Send a `PushNotification`: "Window is open again — resumed [brief description of the interrupted work] automatically (no cancel window configured)." Then go straight into "On the cancel-window follow-up" step 3 (resume) and step 4 (multi-window re-arm) in this same firing — there's no separate follow-up job to create. Delete the polling job with `CronDelete`.

## On the cancel-window follow-up

(Only reached when `cancel_window > 0` produced a separate follow-up job — see above.)

1. Check whether the user has replied CANCEL (or similar — "stop", "cancel", "no") in the conversation since the notification was sent.
2. **Cancelled:** briefly confirm it was stopped. Done, no jobs left running.
3. **Not cancelled:** continue the original, interrupted work directly in this session, right where it left off — as if the cutoff never happened. If the session's context was compacted or otherwise lost during the wait, say so and ask the user how to proceed rather than guessing at the interrupted task.
4. **Multi-window re-arm:** if `windows` (carried in this job's prompt) is `0` (indefinite) or `>1`, re-arm for the next possible cutoff: decrement `windows` by 1 (leave `0` as `0`), compute the next reset time as *now (resume time) + 5 hours*, then redo "On invocation" step 2 using the timed path with that computed time, carrying the same `cancel_window` value forward. This is the same 5-hour rolling window, so the estimate is as good as one the user would have given — no need to ask them again. Do this quietly — no need to re-confirm with the user unless something about the setup changed. If `windows` was `1`, this was the last covered cutoff: stop here, no new job.

## About the tools this skill uses

`CronCreate`, `CronDelete`, and `PushNotification` are harness-provided tools (part of the Claude Code / Claude app scheduling system this skill runs in), not something this skill implements. If your environment doesn't expose them, this skill can't function as written.
