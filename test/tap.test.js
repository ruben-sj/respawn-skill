'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildRecord, tap, safeId, pruneOld } = require('../scripts/respawn-tap.js');
const { tmpDir } = require('./helpers.js');

const TAP = path.join(__dirname, '..', 'scripts', 'respawn-tap.js');
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'statusline.json'), 'utf8');
const BOM = String.fromCharCode(0xfeff);

function runTap(dir, input, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [TAP, ...args], {
    input, env: { ...process.env, RESPAWN_CLAUDE_DIR: dir, ...extraEnv }, encoding: 'utf8',
  });
}

function cacheFile(dir, id = 'sess-aaaa-1111') {
  return path.join(dir, 'respawn-usage', `${id}.json`);
}

test('buildRecord keeps session, five_hour and seven_day', () => {
  const rec = buildRecord(JSON.parse(FIXTURE), 1_800_000_000_000);
  assert.deepEqual(rec, {
    ts: 1_800_000_000,
    session_id: 'sess-aaaa-1111',
    five_hour: { used_percentage: 23.5, resets_at: 1800010800 },
    seven_day: { used_percentage: 41.2, resets_at: 1800400000 },
  });
});

test('buildRecord returns null without a five-hour reading', () => {
  assert.equal(buildRecord({ session_id: 's' }, 0), null);
  assert.equal(buildRecord({ session_id: 's', rate_limits: {} }, 0), null);
  assert.equal(buildRecord({ session_id: 's', rate_limits: { seven_day: { used_percentage: 3 } } }, 0), null);
});

test('buildRecord tolerates a missing seven_day window', () => {
  const rec = buildRecord({ session_id: 's', rate_limits: { five_hour: { used_percentage: 5, resets_at: 9 } } }, 0);
  assert.equal(rec.seven_day, null);
});

test('safeId keeps [A-Za-z0-9_-] and replaces the rest', () => {
  assert.equal(safeId('abc-DEF_123'), 'abc-DEF_123');
  assert.equal(safeId('../x'), '___x');
  assert.equal(safeId('a/b\\c'), 'a_b_c');
  assert.equal(safeId(''), null);
  assert.equal(safeId(undefined), null);
});

test('writes a per-session cache as UTF-8 without BOM and prints nothing without a command', () => {
  const dir = tmpDir();
  const res = runTap(dir, FIXTURE);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  const bytes = fs.readFileSync(cacheFile(dir));
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const rec = JSON.parse(bytes.toString('utf8'));
  assert.equal(rec.session_id, 'sess-aaaa-1111');
  assert.equal(rec.five_hour.used_percentage, 23.5);
  assert.ok(Number.isInteger(rec.ts));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'respawn-usage')), ['sess-aaaa-1111.json']); // no temp files
});

test('two sessions get two cache files', () => {
  const dir = tmpDir();
  runTap(dir, FIXTURE);
  runTap(dir, FIXTURE.replace('sess-aaaa-1111', 'sess-bbbb-2222').replace('23.5', '60'));
  assert.equal(JSON.parse(fs.readFileSync(cacheFile(dir), 'utf8')).five_hour.used_percentage, 23.5);
  assert.equal(JSON.parse(fs.readFileSync(cacheFile(dir, 'sess-bbbb-2222'), 'utf8')).five_hour.used_percentage, 60);
});

test('a session id with path characters is sanitized into a safe file name', () => {
  const dir = tmpDir();
  runTap(dir, FIXTURE.replace('sess-aaaa-1111', '../evil/id'));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'respawn-usage')), ['___evil_id.json']);
});

test('a BOM on the input does not break parsing', () => {
  const dir = tmpDir();
  runTap(dir, BOM + FIXTURE);
  assert.ok(fs.existsSync(cacheFile(dir)));
});

test('overwrites an earlier cache', () => {
  const dir = tmpDir();
  runTap(dir, FIXTURE);
  runTap(dir, FIXTURE.replace('23.5', '77'));
  assert.equal(JSON.parse(fs.readFileSync(cacheFile(dir), 'utf8')).five_hour.used_percentage, 77);
});

