'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { evaluate, parseStop, decodeText } = require('../scripts/respawn-usage-hook.js');
const { SESSION, NOW_S, tmpDir, writeCache, arm, five, weekly } = require('./helpers.js');

const HOOK = path.join(__dirname, '..', 'scripts', 'respawn-usage-hook.js');
const BOM = String.fromCharCode(0xfeff);

function run(dir, sessionId = SESSION) {
  return evaluate({ sessionId, dir, nowS: NOW_S });
}

function flags(dir) {
  return fs.readdirSync(path.join(dir, 'respawn-armed')).filter((f) => f.endsWith('.flag'));
}

test('parseStop reads a single stop=N line and rejects everything else', () => {
  assert.equal(parseStop('stop=85\n'), 85);
  assert.equal(parseStop('  stop = 70  '), 70);
  assert.equal(parseStop('STOP=100'), 100);
  for (const bad of ['stop=off', 'stop=0', 'stop=101', 'stop=250', 'garbage', 'not stop=85', 'stop=85 extra', 'stop=85\nstop=90', '']) {
    assert.equal(parseStop(bad), null, bad);
  }
});

test('decodeText handles UTF-8 BOM, UTF-16LE with BOM and UTF-16LE without BOM', () => {
  assert.equal(decodeText(Buffer.from(BOM + 'stop=85', 'utf8')), 'stop=85');
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('stop=85\r\n', 'utf16le')])), 'stop=85\r\n');
  assert.equal(decodeText(Buffer.from('stop=85', 'utf16le')), 'stop=85');
});

test('a UTF-16LE marker (PowerShell redirect style) arms the hook', () => {
  const dir = tmpDir();
  arm(dir, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('stop=85\r\n', 'utf16le')]));
  writeCache(dir, { five_hour: five(90) });
  assert.match(run(dir), /stop tier/);
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

test('silent when the armed run has stop=off or a malformed marker', () => {
  const dir = tmpDir();
  writeCache(dir, { five_hour: five(99) });
  for (const text of ['stop=off\n', 'stop=85 and more\n', '']) {
    arm(dir, text);
    assert.equal(run(dir), null, text);
  }
});

test('a stale marker (older than 8 days) is ignored and removed', () => {
  const dir = tmpDir();
  const marker = arm(dir, 'stop=85\n', SESSION, 8 * 86400 + 60);
  writeCache(dir, { five_hour: five(99) });
  assert.equal(run(dir), null);
  assert.equal(fs.existsSync(marker), false);
});

test('a marker a few days old still works', () => {
  const dir = tmpDir();
  arm(dir, 'stop=85\n', SESSION, 6 * 86400);
  writeCache(dir, { five_hour: five(90) });
  assert.match(run(dir), /stop tier/);
});

test('silent when the cache is missing, stale, corrupt or from the future', () => {
  const dir = tmpDir();
  arm(dir);
  assert.equal(run(dir), null);
  writeCache(dir, { ts: NOW_S - 11 * 60, five_hour: five(99) });
  assert.equal(run(dir), null);
  writeCache(dir, { ts: NOW_S + 5 * 60, five_hour: five(99) });
  assert.equal(run(dir), null);
  fs.writeFileSync(path.join(dir, 'respawn-usage', `${SESSION}.json`), '{not json');
  assert.equal(run(dir), null);
});

test('each session reads only its own cache file', () => {
  const dir = tmpDir();
  arm(dir, 'stop=85\n', SESSION);
  arm(dir, 'stop=85\n', 'sess-other');
  writeCache(dir, { five_hour: five(10) }, SESSION);
  writeCache(dir, { five_hour: five(95) }, 'sess-other');
  assert.equal(run(dir, SESSION), null);
  assert.match(run(dir, 'sess-other'), /95%/);
});

test('a cache whose session_id differs from its file is not trusted', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { session_id: 'sess-other', five_hour: five(99) });
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
  writeCache(dir, { five_hour: five(69.4) });
  assert.equal(run(dir), null);
});

test('warning tier at stop - 15, informational wording, ends with the marker cleanup sentence', () => {
  const dir = tmpDir();
  const marker = arm(dir);
  writeCache(dir, { five_hour: five(70) });
  const note = run(dir);
  assert.match(note, /^Usage note from the respawn hook/);
  assert.match(note, /70%/);
  assert.match(note, /warning range that starts at 70%/);
  assert.doesNotMatch(note, /\b(must|immediately|you are required|system)\b/i);
  assert.ok(note.endsWith(`If no respawn-state job exists in this session, respawn is not armed: delete the marker file ${marker} and ignore this note.`));
});

test('stop tier at the stop level', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { five_hour: five(85) });
  assert.match(run(dir), /stop tier/);
});

test('tiers are computed on the rounded percent and show the same number', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { five_hour: five(69.6) });
  let note = run(dir);
  assert.match(note, /at 70%/);
  assert.match(note, /warning range/);
  writeCache(dir, { five_hour: five(84.5) });
  note = run(dir);
  assert.match(note, /at 85%/);
  assert.match(note, /stop tier/);
});

test('there is no warning tier when stop is 15 or lower', () => {
  const dir = tmpDir();
  arm(dir, 'stop=15\n');
  writeCache(dir, { five_hour: five(14) });
  assert.equal(run(dir), null);
  writeCache(dir, { five_hour: five(15) });
  assert.match(run(dir), /stop tier/);

  const dir2 = tmpDir();
  arm(dir2, 'stop=10\n');
  writeCache(dir2, { five_hour: five(5) });
  assert.equal(run(dir2), null);
  writeCache(dir2, { five_hour: five(10) });
  assert.match(run(dir2), /stop tier/);
});

