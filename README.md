# respawn-skill

> **Fixes "Rate limit exceeded" overnight cutoffs in Claude Code** by auto-resuming the session once the 5-hour usage window reopens.

A community-made [Claude Code](https://claude.com/claude-code) skill that auto-resumes a session after it gets blocked by Claude's usage limit. It waits for the window to reopen, notifies you, and continues the interrupted work unless you cancel within a configurable grace window.

**Field-tested:** multiple overnight runs, multiple sessions running it in parallel, multiple consecutive 5-hour windows in a single run. The core mechanism (a scheduled job surviving repeated rate-limit rejections and firing correctly once the window reopens) has held up in real use. **Not an official Anthropic feature:** auto-resume after a rate limit is an open, unimplemented feature request (see GitHub issues `anthropics/claude-code` #26775 and #36320). This skill is a best-effort workaround built on scheduling tools (`CronCreate`/`CronDelete`/`PushNotification`) available in the harness, and may stop working if those tools change behavior. See [Known limitations](#known-limitations).

## Installation

```bash
mkdir -p ~/.claude/skills/respawn && curl -fsSL https://raw.githubusercontent.com/ruben-sj/respawn-skill/main/skill/SKILL.md -o ~/.claude/skills/respawn/SKILL.md
```

Or manually: copy the contents of [`skill/SKILL.md`](skill/SKILL.md) into `~/.claude/skills/respawn/SKILL.md` (create the `respawn` folder if it doesn't exist).

**Requires `CronCreate`, `CronDelete`, and `PushNotification` tools in your harness.** If your Claude Code environment doesn't expose these, the skill is inert.

## Usage

Say something like "respawn", "set up respawn", "auto-resume", or "revive this session" **before** you hit the usage limit. It must be set up proactively: there's no way to invoke it reactively once a session is already blocked, since no new message can be sent in any session until the window reopens.

By default it'll ask you a couple of quick questions (how many windows to cover, whether you know the reset time, how long the cancel grace should be). Answer conversationally, or skip straight past the questions with shorthand arguments:

| Argument | Meaning | Default |
|---|---|---|
| `/respawn 3` | Auto-resume through 3 consecutive 5-hour cutoffs, not just one | `1` |
| `/respawn 0` or `until-cancelled` | Keep going indefinitely until you cancel | — |
| `/respawn 22:15` | You already know the reset time: skips blind polling in favor of a precise check | asks conversationally |
| `/respawn cancel=10` | 10-minute cancel window instead of 5 | `5` |
| `/respawn nocancel` | Resume immediately on detection, no cancel window, just a heads-up after | — |

All combinable and order-independent, e.g. `/respawn 3 22:15 cancel=10`.

## Coming in v0.3 (in testing)

v0.3 lives on the [`v0.3.0-dev`](https://github.com/ruben-sj/respawn-skill/tree/v0.3.0-dev) branch and is being field-tested before it lands on `main`. Highlights:

- **Reads the reset time itself** from the Claude desktop app's usage data, so you no longer need to know it.
- **Optional soft stop** (`stop=N`, default 85 %): pauses at a clean point before the limit and resumes after the reset, leaving headroom for other sessions and scheduled tasks.
- **Sturdier scheduling:** a backstop poll next to each timed check, off-minute timing, weekly-limit awareness, and one fixed prompt template for every scheduled job so the rules don't drift over long runs.
- **Falls back to v0.2 behavior** when usage data isn't available (for example outside the desktop app).

Want it early? Install from the branch instead of `main`:

```bash
mkdir -p ~/.claude/skills/respawn && curl -fsSL https://raw.githubusercontent.com/ruben-sj/respawn-skill/v0.3.0-dev/skill/SKILL.md -o ~/.claude/skills/respawn/SKILL.md
```

## Roadmap

- **v0.3.0:** released once it has survived a real usage-limit cutoff.
- **Later:** an optional hook that warns about usage using the terminal CLI's status line data (in our testing the desktop app did not run status line commands), and packaging as a Claude Code plugin.

## What's new in v0.2

- **Multi-window (`windows`)**: keep re-arming automatically through N consecutive cutoffs, or indefinitely, instead of resuming once and stopping.
- **Known-reset-time scheduling**: give a known reset time and the skill schedules one precise check instead of blindly polling every 30 minutes. 15-minute safety recheck if the estimate was off, then falls back to blind polling. Re-arming for a later window auto-computes the next reset time (resume time + 5h).
- **Configurable cancel window (`cancel_window`)**: the "resuming in 5 min, reply CANCEL to stop" grace period is now a parameter. Set it longer, shorter, or `0` for instant resume with just a heads-up notification.
- **Shorthand arguments**: `/respawn 3 22:15 cancel=10` instead of answering three separate questions.

See [CHANGELOG.md](CHANGELOG.md) for the full version history.

## How it works

1. On invocation, a `CronCreate` job is scheduled: either a precise one-time check (if a reset time is known) or a recurring 30-minute poll (if not).
2. While the account is still blocked, a firing job's turn is rejected before it ever runs (confirmed by repeated use), so a firing that does run is itself evidence the window is open.
3. Once a firing detects an unhandled rate-limit cutoff, it sends a push notification and, unless `cancel_window` is `0`, waits out the cancel grace period via a follow-up one-time job before resuming the original interrupted work.
4. If `windows` isn't exhausted, the cycle re-arms for the next cutoff instead of stopping.

Full operational detail lives in [`skill/SKILL.md`](skill/SKILL.md), the prompt Claude actually follows.

## Known limitations

- Requires the app/session to stay open for the entire waiting period. Believed (not independently confirmed) that the underlying jobs are session-only (in-memory) and vanish if the session ends or the app closes.
- Jobs only fire while the session is idle, which can delay or skip the time-sensitive cancel-window deadline.
- The recurring polling job is believed to auto-expire after 7 days; not yet tested against a wait that long.
- Token cost of rejected attempts while the window is closed is unverified.

## Contributing

Issues and PRs are welcome but may go unanswered for a while.

## License

MIT. See [LICENSE](LICENSE).