test('without rate_limits or a session id it writes nothing and still exits 0', () => {
  const dir = tmpDir();
  let res = runTap(dir, JSON.stringify({ session_id: 'x', model: { display_name: 'M' } }));
  assert.equal(res.status, 0);
  res = runTap(dir, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5, resets_at: 9 } } }));
  assert.equal(res.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'respawn-usage')), false);
});

test('invalid input exits 0 and writes nothing', () => {
  const dir = tmpDir();
  const res = runTap(dir, 'not json');
  assert.equal(res.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'respawn-usage')), false);
});

test('pipes the same stdin to the existing command and forwards its stdout', () => {
  const dir = tmpDir();
  const echo = path.join(dir, 'echo.js');
  fs.writeFileSync(echo, "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write('line:'+JSON.parse(s).session_id));");
  const res = runTap(dir, FIXTURE, [`"${process.execPath}" "${echo}"`]);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, 'line:sess-aaaa-1111');
  assert.ok(fs.existsSync(cacheFile(dir)));
});

test('a failing existing command does not crash the tap: exit 0, no output, cache still written', () => {
  const dir = tmpDir();
  const res = runTap(dir, FIXTURE, ['definitely-not-a-real-command-xyz']);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.ok(fs.existsSync(cacheFile(dir)));
});

test('a command that exits without reading stdin does not crash the tap', () => {
  const dir = tmpDir();
  const res = runTap(dir, FIXTURE.repeat(2000), [`"${process.execPath}" -e "process.stdout.write('ok')"`]);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, 'ok');
});

test('a hanging command (with a grandchild) is killed at the timeout and its partial output is forwarded', () => {
  const dir = tmpDir();
  const slow = path.join(dir, 'slow.js');
  fs.writeFileSync(slow, [
    "const { spawn } = require('child_process');",
    "process.stdout.write('partial');",
    "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });",
    'setTimeout(() => {}, 60000);',
  ].join('\n'));
  const started = Date.now();
  const res = runTap(dir, FIXTURE, [`"${process.execPath}" "${slow}"`], { RESPAWN_TAP_TIMEOUT_MS: '1500' });
  const elapsed = Date.now() - started;
  assert.equal(res.status, 0);
  assert.equal(res.stdout, 'partial');
  assert.ok(elapsed < 15000, `tap took ${elapsed} ms`);
  assert.ok(fs.existsSync(cacheFile(dir)));
});

test('tap() with an injected clock writes the record', () => {
  const dir = tmpDir();
  assert.equal(tap(FIXTURE, dir, 1_800_000_000_000), true);
  assert.equal(JSON.parse(fs.readFileSync(cacheFile(dir), 'utf8')).ts, 1_800_000_000);
  assert.equal(tap('nope', dir, 0), false);
});

test('pruneOld removes cache files older than 8 days and keeps recent ones', () => {
  const dir = tmpDir();
  const cacheDir = path.join(dir, 'respawn-usage');
  fs.mkdirSync(cacheDir);
  const now = Date.now();
  const oldFile = path.join(cacheDir, 'old.json');
  const newFile = path.join(cacheDir, 'new.json');
  fs.writeFileSync(oldFile, '{}');
  fs.writeFileSync(newFile, '{}');
  const old = (now - 9 * 86400 * 1000) / 1000;
  fs.utimesSync(oldFile, old, old);
  pruneOld(cacheDir, now);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(newFile), true);
});

test('SIGTERM to the tap takes the inner command tree down with it (POSIX only)', { skip: process.platform === 'win32' }, async () => {
  const { spawn } = require('child_process');
  const dir = tmpDir();
  const pidFile = path.join(dir, 'inner.pid');
  const inner = path.join(dir, 'inner.js');
  fs.writeFileSync(inner, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`);
  const child = spawn(process.execPath, [TAP, `"${process.execPath}" "${inner}"`], { env: { ...process.env, RESPAWN_CLAUDE_DIR: dir } });
  child.stdin.end(FIXTURE);
  const exited = new Promise((resolve) => child.on('close', resolve));
  for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
  const innerPid = Number(fs.readFileSync(pidFile, 'utf8'));
  child.kill('SIGTERM');
  await exited;
  let alive = true;
  for (let i = 0; i < 30 && alive; i++) {
    try { process.kill(innerPid, 0); await new Promise((r) => setTimeout(r, 100)); } catch (_) { alive = false; }
  }
  assert.equal(alive, false);
});
