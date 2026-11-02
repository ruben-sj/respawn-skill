#!/usr/bin/env node
// respawn usage hook: a PostToolUse hook. Does nothing unless a respawn run is
// armed in this session (marker file ~/.claude/respawn-armed/<session_id>,
// written by the respawn skill). When armed and the usage cache written by
// respawn-tap.js is fresh, it adds one short plain-text note to the model's
// context each time usage crosses the warning level or the stop level.
//
// Env: RESPAWN_CLAUDE_DIR replaces ~/.claude (used by the tests).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_MAX_AGE_S = 10 * 60; // older readings are ignored
const MARKER_MAX_AGE_S = 24 * 60 * 60; // an armed marker not refreshed for this long is stale
const WARN_MARGIN = 15; // warning tier starts at stop - 15, as in the skill
const WEEKLY_STOP = 98; // weekly percent that counts as the stop tier, as in the skill

function claudeDir() {
  return process.env.RESPAWN_CLAUDE_DIR || path.join(os.homedir(), '.claude');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; }
}

// The marker holds one line, "stop=<1-100|off>". Returns the stop level, or
// null when the run has no soft stop (nothing for the hook to compare against).
function parseStop(text) {
  const m = /stop\s*=\s*(\d{1,3}|off)/i.exec(text);
  if (!m || m[1].toLowerCase() === 'off') return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 100 ? n : null;
}

function localTime(epochS) {
  const d = new Date(epochS * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// A window whose reset time has passed describes the previous window.
function live(win, nowS) {
  if (!win || !Number.isFinite(win.used_percentage)) return null;
  if (Number.isFinite(win.resets_at) && win.resets_at <= nowS) return null;
  return win;
}

// Returns the note to inject, or null. Updates the per-session state file so
// each tier is announced once per crossing.
function evaluate({ sessionId, dir, nowS }) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;

  const armedDir = path.join(dir, 'respawn-armed');
  const markerFile = path.join(armedDir, sessionId);
  let st;
  try { st = fs.statSync(markerFile); } catch (_) { return null; }
  if (!st.isFile() || nowS - st.mtimeMs / 1000 > MARKER_MAX_AGE_S) return null;

  const stop = parseStop(fs.readFileSync(markerFile, 'utf8'));
  if (stop === null) return null;

  const cache = readJson(path.join(dir, 'respawn-usage.json'));
  if (!cache || cache.session_id !== sessionId) return null;
  if (!Number.isFinite(cache.ts) || nowS - cache.ts > CACHE_MAX_AGE_S || cache.ts - nowS > 60) return null;

  const five = live(cache.five_hour, nowS);
  const week = live(cache.seven_day, nowS);
  const weeklyHit = week !== null && week.used_percentage >= WEEKLY_STOP;
  const warnAt = Math.max(stop - WARN_MARGIN, 0);
  let tier = 0;
  if (five && five.used_percentage >= warnAt) tier = 1;
  if ((five && five.used_percentage >= stop) || weeklyHit) tier = 2;

  // State is tied to the marker's mtime, so re-arming starts a fresh count.
  const stateFile = path.join(armedDir, `${sessionId}.state`);
  const state = readJson(stateFile);
  const sameArm = state && state.marker_mtime_ms === st.mtimeMs;
  const last = sameArm && Number.isFinite(state.tier) ? state.tier : 0;
  if (!sameArm || tier !== last) {
    try { fs.writeFileSync(stateFile, JSON.stringify({ marker_mtime_ms: st.mtimeMs, tier }) + '\n', 'utf8'); } catch (_) { /* best effort */ }
  }
  if (tier <= last) return null;

  const reset = five && Number.isFinite(five.resets_at) ? ` and resets at ${localTime(five.resets_at)} local time` : '';
  const head = 'Usage note from the respawn hook (statusline reading from the last few minutes):';
  if (tier === 2 && weeklyHit && !(five && five.used_percentage >= stop)) {
    return `${head} the weekly usage window is at ${Math.round(week.used_percentage)}%, which respawn treats as the stop tier.`;
  }
  const pct = Math.round(five.used_percentage);
  if (tier === 2) {
    return `${head} the 5-hour window is at ${pct}%${reset}. The respawn soft-stop level for this session is ${stop}%, so usage is at the stop tier.`;
  }
  return `${head} the 5-hour window is at ${pct}%${reset}. The respawn soft-stop level for this session is ${stop}%, so usage is in the warning range that starts at ${warnAt}%.`;
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function main() {
  let input = null;
  try { input = JSON.parse((await readStdin()).replace(/^﻿/, '')); } catch (_) { return; }
  // Subagents share the parent's session id; stay out of their tool calls so
  // the note is not spent where the main agent cannot see it.
  if (input && input.agent_id) return;
  const note = evaluate({ sessionId: input && input.session_id, dir: claudeDir(), nowS: Date.now() / 1000 });
  if (note) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note } }) + '\n');
  }
}

if (require.main === module) {
  main().catch(() => {});
}

module.exports = { evaluate, parseStop };
