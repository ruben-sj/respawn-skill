# Changelog

## v0.3.0 - 2026-11-02

Uses live usage readings where the Claude desktop app provides them (`mcp__ccd_session_mgmt__get_usage`). When that tool is missing, reports `unavailable` / `not_applicable`, or has no 5-hour window, every new behavior falls back to v0.2.0 (apart from the off-minute timing margin, which applies to every timed job). Added:
- Reset time read from usage at invocation, so the timed path is the default. The "do you know the reset time?" question is only asked without usage readings. A user-given `HH:MM` still wins, unless it is more than 30 minutes off the reading (then the earlier one is used and the mismatch is reported).
- Safe timing: every one-shot avoids minute :00 and :30 (such one-shots can fire up to 90 seconds early); reset-time jobs run at the reset plus 3 to 5 minutes.
- Recurring 30-minute backstop alongside each timed one-shot (at most one per run, its ID carried in the state line), because it is unverified whether a one-shot rejected while blocked survives.
- Chaining: a timed one-shot that finds no cutoff schedules the next one at the new reset, instead of a 15-minute recheck plus blind poll. A chain never recreates an expired backstop.
- Multi-window re-arm uses a fresh usage reading, and now happens before the interrupted work resumes, so a long resumed task is never caught by stale jobs.
- Weekly cap: a weekly window at 98 % or more (or a cutoff message naming a weekly limit) makes respawn target the weekly reset.
- Soft stop: `stop=N` (default 85) and `nostop`. At checkpoints respawn reads usage, avoids new large fan-outs from N - 15 %, and at N % finishes the current step, writes a `respawn soft stop:` note, schedules the resume after the reset, removes the backstop for the pause, notifies and ends its turn. If usage is already near the stop level at activation and `stop` was not given, respawn asks first.
- Stand-down: an idle usage-mode run (three empty checks, no background work running) deletes its jobs instead of polling until the 7-day expiry.
- Silent mid-work cutoffs are detected (last non-respawn message is a tool result with no follow-up), since the app can hit the limit without showing an error. Respawn ignores its own messages for this; the 30-minute gap is only required in classic mode.
- Re-invoking replaces an existing run. One calibration log line per usage-mode firing. Activation and setup messages show current usage and the soft-stop level.
- Known limitations upgraded with facts confirmed by the `CronCreate` documentation (session-only jobs, 7-day expiry, idle-only firing, firing jitter).
- README: PowerShell install, updating and version pinning, comparison with the built-in `autoContinueAtUsageLimit`. All em-dashes removed from `skill/SKILL.md`.

## v0.2.0 - 2026-08-10

Field-tested through multiple overnight, multi-session, multi-window runs. Added:
- `windows`: auto-resume through N consecutive cutoffs instead of just one.
- Known-reset-time scheduling: skip blind 30-min polling when the user (or an auto-computed next window) knows the reset time; one-time check + 15-min safety recheck instead.
- `cancel_window`: configurable cancel-grace length, including `0` for immediate resume with no cancel window.
- Shorthand CLI-style arguments (`/respawn 3 22:15 cancel=10`) alongside the conversational flow.

## v0.1.0 - 2026-08-05

Initial public release. Experimental; see README for known limitations.
