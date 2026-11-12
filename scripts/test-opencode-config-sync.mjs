import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { stripJsonc, buildConfig, syncConfigDir } from '../lib/opencode/config-sync.ts';

const assetsDir = path.resolve(import.meta.dirname, '../opencode-assets');

// stripJsonc
const src = `{
  // line
  "$schema": "https://opencode.ai/config.json", /* block */
  "a": [1, 2,],
  "s": "x // not a comment /* nor this */ \\" // still string",
}`;
const parsed = JSON.parse(stripJsonc(src));
assert.equal(parsed.$schema, 'https://opencode.ai/config.json');
assert.deepEqual(parsed.a, [1, 2]);
assert.equal(parsed.s, 'x // not a comment /* nor this */ " // still string');

// buildConfig
const base = { $schema: 'https://opencode.ai/config.json', default_agent: 'scotty', update: 'disable', policies: [{ action: 'tool.use', resource: 'shell:git push *', effect: 'deny' }] };
const user = `{
  // c
  "$schema": "https://opencode.ai/config.json",
  "providers": { "anthropic": { "options": { "baseURL": "https://x.example/v1" } }, },
  "plugins": ["p"], "mcp": { "m": {} },
}`;
assert.deepEqual(buildConfig(user, { importProviders: true }), { ...base, providers: { anthropic: { options: { baseURL: 'https://x.example/v1' } } } });
assert.deepEqual(buildConfig(null, { importProviders: true }), base);
assert.deepEqual(buildConfig('{ nope', { importProviders: true }), base);
assert.deepEqual(buildConfig(user, { importProviders: false }), base);

// syncConfigDir
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgsync-'));
const userDir = path.join(tmp, 'user');
const targetDir = path.join(tmp, 'target');
const w = (p, c = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
w(path.join(userDir, 'agents/a.md'), 'A');
w(path.join(userDir, 'agents/scotty.md'), 'USER SCOTTY');
w(path.join(userDir, 'skills/s/SKILL.md'));
w(path.join(userDir, 'node_modules/x/i.js'));
w(path.join(userDir, '.DS_Store'));
w(path.join(userDir, 'agents/.DS_Store'));
w(path.join(userDir, 'service.json'));
w(path.join(userDir, 'opencode.jsonc'), user);
const snap = (d) => {
  const out = {};
  const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    const rel = path.relative(d, f);
    const st = fs.lstatSync(f);
    if (st.isSymbolicLink()) out[rel] = 'link:' + fs.readlinkSync(f);
    else if (st.isDirectory()) { out[rel] = 'dir'; walk(f); }
    else out[rel] = 'file:' + crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
  } };
  walk(d); return out;
};
const before = snap(userDir);
w(path.join(targetDir, 'agents/stale.md'));
w(path.join(targetDir, 'skills/stale/SKILL.md'));
w(path.join(targetDir, 'node_modules/keep/i.js'), 'keep');
const run = (importUser) => syncConfigDir({ userDir, targetDir, assetsDir, importUser });
run(true);
const ex = (p) => fs.existsSync(path.join(targetDir, p));
assert.ok(ex('agents/a.md') && ex('skills/s/SKILL.md') && ex('skills/scotty-ui/SKILL.md') && ex('opencode.jsonc'));
assert.equal(fs.readFileSync(path.join(targetDir, 'agents/scotty.md'), 'utf8'), fs.readFileSync(path.join(assetsDir, 'agents/scotty.md'), 'utf8'));
assert.ok(!ex('node_modules/x') && !ex('.DS_Store') && !ex('agents/.DS_Store') && !ex('service.json'));
assert.ok(!ex('agents/stale.md') && !ex('skills/stale'));
assert.equal(fs.readFileSync(path.join(targetDir, 'node_modules/keep/i.js'), 'utf8'), 'keep');
const cfg = JSON.parse(fs.readFileSync(path.join(targetDir, 'opencode.jsonc'), 'utf8'));
assert.ok(cfg.providers && !cfg.plugins && !cfg.mcp && cfg.default_agent === 'scotty');
assert.deepEqual(snap(userDir), before, 'user dir untouched');
assert.equal(fs.statSync(path.join(targetDir, 'opencode.jsonc')).mode & 0o777, 0o600);
assert.deepEqual(cfg.policies, base.policies);

run(false);
assert.ok(!ex('agents/a.md') && !ex('skills/s') && ex('agents/scotty.md') && ex('skills/scotty-ui/SKILL.md'));
assert.ok(!JSON.parse(fs.readFileSync(path.join(targetDir, 'opencode.jsonc'), 'utf8')).providers);
assert.deepEqual(snap(userDir), before);

