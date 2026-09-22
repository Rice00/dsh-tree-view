import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { apply } from '../lib/index.js';
import {
  LABEL_MAX_LENGTH,
  labelsFilePath,
  normalizeLabel,
  readLabels,
  setLabel,
  writeLabels,
} from '../lib/labels.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'tree-view-labels-'));

test('labels sidecar round-trips and tolerates damage', () => {
  const dir = scratch();
  const file = join(dir, 'nested', 'labels.json');

  assert.deepEqual(readLabels(file), {}, 'a missing sidecar means "no labels", not an error');

  writeLabels(file, { 'session-a': '方案 B' });
  assert.deepEqual(readLabels(file), { 'session-a': '方案 B' });
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'), 'the file stays human-readable');

  writeFileSync(file, '{ this is not json');
  assert.deepEqual(readLabels(file), {}, 'a truncated write must not take the tree view down');

  writeFileSync(file, '["not", "a", "map"]');
  assert.deepEqual(readLabels(file), {}, 'a foreign JSON shape degrades the same way');

  writeFileSync(file, JSON.stringify({ 'session-a': 'kept', 'session-b': 42, 'session-c': '' }));
  assert.deepEqual(readLabels(file), { 'session-a': 'kept' }, 'only non-empty strings are labels');
});

test('normalizeLabel trims, collapses and bounds', () => {
  assert.equal(normalizeLabel('  方案   B  '), '方案 B');
  assert.equal(normalizeLabel(''), '');
  assert.equal(normalizeLabel('x'.repeat(LABEL_MAX_LENGTH)), 'x'.repeat(LABEL_MAX_LENGTH));
  assert.throws(() => normalizeLabel('x'.repeat(LABEL_MAX_LENGTH + 1)), TypeError);
  assert.throws(() => normalizeLabel(null), TypeError);
  assert.throws(() => normalizeLabel(7), TypeError);
});

test('setLabel writes, and an empty label clears without touching the others', () => {
  const dir = scratch();
  const file = join(dir, 'labels.json');

  setLabel(file, 'session-a', '方案 B');
  setLabel(file, 'session-b', '方案 C');
  assert.deepEqual(readLabels(file), { 'session-a': '方案 B', 'session-b': '方案 C' });

  setLabel(file, 'session-a', '');
  assert.deepEqual(readLabels(file), { 'session-b': '方案 C' });
});

// The route is the only surface the client uses, so at least one test has to go
// through it: POST a label, then read it back out of the tree payload.
function harness() {
  const events = [];
  const header = { id: 'source', createdAt: 1, cwd: '/qa', isSeeded: false };
  const session = {
    id: 'source',
    header,
    inheritedEventCount: 0,
    snapshotEvents: () => Object.freeze([...events]),
  };
  Object.defineProperty(session, 'seq', { get: () => events.length });
  Object.defineProperty(session, 'events', { get: () => { throw new Error('retired .events read'); } });
  const append = (type, data) => events.push({ seq: events.length, time: events.length + 10, type, data });
  append('request/header', { header: { config: { provider: 'qa', model: 'qa' } } });
  append('turn/start', { turn: 1 });
  append('user/message', { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] });
  append('turn/end', { turn: 1 });

  let route;
  const ctx = {
    get(name) { return this[name]; },
    effect(fn) { fn(); },
    webServer: { register(spec) { route = spec.handler; return () => {}; } },
    sessions: { get: () => session, flush: async () => {} },
    sessionPersistence: {},
    workspaceRegistry: { archivedSessionIds: [], list: () => [] },
    sessionQuery: {
      listSessions: async () => [{ header }],
      readSession: async () => ({ session: header, events: structuredClone(events), inheritedEventCount: 0 }),
    },
    agents: { get: () => undefined },
  };
  apply(ctx);
  return async function request(method, body) {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.method = method;
    req.url = '/tree-view?sessionId=source';
    let status;
    let payload;
    await route(req, {
      writeHead(code) { status = code; },
      end(json) { payload = json === undefined ? undefined : JSON.parse(json); },
    });
    return { status, body: payload };
  };
}

test('the route names one version and hands the name back in the tree payload', async () => {
  const home = scratch();
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const request = harness();

    let response = await request('POST', { action: 'label', sessionId: 'source', label: '  方案 B  ' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, sessionId: 'source', label: '方案 B' });

    response = await request('GET');
    assert.equal(response.status, 200);
    assert.equal(response.body.versions.length, 1);
    assert.equal(response.body.versions[0].label, '方案 B', 'the label rides along in the payload');
    assert.deepEqual(readLabels(labelsFilePath(home)), { source: '方案 B' }, 'and it is durable');

    response = await request('POST', { action: 'label', sessionId: 'source', label: '' });
    assert.equal(response.status, 200);
    response = await request('GET');
    assert.ok(!('label' in response.body.versions[0]), 'an empty label removes the field entirely');

    response = await request('POST', { action: 'label', sessionId: 'source', label: 42 });
    assert.equal(response.status, 400, 'a non-string label is a bad request, not a 500');

    response = await request('POST', { action: 'label', label: 'orphan' });
    assert.equal(response.status, 400, 'a missing sessionId is rejected too');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});
