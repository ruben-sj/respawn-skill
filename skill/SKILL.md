---
name: respawn
description: Sets up automatic revival of this session after Claude's 5-hour usage limit is hit. It waits until the window reopens, notifies the user, and resumes automatically unless the user cancels within a configurable grace window (default 5 min). It can also pause itself at a usage threshold (soft stop) and uses live usage readings for timing when the Claude desktop app provides them. Use when the user says "respawn", "set up respawn", "auto-resume", "revive this session", or wants to avoid having to remember to come back after a rate-limit cutoff. MUST be invoked proactively, BEFORE the account is actually blocked; does not work reactively after a cutoff. v0.3.0; the v0.2 core is field-tested through multiple overnight multi-window multi-session runs, the v0.3 additions less so; not an officially supported Anthropic feature.
---

# respawn

Gaming metaphor: the session "dies" (gets blocked by the 5-hour usage limit), waits, and respawns automatically once the window reopens.

**Critical precondition:** this must be set up BEFORE the account gets blocked. After a cutoff, no new message can be sent in any session until the window reopens, so there is no reactive way in. The user must invoke `/respawn` proactively (at the start of a heavy/long session, or when they notice they're approaching the limit).

**Confirmed by repeated real-world use** (multiple overnight runs, multiple sessions running `/respawn` in parallel, multiple consecutive windows in a single run): a recurring `CronCreate` job does survive repeated rate-limit rejections and fires correctly once the window reopens, the detect → notify → cancel-window → resume flow works end to end (tested with the then-fixed 5-minute cancel window), and this holds across several concurrent sessions without interference. Still not an officially supported Anthropic feature: auto-resume after a rate limit was requested in GitHub issues anthropics/claude-code #26775 and #36320, and Claude Code v2.1.234 and later has a built-in `autoContinueAtUsageLimit` setting that may already suit the user (this skill is an independent alternative with a cancel window, multi-window coverage and a soft stop). The core mechanism is no longer just a working assumption. The v0.3 additions (live usage readings, backstop, chaining, soft stop) are newer and have seen less field testing than that core.

**Two behaviours, one skill.** *Usage mode* uses the live usage readings from `mcp__ccd_session_mgmt__get_usage` (see "Reading usage"). *Classic mode* is the v0.2.0 behaviour: no usage readings, timing from a user-given reset time or a blind 30-minute poll. Classic mode is always the fallback. Whenever this skill says "classic", do exactly what v0.2.0 did, apart from the safe-timing margin in "Safe timing", which applies to every timed job.

**Limitations** (tell the user a short version when the skill is activated, and the full list if they ask).

Confirmed by the `CronCreate` tool documentation:
- Jobs are session-only. They live in memory and disappear without a trace if the session ends or the app is closed, so this app/session must stay open for the entire waiting period.
- Recurring jobs auto-expire after 7 days. Treat `/respawn` as covering at most a 7-day wait. For a weekly-limit wait that long, the backstop (see below) may expire before the reset and only the one-shot is left.
- Jobs fire only while the session is idle. If a check or the cancel-window deadline lands while the user is actively interacting (or another turn is in flight), that firing is delayed or effectively skipped. This especially undermines the "resuming in N min" promise in the push notification.
- A recurring job can fire late, by up to half its period (at most 30 minutes). A one-shot scheduled on minute :00 or :30 can fire up to 90 seconds early, which is why timed jobs use an off-minute margin.

Still unverified:
- The token cost of rejected attempts while the window is closed.
- Whether a one-shot that fires while the account is still blocked survives (this is why a recurring backstop runs alongside each timed one-shot in usage mode).
- How precisely `resetsAt` matches the moment the window actually reopens.

## Reading usage

Call `mcp__ccd_session_mgmt__get_usage` (no arguments). It exists only in the Claude desktop app; if the tool is not available in this environment, there is no usage mode and everything below that needs it is classic.

Observed result shape:
- `plan.status`: `"ok"`, `"unavailable"`, or `"not_applicable"`.
- `plan.windows[]`: entries with `label` (`"5-hour limit"`, `"Weekly · all models"`, `"Weekly · <model>"`), `percentUsed` (integer), `resetsAt` (ISO-8601 UTC), `resetsIn` (display text, e.g. `"4h 49m"`).

Rules:
- Identify windows by `label`: the 5-hour window is the one whose label contains "5-hour"; weekly windows are the ones whose label starts with "Weekly". There can be several weekly windows, and any window can be missing. Never rely on order or on the exact weekly labels.
- Use `resetsAt`, not `resetsIn`. It is UTC: convert it to local time before building a cron expression, because `CronCreate` cron expressions are local time. It lands on a whole hour and exists even at low usage.
- A **usable 5-hour reading** means: the call succeeded, `plan.status` is `"ok"`, and a 5-hour window with a parseable `resetsAt` is present. Anything else (tool absent, error, `"unavailable"`, `"not_applicable"`, no 5-hour window) is **not usable**, and the step in question is classic.
- `percentUsed` is account-wide: other sessions and scheduled tasks share it.

## Safe timing

Every one-shot in this skill (reset-time jobs, soft-stop resumes, 15-minute rechecks, the cancel-window follow-up) is scheduled so that it does not land on minute :00 or :30:
- A reset-time job is scheduled at the reset time (`resetsAt`, or the user-given time) plus a margin of 3 to 5 minutes. Use +4 and move to +3 or +5 if the resulting local minute is 0 or 30.
- Any other one-shot (a `recheck` 15 minutes out, the cancel-window follow-up `cancel_window` minutes out): compute the time, and if it lands on minute 0 or 30, add 1 minute. For example a recheck that would land on 22:30 is scheduled for 22:31.
- Express a one-shot as a cron expression with fixed minute, hour, day-of-month and month (local time, which can fall on the next calendar day), and `recurring: false`.
- If the computed time is already in the past or less than 2 minutes away, use now + 3 minutes, again avoiding minute 0 and 30.

## Choosing the target time

Used whenever a reset-time job is created (invocation, chaining, soft stop, re-arm). In usage mode:
1. Read usage (fresh reading).
2. **Weekly cap:** if any weekly window has `percentUsed` of 98 or more, or the cutoff message mentions a weekly limit, the target is that weekly window's `resetsAt` (if several qualify, the latest one). If the message mentions a weekly limit but no weekly window can be read, use the reset time named in the message if it gives one, otherwise the 5-hour reset. Tell the user it is the weekly reset: the wait may be days, and the 7-day expiry of recurring jobs means the backstop may disappear before then.
3. Otherwise the target is the 5-hour window's `resetsAt`.
4. If the target is missing or already in the past, use now + 5 hours. This is the **raw reset time** (no margin yet); a soft-stop note records it as `resume_after`.
5. Add the margin from "Safe timing". The result is the time the one-shot is scheduled for.

In classic mode the target is the user-given time, or (when re-arming) now + 5 hours, plus the margin.

## State carried in job prompts

All state lives inside the `CronCreate` prompt text. Nothing is written to files. Every prompt this skill creates starts with a state line:

`respawn-state: usage=<on|off> windows=<N> cancel_window=<M> stop=<S|off> kind=<kind> chain=<K> backstop=<id|self|none>`

- `usage`: `on` if the invocation-time reading was usable (usage mode for the whole run), otherwise `off` (classic for the whole run).
- `windows`: remaining windows to cover (`0` = indefinite). `cancel_window`: minutes. `stop`: soft-stop percentage, or `off`.
- `kind`: `timed` (one-shot at a reset time), `backstop` (recurring usage-mode poll), `poll` (classic recurring poll), `recheck` (classic 15-minute recheck), `followup` (cancel-window follow-up).
- `chain`: how many empty timed firings have been chained so far (starts at 0).
- `backstop`: the job ID of this run's backstop (`self` in the backstop's own prompt, since it cannot know its own ID in advance; `none` in classic runs and while a soft-stop pause has no backstop). To make this possible, always create the backstop first and the timed one-shot second, and pass the backstop's ID into the one-shot's and the follow-up's prompts. Update the field whenever the backstop is replaced or deleted.

