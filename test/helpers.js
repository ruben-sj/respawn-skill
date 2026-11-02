'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION = 'sess-aaaa-1111';
const NOW_S = 1_800_000_000; // fixed "now" for the pure-function tests

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'respawn-test-'));
}

// Writes the per-session usage cache the way the tap does.
function writeCache(dir, over = {}, session = SESSION) {
  const rec = {
    ts: NOW_S - 30,
    session_id: session,
    five_hour: { used_percentage: 10, resets_at: NOW_S + 3 * 3600 },
    seven_day: { used_percentage: 20, resets_at: NOW_S + 3 * 86400 },
    ...over,
  };
  const d = path.join(dir, 'respawn-usage');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${session}.json`), JSON.stringify(rec));
  return rec;
}

// Writes the armed marker; `content` may be a string or a Buffer.
function arm(dir, content = 'stop=85\n', session = SESSION, ageS = 0) {
  const d = path.join(dir, 'respawn-armed');
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, session);
  fs.writeFileSync(f, content);
  // evaluate() is called with NOW_S, so age the marker relative to that
  const t = NOW_S - ageS;
  fs.utimesSync(f, t, t);
  return f;
}

function five(pct) {
  return { used_percentage: pct, resets_at: NOW_S + 3 * 3600 };
}

function weekly(pct, resetsInS = 86400) {
  return { used_percentage: pct, resets_at: NOW_S + resetsInS };
}

module.exports = { SESSION, NOW_S, tmpDir, writeCache, arm, five, weekly };
