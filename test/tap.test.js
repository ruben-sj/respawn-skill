'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildRecord } = require('../scripts/respawn-tap.js');
const { tmpDir } = require('./helpers.js');

const TAP = path.join(__dirname, '..', 'scripts', 'respawn-tap.js');
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'statusline.json'), 'utf8');

function runTap(dir, input, args = []) {
  return spawnSync(process.execPath, [TAP, ...args], {
    input, env: { ...process.env, RESPAWN_CLAUDE_DIR: dir }, encoding: 'utf8',
  });
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

test('writes the cache as UTF-8 without BOM and prints nothing without a command', () => {
  const dir = tmpDir();
  const res = runTap(dir, FIXTURE);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  const bytes = fs.readFileSync(path.join(dir, 'respawn-usage.json'));
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const rec = JSON.parse(bytes.toString('utf8'));
  assert.equal(rec.session_id, 'sess-aaaa-1111');
  assert.equal(rec.five_hour.used_percentage, 23.5);
  assert.ok(Number.isInteger(rec.ts));
  // no temp files left behind
  assert.deepEqual(fs.readdirSync(dir), ['respawn-usage.json']);
});

test('a BOM on the input does not break parsing', () => {
  const dir = tmpDir();
  runTap(dir, '﻿' + FIXTURE);
  assert.ok(fs.existsSync(path.join(dir, 'respawn-usage.json')));
});

test('overwrites an earlier cache', () => {
  const dir = tmpDir();
  runTap(dir, FIXTURE);
  runTap(dir, FIXTURE.replace('23.5', '77'));
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'respawn-usage.json'), 'utf8'));
  assert.equal(rec.five_hour.used_percentage, 77);
});

test('without rate_limits it writes nothing and still exits 0', () => {
  const dir = tmpDir();
  const res = runTap(dir, JSON.stringify({ session_id: 'x', model: { display_name: 'M' } }));
  assert.equal(res.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'respawn-usage.json')), false);
});

test('invalid input exits 0 and writes nothing', () => {
  const dir = tmpDir();
  const res = runTap(dir, 'not json');
  assert.equal(res.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'respawn-usage.json')), false);
});

test('pipes the same stdin to the existing command and forwards its stdout', () => {
  const dir = tmpDir();
  const echo = path.join(dir, 'echo.js');
  fs.writeFileSync(echo, "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write('line:'+JSON.parse(s).session_id));");
  const cmd = `"${process.execPath}" "${echo}"`;
  const res = runTap(dir, FIXTURE, [cmd]);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, 'line:sess-aaaa-1111');
  assert.ok(fs.existsSync(path.join(dir, 'respawn-usage.json')));
});

test('a failing existing command does not fail the tap and the cache is still written', () => {
  const dir = tmpDir();
  const res = runTap(dir, FIXTURE, ['definitely-not-a-real-command-xyz']);
  assert.equal(res.status, 0);
  assert.ok(fs.existsSync(path.join(dir, 'respawn-usage.json')));
});
