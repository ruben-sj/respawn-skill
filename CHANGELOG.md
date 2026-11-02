# Changelog

## v0.4.0 - unreleased

Optional hook layer and plugin packaging. Everything is opt-in; without the plugin and tap, respawn behaves exactly as in v0.3.0 and writes no files. Added:
- Plugin packaging: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, so `/plugin marketplace add ruben-sj/respawn-skill` and `/plugin install respawn@respawn-skill` work. The plugin points at `skill/SKILL.md` in place (no copy), so existing curl installs keep working. Needs Node.js for the hook.
- Usage tap `scripts/respawn-tap.js`: a dependency-free Node `statusLine` wrapper that atomically writes `{ts, session_id, five_hour, seven_day}` to `~/.claude/respawn-usage/<session id>.json` (one file per session, pruned after 8 days) and pipes the input to the user's existing status line command (one quoted string, run through the platform shell, stopped after 10 seconds with its partial output forwarded, and stopped with the tap if the tap is terminated). Manual opt-in (plugins cannot set `statusLine`).
- Usage hook `scripts/respawn-usage-hook.js` (a `PostToolUse` hook in `hooks/hooks.json`): silent unless a respawn run is armed in the session, and then adds one short note each time the rounded 5-hour percent crosses `stop - 15` (not for `stop` of 15 or less) and `stop`, or a weekly window reaches 98 % (the note then names the weekly reset as the target). Only from a fresh cache of the same session; each crossing is claimed with an exclusive flag file, so parallel tool calls produce one note; calls inside subagents are skipped. Notes state facts and end with a neutral line that they only apply if a respawn run is armed in the session. A `stop=off` marker is inert and removed by the hook, and the hook prunes other sessions' leftover files older than 30 days.
- Armed marker: in a classic run (`usage=off`) with the hook layer present (this session's `~/.claude/respawn-usage/<session id>.json` exists and parses), the skill writes `~/.claude/respawn-armed/<session id>` (`stop=<S>`) once at invocation with the Write tool, and overwrites it with `stop=off` only on interactive disarm paths (user cancel or stop, re-invocation). Unattended steps (cancel-window follow-up, re-arm, end of run, job template fallback) never touch files, and usage mode (desktop app) writes nothing. UTF-8 (with or without BOM) and UTF-16LE markers are read; the session's own marker has no expiry.
- Soft stop also works in classic mode when the hook layer is present: hook notes serve as the usage readings, with the note's reset time as the target, and the near-limit check at invocation uses the cache file's percent. `skill/SKILL.md` gains a section on this, the classic re-arm now carries `stop` forward like the usage branch, a soft-stop pause deletes any pending one-shot of the run (timed or recheck), and poll jobs stay idle during a waiting pause like the backstop.
- Tests: `node --test test/*.test.js` (tap, hook and plugin manifests, with fixture data).
- Known: the desktop app's Code tab was not observed to run status line commands, so the hook layer most likely works only in the terminal CLI. The tap and hook have been tested on fixtures, not yet in a live session.

## v0.3.0 - unreleased

Uses live usage readings where the Claude desktop app provides them (`mcp__ccd_session_mgmt__get_usage`). When that tool is missing, reports `unavailable` / `not_applicable`, or has no 5-hour window, respawn keeps the v0.2.0 flow, plus the off-minute timing margin, silent-cutoff detection, re-arming before resuming, and re-invocation replacing an old run. Added:
- Reset time read from usage at invocation, so the timed path is the default. The "do you know the reset time?" question is only asked without usage readings. A user-given `HH:MM` still wins, unless it is more than 30 minutes off the reading (then the earlier one is used and the mismatch is reported).
- Safe timing: every one-shot avoids minute :00 and :30 (such one-shots can fire up to 90 seconds early); reset-time jobs run at the reset plus 3 to 5 minutes.
- Recurring 30-minute backstop alongside each timed one-shot (at most one per run, its ID carried in the state line), because it is unverified whether a one-shot rejected while blocked survives.
- Fixed job-prompt template: every scheduled job uses the same verbatim text with only the state line substituted, and loads the skill for the full rules only when a cutoff is found or for the follow-up.
- Multi-window re-arm uses a fresh usage reading, creates the new jobs before deleting the old ones, and happens before the interrupted work resumes, so a long resumed task is never caught by stale jobs.
- Weekly cap: a weekly window at 98 % or more (or a cutoff message naming a weekly limit) makes respawn target the weekly reset.
- Soft stop: `stop=N` (default 85) and `nostop`. At checkpoints respawn reads usage, avoids new large fan-outs from N - 15 %, and at N % finishes the current step, writes a `respawn soft stop:` note, schedules the resume after the reset, keeps the backstop as a silent safety net during the pause, notifies and ends its turn. If usage is already near the stop level at activation and `stop` was not given, respawn asks first.
- Silent mid-work cutoffs are detected (last non-respawn message is a tool result with no follow-up), since the app can hit the limit without showing an error. Respawn ignores its own messages for this. It counts after a 30-minute gap, or in usage mode as soon as a recorded reset time has passed since the stalled turn, which catches cutoffs shortly before a reset.
- Re-invoking replaces an existing run. A calibration log line on each usage-mode timed check and each detected cutoff. Activation and setup messages show current usage and the soft-stop level.
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
