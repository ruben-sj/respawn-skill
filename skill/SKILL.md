---
name: respawn
description: Sets up automatic revival of this session after Claude's 5-hour usage limit is hit. It waits until the window reopens, notifies the user, and resumes automatically unless the user cancels within a configurable grace window (default 5 min). It can also pause itself at a usage threshold (soft stop) and uses live usage readings for timing when the Claude desktop app provides them. Use when the user says "respawn", "set up respawn", "auto-resume", "revive this session", or wants to avoid having to remember to come back after a rate-limit cutoff. MUST be invoked proactively, BEFORE the account is actually blocked; does not work reactively after a cutoff. v0.4.0; the v0.2 core is field-tested through multiple overnight multi-window multi-session runs, the v0.3 and v0.4 additions less so; not an officially supported Anthropic feature.
---

# respawn

Gaming metaphor: the session "dies" (gets blocked by the 5-hour usage limit), waits, and respawns automatically once the window reopens.

**Critical precondition:** this must be set up BEFORE the account gets blocked. After a cutoff, no new message can be sent in any session until the window reopens, so there is no reactive way in. The user must invoke `/respawn` proactively (at the start of a heavy/long session, or when they notice they're approaching the limit).

**Confirmed by repeated real-world use** (multiple overnight runs, multiple sessions running `/respawn` in parallel, multiple consecutive windows in a single run): a recurring `CronCreate` job does survive repeated rate-limit rejections and fires correctly once the window reopens, the detect → notify → cancel-window → resume flow works end to end (tested with the then-fixed 5-minute cancel window), and this holds across several concurrent sessions without interference. Still not an officially supported Anthropic feature: auto-resume after a rate limit was requested in GitHub issues anthropics/claude-code #26775 and #36320, and Claude Code v2.1.234 and later has a built-in `autoContinueAtUsageLimit` setting that may already suit the user (this skill is an independent alternative with a cancel window, multi-window coverage and a soft stop). The v0.3 additions (live usage readings, backstop, soft stop) are newer and have seen less field testing than that core.

**Two modes, one skill.** *Usage mode* uses the live usage readings from `mcp__ccd_session_mgmt__get_usage` (see "Reading usage"). *Classic mode* has no usage readings of its own and times its checks from a user-given reset time or a blind 30-minute poll, like v0.2.0 (only the optional usage hook layer can give it readings, and only for the soft stop; see "Hook messages and the armed marker"). Classic mode is always the fallback. It keeps the v0.2.0 flow, with four improvements that apply to both modes: the off-minute margin in "Safe timing", silent-cutoff detection, re-arming before resuming, and re-invocation replacing an old run.

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
- A **usable reading** means: the call succeeded, `plan.status` is `"ok"`, and a 5-hour window is present. Anything else (tool absent, error, `"unavailable"`, `"not_applicable"`, no 5-hour window) is **not usable**, and the step in question is classic. A 5-hour `resetsAt` that is missing or already in the past does not make the reading unusable; "Choosing the target time" handles it.
- `percentUsed` is account-wide: other sessions and scheduled tasks share it.

## Safe timing

Every one-shot in this skill (reset-time jobs, soft-stop resumes, 15-minute rechecks, the cancel-window follow-up) is scheduled so that it does not land on minute :00 or :30:
- A reset-time job is scheduled at the reset time (`resetsAt`, or the user-given time) plus a margin of 3 to 5 minutes. Use +4 and move to +3 or +5 if the resulting local minute is 0 or 30.
- Any other one-shot (a `recheck` 15 minutes out, the cancel-window follow-up `cancel_window` minutes out): compute the time, and if it lands on minute 0 or 30, add 1 minute. For example a recheck that would land on 22:30 is scheduled for 22:31.
- Express a one-shot as a cron expression with fixed minute, hour, day-of-month and month (local time, which can fall on the next calendar day), and `recurring: false`.
- If the computed time is already in the past or less than 2 minutes away, use now + 3 minutes, again avoiding minute 0 and 30.

## Choosing the target time

Used whenever a reset-time job is created (invocation, soft stop, re-arm). In usage mode:
1. Read usage (fresh reading).
2. **Weekly cap:** if any weekly window has `percentUsed` of 98 or more, or the cutoff message mentions a weekly limit, the target is that weekly window's `resetsAt` (if several qualify, the latest one). If the message mentions a weekly limit but no weekly window can be read, use the reset time named in the message if it gives one, otherwise the 5-hour reset. Tell the user it is the weekly reset: the wait may be days, and the 7-day expiry of recurring jobs means the backstop may disappear before then.
3. Otherwise the target is the 5-hour window's `resetsAt`.
4. If the target is missing or already in the past, use now + 5 hours. This is the **raw reset time** (no margin yet); a soft-stop note records it as `resume_after`.
5. Add the margin from "Safe timing". The result is the time the one-shot is scheduled for.

In classic mode the target is the user-given time, or (when re-arming) now + 5 hours, plus the margin. For a soft-stop pause in a classic run with the hook layer, the raw target is the reset time named in the latest hook note instead (the weekly reset when the note says so), or now + 5 hours if it names none.

## Job prompts

All state lives inside the `CronCreate` prompt text. Nothing is written to files, except the optional armed marker when the usage hook layer is present (see "Hook messages and the armed marker"). **Every job this skill creates uses the template below, copied verbatim.** Substitute only the values in the `respawn-state:` line, and add the `context:` line only for a soft-stop resume. Do not shorten, paraphrase or extend the rest: later jobs are created from earlier ones, and a paraphrase of a paraphrase drifts.

```
respawn-state: usage=<on|off> windows=<N> cancel_window=<M> stop=<S|off> kind=<kind> backstop=<id|self|none>
context: <soft-stop resume only: resume from the `respawn soft stop:` note written at <local date and time>>
This is a respawn job (respawn skill). First get the current local date and time (e.g. from the shell). If kind=followup, go straight to step 4. A firing that resumes nothing writes nothing except the log line in step 3.
1. If kind=backstop and a `respawn soft stop:` note is waiting (its resume_after not reached yet, and no `respawn log: soft stop superseded` after it): do nothing at all and end the turn.
2. Look for an unhandled cutoff since respawn was armed. Signals: (a) a usage-limit error message; (b) a turn that stopped mid-work: the last message that is not respawn's own is a tool result with no assistant follow-up, and either 30+ minutes have passed since it or (usage=on) a 5-hour reset time recorded in the conversation before it has passed since; (c) a `respawn soft stop:` note whose resume_after is reached and that is not followed by `respawn log: soft stop superseded`. Respawn's own messages (everything in a turn started by a respawn job prompt, unless that turn resumed the work, plus `respawn log:` lines) never count as the last message. A cutoff is handled once a respawn "Window is open again" or "Reset reached" notification, or a kind=followup job, appears after it, or once the work was resumed or cancelled.
3. Nothing unhandled (this includes a handled cutoff whose follow-up is pending): if kind=timed and usage=on, call mcp__ccd_session_mgmt__get_usage and write one line `respawn log: <local time> | 5-hour <percentUsed>% resets <resetsAt> | timed`; if kind=timed and usage=off, schedule kind=recheck 15 minutes out; if kind=recheck, create the recurring 30-minute poll (kind=poll, minutes 13,43); otherwise do nothing. Exception: if a handled cutoff's notification is older than cancel_window + 10 minutes and nothing has resumed or cancelled since, the follow-up was lost: go to step 4 as kind=followup.
4. Unhandled cutoff found, or kind=followup: load the respawn skill (Skill tool) for reference only, do not run its "On invocation", and follow its "On each check firing" step 4 (cutoff found) or "On the cancel-window follow-up" (kind=followup) with the state line above. If the skill cannot be loaded: for kind=followup, if the user replied CANCEL, stop or no since the notification, delete every job whose prompt starts with respawn-state: (and the armed marker file named in the setup-complete message, if any) and confirm; otherwise delete those jobs (and that marker file), send a PushNotification that the window is open again and respawn is now disarmed, and resume the interrupted work. For a found cutoff with cancel_window > 0, send a PushNotification "Window is open again. Resuming in <cancel_window> min. Reply CANCEL to stop.", create a kind=followup one-shot from this template cancel_window minutes out, and end the turn; with cancel_window = 0, act as for kind=followup without a cancel reply.
New jobs copy this template verbatim. Schedule one-shots off minute :00 and :30 (reset time + 3 to 5 minutes).
```

State-line fields:
- `usage`: `on` if the invocation-time reading was usable (usage mode for the whole run), otherwise `off` (classic for the whole run).
- `windows`: remaining windows to cover (`0` = indefinite). `cancel_window`: minutes. `stop`: soft-stop percentage, or `off` (always `off` in a classic run without the usage hook layer).
- `kind`: `timed` (one-shot at a reset time), `backstop` (recurring usage-mode poll), `poll` (classic recurring poll), `recheck` (classic 15-minute recheck), `followup` (cancel-window follow-up).
- `backstop`: the job ID of this run's backstop (`self` in the backstop's own prompt, since it cannot know its own ID in advance; `none` in classic runs). To make this possible, always create the backstop first and the timed one-shot second, and pass the backstop's ID into the one-shot's and the follow-up's prompts.

