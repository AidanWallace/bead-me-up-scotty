// Run with: node scripts/test-opencode-urls.mjs
import assert from 'node:assert/strict';

const { iframeHost, connectUrl, sessionUrl, isLoopbackHost } = await import('../lib/opencode/urls.ts');

assert.equal(iframeHost('localhost:3000'), 'localhost');
assert.equal(iframeHost('127.0.0.1:3197'), '127.0.0.1');
assert.equal(iframeHost('[::1]:3000'), '[::1]');
assert.equal(iframeHost('mybox.local'), 'mybox.local');
assert.equal(iframeHost(null), 'localhost');
assert.equal(iframeHost(''), 'localhost');

assert.equal(connectUrl('localhost', 4096, 'abc'), 'http://localhost:4096/auth/connect/abc');

const b64 = (s) => Buffer.from(s).toString('base64url');
assert.equal(sessionUrl('localhost', 4096, 'ses_1'), `http://localhost:4096/server/${b64('http://localhost:4096')}/session/ses_1`);
assert.equal(sessionUrl('127.0.0.1', 49555, 'ses_1'), 'http://127.0.0.1:49555/server/aHR0cDovLzEyNy4wLjAuMTo0OTU1NQ/session/ses_1');
assert.ok(!sessionUrl('localhost', 1, 's').includes('='));

for (const h of ['localhost', '127.0.0.1', '127.1.2.3']) assert.equal(isLoopbackHost(h), true, h);
for (const h of ['[::1]', 'mybox.local', '192.168.1.5']) assert.equal(isLoopbackHost(h), false, h);

console.log('opencode urls: ok');
