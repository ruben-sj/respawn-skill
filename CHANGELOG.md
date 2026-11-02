# Changelog

## Unreleased

- Cutoff detection also treats a turn that stopped mid-work (last message is a tool result with no follow-up, 30+ min gap) as a cutoff, since the app can hit the limit without showing an error.

## v0.2.0 - 2026-08-10

Field-tested through multiple overnight, multi-session, multi-window runs. Added:
- `windows`: auto-resume through N consecutive cutoffs instead of just one.
- Known-reset-time scheduling: skip blind 30-min polling when the user (or an auto-computed next window) knows the reset time; one-time check + 15-min safety recheck instead.
- `cancel_window`: configurable cancel-grace length, including `0` for immediate resume with no cancel window.
- Shorthand CLI-style arguments (`/respawn 3 22:15 cancel=10`) alongside the conversational flow.

## v0.1.0 - 2026-08-05

Initial public release. Experimental; see README for known limitations.