After the state line, the prompt says which section to follow ("On each check firing", or "On the cancel-window follow-up" for `followup`) and carries a condensed copy of that section's steps, so the job still works if this skill text is no longer in context. The condensed copy must be self-contained: besides the steps it restates, briefly, the target-time rule (reset time plus 3 to 5 minutes, never minute :00 or :30; a weekly window at 98 % or more takes over), the state-line format, the idempotence and stand-down rules, the cutoff signals (including the `respawn soft stop:` note convention), and, when `stop` is not `off`, a one-line reminder to check usage at checkpoints against the soft-stop level.

Keep track of the job IDs you create (the setup-complete message lists them) so they can be passed to `CronDelete`. The backstop ID also travels in the state line (see above). The ID of a pending one-shot is not carried, so find it with `CronList` when available, recognising this skill's jobs by the `respawn-state:` prefix. If IDs are lost (for example after context compaction) and `CronList` is unavailable, delete what the conversation still lists, and accept that a stray one-shot may fire once later and must then stand down (see "On each check firing", step 3). At most one backstop and at most one pending timed one-shot may exist per respawn run.

## On invocation

`/respawn` here refers to whatever phrase triggers this skill (see the trigger phrases in the frontmatter `description` above). It is not necessarily a registered slash command; treat it as shorthand for "when this skill fires."

