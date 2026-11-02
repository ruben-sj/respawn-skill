#!/usr/bin/env node
// respawn usage tap: a statusLine wrapper. Reads the statusline JSON from
// stdin, saves the usage numbers for the respawn usage hook, then hands the
// same input to the user's own statusline command (if any) and prints its
// output. It never fails the statusline: every error is swallowed.
//
// Usage: node respawn-tap.js "<your existing statusline command>"
// The inner command is one string and runs through the platform shell
// (cmd.exe on Windows, sh elsewhere). Extra arguments are joined with spaces.
//
// Env:   RESPAWN_CLAUDE_DIR       replaces ~/.claude (used by the tests)
//        RESPAWN_TAP_TIMEOUT_MS   limit for the inner command, default 10000
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CACHE_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

function claudeDir() {
  return process.env.RESPAWN_CLAUDE_DIR || path.join(os.homedir(), '.claude');
}

// Same rule as the hook, so both name the same file for a session.
function safeId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
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

// Best effort: drop per-session caches nobody has touched for 8 days.
function pruneOld(dir, nowMs) {
  try {
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f);
      try { if (nowMs - fs.statSync(file).mtimeMs > CACHE_MAX_AGE_MS) fs.unlinkSync(file); } catch (_) { /* skip */ }
    }
  } catch (_) { /* nothing to prune */ }
}

// Saves ~/.claude/respawn-usage/<session id>.json. The folder's existence is
// also how the respawn skill learns that the hook layer is installed.
function tap(raw, dir, nowMs) {
  let input;
  try { input = JSON.parse(raw); } catch (_) { return false; }
  const record = buildRecord(input, nowMs);
  const id = record && safeId(record.session_id);
  if (!id) return false;
  const cacheDir = path.join(dir, 'respawn-usage');
  try {
    writeAtomic(path.join(cacheDir, `${id}.json`), JSON.stringify(record) + '\n');
  } catch (_) { return false; }
  if (Math.random() < 0.02) pruneOld(cacheDir, nowMs);
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

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch (_) {
    try { child.kill('SIGKILL'); } catch (__) { /* already gone */ }
  }
}

// Runs the inner command with the statusline JSON on stdin. Resolves with
// whatever stdout arrived, also when the command hangs past the timeout.
function runInner(command, raw, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(out); } };
    let child;
    try {
      child = spawn(command, { shell: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (_) { resolve(''); return; }
    const timer = setTimeout(() => {
      killTree(child);
      try { child.stdout.destroy(); } catch (_) { /* closed */ }
      finish();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stdout.on('error', finish);
    child.on('error', finish);
    child.on('close', finish);
    child.stdin.on('error', () => { /* command exited before reading */ });
    child.stdin.end(raw);
  });
}

async function main() {
  const raw = (await readStdin()).replace(/^\uFEFF/, '');
  tap(raw, claudeDir(), Date.now());

  const command = process.argv.slice(2).join(' ').trim();
  if (!command) return;
  const timeoutMs = Number(process.env.RESPAWN_TAP_TIMEOUT_MS) > 0 ? Number(process.env.RESPAWN_TAP_TIMEOUT_MS) : 10000;
  const out = await runInner(command, raw, timeoutMs);
  if (out) await new Promise((resolve) => process.stdout.write(out, resolve));
}

if (require.main === module) {
  // Exit explicitly: a leftover grandchild must not keep the statusline waiting.
  main().catch(() => {}).then(() => process.exit(0));
}

module.exports = { buildRecord, tap, safeId, pruneOld };