Keep track of the job IDs you create (the setup-complete message lists them) so they can be passed to `CronDelete`. Find the rest with `CronList` when available, recognizing this skill's jobs by the `respawn-state:` prefix. A `CronCreate` prompt cannot be edited: to change a job's state, delete it and create a new one. If IDs are lost (for example after context compaction) and `CronList` is unavailable, delete what the conversation still lists, and accept that a stray one-shot may fire once later; it will find nothing unhandled and do nothing. At most one backstop and at most one pending timed one-shot may exist per respawn run, except for the moment inside a re-arm or soft stop between creating the new jobs and deleting the old ones.

**Respawn's own messages** are everything in a turn started by a respawn job prompt (unless that turn resumed the work), plus `respawn log:` lines. They are ignored only when deciding what the last real message is (signal b). They still count as evidence that a cutoff was handled. To keep this clean, a firing that resumes nothing writes nothing except its log line.

## On invocation

`/respawn` here refers to whatever phrase triggers this skill (see the trigger phrases in the frontmatter `description` above). It is not necessarily a registered slash command; treat it as shorthand for "when this skill fires." If this skill was loaded from inside a respawn job (step 4 of the template), skip this section.

**Re-invocation:** if a respawn run is already armed in this session (job IDs listed earlier in the conversation, or jobs with the `respawn-state:` prefix in `CronList`), delete all of its jobs and its armed marker first and tell the user the new settings replace the old run. Never keep two runs side by side.