**Re-invocation:** if a respawn run is already armed in this session (job IDs listed earlier in the conversation, or jobs with the `respawn-state:` prefix in `CronList`), delete all of its jobs first and tell the user the new settings replace the old run. Never keep two runs side by side.

**Shorthand arguments:** if invoked with arguments (e.g. `/respawn 3`, `/respawn 22:15`, `/respawn 3 22:15 cancel=10`, `/respawn nocancel`, `/respawn stop=70`), parse instead of asking conversationally:
- A bare integer token → `windows` (`0` = indefinite).
- A token matching `H:MM`/`HH:MM` (24h) → known reset time. It overrides a reset time read from usage.
- `until-cancelled` or `inf` → `windows: 0`.
- `cancel=N` → cancel-window length in minutes (see below).
- `nocancel` → shorthand for `cancel=0`.
- `stop=N` → soft-stop percentage (integer 1 to 100, default `85`); see "Soft stop".
- `nostop` → disables the soft stop (`stop=off`).
- Any combination of the above, in any order. Anything that doesn't parse cleanly, or no arguments at all → fall back to asking conversationally (step 2 below).

Steps:

1. **Read usage** (see "Reading usage"). A usable 5-hour reading → `usage=on`. Otherwise `usage=off` and the whole run is classic. If a usable reading shows a 5-hour `resetsAt` in the past, treat it as not usable. Then, in usage mode with the soft stop on (call the 5-hour percent P and the soft-stop level N), and **also when shorthand arguments skipped the conversation**: if P is at or above N - 15 and the user did not give `stop` explicitly, do not arm silently. The default would pause the session at the first checkpoint (or block new fan-outs), which is the opposite of what someone nearing the limit usually wants. Say that usage is already P %, and ask whether to keep `stop` at N, raise it (for example to the lower of 100 and P + 10), or turn it off (`nostop`). If they have no preference, use `nostop` for this run and say so. If the user did give `stop` explicitly, respect it and just mention the current P.
2. If no valid arguments were given, briefly confirm with the user what's about to happen (see **Activation message** below), and remind them of the limitations above if this is the first time they've used the skill in this session. Ask:
   - How many consecutive 5-hour cutoffs to auto-resume through (`windows`): default `1` (resume once, then stop) if they don't say. `0` or "until cancelled" means keep re-arming indefinitely.
   - **Only if `usage=off`:** whether they already know the reset time for this cutoff (the app UI often shows it). Optional, and most people won't know it yet if they're setting this up pre-emptively. In usage mode do not ask: the reset time comes from the reading.
   - How long the cancel window should be once a cutoff is detected (`cancel_window`, minutes): default `5` if they don't say. `0` means resume immediately with no cancel window at all, only a heads-up notification after the fact.
   - The soft stop (`stop`) is not asked about: use the default `85` unless the user brings it up (see "Soft stop").
