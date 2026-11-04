#!/usr/bin/env node
'use strict';

// Keeps the job prompt in every eval case identical to the fenced template in
// skill/SKILL.md ("Job prompts"). Each prompt.md ends with JOB_HEADER, a
// respawn-state: line, an optional context: line, and then the template body,
// which this script rewrites from SKILL.md.
//   node evals/sync-template.js          rewrite stale prompt.md files
//   node evals/sync-template.js --check  exit 1 if any file is stale

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EVALS = __dirname;
const JOB_HEADER = '=== Job prompt (the message that just arrived) ===';

// Returns { stateLine, contextLine, body } of the fenced template in SKILL.md.
function readTemplate(skillText = fs.readFileSync(path.join(ROOT, 'skill', 'SKILL.md'), 'utf8')) {
  const lines = skillText.replace(/\r\n/g, '\n').split('\n');
  const start = lines.indexOf('## Job prompts');
  if (start < 0) throw new Error('SKILL.md has no "## Job prompts" section');
  const open = lines.indexOf('```', start);
  const close = lines.indexOf('```', open + 1);
  if (open < 0 || close < 0) throw new Error('SKILL.md "Job prompts" has no fenced template');
  const fenced = lines.slice(open + 1, close);
  if (!fenced[0].startsWith('respawn-state: ') || !fenced[1].startsWith('context: ')) {
    throw new Error('template must start with the respawn-state: and context: lines');
  }
  return { stateLine: fenced[0], contextLine: fenced[1], body: fenced.slice(2) };
}

// Returns the prompt text with its template body replaced by the current one.
function syncPrompt(text, template = readTemplate()) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const at = lines.indexOf(JOB_HEADER);
  if (at < 0) throw new Error(`missing line "${JOB_HEADER}"`);
  let keep = at + 1;
  if (!(lines[keep] || '').startsWith('respawn-state: ')) throw new Error('no respawn-state: line after the job header');
  keep++;
  if ((lines[keep] || '').startsWith('context: ')) keep++;
  return [...lines.slice(0, keep), ...template.body].join('\n') + '\n';
}

function promptFiles(dir = EVALS) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'results') continue;
    const sub = path.join(dir, entry.name);
    const prompt = path.join(sub, 'prompt.md');
    if (fs.existsSync(prompt)) out.push(prompt);
    else out.push(...promptFiles(sub));
  }
  return out.sort();
}

function main() {
  const check = process.argv.includes('--check');
  const template = readTemplate();
  const stale = [];
  for (const file of promptFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const next = syncPrompt(text, template);
    if (next === text.replace(/\r\n/g, '\n')) continue;
    stale.push(path.relative(ROOT, file));
    if (!check) fs.writeFileSync(file, next);
  }
  if (check && stale.length) {
    console.error(`Stale job template in:\n  ${stale.join('\n  ')}\nRun: node evals/sync-template.js`);
    process.exit(1);
  }
  if (!check) console.log(stale.length ? `Updated ${stale.length} file(s).` : 'All prompt.md files are current.');
}

if (require.main === module) main();

module.exports = { JOB_HEADER, readTemplate, syncPrompt, promptFiles };
