# respawn-skill

> **Fixes "Rate limit exceeded" overnight cutoffs in Claude Code** by auto-resuming the session once the 5-hour usage window reopens.

A community-made [Claude Code](https://claude.com/claude-code) skill that auto-resumes a session after it gets blocked by Claude's usage limit. It waits for the window to reopen, notifies you, and continues the interrupted work unless you cancel within a configurable grace window.

**Field-tested (v0.2 core):** multiple overnight runs, multiple sessions running it in parallel, multiple consecutive 5-hour windows in a single run. The core mechanism (a scheduled job surviving repeated rate-limit rejections and firing correctly once the window reopens) has held up in real use. The v0.3 additions (live usage readings, backstop, chaining, soft stop, stand-down) are newer and less field-tested. **Not an official Anthropic feature:** auto-resume after a rate limit was requested in GitHub issues `anthropics/claude-code` #26775 and #36320, and Claude Code v2.1.234 and later has a built-in `autoContinueAtUsageLimit` setting (see [below](#compared-to-the-built-in-auto-continue)). This skill is a best-effort workaround built on scheduling tools (`CronCreate`/`CronDelete`/`PushNotification`) available in the harness, and may stop working if those tools change behavior. See [Known limitations](#known-limitations).

## Installation

macOS / Linux / Git Bash:

```bash
mkdir -p ~/.claude/skills/respawn && curl -fsSL https://raw.githubusercontent.com/ruben-sj/respawn-skill/main/skill/SKILL.md -o ~/.claude/skills/respawn/SKILL.md
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude\skills\respawn" | Out-Null
Invoke-WebRequest https://raw.githubusercontent.com/ruben-sj/respawn-skill/main/skill/SKILL.md -OutFile "$HOME\.claude\skills\respawn\SKILL.md"
```

Or manually: copy the contents of [`skill/SKILL.md`](skill/SKILL.md) into `~/.claude/skills/respawn/SKILL.md` (create the `respawn` folder if it doesn't exist).

**Updating:** rerun the install line; it overwrites the file with the latest version.

**Pinning a version:** to stay on a specific release, use a tag URL instead of `main`:

```bash
mkdir -p ~/.claude/skills/respawn && curl -fsSL https://raw.githubusercontent.com/ruben-sj/respawn-skill/v0.3.0/skill/SKILL.md -o ~/.claude/skills/respawn/SKILL.md
```

**Requires `CronCreate`, `CronDelete`, and `PushNotification` tools in your harness.** If your Claude Code environment doesn't expose these, the skill is inert.

**Optional, for the v0.3 usage features:** the live-usage features (reset time read automatically, chaining, weekly-limit handling, soft stop, usage log lines) need the `mcp__ccd_session_mgmt__get_usage` tool, which is provided by the Claude desktop app. Elsewhere, or if the tool reports usage as unavailable, the skill falls back to the v0.2 behavior automatically.

## Usage

Say something like "respawn", "set up respawn", "auto-resume", or "revive this session" **before** you hit the usage limit. It must be set up proactively: there's no way to invoke it reactively once a session is already blocked, since no new message can be sent in any session until the window reopens.

By default it'll ask you a couple of quick questions (how many windows to cover, how long the cancel grace should be, and, only when live usage readings are unavailable, whether you know the reset time). Answer conversationally, or skip straight past the questions with shorthand arguments:

| Argument | Meaning | Default |
|---|---|---|
| `/respawn 3` | Auto-resume through 3 consecutive 5-hour cutoffs, not just one | `1` |
| `/respawn 0`, `until-cancelled` or `inf` | Keep going indefinitely until you cancel | none |
| `/respawn 22:15` | You already know the reset time (24h, local): schedules a precise check; overrides a reset time read from live usage | read from usage if available, otherwise asks |
| `/respawn cancel=10` | 10-minute cancel window instead of 5 | `5` |
| `/respawn nocancel` | Resume immediately on detection, no cancel window, just a heads-up after | none |
| `/respawn stop=70` | Soft stop: pause at 70 % of the 5-hour limit instead of 85 % (needs live usage) | `85` |
| `/respawn nostop` | Disable the soft stop | none |

All combinable and order-independent, e.g. `/respawn 3 22:15 cancel=10 stop=80`.

## What's new in v0.3

- **Reset time read automatically.** When the desktop app's usage tool is available, respawn reads the 5-hour reset time itself, so you no longer need to know it.
- **Safer timing.** Timed checks fire a few minutes after the reset, never on minute :00 or :30 (one-shots on those minutes can fire up to 90 seconds early).
- **Backstop and chaining.** A recurring 30-minute backstop runs alongside each timed check, in case a one-shot that fires while the account is still blocked does not survive. A timed check that finds no cutoff schedules the next one at the new reset time instead of falling back to blind polling.
- **Weekly limit.** If a weekly window is nearly used up, respawn waits for the weekly reset instead and tells you so.
- **Soft stop (`stop=N`, default 85).** Respawn can pause itself before the wall: at natural checkpoints it reads usage, avoids starting big fan-outs from N - 15 %, and at N % finishes the current step, writes a short state note, schedules the resume for after the reset and ends its turn. If you are already close to the stop level when you arm it, it asks first. The percent is account-wide (other sessions and scheduled tasks share it) and one big step can overshoot, so a value close to 100 behaves almost like plain respawn.
- **Idle stand-down.** If the session has been idle for several checks with nothing running in the background, respawn deletes its jobs and says so, instead of polling until the 7-day expiry.
- **Better silent-cutoff detection, safer re-arm.** Respawn ignores its own messages when looking for a turn that stopped mid-work, and arms the next window before resuming the work.
- **Usage log lines** in the conversation for calibration, and **updated limitations** confirmed from the `CronCreate` tool documentation.

Everything above needs live usage readings; without them respawn behaves like v0.2, apart from the off-minute timing margin, which applies to every timed job. See [CHANGELOG.md](CHANGELOG.md) for the full version history.

## Compared to the built-in auto-continue

Claude Code v2.1.234 and later include a built-in setting, `autoContinueAtUsageLimit`, that continues a session after a usage limit. It exists, it is first-party, and it may well be all you need. Respawn is an independent skill that adds a few things on top: a configurable cancel window with a push notification before resuming, coverage of several consecutive windows, and a soft stop at a usage threshold. In the author's own use in the Claude desktop app, respawn also turned out more reliable than the built-in option, but that is one setup and not a general claim. Try the built-in setting first if it fits your workflow.

## How it works

1. On invocation, respawn tries to read live usage. With a reading, it schedules a precise one-time check a few minutes after the 5-hour reset, plus a recurring 30-minute backstop. Without one, it uses the reset time you give (one-time check, 15-minute recheck, then polling) or a plain recurring 30-minute poll.
2. While the account is still blocked, a firing job's turn is rejected before it ever runs (confirmed by repeated use), so a firing that does run is itself evidence the window is open.
3. Once a firing detects an unhandled rate-limit cutoff, it sends a push notification and, unless `cancel_window` is `0`, waits out the cancel grace period via a follow-up one-time job before resuming the original interrupted work.
4. If `windows` isn't exhausted, the cycle re-arms for the next cutoff instead of stopping. If a timed check finds no cutoff, it chains to the next reset instead.

All state (window count, cancel window, stop level, chain step) travels inside the scheduled prompts. No files are written.

Full operational detail lives in [`skill/SKILL.md`](skill/SKILL.md), the prompt Claude actually follows.

## Known limitations

Confirmed by the `CronCreate` tool documentation:

- Jobs are session-only: the app/session must stay open for the entire waiting period, and the jobs vanish if the session ends or the app closes.
- Recurring jobs auto-expire after 7 days, so a wait that long (for example a weekly limit) may outlive the backstop.
- Jobs fire only while the session is idle, which can delay or skip the time-sensitive cancel-window deadline.
- Recurring jobs can fire late, by up to half their period (at most 30 minutes). One-shots scheduled on :00 or :30 can fire up to 90 seconds early, which is why respawn schedules off-minute.

Still unverified:

- Token cost of rejected attempts while the window is closed.
- Whether a one-shot that fires while the account is still blocked survives (the reason for the backstop).
- How precisely the reported reset time matches the moment the window actually reopens.

## Contributing

Issues and PRs are welcome but may go unanswered for a while.

## License

MIT. See [LICENSE](LICENSE).