3. **Pick the target time** and create the jobs with `CronCreate`:
   - **`usage=on` (timed path with backstop):**
     1. Target time: the user-given `HH:MM` if there was one (next occurrence in the future), otherwise "Choosing the target time" from the reading just taken (this includes the weekly-cap rule). If the user-given time and the reading's 5-hour reset differ by more than 30 minutes, use the earlier of the two and tell the user about the mismatch: a time of day that has already passed today means tomorrow, which would otherwise delay the first check by most of a day.
     2. Create the backstop first: `recurring: true`, `cron` every 30 minutes on off-minutes, e.g. `"13,43 * * * *"`, with `kind=backstop backstop=self`. The backstop exists because it is unverified whether a one-shot that fires while the account is still blocked survives; it is deleted when the flow ends or after a successful resume, and recreated on re-arm.
     3. Then create the timed one-shot (`recurring: false`) at the target, with `kind=timed chain=0` and `backstop=<the backstop's job ID>`.
   - **`usage=off` and a reset time is known** (given by the user, or auto-computed as now + 5 hours for a later window; see the re-arm step of the follow-up), classic timed path: first job is ONE-TIME (`recurring: false`), scheduled at the reset time plus the margin from "Safe timing", with `kind=timed backstop=none`. This is the dynamic-scheduling win: the known reset time replaces the blind 30-minute cadence for the first check, since the harness can't read a live reset time from inside a blocked job itself. Safety net if the estimate was off: if this job fires and finds no unhandled cutoff, schedule one more ONE-TIME recheck 15 minutes later (`kind=recheck`, off-minute per "Safe timing"); if *that* also finds nothing, fall through to the blind 30-minute recurring poll from there.
   - **`usage=off` and no reset time known** (classic blind path): `recurring: true`, `cron`: every 30 minutes, offset from the hour/half-hour, e.g. `"13,43 * * * *"`, `kind=poll backstop=none`.
   - In every case the prompt carries the state line (so `windows` and `cancel_window` travel inside the job's prompt) and the condensed instructions under "On each check firing".
4. Note the job ID(s) from the response (needed for `CronDelete` later).
5. Briefly confirm it's set up (see **Setup-complete message** below).

**Activation message**: cover these points, adapted to the user's language and phrasing, not a literal script:
> Setting up respawn: I'll watch for the usage-limit cutoff and auto-resume once the window reopens ([windows] window(s), [cancel_window]-min cancel grace / no cancel grace). [Usage mode: current usage is [P]% of the 5-hour limit (resets around HH:MM local) and [W]% of the weekly limit(s) where readable; soft stop at [N]% (account-wide percent) unless disabled. | Classic mode: usage readings are not available here, so I'll fall back to the reset time you give me or a 30-minute poll, and the soft stop is off.] [First time only: one-line limitations summary: requires this session to stay open, unofficial workaround, see full list if asked.]

