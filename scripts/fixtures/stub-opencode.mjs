#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
if (args.includes('--version')) {
  console.log('2.2.7');
  process.exit(0);
}

const password = process.env.OPENCODE_PASSWORD ?? '';
const keys = ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_PASSWORD', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DB', 'HOME'];
if (process.env.STUB_LOG) {
  const env = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv: args, env, pid: process.pid }) + '\n');
}
if (process.env.STUB_MODE === 'exit') process.exit(1);
if (process.env.STUB_MODE === 'hang') setInterval(() => {}, 1000);
else {
const expected = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
const requests = [];
const sseClients = new Set();
const seen = [];
let sessionCount = 0;
const usedCodes = new Set();
const port = () => server.address().port;
const server = http.createServer((req, res) => {
  const pub = new URL(req.url, 'http://x');
  const html = (body) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><body>${body}</body></html>`);
  };
  if (req.method === 'GET' && !pub.pathname.startsWith('/api/') && !pub.pathname.startsWith('/__')) {
    seen.push({ method: req.method, path: pub.pathname, search: pub.search });
    const connect = /^\/auth\/connect\/([^/]+)$/.exec(pub.pathname);
    if (connect) {
      if (usedCodes.has(connect[1])) { res.writeHead(401).end(); return; }
      usedCodes.add(connect[1]);
      res.writeHead(302, { location: '/', 'set-cookie': `opencode_session_${port()}=ok; HttpOnly; SameSite=Lax` });
      res.end();
      return;
    }
    if (pub.pathname === '/') return html('stub-opencode');
    const sess = /^\/server\/[^/]+\/session\/([^/]+)$/.exec(pub.pathname);
    if (sess) return html(`stub-opencode session ${sess[1]}`);
    res.writeHead(404).end();
    return;
  }
  if (req.headers.authorization !== expected) {
    res.writeHead(401).end();
    return;
  }
  if (req.method === 'GET' && req.url === '/api/info') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: '2.2.7', pid: process.pid }));
    return;
  }
  const url = new URL(req.url, 'http://x');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/__requests') return json(200, requests);
    if (url.pathname === '/__log') return json(200, seen);
    if (url.pathname === '/__emit' && req.method === 'POST') {
      for (const c of sseClients) c.write(raw);
      return json(200, { clients: sseClients.size });
    }
    if (url.pathname === '/api/event' && req.method === 'GET') {
      requests.push({ method: req.method, path: url.pathname, search: url.search, body: null });
      if (url.searchParams.get('fail') === '500') return json(500, { error: 'boom' });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      sseClients.add(res);
      res.on('close', () => sseClients.delete(res));
      return;
    }
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const apiRoute = url.pathname === '/api/pair' || url.pathname === '/api/session'
      || url.pathname === '/api/experimental/generate/text'
      || /^\/api\/experimental\/session\/[^/]+\/instructions\/entries\/[^/]+$/.test(url.pathname);
    if (!apiRoute) { res.writeHead(404).end(); return; }
    requests.push({ method: req.method, path: url.pathname, search: url.search, body });
    seen.push({ method: req.method, path: url.pathname, search: url.search, body });
    if (JSON.stringify(body).includes('__fail500')) return json(500, { error: 'boom' });
    if (req.method === 'POST' && url.pathname === '/api/pair') return json(200, { code: 'ABC123', expires_in: 60 });
    if (req.method === 'POST' && url.pathname === '/api/session') return json(200, { data: { id: `ses_stub${++sessionCount}` } });
    if (req.method === 'POST' && url.pathname === '/api/experimental/generate/text') return json(200, { data: { text: 'pong' } });
    if (req.method === 'PUT') return json(200, { data: {} });
    res.writeHead(404).end();
  });
});
server.listen(Number(opt('--port', '0')), opt('--hostname', '127.0.0.1'));
}
