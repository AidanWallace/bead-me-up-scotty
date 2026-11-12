// Run with: node --conditions=react-server scripts/test-opencode-server.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stub = path.resolve(import.meta.dirname, 'fixtures/stub-opencode.mjs');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scotty-oc-server-'));
const xdg = path.join(scratch, 'xdg');
const log = path.join(scratch, 'stub.log');
process.env.XDG_CONFIG_HOME = xdg;
process.env.SCOTTY_OPENCODE_BIN = stub;
process.env.STUB_LOG = log;
process.env.OPENCODE_CONFIG_DIR = '/should/not/leak';
process.env.OPENCODE_CONFIG = '/leak/config';
process.env.OPENCODE_CONFIG_CONTENT = '{"leak":1}';
process.env.OPENCODE_DB = '/leak/db';

const mod = await import('../lib/opencode/server.ts');
const { ensureServer, peekServer, stopServer, resolveOpencodeBin, opencodeEnv, listenConfig, OpencodeUnavailableError } = mod;
const appDir = path.join(xdg, 'bead-me-up-scotty', 'opencode');
const spawned = new Set();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitDead = async (pid) => { for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100)); return !alive(pid); };
const info = async (h, pw = h.password) => fetch(`${h.url}/api/info`, { headers: { authorization: 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64') } });

try {
  // opencodeEnv is pure and isolating
  const e = opencodeEnv('/a', 'pw', { OPENCODE_CONFIG_DIR: '/x', XDG_DATA_HOME: '/y', XDG_CONFIG_HOME: '/z', KEEP: '1' });
  assert.equal(e.XDG_DATA_HOME, '/a/data');
  assert.equal(e.XDG_STATE_HOME, '/a/state');
  assert.equal(e.XDG_CACHE_HOME, '/a/cache');
  assert.equal(e.OPENCODE_CONFIG_DIR, '/a/config');
  assert.equal(e.OPENCODE_DISABLE_AUTOUPDATE, '1');
  assert.equal(e.OPENCODE_PASSWORD, 'pw');
  assert.equal(e.KEEP, '1');
  assert.equal(e.XDG_CONFIG_HOME, '/a/xdg-config');
  assert.equal(e.OPENCODE_CONFIG, undefined);
  assert.equal(e.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(e.OPENCODE_DB, undefined);

  // resolveOpencodeBin
  assert.equal(resolveOpencodeBin(), stub);
  delete process.env.SCOTTY_OPENCODE_BIN;
  const real = resolveOpencodeBin();
  assert.ok(real && fs.existsSync(real), `real bin: ${real}`);
  assert.match(execFileSync(real, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: xdg } }), /2\.2\.7/);
  process.env.SCOTTY_OPENCODE_BIN = stub;

  assert.equal(await peekServer(), null);

  // start
  const h = await ensureServer();
  spawned.add(h.pid);
  assert.equal(h.url, `http://127.0.0.1:${h.port}`);
  assert.equal(h.password.length >= 16, true);
  const r = await info(h);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).pid, h.pid);
  assert.equal((await info(h, 'wrong')).status, 401);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  const a = lines[0].argv;
  assert.equal(a[a.indexOf('--hostname') + 1], '127.0.0.1');
  assert.equal(a[a.indexOf('--port') + 1], String(h.port));
  assert.equal(lines[0].env.XDG_DATA_HOME, path.join(appDir, 'data'));
  assert.equal(lines[0].env.XDG_STATE_HOME, path.join(appDir, 'state'));
  assert.equal(lines[0].env.XDG_CACHE_HOME, path.join(appDir, 'cache'));
  assert.equal(lines[0].env.OPENCODE_CONFIG_DIR, path.join(appDir, 'config'));
  assert.equal(lines[0].env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  assert.equal(lines[0].env.XDG_CONFIG_HOME, path.join(appDir, 'xdg-config'));
  assert.notEqual(lines[0].env.XDG_CONFIG_HOME, xdg);
  assert.ok(fs.statSync(path.join(appDir, 'xdg-config')).isDirectory());
  assert.equal(lines[0].env.OPENCODE_CONFIG, undefined);
  assert.equal(lines[0].env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(lines[0].env.OPENCODE_DB, undefined);
  assert.ok(!String(lines[0].env.XDG_CONFIG_HOME).startsWith(path.join(os.homedir(), '.config')));
  assert.ok(fs.existsSync(path.join(appDir, 'config', 'opencode.jsonc')));
  assert.ok(fs.existsSync(path.join(appDir, 'config', 'agents')));
  const st = fs.statSync(path.join(appDir, 'server.json'));
  assert.equal(st.mode & 0o777, 0o600);

  // same pid
  const h2 = await ensureServer();
  assert.equal(h2.pid, h.pid);
  assert.equal((await peekServer()).pid, h.pid);

  // stale state: live pid + port but wrong password is not reused
  const goodState = fs.readFileSync(path.join(appDir, 'server.json'), 'utf8');
  fs.writeFileSync(path.join(appDir, 'server.json'), JSON.stringify({ pid: h.pid, port: h.port, password: 'wrong' }));
  assert.equal(await peekServer(), null);
  fs.writeFileSync(path.join(appDir, 'server.json'), goodState);
  assert.equal((await peekServer()).pid, h.pid);

  // second process reuses
  const child = spawnSync(process.execPath, ['--conditions=react-server', '--no-warnings', '--input-type=module', '-e',
    `const m = await import(${JSON.stringify(new URL('../lib/opencode/server.ts', import.meta.url).href)}); const h = await m.ensureServer(); console.log(h.pid);`],
    { env: process.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(Number(child.stdout.trim()), h.pid);
  assert.equal(alive(h.pid), true);

  // kill -> new pid
  process.kill(h.pid, 'SIGKILL');
  assert.ok(await waitDead(h.pid));
  assert.equal(await peekServer(), null);
  const h3 = await ensureServer();
  spawned.add(h3.pid);
  assert.notEqual(h3.pid, h.pid);

  // stopServer
  stopServer();
  assert.ok(await waitDead(h3.pid), 'stopServer ends the process');
  assert.equal(await peekServer(), null);

  // stale server.json (dead pid) ignored
  fs.writeFileSync(path.join(appDir, 'server.json'), JSON.stringify({ pid: h3.pid, port: 1, password: 'x' }));
  assert.equal(await peekServer(), null);
  const h4 = await ensureServer();
  spawned.add(h4.pid);
  assert.notEqual(h4.pid, h3.pid);
  stopServer();
  assert.ok(await waitDead(h4.pid));

  // stopServer then ensureServer re-syncs config (import toggle path)
  const hr = await ensureServer();
  spawned.add(hr.pid);
  stopServer();
  assert.ok(await waitDead(hr.pid));
  fs.writeFileSync(path.join(appDir, 'config', 'opencode.jsonc'), 'STALE');
  const hr2 = await ensureServer();
  spawned.add(hr2.pid);
  assert.notEqual(hr2.pid, hr.pid);
  assert.ok(JSON.parse(fs.readFileSync(path.join(appDir, 'config', 'opencode.jsonc'), 'utf8')).policies);
  stopServer();
  assert.ok(await waitDead(hr2.pid));

  // concurrent ensureServer calls share one spawn
  const before = fs.readFileSync(log, 'utf8').trim().split('\n').length;
  const [c1, c2, c3] = await Promise.all([ensureServer(), ensureServer(), ensureServer()]);
  spawned.add(c1.pid);
  assert.equal(c1.pid, c2.pid);
  assert.equal(c2.pid, c3.pid);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, before + 1);
  stopServer();
  assert.ok(await waitDead(c1.pid));

  // not installed
  process.env.SCOTTY_OPENCODE_BIN = '/nonexistent/opencode';
  await assert.rejects(ensureServer(), (err) => err instanceof OpencodeUnavailableError && err.code === 'not_installed');

  // start_failed
  process.env.SCOTTY_OPENCODE_BIN = stub;
  process.env.STUB_MODE = 'exit';
  const t0 = Date.now();
  await assert.rejects(ensureServer(), (err) => err instanceof OpencodeUnavailableError && err.code === 'start_failed');
  assert.ok(Date.now() - t0 < 30000);

  // SIGTERM to the owning process stops its child
  delete process.env.STUB_MODE;
  const owner = (await import('node:child_process')).spawn(process.execPath, ['--conditions=react-server', '--no-warnings', '--input-type=module', '-e',
    `const m = await import(${JSON.stringify(new URL('../lib/opencode/server.ts', import.meta.url).href)}); const h = await m.ensureServer(); console.log(h.pid); setInterval(() => {}, 1000);`],
    { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  const ownedPid = await new Promise((resolve) => owner.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  spawned.add(ownedPid);
  assert.ok(alive(ownedPid));
  owner.kill('SIGTERM');
  assert.ok(await waitDead(ownedPid), 'child stopped on SIGTERM');
  assert.ok(await waitDead(owner.pid), 'owner exited on SIGTERM');

  // never listens: times out quickly and leaves no process behind
  process.env.STUB_MODE = 'hang';
  process.env.SCOTTY_OPENCODE_START_TIMEOUT_MS = '1500';
  const before2 = fs.readFileSync(log, 'utf8').trim().split('\n').length;
  await assert.rejects(ensureServer(), (err) => err instanceof OpencodeUnavailableError && err.code === 'start_failed');
  const hangLines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(hangLines.length, before2 + 1);
  const hangPid = hangLines.at(-1).pid;
  spawned.add(hangPid);
  assert.ok(await waitDead(hangPid), 'timed-out child is killed');
  assert.equal(await peekServer(), null);

  // listenConfig: random loopback by default; fixed port / 0.0.0.0 only on explicit opt-in
  assert.deepEqual(listenConfig({}), { host: '127.0.0.1', port: null });
  assert.deepEqual(listenConfig({ SCOTTY_OPENCODE_PORT: '4096', SCOTTY_OPENCODE_HOST: '0.0.0.0' }), { host: '0.0.0.0', port: 4096 });
  assert.deepEqual(listenConfig({ SCOTTY_OPENCODE_PORT: 'nope', SCOTTY_OPENCODE_HOST: '10.0.0.5' }), { host: '127.0.0.1', port: null });
  assert.equal(listenConfig({ SCOTTY_OPENCODE_PORT: '70000' }).port, null);

  // a fixed port + 0.0.0.0 reach the child's argv and the returned handle
  stopServer();
  delete process.env.STUB_MODE;
  delete process.env.SCOTTY_OPENCODE_START_TIMEOUT_MS;
  const { createServer } = await import('node:net');
  const fixed = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  process.env.SCOTTY_OPENCODE_PORT = String(fixed);
  process.env.SCOTTY_OPENCODE_HOST = '0.0.0.0';
  fs.writeFileSync(log, '');
  const hf = await ensureServer();
  spawned.add(hf.pid);
  assert.equal(hf.port, fixed);
  assert.equal(hf.url, `http://127.0.0.1:${fixed}`);
  const fl = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1).argv;
  assert.equal(fl[fl.indexOf('--hostname') + 1], '0.0.0.0');
  assert.equal(fl[fl.indexOf('--port') + 1], String(fixed));
  stopServer();
  delete process.env.SCOTTY_OPENCODE_PORT;
  delete process.env.SCOTTY_OPENCODE_HOST;

  console.log('opencode server tests passed');
} finally {
  stopServer();
  for (const pid of spawned) if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
  fs.rmSync(scratch, { recursive: true, force: true });
}
