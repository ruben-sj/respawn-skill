'use strict';

// Static checks for the eval suite in evals/ (no model calls): every case uses
// the current job template from skill/SKILL.md, every grader parses, and the
// regex graders accept a known-good answer and reject known-bad ones.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readTemplate, syncPrompt, promptFiles } = require('../evals/sync-template.js');

const EVALS = path.join(__dirname, '..', 'evals');
const caseDir = (name) => path.join(EVALS, ...name.split('/'));

// Minimal reader for the flat grader frontmatter this suite uses.
function readGrader(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  assert.ok(m, `${file}: no frontmatter`);
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    assert.ok(kv, `${file}: unreadable line ${line}`);
    let v = kv[2];
    if (v.startsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
    else if (v.startsWith('"')) v = JSON.parse(v);
    fm[kv[1]] = v;
  }
  return { ...fm, body: m[2] };
}

function graders(name) {
  const dir = path.join(caseDir(name), 'graders');
  return Object.fromEntries(fs.readdirSync(dir).map((f) => [f.replace(/\.md$/, ''), readGrader(path.join(dir, f))]));
}

function regexPasses(g, reply) {
  const re = new RegExp(g.pattern, `${g.flags || ''}g`);
  const n = (reply.match(re) || []).length;
  if (g.match === 'not_contains') return n === 0;
  if (g.match && g.match.startsWith('count:')) return n === Number(g.match.slice(6));
  return n > 0;
}

// Asserts that every regex grader of the case passes on the reply.
function assertAllPass(name, reply) {
  for (const [g, def] of Object.entries(graders(name))) {
    if (def.type === 'regex') assert.ok(regexPasses(def, reply), `${name}/${g} should pass`);
  }
}

// Asserts that at least one regex grader of the case fails on the reply.
function assertSomeFail(name, reply) {
  const failing = Object.entries(graders(name)).filter(([, d]) => d.type === 'regex' && !regexPasses(d, reply));
  assert.ok(failing.length > 0, `${name}: a bad reply passed every regex grader`);
}

test('every prompt.md carries the current job template from SKILL.md', () => {
  const template = readTemplate();
  const files = promptFiles();
  assert.ok(files.length >= 12, `expected at least 12 cases, found ${files.length}`);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(syncPrompt(text, template), text,`${path.relative(EVALS, file)} is stale: run node evals/sync-template.js`);
  }
});

test('every case has graders, and every grader parses', () => {
  for (const file of promptFiles()) {
    const dir = path.join(path.dirname(file), 'graders');
    const files = fs.readdirSync(dir);
    assert.ok(files.length > 0, `${dir}: no graders`);
    for (const f of files) {
      const g = readGrader(path.join(dir, f));
      assert.ok(['regex', 'tool_used', 'llm'].includes(g.type), `${f}: type ${g.type}`);
      if (g.type === 'regex') assert.doesNotThrow(() => new RegExp(g.pattern, g.flags || ''), f);
    }
  }
});

test('eval files contain no em-dashes and no local paths', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'results') return [];
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  for (const file of walk(EVALS)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes('—'), `${file}: em-dash`);
    assert.ok(!/(?<!\w)[A-Z]:\\\w|\/Users\/|\/home\//.test(text), `${file}: local path`);
  }
});

test('softstop/backstop-paused graders: only the paused line passes', () => {
  const name = 'softstop/backstop-paused';
  assertAllPass(name, 'respawn log: 2026-11-04 11:13 | backstop | paused');
  assertSomeFail(name, 'CALL mcp__ccd_session_mgmt__get_usage {}\nrespawn log: 2026-11-04 11:13 | backstop | paused');
  assertSomeFail(name, 'respawn log: 2026-11-04 11:13 | backstop | paused\nStill paused until 12:00.');
  assertSomeFail(name, 'respawn log: 2026-11-04 11:13 | backstop | 5-hour 86% resets 2026-11-04T11:00:00Z');
});

test('idle/disarm-classic-poll graders: disarm passes, a plain log line fails', () => {
  const name = 'idle/disarm-classic-poll';
  assertAllPass(name, [
    'CALL CronDelete {"id":"job_p1"}',
    'CALL PushNotification {"message":"Respawn disarmed: no cutoff and no activity for hours. Arm it again if you still need it."}',
    'respawn log: 2026-11-04 00:13 | poll | disarmed, idle',
  ].join('\n'));
  assertSomeFail(name, 'respawn log: 2026-11-04 00:13 | poll | no cutoff');
});

test('rollover/creates-backstop-stop70 graders: backstop first, then the timed job with its ID', () => {
  const name = 'rollover/creates-backstop-stop70';
  const backstop = 'CALL CronCreate {"cron":"13,43 * * * *","recurring":true,"state":"respawn-state: usage=on windows=1 cancel_window=5 stop=70 kind=backstop backstop=self"}';
  const timed = 'CALL CronCreate {"cron":"4 19 4 11 *","recurring":false,"state":"respawn-state: usage=on windows=1 cancel_window=5 stop=70 kind=timed backstop=job_n1"}';
  const log = 'respawn log: 2026-11-04 16:21 | timed | 5-hour 60% resets 2026-11-04T18:00:00Z';
  assertAllPass(name, [backstop, timed, log].join('\n'));
  assertSomeFail(name, [timed.replace('job_n1', 'none'), log].join('\n'));
  assertSomeFail(name, [backstop, timed.replace('"4 19', '"0 19'), log].join('\n'));
});

test('rollover/stop-off-deletes-backstop graders: :30 is rejected, :31 passes', () => {
  const name = 'rollover/stop-off-deletes-backstop';
  const del = 'CALL CronDelete {"id":"job_b1"}';
  const timed = (m) => `CALL CronCreate {"cron":"${m} 13 4 11 *","recurring":false,"state":"respawn-state: usage=on windows=2 cancel_window=5 stop=off kind=timed backstop=none"}`;
  const log = 'respawn log: 2026-11-04 10:12 | timed | 5-hour 65% resets 2026-11-04T12:26:00Z';
  assertAllPass(name, [del, timed(31), log].join('\n'));
  assertSomeFail(name, [del, timed(30), log].join('\n'));
});

test('cutoff/trailing-tool-result graders: follow-up passes, a plain log line fails', () => {
  const name = 'cutoff/trailing-tool-result';
  assertAllPass(name, [
    'CALL CronDelete {"id":"job_t1"}',
    'CALL PushNotification {"message":"Window is open again. Resuming the settings loader migration in 5 min. Reply CANCEL to stop."}',
    'CALL CronCreate {"cron":"18 0 4 11 *","recurring":false,"state":"respawn-state: usage=on windows=1 cancel_window=5 stop=90 kind=followup backstop=job_b1"}',
    'respawn log: 2026-11-04 00:13 | backstop | cutoff found | 5-hour 83% resets 2026-11-04T01:00:00Z',
  ].join('\n'));
  assertSomeFail(name, 'respawn log: 2026-11-04 00:13 | backstop | 5-hour 83% resets 2026-11-04T01:00:00Z');
});
