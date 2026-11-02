#!/usr/bin/env node
// respawn usage hook: a PostToolUse hook. Does nothing unless a respawn run is
// armed in this session (marker file ~/.claude/respawn-armed/<session_id>,
// written by the respawn skill). When armed and this session's usage cache
// (written by respawn-tap.js) is fresh, it adds one short plain-text note to
// the model's context each time usage crosses the warning level or the stop
// level, once per crossing.
//
// Env: RESPAWN_CLAUDE_DIR replaces ~/.claude (used by the tests).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_MAX_AGE_S = 10 * 60; // older readings are ignored
const MARKER_MAX_AGE_S = 8 * 24 * 60 * 60; // recurring cron jobs expire after 7 days
const WARN_MARGIN = 15; // warning tier starts at stop - 15, as in the skill
const WEEKLY_STOP = 98; // weekly percent that counts as the stop tier, as in the skill

function claudeDir() {
  return process.env.RESPAWN_CLAUDE_DIR || path.join(os.homedir(), '.claude');
}

// Same rule as the tap, so both name the same file for a session.
function safeId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return null; }
}

// Marker files are written by a model, so tolerate a UTF-8 BOM and UTF-16LE.
function decodeText(buf) {
  const utf16 = (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) || buf.includes(0);
  return buf.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
}

// The marker holds one line, "stop=<1-100|off>". Returns the stop level, or
// null when the run has no soft stop (or the text is not that line at all).
function parseStop(text) {
  const m = /^\s*stop\s*=\s*(\d{1,3}|off)\s*$/i.exec(text);
  if (!m || m[1].toLowerCase() === 'off') return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 100 ? n : null;
}

function two(n) { return String(n).padStart(2, '0'); }

// "HH:MM", or "YYYY-MM-DD HH:MM" when the date is not today (local time).
function localStamp(epochS, nowS) {
  const d = new Date(epochS * 1000);
  const today = new Date(nowS * 1000);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const same = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return same ? hm : `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm}`;
}

// A window whose reset time has passed describes the previous window.
function live(win, nowS) {
  if (!win || !Number.isFinite(win.used_percentage)) return null;
  if (Number.isFinite(win.resets_at) && win.resets_at <= nowS) return null;
  return { pct: Math.round(win.used_percentage), resets_at: Number.isFinite(win.resets_at) ? win.resets_at : null };
}

const TIER_NAMES = { 1: 'warn', 2: 'stop', 3: 'weekly' };

function flagFile(armedDir, id, mtimeMs, tier) {
  return path.join(armedDir, `${id}.${Math.round(mtimeMs)}.${TIER_NAMES[tier]}.flag`);
}

function listFlags(armedDir, id) {
  try { return fs.readdirSync(armedDir).filter((f) => f.startsWith(`${id}.`) && f.endsWith('.flag')); } catch (_) { return []; }
}

function removeQuietly(file) { try { fs.unlinkSync(file); } catch (_) { /* gone or busy */ } }

// Returns the note to inject, or null. Each tier is announced once per
// crossing: an exclusive-create flag file claims the announcement, so two
// tool calls finishing together cannot both speak.
function evaluate({ sessionId, dir, nowS }) {
  const id = safeId(sessionId);
  if (id === null) return null;

  const armedDir = path.join(dir, 'respawn-armed');
  if (!fs.existsSync(armedDir)) return null;
  const markerFile = path.join(armedDir, id);

  let st = null;
  try { st = fs.statSync(markerFile); } catch (_) { /* not armed */ }
  if (st && nowS - st.mtimeMs / 1000 > MARKER_MAX_AGE_S) {
    removeQuietly(markerFile);
    st = null;
  }
  if (!st || !st.isFile()) {
    for (const f of listFlags(armedDir, id)) removeQuietly(path.join(armedDir, f));
    return null;
  }

  let stop = null;
  try { stop = parseStop(decodeText(fs.readFileSync(markerFile))); } catch (_) { /* unreadable */ }
  if (stop === null) return null;

  // Flags from an earlier arming of this session belong to another marker mtime.
  const mine = `${id}.${Math.round(st.mtimeMs)}.`;
  for (const f of listFlags(armedDir, id)) if (!f.startsWith(mine)) removeQuietly(path.join(armedDir, f));

  const cache = readJson(path.join(dir, 'respawn-usage', `${id}.json`));
  if (!cache || cache.session_id !== sessionId) return null;
  if (!Number.isFinite(cache.ts) || nowS - cache.ts > CACHE_MAX_AGE_S || cache.ts - nowS > 60) return null;

  const five = live(cache.five_hour, nowS);
  const week = live(cache.seven_day, nowS);
  const weeklyHit = week !== null && week.pct >= WEEKLY_STOP;
  const warnAt = stop - WARN_MARGIN; // no warning tier when this is 0 or less
  let tier = 0;
  if (five && warnAt > 0 && five.pct >= warnAt) tier = 1;
  if (five && five.pct >= stop) tier = 2;
  if (weeklyHit) tier = 3; // the weekly reset wins when both are hit

  // Usage fell back below a tier: forget it so the next crossing speaks again.
  for (let t = tier + 1; t <= 3; t++) removeQuietly(flagFile(armedDir, id, st.mtimeMs, t));
  if (tier === 0) return null;

  // Claim this tier; lower tiers are marked as passed without speaking.
  let claimed = false;
  for (let t = 1; t <= tier; t++) {
    try {
      fs.closeSync(fs.openSync(flagFile(armedDir, id, st.mtimeMs, t), 'wx'));
      if (t === tier) claimed = true;
    } catch (_) { /* already claimed, or not writable */ }
  }
  if (!claimed) return null;

  const head = 'Usage note from the respawn hook (statusline reading from the last few minutes):';
  const tail = ` If no respawn-state job exists in this session, respawn is not armed: delete the marker file ${markerFile} and ignore this note.`;
  if (tier === 3) {
    const when = week.resets_at !== null ? `It resets at ${localStamp(week.resets_at, nowS)} local time.` : 'No reset time was given.';
    const fiveText = five ? ` The 5-hour window is at ${five.pct}%.` : '';
    return `${head} the weekly usage window is at ${week.pct}%, which respawn treats as the stop tier. This is the weekly reset, not the 5-hour one: ${when} The weekly reset is the target time for the pause.${fiveText}${tail}`;
  }
  const reset = five.resets_at !== null ? ` and resets at ${localStamp(five.resets_at, nowS)} local time` : '';
  if (tier === 2) {
    return `${head} the 5-hour window is at ${five.pct}%${reset}. The respawn soft-stop level for this session is ${stop}%, so usage is at the stop tier.${tail}`;
  }
  return `${head} the 5-hour window is at ${five.pct}%${reset}. The respawn soft-stop level for this session is ${stop}%, so usage is in the warning range that starts at ${warnAt}%.${tail}`;
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
  try { input = JSON.parse((await readStdin()).replace(/^\uFEFF/, '')); } catch (_) { return; }
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

module.exports = { evaluate, parseStop, decodeText, safeId };
