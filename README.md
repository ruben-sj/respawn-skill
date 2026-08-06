# respawn-skill

> **⚠️ Beta — freshly published, not yet battle-tested.** This repo was just cut from a working draft and hasn't seen real-world use in this form yet. Expect rough edges; give it a week or two of actual use before trusting it for anything important. This notice will be removed once it's held up in practice.

An experimental, community-made [Claude Code](https://claude.com/claude-code) skill that tries to auto-resume a session after it gets blocked by Claude's usage limit — it waits for the window to reopen, notifies you, and continues the interrupted work unless you cancel within 5 minutes.

**This is not an official Anthropic feature.** Auto-resume after a rate limit is an open, unimplemented feature request (see GitHub issues `anthropics/claude-code` #26775 and #36320). This skill is a best-effort workaround built on scheduling tools (`CronCreate`/`CronDelete`/`PushNotification`) available in the harness — it has not been extensively verified in production and may stop working if those tools change behavior.

## Installation

Copy the contents of [`skill/SKILL.md`](skill/SKILL.md) into `~/.claude/skills/respawn/SKILL.md` (create the `respawn` folder if it doesn't exist).

**Requires `CronCreate`, `CronDelete`, and `PushNotification` tools in your harness.** If your Claude Code environment doesn't expose these, the skill is inert — it has nothing to run.

## Usage

Say something like "respawn", "set up respawn", "auto-resume", or "revive this session" **before** you hit the usage limit — it must be set up proactively; there's no way to invoke it reactively once a session is already blocked, since no new message can be sent in any session until the window reopens.

## Known limitations

- Requires the app/session to stay open for the entire waiting period — the underlying jobs are session-only (in-memory) and vanish if the session ends or the app closes.
- Jobs only fire while the session is idle, which can delay or skip the time-sensitive 5-minute follow-up.
- The recurring polling job auto-expires after 7 days; if the usage window doesn't reopen within a week, polling silently stops.
- It's unverified whether the polling mechanism actually survives repeated rate-limit rejections without the harness stopping it — this is the skill's core assumption and hasn't been independently confirmed.
- Token cost of rejected attempts while the window is closed is unverified.
- Treat the first real trigger from an actual rate-limit cutoff as a live test, and watch it to confirm it behaves as expected.

See [`skill/SKILL.md`](skill/SKILL.md) for the full operational detail.

## Contributing

This is an experimental, unsupported side project. Issues and PRs are welcome but may go unanswered for a while.

## License

MIT — see [LICENSE](LICENSE).
