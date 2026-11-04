# respawn-skill

> **Fixes "Rate limit exceeded" overnight cutoffs in Claude Code** by auto-resuming the session once the 5-hour usage window reopens.

A community-made [Claude Code](https://claude.com/claude-code) skill that auto-resumes a session after it gets blocked by Claude's usage limit. It waits for the window to reopen, notifies you, and continues the interrupted work unless you cancel within a configurable grace window.

**Field-tested (v0.2 core):** multiple overnight runs, multiple sessions running it in parallel, multiple consecutive 5-hour windows in a single run. The core mechanism (a scheduled job surviving repeated rate-limit rejections and firing correctly once the window reopens) has held up in real use. The v0.3 additions (live usage readings, backstop, soft stop) and the v0.4 additions (plugin, usage hook) are newer and less field-tested. **Not an official Anthropic feature:** auto-resume after a rate limit was requested in GitHub issues `anthropics/claude-code` #26775 and #36320, and Claude Code v2.1.234 and later has a built-in `autoContinueAtUsageLimit` setting (see [below](#compared-to-the-built-in-auto-continue)). This skill is a best-effort workaround built on scheduling tools (`CronCreate`/`CronDelete`/`PushNotification`) available in the harness, and may stop working if those tools change behavior. See [Known limitations](#known-limitations).

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

**As a plugin (v0.4, optional):** the repo is also a Claude Code plugin and marketplace. This installs the same skill plus the optional usage hook (see [below](#optional-usage-hook-terminal-cli)):

```
/plugin marketplace add ruben-sj/respawn-skill
/plugin install respawn@respawn-skill
```

From a shell, recent Claude Code builds also offer a one-step form: `claude plugin install respawn --marketplace ruben-sj/respawn-skill` (check `claude plugin install --help` for the `--marketplace` option).

If you installed the skill by hand earlier, delete `~/.claude/skills/respawn` first so the skill is not defined twice. The curl install above keeps working: the skill stays at `skill/SKILL.md`, and the plugin points at that same file.

**Requires `CronCreate`, `CronDelete`, and `PushNotification` tools in your harness.** If your Claude Code environment doesn't expose these, the skill is inert.

**Optional, for the v0.3 usage features:** the live-usage features (reset time read automatically, backstop, weekly-limit handling, soft stop, usage log lines) need the `mcp__ccd_session_mgmt__get_usage` tool, which is provided by the Claude desktop app. Elsewhere, or if the tool reports usage as unavailable, the skill falls back to the v0.2 behavior automatically.

## Usage

Say something like "respawn", "set up respawn", "auto-resume", or "revive this session" **before** you hit the usage limit. It must be set up proactively: there's no way to invoke it reactively once a session is already blocked, since no new message can be sent in any session until the window reopens.

By default it'll ask you a couple of quick questions (how many windows to cover, how long the cancel grace should be, and, only when live usage readings are unavailable, whether you know the reset time). Answer conversationally, or skip straight past the questions with shorthand arguments:

| Argument | Meaning | Default |
|---|---|---|
| `/respawn 3` | Auto-resume through 3 consecutive 5-hour cutoffs, not just one | `1` |
| `/respawn 0`, `until-cancelled` or `inf` | Keep going indefinitely until you cancel | none |
| `/respawn 22:15` | You already know the reset time (24h, local): schedules a precise check. With live usage it is used unless it is more than 30 min off the reading (then the earlier time wins and you are told) | read from usage if available, otherwise asks |
| `/respawn cancel=10` | 10-minute cancel window instead of 5 | `5` |
| `/respawn nocancel` | Resume immediately on detection, no cancel window, just a heads-up after | none |
| `/respawn stop=70` | Soft stop: pause at 70 % of the 5-hour limit instead of 85 % (needs live usage) | `85` |
| `/respawn nostop` | Disable the soft stop | none |

All combinable and order-independent, e.g. `/respawn 3 22:15 cancel=10 stop=80`.

## What's new in v0.4

- **No more runaway checks (0.4.1).** A run that never meets a cutoff now ends by itself: after roughly 5 to 10 hours with no cutoff and no activity in the session, it deletes its jobs and sends a push notification (for `windows=0` after about 24 hours instead). In an active session the timed check rolls over to the next reset instead of leaving a poll behind, and the 30-minute backstop only runs once usage reaches the warning level (70 % by default). Checks that find nothing write one dated `respawn log:` line and nothing else. Trade-off: if usage jumps to the limit with no checkpoint reading in between, there is no backstop yet and only the timed check is left (see [Known limitations](#known-limitations)).
- **Plugin packaging.** `/plugin marketplace add ruben-sj/respawn-skill`, then install `respawn`. The skill file stays at `skill/SKILL.md`.
- **Optional usage hook and statusline tap** for the terminal CLI (see above), so usage warnings do not depend on the model remembering to check.
- **Armed marker.** In the terminal, with the hook layer installed, respawn writes `~/.claude/respawn-armed/<session id>` once at invocation, so the hook knows a run is armed. Only the user-present steps touch it (invocation, and a disarm that overwrites it with `stop=off`); the unattended resume and re-arm never write files. In the desktop app (usage mode) and without the hook layer respawn writes no files, as before.
- **Soft stop in the terminal.** With the hook layer installed, the soft stop (default 85 %) also works in the terminal CLI, where the desktop usage tool does not exist: hook notes serve as the usage readings.

## What's new in v0.3

- **Reset time read automatically.** When the desktop app's usage tool is available, respawn reads the 5-hour reset time itself, so you no longer need to know it.
- **Safer timing.** Timed checks fire a few minutes after the reset, never on minute :00 or :30 (one-shots on those minutes can fire up to 90 seconds early).
- **Backstop.** A recurring 30-minute backstop runs alongside the timed check, in case a one-shot that fires while the account is still blocked does not survive. Since 0.4.1 it only runs once usage nears the limit.
- **Weekly limit.** If a weekly window is nearly used up, respawn waits for the weekly reset instead and tells you so.
- **Soft stop (`stop=N`, default 85).** Respawn can pause itself before the wall: at natural checkpoints it reads usage, avoids starting big fan-outs from N - 15 %, and at N % finishes the current step, writes a short state note, schedules the resume for after the reset and ends its turn. A pause uses up one of the covered windows. If you are already close to the stop level when you arm it, it asks first. The percent is account-wide (other sessions and scheduled tasks share it) and one big step can overshoot, so a value close to 100 behaves almost like plain respawn.
- **Fixed job prompts.** Every scheduled job uses one verbatim template, so the rules do not drift from job to job over a long run.
- **Better silent-cutoff detection, safer re-arm** (also without live usage). Respawn ignores its own messages when looking for a turn that stopped mid-work, and arms the next window before resuming the work.
- **Usage log lines** in the conversation for calibration, and **updated limitations** confirmed from the `CronCreate` tool documentation.

Without live usage readings respawn keeps the v0.2 flow, plus the off-minute timing margin, silent-cutoff detection, re-arming before resuming, and re-invocation replacing an old run. See [CHANGELOG.md](CHANGELOG.md) for the full version history.

## Optional: usage hook (terminal CLI)

New in v0.4. Without this, usage awareness depends on the model remembering to read usage at its checkpoints, and the terminal CLI has no usage tool at all. This optional layer adds a hook that does the watching, using the usage numbers the terminal CLI passes to the status line command. Two small Node scripts (Node.js is required for this layer), no dependencies. Everything in respawn still works without them, and without them respawn writes no files.

**Honest caveat:** in a 5-minute test the Claude desktop app's Code tab did not run the status line command, so this layer most likely works only in the terminal `claude` CLI. In the desktop app the skill's own `get_usage` checkpoints stay the mechanism. The scripts are covered by unit tests on fixture data; they have not yet been seen working in a live terminal session.

How it fits together:

1. **Usage tap** (`scripts/respawn-tap.js`). A wrapper for your `statusLine` command. It saves `{ts, session_id, five_hour, seven_day}` to `~/.claude/respawn-usage/<session id>.json` (one file per session) and passes the same input on to your existing status line command, forwarding its output. With no command it prints nothing. The existing command gets 10 seconds; after that it is stopped and whatever it had printed is forwarded. The `respawn-usage` folder is also how the skill learns that the hook layer is installed.
2. **Usage hook** (`hooks/hooks.json`, shipped by the plugin). A `PostToolUse` hook that does nothing unless a respawn run is armed in the current session. For a classic run (no desktop usage tool) with the hook layer present, respawn writes `~/.claude/respawn-armed/<session id>` (one line, `stop=85`) once at invocation. Disarming overwrites it with `stop=off`, which the hook treats as inert and removes itself. The session's own marker has no expiry; the hook removes other sessions' leftover files older than 30 days. When armed and this session's cache is fresh (under 10 minutes old), the hook compares the rounded 5-hour percent to your soft-stop level and adds one short note to the context when usage reaches `stop - 15` (not for `stop` of 15 or less) and again when it reaches `stop`, each once per crossing. A weekly window at 98 % counts as the stop level, and then the note names the weekly reset as the target, as in the skill. A stale or missing cache means silence. The notes state facts and end with a line saying they only apply if a respawn run is armed in the session; the skill treats such a note as a checkpoint reading, and ignores it when no run is armed.

With the layer installed, a plain `/respawn` in the terminal gets the soft stop (default 85 %) too, driven by those notes. The hook starts a short Node process after every tool call; it exits within milliseconds when nothing is armed.

Setup:

1. Install the plugin (above) for the hook.
2. Copy the tap somewhere stable (the plugin folder changes with each version), pinned to the release you installed:

   ```bash
   mkdir -p ~/.claude/respawn && curl -fsSL https://raw.githubusercontent.com/ruben-sj/respawn-skill/v0.4.0/scripts/respawn-tap.js -o ~/.claude/respawn/respawn-tap.js
   ```

3. Change the `statusLine` entry in your `~/.claude/settings.json` by hand. Plugins cannot set `statusLine`, so this step is always manual. Pass your existing status line command as **one quoted string**:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node ~/.claude/respawn/respawn-tap.js \"bash ~/.claude/statusline.sh\""
     }
   }
   ```

   Without an existing status line, use just `node ~/.claude/respawn/respawn-tap.js`.

   The inner command runs through the platform shell (cmd.exe on Windows, sh elsewhere), which does not expand `~` inside the quoted string on Windows. On Windows write full paths with forward slashes, for example:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node C:/Users/<you>/.claude/respawn/respawn-tap.js \"powershell -NoProfile -File C:/Users/<you>/.claude/statusline.ps1\""
     }
   }
   ```

Limits: `rate_limits` appears in the status line input only for subscription plans (not API-key use) and only after the first API response in a session, so the cache can be empty early on. Respawn checks for the cache only when it arms, so arm it after the session's first reply; if you arm it as the very first message, it reports that no hook layer was found, and invoking it again later enables the soft stop. The cache holds only the session id, a timestamp and usage percentages, and files older than 8 days are pruned. The hook skips tool calls made inside subagents. If the tap itself is stopped, it stops the inner command with it. On macOS and Linux the inner command runs without a controlling terminal, so tricks like `stty size </dev/tty` for width detection will not work there; read `COLUMNS` or the JSON input instead.

## Compared to the built-in auto-continue

Claude Code has first-party auto-continue, and it may well be all you need. Per the official docs ([interactive mode](https://code.claude.com/docs/en/interactive-mode.md), [settings](https://code.claude.com/docs/en/settings-reference#autocontinueatusagelimit), [errors](https://code.claude.com/docs/en/errors.md)):

- **Terminal CLI (v2.1.234 and later):** `autoContinueAtUsageLimit`, on by default for claude.ai subscriptions ("Continue automatically at usage limit" in `/config`). It waits in the open session, shows the time it will continue, can be cancelled with Esc, and stops after three automatic continuations in a row. It does not start by itself in Remote Control sessions or for a reset more than 24 hours away.
- **Desktop app:** a separate "Auto-continue when limits reset" checkbox on the session-limit card. Not on the weekly-limit card.

What respawn adds: a timed cancel window with a push notification before it resumes, a configurable number of covered windows, a soft stop that pauses before the wall at a clean point, weekly-limit handling, and coverage where the built-in wait does not start (Remote Control, long waits). In the author's own desktop use respawn was also more reliable than the built-in option, but that is one setup and not a general claim. If you use both, the first to resume wins: respawn treats a cutoff that was already resumed as handled.

## How it works

1. On invocation, respawn tries to read live usage. With a reading, it schedules a precise one-time check a few minutes after the 5-hour reset, plus a recurring 30-minute backstop once usage reaches the backstop level (`stop - 15`, or 70 % with `nostop`). A timed check that finds no cutoff schedules the next one at the following reset. Without a reading, it uses the reset time you give (one-time check, 15-minute recheck, then polling) or a plain recurring 30-minute poll.
2. While the account is still blocked, a firing job's turn is rejected before it ever runs (confirmed by repeated use), so a firing that does run is itself evidence the window is open.
3. A run that is no longer needed ends by itself: after roughly 5 to 10 hours with no cutoff and no activity in the session, a check deletes all of respawn's jobs and sends a push notification. Runs armed with `windows=0` wait about 24 hours instead. Checks that find nothing write a single `respawn log:` line. A lead session that waits many hours for other sessions can also be disarmed this way; arm it with `windows=0` (24-hour threshold) if that matters.
4. Once a firing detects an unhandled rate-limit cutoff, it sends a push notification and, unless `cancel_window` is `0`, waits out the cancel grace period via a follow-up one-time job before resuming the original interrupted work.
5. If `windows` isn't exhausted, the cycle re-arms for the next cutoff instead of stopping.

All state (window count, cancel window, stop level, job kind) travels inside the scheduled prompts. The core flow writes no files. Only if you install the optional usage hook layer (see above) are a few small things written: the statusline tap's per-session usage cache, the armed marker (terminal classic runs only, written once at invocation), and tiny flag files from the hook that remember which usage notes were already sent.

Full operational detail lives in [`skill/SKILL.md`](skill/SKILL.md), the prompt Claude actually follows.

## Known limitations

Confirmed by the `CronCreate` tool documentation:

- Jobs are session-only: the app/session must stay open for the entire waiting period, and the jobs vanish if the session ends or the app closes.
- Recurring jobs auto-expire after 7 days, so a wait that long (for example a weekly limit) may outlive the backstop.
- Jobs fire only while the session is idle, which can delay or skip the time-sensitive cancel-window deadline.
- Every firing is a full model turn that sends the whole conversation again, so it draws usage even when it finds nothing. This is why respawn keeps checks rare and disarms idle runs.
- Recurring jobs can fire late, by up to half their period (at most 30 minutes). One-shots scheduled on :00 or :30 can fire up to 90 seconds early, which is why respawn schedules off-minute.

Still unverified:

- Token cost of rejected attempts while the window is closed.
- Whether a one-shot that fires while the account is still blocked survives (the reason for the backstop). Since 0.4.1 the backstop only starts at the warning level, so if usage jumps to the limit with no checkpoint reading in between (for example another session spending the shared quota), only the one-shot is left.
- How precisely the reported reset time matches the moment the window actually reopens.

## Roadmap

- **v0.3.0:** released once it has survived a real usage-limit cutoff.
- **v0.4.0 (in development):** plugin packaging and the optional usage hook. Next step is a live terminal test, starting with checking that the session id is the same in the status line input, the hook input and the skill.
- **Later:** a first-party way to read usage from hooks or from the desktop app, if one appears; 1.0.0 once the behavior has settled.

## Contributing

Issues and PRs are welcome but may go unanswered for a while.

## License

MIT. See [LICENSE](LICENSE).
