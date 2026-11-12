// Run with: node --conditions=react-server scripts/test-opencode-client.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const stub = path.resolve(import.meta.dirname, 'fixtures/stub-opencode.mjs');
const { pair, createSession, generateText, putInstruction, subscribeEvents, OpencodeApiError } = await import('../lib/opencode/client.ts');

const port = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const password = 'pw-test';
const proc = spawn(process.execPath, [stub, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
  stdio: 'ignore',
  env: { ...process.env, OPENCODE_PASSWORD: password },
});
const h = { url: `http://127.0.0.1:${port}`, port, password, pid: proc.pid };
const auth = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
const raw = (p, init = {}) => fetch(h.url + p, { ...init, headers: { authorization: auth, ...(init.headers ?? {}) } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 50; i++) {
    try { if ((await raw('/api/info')).ok) break; } catch {}
    await sleep(100);
  }
  const reqs = async () => (await raw('/__requests')).json();

  assert.equal(await pair(h), 'ABC123');
  assert.equal(await createSession(h, '/tmp/my proj'), 'ses_stub1');
  assert.equal(await generateText(h, 'ping', '/tmp/my proj'), 'pong');
  await putInstruction(h, 'ses/1', 'key a/b', 'hello');

  const r = await reqs();
  assert.deepEqual(r[0], { method: 'POST', path: '/api/pair', search: '', body: {} });
  assert.deepEqual(r[1], { method: 'POST', path: '/api/session', search: '', body: { location: { directory: '/tmp/my proj' } } });
  assert.equal(r[2].method, 'POST');
  assert.equal(r[2].path, '/api/experimental/generate/text');
  assert.equal(new URLSearchParams(r[2].search).get('location[directory]'), '/tmp/my proj');
  assert.deepEqual(r[2].body, { prompt: 'ping' });
  assert.equal(r[3].method, 'PUT');
  assert.equal(r[3].path, '/api/experimental/session/ses%2F1/instructions/entries/key%20a%2Fb');
  assert.deepEqual(r[3].body, { value: 'hello' });

  // errors
  await assert.rejects(() => pair({ ...h, password: 'wrong' }), (e) => e instanceof OpencodeApiError && e.status === 401);
  await assert.rejects(() => generateText(h, '__fail500', '/x'), (e) => e instanceof OpencodeApiError && e.status === 500);

  // SSE: chunk-boundary splits, CRLF, comments, non-JSON
  const ac = new AbortController();
  const got = [];
  const done = (async () => { for await (const e of subscribeEvents(h, ac.signal)) got.push(e); })();
  for (let i = 0; i < 50; i++) {
    const res = await raw('/__emit', { method: 'POST', body: ': keepalive\n\n' });
    if ((await res.json()).clients > 0) break;
    await sleep(50);
  }
  const emit = async (s) => { await raw('/__emit', { method: 'POST', body: s }); await sleep(30); };
  await emit('data: {"type":"session.id');
  await emit('le","data":{"sessionID":"a"}}\n');
  await emit('\ndata: not json\n\n');
  await emit('data: {"type":"permission.asked",\r\ndata: "n":1}\r\n\r\n');
  await emit('data: {"type":"form.created"}\r\n\r\n');
  assert.deepEqual(got[0], { type: 'session.idle', data: { sessionID: 'a' } });
  assert.deepEqual(got[1], { type: 'permission.asked', n: 1 });
  assert.equal(got[got.length - 1].type, 'form.created');
  assert.ok(got.every((e) => typeof e === 'object'));
  ac.abort();
  await Promise.race([done, sleep(2000).then(() => { throw new Error('did not end on abort'); })]);

  // already-aborted signal ends cleanly
  const ac2 = new AbortController();
  ac2.abort();
  for await (const _ of subscribeEvents(h, ac2.signal)) assert.fail('should yield nothing');

  console.log('opencode client tests passed');
} finally {
  try { process.kill(proc.pid, 'SIGKILL'); } catch {}
}
