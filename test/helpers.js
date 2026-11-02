'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION = 'sess-aaaa-1111';
const NOW_S = 1_800_000_000; // fixed "now" for the pure-function tests

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'respawn-test-'));
}

function writeCache(dir, over = {}) {
  const rec = {
    ts: NOW_S - 30,
    session_id: SESSION,
    five_hour: { used_percentage: 10, resets_at: NOW_S + 3 * 3600 },
    seven_day: { used_percentage: 20, resets_at: NOW_S + 3 * 86400 },
    ...over,
  };
  fs.writeFileSync(path.join(dir, 'respawn-usage.json'), JSON.stringify(rec));
  return rec;
}

function arm(dir, text = 'stop=85\n', session = SESSION, ageS = 0) {
  const d = path.join(dir, 'respawn-armed');
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, session);
  fs.writeFileSync(f, text);
  // evaluate() is called with NOW_S, so age the marker relative to that
  const t = NOW_S - ageS;
  fs.utimesSync(f, t, t);
  return f;
}

function five(pct) {
  return { used_percentage: pct, resets_at: NOW_S + 3 * 3600 };
}

module.exports = { SESSION, NOW_S, tmpDir, writeCache, arm, five };