**Setup-complete message**: cover these points:
> Respawn is armed: [usage mode: first check at HH:MM (5-hour reset plus a few minutes of margin; weekly reset instead if a weekly limit is nearly used) with a 30-min backstop poll | classic: checking once around HH:MM (+ 15-min safety recheck) | classic: polling every 30 min] until the window reopens[, repeating for up to N windows]. [Usage mode: current usage [P]% of the 5-hour limit and [W]% weekly where readable; soft stop at [N]%, or off. | Classic mode, `stop` given: soft stop ignored (no usage readings here).] [If cancel_window > 0: you'll get [cancel_window] min to cancel once it fires. | If cancel_window = 0: it'll resume immediately on detection, no cancel window, and you'll just get a heads-up after the fact.] Jobs: [IDs].

## Soft stop

Only in usage mode (`usage=on`) with `stop` not `off`. Without usage readings the `stop` argument is ignored; say so once at activation or in the setup-complete message instead of silently dropping it. The same applies to the soft-stop level and the current usage figures: the setup-complete message always carries them, so shorthand invocations (which skip the activation message) still show them.

**The point:** instead of running into the hard cutoff mid-step, pause deliberately at a threshold, at a clean place in the work. Important caveats to tell the user if they ask: the percent is account-wide (other sessions and scheduled tasks share it), and a single big step can overshoot the threshold, so `stop=N` with N close to 100 behaves almost like classic respawn (run until the wall, then resume), which remains the fallback.

**Checkpoints.** While respawn is armed, read usage at natural checkpoints: between steps of the work, and before starting a large fan-out (a Workflow, or several subagents at once). Not after every tool call. Take the 5-hour `percentUsed` (call it P); also apply the weekly cap check from "Choosing the target time" (a weekly window at 98 or more counts as the stop tier regardless of N, with the weekly reset as the target).

Tiers, with N = `stop`:
- **P below N - 15:** carry on normally.
- **P from N - 15 up to (not including) N, warning tier:** do not start new large fan-outs; prefer finishing the current unit of work. Mention this once in the conversation, then continue.
- **P at or above N, stop tier:**
  1. Finish the current step. Do not abandon a half-made edit.
  2. Take a fresh reading and run "Choosing the target time".
  3. Write a short state note in the conversation, starting with `respawn soft stop:`, giving what is done, what is next, and `resume_after=<raw reset time, local>` (the target before the safe-timing margin).
  4. Schedule a timed one-shot (`kind=timed`, same state line, `backstop=none`) at the target plus margin, with prompt text that resumes the work from the state note. If a pending timed one-shot of this run already targets the same time, keep it instead of creating another; if its target differs, delete it and create the new one. Then delete the backstop and set `backstop=none` in the new one-shot's state line. The pause starts before the wall, so the account is open and the one-shot should fire normally; a kept backstop would run a full-context turn every 30 minutes during the pause and spend the very headroom the soft stop is protecting. The re-arm step of the follow-up creates a fresh backstop.
  5. Send a `PushNotification`: "Paused at [P]% usage. Resuming around [HH:MM]."
  6. End the turn. Start no further work.
- If the user explicitly tells you to keep going past the stop level, do so and do not stop again until the next window.

A soft-stop pause counts as one covered window: it is resumed through the same flow as a hard cutoff, including the cancel window and the `windows` decrement. The state note is treated as a cutoff only once `resume_after` has been reached (see "On each check firing"). Once the last covered window has been resumed and the run's jobs are deleted, respawn is no longer armed and there are no more soft-stop checkpoints.

## On each check firing

This covers every firing: `timed`, `backstop`, `poll`, `recheck`.

Confirmed by repeated use: if the account is still blocked by the usage limit when the job fires, the turn never runs at all (rejected before any model turn starts), so the fact that this prompt actually runs is evidence the window is open. Behave accordingly. (The exception is a soft-stop note whose `resume_after` has not passed yet: the account is not blocked there, so the evidence does not apply.)

**Respawn's own messages** are firing prompts, `respawn log:` lines, and the calls and results of its own `CronCreate`, `CronDelete`, `CronList`, `get_usage` and `PushNotification` uses. Detection (step 2) ignores them, so that writing them does not hide a cutoff.

1. **Log line (usage mode).** If `usage=on`, call `mcp__ccd_session_mgmt__get_usage` and write one line into the conversation: `respawn log: <local time> | 5-hour <percentUsed>% resets <resetsAt> | <kind> chain=<K>`. If the reading is not usable, write the line with "usage unavailable" in place of the values and treat the rest of this firing as classic where it says so. The log exists for calibration; it is not written to any file. In classic runs (`usage=off`) this step is skipped and no-op firings stay silent, as in v0.2.0.
2. **Detect.** Check the conversation history for an unhandled rate-limit cutoff that happened after `/respawn` was activated and that no later message in the session has already acted on. Any of these counts:
   - a visible error message about the usage limit (e.g. mentioning a reset time), or
   - a turn that stopped mid-work: the last message that is **not one of respawn's own** is a tool result with no assistant follow-up. Field-observed: the app can cut a turn off at the limit without showing any error in the conversation. An explicit user interruption does not count. For `poll` and `recheck` firings (classic) also require that roughly 30+ minutes have passed since that tool result. For `timed` and `backstop` firings (usage mode) no minimum gap is needed: the firing running at all is evidence the window is open, and jobs fire only while the session is idle, so a trailing tool result means the turn was cut off. This matters for silent cutoffs shortly before a reset, which a 30-minute gap would miss. Or
   - a `respawn soft stop:` note whose `resume_after` time has been reached (at or after it).

   If a cancel-window notification was sent more than `cancel_window` + 10 minutes ago and nothing since has resumed or cancelled, treat the follow-up job as lost and run "On the cancel-window follow-up" yourself, in this firing.
3. **No unhandled cutoff found.** Firings must be idempotent: a firing that finds the cutoff already handled counts here and does nothing about it. Leave the recurring job (backstop or poll) in place, since a cutoff could come later. What else happens depends on the job:
   - **Stand-down (usage mode, `timed` and `backstop` firings), checked first.** A run whose work is finished must not keep spending usage on empty firings. If the conversation shows at least three earlier `respawn log:` lines of this run with nothing but respawn's own messages since the first of them (no user message, no assistant work), and no `respawn soft stop:` note is waiting for its `resume_after`, and no background work started in this session (a Workflow, a background agent or a background command) is still running without having reported completion, there is nothing left that could be cut off. A session waiting on background work looks idle but is not. Delete every job of this run, tell the user that respawn stood down because the session has been idle, and that they can invoke it again for new work. Do not chain. If the conversation already shows this run has ended (stand-down, cancel, or the last window resumed), do nothing and do not chain. Classic runs keep v0.2.0 behaviour and have no stand-down rule.
   - **`backstop`, `poll`:** nothing more.
   - **`timed` in usage mode: chain.** Do not fall through to a recheck. Make sure no other pending timed one-shot of this run exists (if one does, stop here). Run "Choosing the target time" with the reading from step 1, and create the next timed one-shot at that target with `chain` + 1 and the same `windows`, `cancel_window`, `stop`, `backstop`. Do not recreate a backstop that is gone (it expires after 7 days, and a soft-stop pause deliberately has none): recreating it from a chain would defeat the 7-day expiry. If the reading was not usable, schedule a `recheck` 15 minutes later instead (off-minute per "Safe timing").
   - **`timed` in classic mode:** schedule one more ONE-TIME recheck 15 minutes later (`kind=recheck`, off-minute per "Safe timing"), per v0.2.0.
   - **`recheck`:** classic (`usage=off`): fall through to the blind 30-minute recurring poll (`kind=poll`) from here. Usage mode: retry the chain as above; if the reading is still unusable, do nothing more (the backstop is still running).
4. **An unhandled cutoff found.** Branch on `cancel_window` (carried in this job's prompt; default `5` if absent, i.e. jobs created before this option existed). In both branches, delete any other pending timed one-shot or recheck of this run with `CronDelete` so the cutoff is not handled twice. Keep the backstop for now (usage mode): the re-arm step of the follow-up replaces or deletes it before the interrupted work resumes. In classic mode delete the polling job.
   - **`cancel_window > 0`:** send a `PushNotification`: "Window is open again. Resuming [brief description of the interrupted work] in [cancel_window] min. Reply CANCEL to stop." (For a soft-stop pause use "Reset reached. Resuming ..." instead, since the account was never blocked.) Create a new ONE-TIME `CronCreate` job (`recurring: false`, `kind=followup`) `cancel_window` minutes out (see "Safe timing"), prompt: see "On the cancel-window follow-up" below, carrying the state line (`windows`, `cancel_window`, `stop`, `usage`, `backstop`) forward in the prompt text. Classic mode: also delete the original polling job with `CronDelete`; the follow-up job takes over the rest of the flow. If the session ends before this delete completes, both jobs may end up live; the follow-up job firing twice is harmless (step 1 of the follow-up is idempotent), so this is not handled specially.
   - **`cancel_window == 0`:** no waiting, no cancel opportunity. Send a `PushNotification`: "Window is open again. Resumed [brief description of the interrupted work] automatically (no cancel window configured)." (For a soft-stop pause: "Reset reached. Resumed ...".) Then go straight into "On the cancel-window follow-up" step 3 (multi-window re-arm, which comes first) and step 4 (resume) in this same firing; there's no separate follow-up job to create. Classic mode: delete the polling job with `CronDelete`.

## On the cancel-window follow-up

(Only reached when `cancel_window > 0` produced a separate follow-up job, or when a backstop firing declared the follow-up lost; see above.)

1. If the conversation already shows this cutoff was resumed, cancelled, or already re-armed or cleaned up (step 3 below ran for it), do nothing. Otherwise check whether the user has replied CANCEL (or similar: "stop", "cancel", "no") in the conversation since the notification was sent.
2. **Cancelled:** briefly confirm it was stopped. Delete every job of this run that is still live (backstop, pending one-shots), so no jobs are left running.
3. **Not cancelled: re-arm or clean up FIRST, before resuming the work.** The resumed work can be long and can itself hit the next wall or a soft stop; the run's jobs must already reflect the new state by then, otherwise a stale backstop (still carrying the old `windows` value) would cover more windows than requested and a soft stop would build its one-shot from stale state. If `windows` (carried in this job's prompt) is `0` (indefinite) or `>1`, re-arm for the next possible cutoff: decrement `windows` by 1 (leave `0` as `0`), and compute the next reset time:
   - **Usage mode:** take a fresh reading and run "Choosing the target time" (this applies the weekly cap, and falls back to now + 5 hours if the 5-hour `resetsAt` is in the past or missing). Then redo "On invocation" step 3 for usage mode: a new backstop (if the previous one still exists, delete it using the `backstop` ID from the state line), then a new timed one-shot (`chain=0`, `backstop=<new ID>`), both carrying the new `windows` and the same `cancel_window` and `stop`.
   - **Classic mode:** the next reset time is *now (resume time) + 5 hours*; redo "On invocation" step 3 using the classic timed path with that computed time, carrying the same `cancel_window` value forward. This is the same 5-hour rolling window, so the estimate is as good as one the user would have given, with no need to ask them again.

   Do this quietly, with no need to re-confirm with the user unless something about the setup changed (say so if the target switched to a weekly reset). If `windows` was `1`, this was the last covered cutoff: delete the backstop (if any) and every other job of this run, create no new jobs, and note that respawn is now disarmed (no more soft-stop checkpoints).
4. **Resume:** continue the original, interrupted work directly in this session, right where it left off, as if the cutoff never happened. For a soft-stop pause, continue from the state note. If the session's context was compacted or otherwise lost during the wait, say so and ask the user how to proceed rather than guessing at the interrupted task.

## About the tools this skill uses

`CronCreate`, `CronDelete`, and `PushNotification` are harness-provided tools (part of the Claude Code / Claude app scheduling system this skill runs in), not something this skill implements. If your environment doesn't expose them, this skill can't function as written. `CronList` is used only if available, for recovering lost job IDs. `mcp__ccd_session_mgmt__get_usage` is optional: it exists only in the Claude desktop app, and without it (or when it reports `unavailable` / `not_applicable`) the skill runs as classic respawn.