**Shorthand arguments:** if invoked with arguments (e.g. `/respawn 3`, `/respawn 22:15`, `/respawn 3 22:15 cancel=10`, `/respawn nocancel`, `/respawn stop=70`), parse instead of asking conversationally:
- A bare integer token → `windows` (`0` = indefinite).
- A token matching `H:MM`/`HH:MM` (24h) → known reset time (see step 3 for how it combines with a usage reading).
- `until-cancelled` or `inf` → `windows: 0`.
- `cancel=N` → cancel-window length in minutes (see below).
- `nocancel` → shorthand for `cancel=0`.
- `stop=N` → soft-stop percentage (integer 1 to 100, default `85`); see "Soft stop".
- `nostop` → disables the soft stop (`stop=off`).
- Any combination of the above, in any order. Anything that doesn't parse cleanly, or no arguments at all → fall back to asking conversationally (step 2 below).

Steps:

1. **Read usage** (see "Reading usage"). A usable reading → `usage=on`. Otherwise `usage=off` and the whole run is classic. Also check whether the usage hook layer is present (see "Hook messages and the armed marker"); it only matters for classic runs, where it switches the soft stop on. Then, in usage mode with the soft stop on (call the 5-hour percent P and the soft-stop level N), and **also when shorthand arguments skipped the conversation**: if P is at or above N - 15 and the user did not give `stop` explicitly, do not arm silently. The default would pause the session at the first checkpoint (or block new fan-outs), which is the opposite of what someone nearing the limit usually wants. Say that usage is already P %, and ask whether to keep `stop` at N, raise it (for example to the lower of 100 and P + 10), or turn it off (`nostop`). If they have no preference, use `nostop` for this run and say so. If the user did give `stop` explicitly, respect it and just mention the current P.
2. If no valid arguments were given, briefly confirm with the user what's about to happen (see **Activation message** below), and remind them of the limitations above if this is the first time they've used the skill in this session. Ask:
   - How many consecutive 5-hour cutoffs to auto-resume through (`windows`): default `1` (resume once, then stop) if they don't say. `0` or "until cancelled" means keep re-arming indefinitely. A soft-stop pause also uses up one window.
   - **Only if `usage=off`:** whether they already know the reset time for this cutoff (the app UI often shows it). Optional, and most people won't know it yet if they're setting this up pre-emptively. In usage mode do not ask: the reset time comes from the reading.
   - How long the cancel window should be once a cutoff is detected (`cancel_window`, minutes): default `5` if they don't say. `0` means resume immediately with no cancel window at all, only a heads-up notification after the fact.
   - The soft stop (`stop`) is not asked about: use the default `85` unless the user brings it up (see "Soft stop"). In a classic run it applies only if the hook layer is present; otherwise use `stop=off`.
