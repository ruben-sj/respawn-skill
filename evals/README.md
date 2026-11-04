# respawn eval suite

Behavioral tests for the decisions a scheduled respawn job makes when it fires, run with `claude plugin eval`. They cover the job template in `skill/SKILL.md` ("Job prompts") and the sections "On each check firing", "Backstop and idle expiry", "Soft stop" and "On the cancel-window follow-up", without waiting for a real cutoff.

## How a case works

Each case is one firing. `prompt.md` holds:
1. A short sandbox header: the local date and time, what `CronList` and `mcp__ccd_session_mgmt__get_usage` would return, and an answer format. The scheduling tools do not exist in an eval sandbox, so the model writes each call it would make as `CALL <ToolName> <JSON>` and then the exact text its turn ends with. The Skill tool is real, so step 4 can load the skill.
2. A fixture conversation as text, with local times and `respawn log:` lines.
3. The job prompt: a `respawn-state:` line plus the template body from `skill/SKILL.md`, byte for byte.

The graders in `graders/` are mostly free `regex` checks on that answer (the log line, cron expressions, state lines, which jobs are created or deleted, no chat sentence on an empty firing). One case uses an `llm` judge, and two check that the skill was loaded (`tool_used: Skill`).

| Group | Cases |
| :- | :- |
| `cutoff/` | usage-limit error; trailing tool result 30+ min old; user interruption (not a cutoff); app message asking for visible output (looked past) |
| `idle/` | disarm after 5.5 h of poll log lines; `windows=0` uses 24 h; disarm before roll-over in usage mode; no disarm when a cutoff is unhandled, a follow-up is pending, or a soft-stop note waits |
| `rollover/` | below the backstop level (delete it, next calendar day); at it with `stop=70` (create the backstop first); `stop=off` uses 70 and a reset that would land on :30; skipped when a later timed job is listed |
| `softstop/` | backstop firing during a pause writes only `paused` |
| `followup/` | lost follow-up: the backstop ends the run and resumes the work |
| `classic/` | classic timed firing schedules the 15-minute recheck |

Tags: `smoke` (3 cheap regex-only cases), `empty-firing` (cases whose answer must be exactly one log line and nothing else), plus one tag per group.

## Running

Every run is a real model call on your account. From the plugin root:

```bash
claude plugin eval . --tag smoke --runs 1 --ablation none --no-publish
```

Full suite (17 cases, 3 runs each, about 51 agent runs plus 3 judge calls per run of the one `llm` grader):

```bash
claude plugin eval . --ablation none --no-publish
```

`--ablation none` is recommended: the job prompt carries the template itself, so a no-plugin baseline differs only where step 4 loads the skill, and the baseline arm would double the cost for little signal. Add `--model <model>` to pin the model under test, `--case <glob>` for one case, and `--trust-plugin` in a non-interactive shell.

## Keeping cases in sync with SKILL.md

When the job template in `skill/SKILL.md` changes, run:

```bash
node evals/sync-template.js
```

It rewrites the template body in every `prompt.md` and keeps each case's state line. `node --test test/*.test.js` fails while any case is stale, and also checks that the regex graders accept a known-good answer and reject known-bad ones for a few cases. Fixture timelines and expected values (cron times, IDs) are hand-made, so a change to the rules themselves still means reviewing the affected cases.
