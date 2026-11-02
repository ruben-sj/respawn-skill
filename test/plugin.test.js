'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

test('hooks.json command points at an existing script inside the plugin', () => {
  const cfg = readJson('hooks/hooks.json');
  const entries = cfg.hooks.PostToolUse.flatMap((g) => g.hooks);
  assert.equal(entries.length, 1);
  const command = entries[0].command;
  const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"$/.exec(command);
  assert.ok(m, `unexpected command form: ${command}`);
  assert.ok(fs.existsSync(path.join(ROOT, m[1])), `${m[1]} does not exist`);
});

test('plugin.json skills path holds the SKILL.md whose name matches the plugin', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  assert.deepEqual(plugin.skills, ['./skill']);
  const skill = fs.readFileSync(path.join(ROOT, 'skill', 'SKILL.md'), 'utf8');
  const name = /^name:\s*(\S+)/m.exec(skill);
  assert.equal(name && name[1], plugin.name);
});

test('marketplace lists the plugin under the same name and sources it from the repo root', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  const market = readJson('.claude-plugin/marketplace.json');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, plugin.name);
  assert.equal(market.plugins[0].source, './');
});

test('public files have no em-dashes', () => {
  const files = ['README.md', 'CHANGELOG.md', 'skill/SKILL.md', 'scripts/respawn-tap.js', 'scripts/respawn-usage-hook.js', 'hooks/hooks.json'];
  for (const f of files) {
    assert.equal(fs.readFileSync(path.join(ROOT, f), 'utf8').includes(String.fromCharCode(0x2014)), false, f);
  }
});