3. **Pick the target time** and create the jobs with `CronCreate`, each prompt built from the template in "Job prompts":
   - **`usage=on` (timed path with backstop):**
     1. Target time: "Choosing the target time" from the reading just taken (this includes the weekly-cap rule). If the user gave an `HH:MM` (next occurrence in the future), use it instead, unless it differs from the reading's raw target by more than 30 minutes: then use the earlier of the two and tell the user about the mismatch, since a time of day that has already passed today means tomorrow and would otherwise delay the first check by most of a day.
     2. Create the backstop first: `recurring: true`, `cron` every 30 minutes on off-minutes, e.g. `"13,43 * * * *"`, with `kind=backstop backstop=self`. It exists because it is unverified whether a one-shot that fires while the account is still blocked survives.
     3. Then create the timed one-shot (`recurring: false`) at the target, with `kind=timed` and `backstop=<the backstop's job ID>`.
   - **`usage=off` and a reset time is known** (given by the user, or auto-computed as now + 5 hours for a later window; see the re-arm step of the follow-up), classic timed path: first job is ONE-TIME (`recurring: false`), scheduled at the reset time plus the margin from "Safe timing", with `kind=timed backstop=none`. The known reset time replaces the blind 30-minute cadence for the first check, since the harness can't read a live reset time from inside a blocked job itself. Safety net if the estimate was off: if this job fires and finds no unhandled cutoff, it schedules one more ONE-TIME recheck 15 minutes later (`kind=recheck`); if *that* also finds nothing, it falls through to the blind 30-minute recurring poll.
   - **`usage=off` and no reset time known** (classic blind path): `recurring: true`, `cron`: every 30 minutes, offset from the hour/half-hour, e.g. `"13,43 * * * *"`, `kind=poll backstop=none`.
4. Note the job ID(s) from the response (needed for `CronDelete` later).
5. If the hook layer is present and `stop` is a number, write the armed marker (see "Hook messages and the armed marker"). This happens once, here; re-arming never touches it.
6. Briefly confirm it's set up (see **Setup-complete message** below).

**Activation message**: cover these points, adapted to the user's language and phrasing, not a literal script:
> Setting up respawn: I'll watch for the usage-limit cutoff and auto-resume once the window reopens ([windows] window(s), [cancel_window]-min cancel grace / no cancel grace). [Usage mode: current usage is [P]% of the 5-hour limit (resets around HH:MM local) and [W]% of the weekly limit(s) where readable; soft stop at [N]% (account-wide percent) unless disabled. | Classic mode: usage readings are not available here, so I'll fall back to the reset time you give me or a 30-minute poll, and the soft stop is off unless the usage hook layer is present (then it is on at [N]%, driven by hook notes).] [First time only: one-line limitations summary: requires this session to stay open, unofficial workaround, see full list if asked.]

