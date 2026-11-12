// Run: node --conditions=react-server --no-warnings scripts/test-ai-provider.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'scotty-aiprov-'));
process.env.XDG_CONFIG_HOME = xdg;
const mod = (p) => import(fileURLToPath(new URL(p, import.meta.url)));
const { resolveProvider } = await mod('../lib/ai-provider.ts');
const { assistBead, AiError, runOpencodeWithTimeout } = await mod('../lib/ai.ts');
const { OpencodeUnavailableError } = await mod('../lib/opencode/server.ts');
const { OpencodeApiError } = await mod('../lib/opencode/client.ts');
const { getConfig, saveConfig } = await mod('../lib/config.ts');

try {
  const both = { opencode: true, claude: true };
  assert.equal(resolveProvider('auto', both), 'opencode');
  assert.equal(resolveProvider(undefined, both), 'opencode');
  assert.equal(resolveProvider('auto', { opencode: false, claude: true }), 'claude');
  assert.equal(resolveProvider('claude', both), 'claude');
  assert.equal(resolveProvider('opencode', { opencode: false, claude: true }), 'claude');
  assert.equal(resolveProvider('claude', { opencode: true, claude: false }), 'opencode');
  assert.equal(resolveProvider('auto', { opencode: false, claude: false }), null);

  const input = { id: 'b-1', title: 'T', description: 'd', type: 'task', labels: [], others: [{ id: 'b-2', title: 'O' }] };
  const json = JSON.stringify({ description: 'new', acceptance: 'a', labels: ['x'], duplicates: [{ id: 'b-2', title: 'O', reason: 'r' }, { id: 'zz', title: 'bad', reason: 'r' }] });
  const avail = async () => both;
  const spy = (fn) => { const f = async (...a) => { f.calls++; return fn(...a); }; f.calls = 0; return f; };

  let oc = spy(async () => json), cl = spy(async () => '{}');
  let r = await assistBead(input, { directory: '/x' }, { runOpencode: oc, runClaude: cl, avail });
  assert.equal(r.description, 'new');
  assert.deepEqual(r.duplicates.map((d) => d.id), ['b-2']);
  assert.equal(cl.calls, 0);

  oc = spy(async () => { throw new OpencodeUnavailableError('not_installed', 'nope'); });
  cl = spy(async () => json);
  r = await assistBead(input, { directory: null }, { runOpencode: oc, runClaude: cl, avail });
  assert.equal(r.description, 'new');
  assert.equal(cl.calls, 1);

  oc = spy(async () => 'just prose'); cl = spy(async () => json);
  await assert.rejects(assistBead(input, { directory: null }, { runOpencode: oc, runClaude: cl, avail }), (e) => e instanceof AiError && e.code === 'bad_output');
  assert.equal(cl.calls, 0);

  oc = spy(async () => { throw new AiError('slow', 'timeout'); }); cl = spy(async () => json);
  await assert.rejects(assistBead(input, { directory: null }, { runOpencode: oc, runClaude: cl, avail }), (e) => e.code === 'timeout');
  assert.equal(cl.calls, 0);

  await assert.rejects(
    assistBead(input, { directory: null }, { runOpencode: oc, runClaude: cl, avail: async () => ({ opencode: false, claude: false }) }),
    (e) => e instanceof AiError,
  );

  oc = spy(async () => { throw new AiError('500', 'opencode_failed'); }); cl = spy(async () => json);
  r = await assistBead(input, { directory: null }, { runOpencode: oc, runClaude: cl, avail });
  assert.equal(r.description, 'new');
  assert.equal(cl.calls, 1, 'opencode_failed falls back');

  await assert.rejects(runOpencodeWithTimeout(async () => { throw new OpencodeApiError(401, 'unauth'); }), (e) => e instanceof AiError && e.code === 'opencode_failed');
  let aborted = false;
  await assert.rejects(
    runOpencodeWithTimeout((signal) => new Promise(() => signal.addEventListener('abort', () => { aborted = true; })), 20),
    (e) => e instanceof AiError && e.code === 'timeout' && e.message === 'The OpenCode agent timed out.',
  );
  assert.ok(aborted, 'timeout aborts the request');

  assert.equal(getConfig().aiProvider, 'auto');
  assert.equal(getConfig().importOpencodeConfig, true);
  saveConfig({ aiProvider: 'claude', importOpencodeConfig: false });
  const saved = JSON.parse(fs.readFileSync(path.join(xdg, 'bead-me-up-scotty', 'config.json'), 'utf8'));
  assert.equal(saved.aiProvider, 'claude');
  assert.equal(saved.importOpencodeConfig, false);
} finally {
  fs.rmSync(xdg, { recursive: true, force: true });
}
console.log('PASS ai provider: resolve table, fallback rules, config round-trip');
