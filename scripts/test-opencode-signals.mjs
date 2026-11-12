// Run with: node scripts/test-opencode-signals.mjs
import assert from 'node:assert/strict';

const { mapEvent } = await import('../lib/opencode/signals.ts');
const ev = (type, data = { sessionID: 's1' }, extra = {}) => ({ id: 'e', created: 1, type, data, ...extra });

const rows = [
  ['session.execution.started', 'working'],
  ['session.execution.succeeded', 'idle'],
  ['session.execution.failed', 'idle'],
  ['session.execution.interrupted', 'idle'],
  ['session.idle', 'idle'],
  ['permission.asked', 'attention'],
  ['form.created', 'attention'],
  ['permission.replied', 'attention-cleared'],
  ['form.replied', 'attention-cleared'],
  ['form.cancelled', 'attention-cleared'],
  ['session.tool.success', 'tool-finished'],
];
for (const [type, kind] of rows) {
  assert.deepEqual(mapEvent(ev(type)), { kind, sessionId: 's1' }, type);
}

assert.equal(mapEvent(ev('message.updated')), null);
assert.equal(mapEvent(null), null);
assert.equal(mapEvent(undefined), null);
assert.equal(mapEvent('session.idle'), null);
assert.equal(mapEvent(42), null);
assert.equal(mapEvent({ type: 'session.idle' }).sessionId, '');
assert.equal(mapEvent({ type: 'session.idle', data: null }).sessionId, '');
assert.deepEqual(mapEvent({ type: 'session.idle', data: {}, durable: { aggregateID: 'agg' } }), { kind: 'idle', sessionId: 'agg' });
assert.equal(mapEvent({ type: 'session.idle', data: { sessionID: 's2' }, durable: { aggregateID: 'agg' } }).sessionId, 's2');
assert.equal(mapEvent({ type: 7 }), null);
assert.equal(mapEvent({ type: 'session.idle', data: { sessionID: 5 } }).sessionId, '');

console.log('opencode signals tests passed');
