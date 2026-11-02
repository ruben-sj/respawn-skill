#!/usr/bin/env node
// respawn usage tap: a statusLine wrapper. Reads the statusline JSON from
// stdin, saves the usage numbers for the respawn usage hook, then hands the
// same input to the user's own statusline command (if any) and prints its
// output. It never fails the statusline: every error is swallowed.
//
// Usage: node respawn-tap.js [your existing statusline command ...]
// Env:   RESPAWN_CLAUDE_DIR replaces ~/.claude as the cache folder (used by the tests).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function cachePath() {
  const dir = process.env.RESPAWN_CLAUDE_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'respawn-usage.json');
}

function pick(win) {
  if (!win || typeof win !== 'object') return null;
  const pct = Number(win.used_percentage);
  if (!Number.isFinite(pct)) return null;
  const reset = Number(win.resets_at);
  return { used_percentage: pct, resets_at: Number.isFinite(reset) ? reset : null };
}

// Returns the cache record for a statusline payload, or null when the payload
// carries no five-hour reading (API-key users, or before the first response).
function buildRecord(input, nowMs) {
  const limits = input && input.rate_limits;
  if (!limits) return null;
  const five = pick(limits.five_hour);
  if (!five) return null;
  return {
    ts: Math.floor(nowMs / 1000),
    session_id: typeof input.session_id === 'string' ? input.session_id : null,
    five_hour: five,
    seven_day: pick(limits.seven_day),
  };
}

// Write to a temp file in the same folder, then rename over the target, so a
// reader never sees a half-written file. UTF-8, no BOM.
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8' });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows can refuse to replace a file that a reader has open.
    try { fs.writeFileSync(file, text, { encoding: 'utf8' }); } finally { try { fs.unlinkSync(tmp); } catch (_) { /* gone */ } }
  }
}

function tap(raw, file, nowMs) {
  let input;
  try { input = JSON.parse(raw); } catch (_) { return false; }
  const record = buildRecord(input, nowMs);
  if (!record) return false;
  try { writeAtomic(file, JSON.stringify(record) + '\n'); } catch (_) { return false; }
  return true;
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
  const raw = (await readStdin()).replace(/^﻿/, '');
  tap(raw, cachePath(), Date.now());

  const command = process.argv.slice(2).join(' ').trim();
  if (!command) return;
  const res = spawnSync(command, { input: raw, shell: true, encoding: 'utf8', timeout: 10000 });
  if (res.stdout) process.stdout.write(res.stdout);
}

if (require.main === module) {
  main().catch(() => {});
}

module.exports = { buildRecord, tap };