syncConfigDir({ userDir: path.join(tmp, 'missing'), targetDir, assetsDir, importUser: true });
assert.ok(ex('agents/scotty.md'));

// symlink safety
{
  const mk = (n) => fs.mkdtempSync(path.join(tmp, n));
  const uD = mk('u-'), tD = mk('t-'), other = mk('o-'), outside = mk('x-');
  w(path.join(other, 'b.md'), 'B');
  w(path.join(other, 'scotty.md'), 'OTHER SCOTTY');
  fs.symlinkSync(other, path.join(uD, 'agents'));
  w(path.join(uD, 'skills/ok/SKILL.md'));
  w(path.join(outside, 'f.md'), 'OUTSIDE');
  fs.symlinkSync(path.join(outside, 'f.md'), path.join(uD, 'skills/scotty-ui.md'));
  fs.mkdirSync(path.join(uD, 'skills/scotty-ui'));
  fs.symlinkSync(path.join(outside, 'f.md'), path.join(uD, 'skills/scotty-ui/SKILL.md'));
  fs.symlinkSync(path.join(uD, 'skills'), path.join(uD, 'skills/loop'));
  fs.symlinkSync(path.join(tmp, 'nowhere'), path.join(uD, 'skills/dangling'));
  const bu = snap(uD), bo = snap(other), bx = snap(outside);
  syncConfigDir({ userDir: uD, targetDir: tD, assetsDir, importUser: true });
  assert.deepEqual(snap(uD), bu); assert.deepEqual(snap(other), bo); assert.deepEqual(snap(outside), bx);
  assert.ok(fs.lstatSync(path.join(tD, 'agents')).isDirectory());
  assert.equal(fs.readFileSync(path.join(tD, 'agents/b.md'), 'utf8'), 'B');
  const asset = fs.readFileSync(path.join(assetsDir, 'agents/scotty.md'), 'utf8');
  assert.equal(fs.readFileSync(path.join(tD, 'agents/scotty.md'), 'utf8'), asset);
  assert.equal(fs.readFileSync(path.join(tD, 'skills/scotty-ui/SKILL.md'), 'utf8'),
    fs.readFileSync(path.join(assetsDir, 'skills/scotty-ui/SKILL.md'), 'utf8'));
  // pre-existing target symlinks are replaced, not followed
  const tD2 = mk('t-');
  fs.symlinkSync(other, path.join(tD2, 'agents'));
  fs.symlinkSync(path.join(outside, 'f.md'), path.join(tD2, 'opencode.jsonc'));
  syncConfigDir({ userDir: uD, targetDir: tD2, assetsDir, importUser: false });
  assert.deepEqual(snap(other), bo); assert.deepEqual(snap(outside), bx);
  assert.ok(fs.lstatSync(path.join(tD2, 'agents')).isDirectory());
}

// in-dir symlinked file agents/scotty.md -> outside
{
  const uD = fs.mkdtempSync(path.join(tmp, 'u-')), tD = fs.mkdtempSync(path.join(tmp, 't-')), outside = fs.mkdtempSync(path.join(tmp, 'x-'));
  w(path.join(outside, 'scotty.md'), 'OUTSIDE');
  fs.mkdirSync(path.join(uD, 'agents'));
  fs.symlinkSync(path.join(outside, 'scotty.md'), path.join(uD, 'agents/scotty.md'));
  const bu = snap(uD), bx = snap(outside);
  syncConfigDir({ userDir: uD, targetDir: tD, assetsDir, importUser: true });
  assert.deepEqual(snap(uD), bu); assert.deepEqual(snap(outside), bx);
  assert.equal(fs.readFileSync(path.join(tD, 'agents/scotty.md'), 'utf8'), fs.readFileSync(path.join(assetsDir, 'agents/scotty.md'), 'utf8'));
}

// opencode.json fallback
{
  const uD = fs.mkdtempSync(path.join(tmp, 'u-')), tD = fs.mkdtempSync(path.join(tmp, 't-'));
  w(path.join(uD, 'opencode.json'), '{"providers":{"p":{}}}');
  syncConfigDir({ userDir: uD, targetDir: tD, assetsDir, importUser: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tD, 'opencode.jsonc'), 'utf8')).providers, { p: {} });
}

// stripJsonc / buildConfig edges
assert.deepEqual(JSON.parse(stripJsonc('{"a":1} // eof')), { a: 1 });
assert.deepEqual(JSON.parse(stripJsonc('{"a":[1, // c\n ],\n"b":2, /* c */ }')), { a: [1], b: 2 });
assert.deepEqual(buildConfig('{"providers":"nope"}', { importProviders: true }), base);
assert.deepEqual(buildConfig('{"providers":[1]}', { importProviders: true }), base);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('opencode config-sync: all passed');
