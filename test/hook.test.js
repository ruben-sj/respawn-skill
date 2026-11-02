'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { evaluate, parseStop } = require('../scripts/respawn-usage-hook.js');
const { SESSION, NOW_S, tmpDir, writeCache, arm, five } = require('./helpers.js');

const HOOK = path.join(__dirname, '..', 'scripts', 'respawn-usage-hook.js');

function run(dir, sessionId = SESSION) {
  return evaluate({ sessionId, dir, nowS: NOW_S });
}

test('parseStop reads stop=N and treats off or junk as no soft stop', () => {
  assert.equal(parseStop('stop=85\n'), 85);
  assert.equal(parseStop('stop = 70'), 70);
  assert.equal(parseStop('stop=off'), null);
  assert.equal(parseStop('stop=0'), null);
  assert.equal(parseStop('stop=250'), null);
  assert.equal(parseStop('garbage'), null);
});

test('silent when no respawn run is armed', () => {
  const dir = tmpDir();
  writeCache(dir, { five_hour: five(99) });
  assert.equal(run(dir), null);
});

test('silent when the marker is for another session', () => {
  const dir = tmpDir();
  arm(dir, 'stop=85\n', 'sess-other');
  writeCache(dir, { five_hour: five(99) });
  assert.equal(run(dir), null);
});

test('silent when the armed run has stop=off', () => {
  const dir = tmpDir();
  arm(dir, 'stop=off\n');
  writeCache(dir, { five_hour: five(99) });
  assert.equal(run(dir), null);
});

test('silent when the marker is stale', () => {
  const dir = tmpDir();
  arm(dir, 'stop=85\n', SESSION, 25 * 3600);
  writeCache(dir, { five_hour: five(99) });
  assert.equal(run(dir), null);
});

test('silent when the cache is missing', () => {
  const dir = tmpDir();
  arm(dir);
  assert.equal(run(dir), null);
});

test('silent when the cache is stale', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { ts: NOW_S - 11 * 60, five_hour: five(99) });
  assert.equal(run(dir), null);
});

test('silent when the cache belongs to another session', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { session_id: 'sess-other', five_hour: five(99) });
  assert.equal(run(dir), null);
});

test('silent when the cache is corrupt', () => {
  const dir = tmpDir();
  arm(dir);
  fs.writeFileSync(path.join(dir, 'respawn-usage.json'), '{not json');
  assert.equal(run(dir), null);
});

test('silent when the five-hour window has already reset', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { five_hour: { used_percentage: 99, resets_at: NOW_S - 5 } });
  assert.equal(run(dir), null);
});

test('silent below the warning level', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { five_hour: five(69) });
  assert.equal(run(dir), null);
});

test('warning tier at stop - 15, informational wording', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { five_hour: five(70) });
  const note = run(dir);
  assert.match(note, /^Usage note from the respawn hook/);
  assert.match(note, /70%/);
  assert.match(note, /warning range that starts at 70%/);
  assert.doesNotMatch(note, /\b(must|immediately|you are required|system)\b/i);
});

test('stop tier at the stop level', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { five_hour: five(85) });
  assert.match(run(dir), /stop tier/);
});

test('each tier is announced once per crossing', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { five_hour: five(72) });
  assert.match(run(dir), /warning range/);
  assert.equal(run(dir), null); // same tier again
  writeCache(dir, { five_hour: five(78) });
  assert.equal(run(dir), null); // still the warning tier
  writeCache(dir, { five_hour: five(86) });
  assert.match(run(dir), /stop tier/);
  assert.equal(run(dir), null);
  writeCache(dir, { five_hour: five(91) });
  assert.equal(run(dir), null); // still the stop tier
});

test('jumping straight to the stop tier gives only the stop note', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { five_hour: five(90) });
  assert.match(run(dir), /stop tier/);
  assert.equal(run(dir), null);
});

test('a new crossing after usage dropped is announced again', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { five_hour: five(72) });
  assert.match(run(dir), /warning range/);
  writeCache(dir, { five_hour: five(5) }); // window reset
  assert.equal(run(dir), null);
  writeCache(dir, { five_hour: five(72) });
  assert.match(run(dir), /warning range/);
});

test('re-arming (marker rewritten) starts a fresh count', () => {
  const dir = tmpDir();
  const marker = arm(dir);
  writeCache(dir, { five_hour: five(72) });
  assert.match(run(dir), /warning range/);
  assert.equal(run(dir), null);
  const t = NOW_S - 5;
  fs.utimesSync(marker, t, t);
  assert.match(run(dir), /warning range/);
});

test('the warning level follows the armed stop level', () => {
  const dir = tmpDir();
  arm(dir, 'stop=50\n');
  writeCache(dir, { five_hour: five(34) });
  assert.equal(run(dir), null);
  writeCache(dir, { five_hour: five(35) });
  assert.match(run(dir), /warning range that starts at 35%/);
});

test('weekly window at 98% or more is the stop tier', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { five_hour: five(10), seven_day: { used_percentage: 98, resets_at: NOW_S + 86400 } });
  assert.match(run(dir), /weekly usage window is at 98%/);
  assert.equal(run(dir), null);
});

test('session ids that could escape the folder are ignored', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { five_hour: five(99) });
  for (const sessionId of ['../x', '', undefined, 'a/b', 'a\\b']) {
    assert.equal(evaluate({ sessionId, dir, nowS: NOW_S }), null);
  }
});

test('process: prints PostToolUse additionalContext JSON when armed and over the line', () => {
  const dir = tmpDir();
  const now = Math.floor(Date.now() / 1000);
  const d = path.join(dir, 'respawn-armed');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, SESSION), 'stop=85\n');
  fs.writeFileSync(path.join(dir, 'respawn-usage.json'), JSON.stringify({
    ts: now, session_id: SESSION,
    five_hour: { used_percentage: 90, resets_at: now + 3600 }, seven_day: null,
  }));
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: SESSION, hook_event_name: 'PostToolUse', tool_name: 'Bash' }),
    env: { ...process.env, RESPAWN_CLAUDE_DIR: dir }, encoding: 'utf8',
  });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /stop tier/);
  // second call: already announced, so no output at all
  const again = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: SESSION }), env: { ...process.env, RESPAWN_CLAUDE_DIR: dir }, encoding: 'utf8',
  });
  assert.equal(again.stdout, '');
});

test('process: stays silent and keeps the note for the main agent when fired inside a subagent', () => {
  const dir = tmpDir();
  const now = Math.floor(Date.now() / 1000);
  const d = path.join(dir, 'respawn-armed');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, SESSION), 'stop=85\n');
  fs.writeFileSync(path.join(dir, 'respawn-usage.json'), JSON.stringify({
    ts: now, session_id: SESSION, five_hour: { used_percentage: 90, resets_at: now + 3600 }, seven_day: null,
  }));
  const env = { ...process.env, RESPAWN_CLAUDE_DIR: dir };
  const sub = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: SESSION, agent_id: 'agent-1' }), env, encoding: 'utf8' });
  assert.equal(sub.stdout, '');
  const main = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: SESSION }), env, encoding: 'utf8' });
  assert.match(JSON.parse(main.stdout).hookSpecificOutput.additionalContext, /stop tier/);
});

test('process: empty or invalid stdin exits 0 with no output', () => {
  const dir = tmpDir();
  for (const input of ['', 'not json', '{}']) {
    const res = spawnSync(process.execPath, [HOOK], { input, env: { ...process.env, RESPAWN_CLAUDE_DIR: dir }, encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  }
});
