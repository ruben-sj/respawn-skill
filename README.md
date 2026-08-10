# respawn-skill

> **Fixes "Rate limit exceeded" overnight cutoffs in Claude Code** by auto-resuming the session once the 5-hour usage window reopens — no more remembering to come back and type "continue" at 3am.

A community-made [Claude Code](https://claude.com/claude-code) skill that auto-resumes a session after it gets blocked by Claude's usage limit — it waits for the window to reopen, notifies you, and continues the interrupted work unless you cancel within a configurable grace window.

**Field-tested**, not just a draft: multiple overnight runs, multiple sessions running it in parallel, multiple consecutive 5-hour windows in a single run. The core mechanism — a scheduled job surviving repeated rate-limit rejections and firing correctly once the window reopens — has held up in real use. Still: **not an official Anthropic feature.** Auto-resume after a rate limit is an open, unimplemented feature request (see GitHub issues `anthropics/claude-code` #26775 and #36320). This skill is a best-effort workaround built on scheduling tools (`CronCreate`/`CronDelete`/`PushNotification`) available in the harness, and may stop working if those tools change behavior. See [Known limitations](#known-limitations) for what's still unverified.

## Installation

```bash
mkdir -p ~/.claude/skills/respawn && curl -fsSL https://raw.githubusercontent.com/ruben-sj/respawn-skill/main/skill/SKILL.md -o ~/.claude/skills/respawn/SKILL.md
```

Or manually: copy the contents of [`skill/SKILL.md`](skill/SKILL.md) into `~/.claude/skills/respawn/SKILL.md` (create the `respawn` folder if it doesn't exist).

**Requires `CronCreate`, `CronDelete`, and `PushNotification` tools in your harness.** If your Claude Code environment doesn't expose these, the skill is inert — it has nothing to run.

## Usage

Say something like "respawn", "set up respawn", "auto-resume", or "revive this session" **before** you hit the usage limit. It must be set up proactively — there's no way to invoke it reactively once a session is already blocked, since no new message can be sent in any session until the window reopens.

By default it'll ask you a couple of quick questions (how many windows to cover, whether you know the reset time, how long the cancel grace should be). Answer conversationally, or skip straight past the questions with shorthand arguments:

| Argument | Meaning | Default |
|---|---|---|
| `/respawn 3` | Auto-resume through 3 consecutive 5-hour cutoffs, not just one | `1` |
| `/respawn 0` or `until-cancelled` | Keep going indefinitely until you cancel | — |
| `/respawn 22:15` | You already know the reset time — skips blind polling in favor of a precise check | asks conversationally |
| `/respawn cancel=10` | 10-minute cancel window instead of 5 | `5` |
| `/respawn nocancel` | Resume immediately on detection, no cancel window, just a heads-up after | — |

All combinable and order-independent, e.g. `/respawn 3 22:15 cancel=10` = cover 3 windows, first check timed to 22:15, 10-minute cancel grace each time.

## What's new in v0.2

- **Multi-window (`windows`)** — instead of resuming once and stopping, keep re-arming automatically through N consecutive cutoffs (or indefinitely). Useful for autonomous work that spans more than one 5-hour window.
- **Known-reset-time scheduling** — if you (or the app UI) already know when the window reopens, give that time and the skill schedules one precise check instead of blindly polling every 30 minutes from the start. Comes with a 15-minute safety recheck, then falls back to blind polling if the estimate was off. When re-arming for a later window, the next reset time is auto-computed (resume time + 5h) so you're not asked again.
- **Configurable cancel window (`cancel_window`)** — the "resuming in 5 min, reply CANCEL to stop" grace period is now a parameter, not a hardcoded number. Set it longer, shorter, or to `0` for instant resume with just a heads-up notification instead of a cancel opportunity.
- **Shorthand arguments** — `/respawn 3 22:15 cancel=10` instead of answering three separate questions.

See [CHANGELOG.md](CHANGELOG.md) for the full version history.

## How it works

1. On invocation, a `CronCreate` job is scheduled — either a precise one-time check (if a reset time is known) or a recurring 30-minute poll (if not).
2. While the account is still blocked, the working assumption (confirmed by repeated use) is that a firing job's turn is rejected before it ever runs — so a firing that *does* run is itself evidence the window is open.
3. Once a firing detects an unhandled rate-limit cutoff in the conversation history, it sends a push notification and — unless `cancel_window` is `0` — waits out the cancel grace period via a follow-up one-time job before resuming the original interrupted work.
4. If `windows` isn't exhausted, the cycle re-arms for the next cutoff instead of stopping.

Full operational detail, including exact branching logic, lives in [`skill/SKILL.md`](skill/SKILL.md) — that file *is* the skill's source of truth, since it's the prompt Claude actually follows.

## Known limitations

- Requires the app/session to stay open for the entire waiting period — the underlying jobs are believed to be session-only (in-memory) and vanish if the session ends or the app closes. Not independently confirmed.
- Jobs only fire while the session is idle, which can delay or skip the time-sensitive cancel-window deadline.
- The recurring polling job is believed to auto-expire after 7 days; not yet tested against a wait that long.
- Token cost of rejected attempts while the window is closed is unverified.

## Contributing

Issues and PRs are welcome but may go unanswered for a while.

## License

MIT — see [LICENSE](LICENSE).