**Setup-complete message**: cover these points. It always carries the reset time, the current usage and the soft-stop level, so shorthand invocations (which skip the activation message) still show them, and because signal (b) of the template relies on a reset time recorded in the conversation:
> Respawn is armed: [usage mode: first check at HH:MM (5-hour reset at YYYY-MM-DD HH:MM plus a few minutes of margin; weekly reset instead if a weekly limit is nearly used, and then still name the 5-hour reset) with a 30-min backstop poll | classic: checking once around HH:MM (+ 15-min safety recheck) | classic: polling every 30 min] until the window reopens[, repeating for up to N windows]. [Usage mode: current usage [P]% of the 5-hour limit and [W]% weekly where readable; soft stop at [N]%, or off. | Classic mode: soft stop at [N]% driven by hook notes if the hook layer is present, otherwise off; an explicit `stop` is ignored then (no usage readings here). If an armed marker was written, name its full path.] [If cancel_window > 0: you'll get [cancel_window] min to cancel once it fires. | If cancel_window = 0: it'll resume immediately on detection, no cancel window, and you'll just get a heads-up after the fact.] Jobs: [IDs].

## Soft stop

Active when `stop` is not `off` and either the run is in usage mode (`usage=on`) or the usage hook layer is present (its notes are the readings, see "Hook messages and the armed marker"). Without either, the `stop` argument is ignored; say so in the setup-complete message instead of silently dropping it.

**The point:** instead of running into the hard cutoff mid-step, pause deliberately at a threshold, at a clean place in the work. Important caveats to tell the user if they ask: the percent is account-wide (other sessions and scheduled tasks share it), a single big step can overshoot the threshold, so `stop=N` with N close to 100 behaves almost like classic respawn (run until the wall, then resume), which remains the fallback, and a pause uses up one of the covered `windows`.

**Checkpoints.** While respawn is armed, read usage at natural checkpoints: between steps of the work, and before starting a large fan-out (a Workflow, or several subagents at once). Not after every tool call. A message from the optional usage hook counts as a checkpoint reading too. Take the 5-hour `percentUsed` (call it P); also apply the weekly cap check from "Choosing the target time" (a weekly window at 98 or more counts as the stop tier regardless of N, with the weekly reset as the target).

Tiers, with N = `stop`:
- **P below N - 15:** carry on normally.
- **P from N - 15 up to (not including) N, warning tier:** do not start new large fan-outs; prefer finishing the current unit of work. Mention this once in the conversation, then continue.
- **P at or above N, stop tier:**
  1. Finish the current step. Do not abandon a half-made edit.
  2. Take a fresh reading and run "Choosing the target time".
  3. Write a short state note in the conversation, starting with `respawn soft stop:`, giving what is done, what is next, and `resume_after=<raw reset time as local date and time, e.g. 2026-11-03 03:00>` (the target before the safe-timing margin).
  4. Create a new timed one-shot (`kind=timed`, same state line, the existing `backstop` ID) at the target plus margin, from the template with a `context:` line pointing to the state note, then delete this run's previous pending timed one-shot, if any (create first, so a failed `CronCreate` never leaves the pause without a resume job). Keep the backstop: during the pause its firings do nothing at all (template step 1), and it is the safety net if the account gets blocked anyway (for example by another session) and the one-shot fires while blocked.
  5. Send a `PushNotification`: "Paused at [P]% usage. Resuming around [HH:MM]."
  6. End the turn. Start no further work.
- If the user explicitly tells you to keep going past the stop level, or continues the work themselves during the pause, delete the pause one-shot, write `respawn log: soft stop superseded`, and do not stop again until the next window. A note followed by that log line is no longer waiting and is not a cutoff.

A soft-stop pause counts as one covered window: it is resumed through the same flow as a hard cutoff, including the cancel window and the `windows` decrement. Once the last covered window has been resumed and the run's jobs are deleted, respawn is no longer armed and there are no more soft-stop checkpoints.

## Hook messages and the armed marker

Optional. A usage hook layer (a hook plus a statusline tap, installed as described in the README) can watch a statusline usage reading for you in the terminal CLI. Everything in this skill works without it, and without it nothing is ever written to files.

- **Is the hook layer present?** Check once, at invocation: does the folder `.claude/respawn-usage/` exist under the user's home folder? (The statusline tap creates it.) If not, skip the rest of this section.
- **Your session ID:** `${CLAUDE_SESSION_ID}`. If that shows a literal dollar sign and braces instead of an ID, treat the hook layer as absent.
- **Arm (once, at invocation):** with the layer present and `stop` a number, use the Write tool (plain text, UTF-8) to create a file named after the session ID in `.claude/respawn-armed/` under the user's home folder, holding one line: `stop=<S>`. Write it after the jobs exist, and name its full path in the setup-complete message. Re-arming for the next window does not touch it. If writing fails, carry on without it.
- **Disarm:** delete that file on every path that ends the run: cancel, the last covered window resumed, the user telling you to stop, re-invocation (before the new one is written) and the template's fallback. Best effort: the hook ignores and removes a marker older than 8 days (recurring jobs expire after 7), and a hook note that reaches you when no `respawn-state:` job exists in this session means the marker was left behind: delete it and ignore the note.
- **A hook message counts as a checkpoint reading.** A message starting `Usage note from the respawn hook` gives the 5-hour percent P and its reset time (or names the weekly reset). Apply the tiers in "Soft stop" to it. In a classic run it is the only reading there is: wherever the soft stop says to take a fresh reading, use the latest hook note, and use its reset time as the raw target (now + 5 hours if it names none). The hook speaks once per crossing, so a quiet hook means nothing; keep taking checkpoint readings yourself where `mcp__ccd_session_mgmt__get_usage` exists.

## On each check firing

This covers every firing of kind `timed`, `backstop`, `poll` or `recheck`. Steps 1 to 3 are the template's quick check (see "Job prompts"); a firing only loads this skill for step 4.

Confirmed by repeated use: if the account is still blocked by the usage limit when the job fires, the turn never runs at all (rejected before any model turn starts), so the fact that this prompt actually runs is evidence the window is open. Behave accordingly. (The exception is a soft-stop pause: the account is not blocked there, which is why the note has its own `resume_after`.)

1. **Soft-stop pause.** A backstop firing while a `respawn soft stop:` note waits for its `resume_after` does nothing at all: no usage reading, no log line.
2. **Detect** an unhandled cutoff since `/respawn` was activated, using signals (a) to (c) and the "handled" rule from the template. Signal (b) explained: field-observed, the app can cut a turn off at the limit without showing any error in the conversation, so a trailing tool result with no assistant follow-up counts. An explicit user interruption does not count. To avoid mistaking an unrelated stalled turn for a cutoff, roughly 30+ minutes must have passed since the tool result (as in v0.2.0), or, in usage mode, a 5-hour reset time recorded in the conversation before it (in the setup-complete message, a checkpoint reading or a `respawn log:` line) has passed since. The second condition catches a silent cutoff shortly before a reset; the first still works if the recorded reset was lost to context compaction.
3. **No unhandled cutoff** (including a handled cutoff whose follow-up is pending). Firings are idempotent: do nothing about a handled cutoff. A `timed` firing in usage mode writes one `respawn log:` line for calibration and does nothing else: the backstop keeps watching, and the next timed one-shot is only created at re-arm. A `timed` firing in classic mode schedules the 15-minute `recheck`; a `recheck` creates the 30-minute `poll`. Backstop and poll firings do nothing. Exception: the lost follow-up rule in template step 3.
4. **An unhandled cutoff found.** In usage mode, take a fresh reading and write the `respawn log:` line first. Delete this run's other pending one-shots (timed, recheck) with `CronDelete`, found via `CronList` or the conversation, so the cutoff is not handled twice. Keep the backstop (usage mode) or the polling job (classic) for now: it is the safety net if the follow-up job is lost (lost-follow-up rule), and the re-arm step of the follow-up replaces or deletes it before the interrupted work resumes. Then branch on `cancel_window` (carried in this job's prompt; default `5` if absent, i.e. jobs created before this option existed):
   - **`cancel_window > 0`:** send a `PushNotification`: "Window is open again. Resuming [brief description of the interrupted work] in [cancel_window] min. Reply CANCEL to stop." (For a soft-stop pause use "Reset reached. Resuming ..." instead, since the account was never blocked.) Create a new ONE-TIME `CronCreate` job (`recurring: false`, `kind=followup`) `cancel_window` minutes out (see "Safe timing"), from the template, carrying the state line forward. If the session ends before the deletes complete, extra jobs may end up live; a second firing finds the cutoff handled and does nothing, so this is not handled specially.
   - **`cancel_window == 0`:** no waiting, no cancel opportunity. Send a `PushNotification`: "Window is open again. Resumed [brief description of the interrupted work] automatically (no cancel window configured)." (For a soft-stop pause: "Reset reached. Resumed ...".) Then go straight into "On the cancel-window follow-up" step 3 (re-arm, which comes first) and step 4 (resume) in this same firing; there's no separate follow-up job to create.