test('the warning level follows the armed stop level', () => {
  const dir = tmpDir();
  arm(dir, 'stop=50\n');
  writeCache(dir, { five_hour: five(34) });
  assert.equal(run(dir), null);
  writeCache(dir, { five_hour: five(35) });
  assert.match(run(dir), /warning range that starts at 35%/);
});

test('each tier is announced once per crossing', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { five_hour: five(72) });
  assert.match(run(dir), /warning range/);
  assert.equal(run(dir), null);
  writeCache(dir, { five_hour: five(78) });
  assert.equal(run(dir), null);
  writeCache(dir, { five_hour: five(86) });
  assert.match(run(dir), /stop tier/);
  assert.equal(run(dir), null);
  writeCache(dir, { five_hour: five(91) });
  assert.equal(run(dir), null);
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

test('re-arming (marker rewritten) starts a fresh count and old flags are removed', () => {
  const dir = tmpDir();
  const marker = arm(dir);
  writeCache(dir, { five_hour: five(72) });
  assert.match(run(dir), /warning range/);
  assert.equal(run(dir), null);
  const t = NOW_S - 5;
  fs.utimesSync(marker, t, t);
  assert.match(run(dir), /warning range/);
  assert.equal(flags(dir).length, 1);
});

test('flag files are cleaned up when the marker is gone', () => {
  const dir = tmpDir();
  const marker = arm(dir);
  writeCache(dir, { five_hour: five(90) });
  assert.match(run(dir), /stop tier/);
  assert.ok(flags(dir).length > 0);
  fs.unlinkSync(marker);
  assert.equal(run(dir), null);
  assert.deepEqual(flags(dir), []);
});

test('weekly window at 98% is the stop tier and the note names the weekly reset', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { five_hour: five(10), seven_day: weekly(98, 3 * 86400) });
  const note = run(dir);
  assert.match(note, /weekly usage window is at 98%/);
  assert.match(note, /This is the weekly reset, not the 5-hour one/);
  assert.match(note, /It resets at \d{4}-\d\d-\d\d \d\d:\d\d local time/); // a different day, so the date is shown
  assert.match(note, /weekly reset is the target time/);
  assert.equal(run(dir), null);
});

test('when both the 5-hour stop level and the weekly cap are hit, the weekly reset wins', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { five_hour: five(90), seven_day: weekly(99) });
  const note = run(dir);
  assert.match(note, /weekly reset is the target time/);
  assert.match(note, /5-hour window is at 90%/);
  assert.equal(run(dir), null);
});

test('the weekly note still speaks after a 5-hour stop note', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { five_hour: five(90) });
  assert.match(run(dir), /5-hour window is at 90%/);
  writeCache(dir, { five_hour: five(90), seven_day: weekly(98) });
  assert.match(run(dir), /weekly reset is the target time/);
});

test('reset time shows only HH:MM when it is today', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { five_hour: { used_percentage: 90, resets_at: NOW_S + 60 } });
  assert.match(run(dir), /resets at \d\d:\d\d local time/);
});

test('session ids that could escape the folder never reach another path', () => {
  const dir = tmpDir();
  arm(dir);
  writeCache(dir, { five_hour: five(99) });
  for (const sessionId of ['../x', '', undefined, 'a/b', 'a\\b']) {
    assert.equal(evaluate({ sessionId, dir, nowS: NOW_S }), null);
  }
});

function hookEnv(dir) {
  return { ...process.env, RESPAWN_CLAUDE_DIR: dir };
}

function seedLive(dir, pct) {
  const now = Math.floor(Date.now() / 1000);
  const armed = path.join(dir, 'respawn-armed');
  fs.mkdirSync(armed, { recursive: true });
  fs.writeFileSync(path.join(armed, SESSION), 'stop=85\n');
  fs.mkdirSync(path.join(dir, 'respawn-usage'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'respawn-usage', `${SESSION}.json`), JSON.stringify({
    ts: now, session_id: SESSION, five_hour: { used_percentage: pct, resets_at: now + 3600 }, seven_day: null,
  }));
}

test('process: prints PostToolUse additionalContext JSON when armed and over the line', () => {
  const dir = tmpDir();
  seedLive(dir, 90);
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: SESSION, hook_event_name: 'PostToolUse', tool_name: 'Bash' }),
    env: hookEnv(dir), encoding: 'utf8',
  });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /stop tier/);
  const again = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: SESSION }), env: hookEnv(dir), encoding: 'utf8' });
  assert.equal(again.stdout, '');
});

test('process: parallel tool calls produce exactly one note', async () => {
  const dir = tmpDir();
  seedLive(dir, 90);
  const outputs = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: hookEnv(dir) });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('close', () => resolve(out));
    child.stdin.end(JSON.stringify({ session_id: SESSION }));
  })));
  assert.equal(outputs.filter((o) => o.includes('additionalContext')).length, 1);
});

test('process: stays silent and keeps the note for the main agent when fired inside a subagent', () => {
  const dir = tmpDir();
  seedLive(dir, 90);
  const sub = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: SESSION, agent_id: 'agent-1' }), env: hookEnv(dir), encoding: 'utf8' });
  assert.equal(sub.stdout, '');
  const main = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: SESSION }), env: hookEnv(dir), encoding: 'utf8' });
  assert.match(JSON.parse(main.stdout).hookSpecificOutput.additionalContext, /stop tier/);
});

test('process: empty or invalid stdin exits 0 with no output', () => {
  const dir = tmpDir();
  for (const input of ['', 'not json', '{}']) {
    const res = spawnSync(process.execPath, [HOOK], { input, env: hookEnv(dir), encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  }
});