## On the cancel-window follow-up

(Reached from a `kind=followup` job, or from the lost-follow-up rule.)

1. If the conversation already shows this cutoff was resumed, cancelled, or already re-armed or cleaned up (step 3 below ran for it), do nothing. Otherwise check whether the user has replied CANCEL (or similar: "stop", "cancel", "no") in the conversation since the notification was sent.
2. **Cancelled:** briefly confirm it was stopped. Delete every job of this run that is still live (backstop, pending one-shots), so no jobs are left running, and delete the armed marker.
3. **Not cancelled: re-arm or clean up FIRST, before resuming the work.** The resumed work can be long and can itself hit the next wall or a soft stop; the run's jobs must already reflect the new state by then, otherwise a stale backstop (still carrying the old `windows` value) would cover more windows than requested and a soft stop would build its one-shot from stale state. Create the new jobs first and delete the old ones after, so a failed `CronCreate` never leaves the run unarmed (report any create failure to the user):
   - If `windows` (carried in this job's prompt) is `1`, this was the last covered cutoff: create no new jobs, delete every other job of this run (the backstop or poll and any pending one-shot, via `CronList` or the conversation), delete the armed marker, and note that respawn is now disarmed (no more soft-stop checkpoints).
   - If `windows` is `0` (indefinite) or `>1`, re-arm for the next possible cutoff: decrement `windows` by 1 (leave `0` as `0`), then
     - **usage mode:** take a fresh reading, run "Choosing the target time" (this applies the weekly cap and falls back to now + 5 hours), and redo "On invocation" step 3 for usage mode: a new backstop, then a new timed one-shot with `backstop=<new ID>`, both carrying the new `windows` and the same `cancel_window` and `stop`. Then delete every other job of this run (the old backstop by the ID in the state line, and any other pending one-shot). Write the new reset time into the conversation (it is the recorded reset time signal (b) relies on).
     - **classic mode:** the next reset time is *now (resume time) + 5 hours*; redo "On invocation" step 3 using the classic timed path with that computed time, carrying the same `cancel_window` and `stop` values forward, then delete every other job of this run (the old poll and any other pending one-shot). This is the same 5-hour rolling window, so the estimate is as good as one the user would have given, with no need to ask them again.

   Do this quietly, with no need to re-confirm with the user unless something about the setup changed (say so if the target switched to a weekly reset).
4. **Resume:** continue the original, interrupted work directly in this session, right where it left off, as if the cutoff never happened. For a soft-stop pause, continue from the state note. If the session's context was compacted or otherwise lost during the wait, say so and ask the user how to proceed rather than guessing at the interrupted task.

## About the tools this skill uses

`CronCreate`, `CronDelete`, and `PushNotification` are harness-provided tools (part of the Claude Code / Claude app scheduling system this skill runs in), not something this skill implements. If your environment doesn't expose them, this skill can't function as written. `CronList` is used when available, to find this run's jobs. `mcp__ccd_session_mgmt__get_usage` is optional: it exists only in the Claude desktop app, and without it (or when it reports `unavailable` / `not_applicable`) the skill runs in classic mode.
