import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { apply } from '../lib/index.js';
import {
  LABEL_MAX_LENGTH,
  legacyLabelsPath,
  normalizeLabel,
  readState,
  setDemoted,
  setLabel,
  stateFilePath,
  writeState,
} from '../lib/tree-state.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'tree-view-state-'));

test('the sidecar round-trips and tolerates damage', () => {
  const dir = scratch();
  const file = join(dir, 'nested', 'state.json');

  assert.deepEqual(readState(file), { labels: {}, demoted: {} }, 'a missing sidecar means "nothing recorded", not an error');

  writeState(file, { labels: { 'session-a': '方案 B' }, demoted: { 'session-z': true } });
  assert.deepEqual(readState(file), { labels: { 'session-a': '方案 B' }, demoted: { 'session-z': true } });
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'), 'the file stays human-readable');

  writeFileSync(file, '{ this is not json');
  assert.deepEqual(readState(file), { labels: {}, demoted: {} }, 'a truncated write must not take the tree view down');

  writeFileSync(file, '["not", "a", "map"]');
  assert.deepEqual(readState(file), { labels: {}, demoted: {} }, 'a foreign JSON shape degrades the same way');

  writeFileSync(file, JSON.stringify({ labels: { a: 'kept', b: 42, c: '' }, demoted: { d: 'yes', e: true } }));
  assert.deepEqual(readState(file), { labels: { a: 'kept' }, demoted: { e: true } }, 'only real names and real flags survive');
});

test('names written by the first release still read', () => {
  const dir = scratch();
  const file = join(dir, 'state.json');
  writeFileSync(legacyLabelsPath(file), JSON.stringify({ 'session-legacy': '旧名字' }));
  assert.deepEqual(readState(file), { labels: { 'session-legacy': '旧名字' }, demoted: {} },
    'the older labels.json is a one-way migration source');
});

test('normalizeLabel trims, collapses and bounds', () => {
  assert.equal(normalizeLabel('  方案   B  '), '方案 B');
  assert.equal(normalizeLabel(''), '');
  assert.equal(normalizeLabel('x'.repeat(LABEL_MAX_LENGTH)), 'x'.repeat(LABEL_MAX_LENGTH));
  assert.throws(() => normalizeLabel('x'.repeat(LABEL_MAX_LENGTH + 1)), TypeError);
  assert.throws(() => normalizeLabel(null), TypeError);
  assert.throws(() => normalizeLabel(7), TypeError);
});

test('names and memberships are written independently', () => {
  const dir = scratch();
  const file = join(dir, 'state.json');

  setLabel(file, 'session-a', '方案 B');
  setDemoted(file, 'session-a', true);
  setLabel(file, 'session-b', '方案 C');
  assert.deepEqual(readState(file), { labels: { 'session-a': '方案 B', 'session-b': '方案 C' }, demoted: { 'session-a': true } });

  setLabel(file, 'session-a', '');
  assert.deepEqual(readState(file), { labels: { 'session-b': '方案 C' }, demoted: { 'session-a': true } }, 'clearing a name keeps membership');

  setDemoted(file, 'session-a', false);
  assert.deepEqual(readState(file), { labels: { 'session-b': '方案 C' }, demoted: {} });
});

// The route is the only surface the client uses, so the moves are exercised
// through it: name a version, take it out of the main conversation, put it back.
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
  append('user/message', { data: undefined, id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] });
  append('turn/end', { turn: 1 });

  const registry = {
    archivedSessionIds: [],
    async archiveSession(id) {
      if (!this.archivedSessionIds.includes(id)) this.archivedSessionIds.push(id);
    },
    async enqueueOperation(job) { return job(); },
    requireState() { return { archivedSessionIds: [...registry.archivedSessionIds] }; },
    async setState(next) { registry.archivedSessionIds = [...next.archivedSessionIds]; },
    list: () => [],
  };

  let route;
  const ctx = {
    get(name) { return this[name]; },
    effect(fn) { fn(); },
    webServer: { register(spec) { route = spec.handler; return () => {}; } },
    sessions: { get: () => session, flush: async () => {} },
    sessionPersistence: {},
    workspaceRegistry: registry,
    sessionQuery: {
      listSessions: async () => [{ header }],
      readSession: async () => ({ session: header, events: structuredClone(events), inheritedEventCount: 0 }),
    },
    agents: { get: () => undefined },
  };
  apply(ctx);
  return async function request(method, body) {
    const request_ = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    request_.method = method;
    request_.url = '/tree-view?sessionId=source';
    let status;
    let payload;
    await route(request_, {
      writeHead(code) { status = code; },
      end(json) { payload = json === undefined ? undefined : JSON.parse(json); },
    });
    return { status, body: payload };
  };
}

test('the route names a version, takes it out of the main chat and puts it back', async () => {
  const home = scratch();
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const request = harness();

    let response = await request('POST', { action: 'label', sessionId: 'source', label: '  方案 B  ' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, sessionId: 'source', label: '方案 B' });

    response = await request('GET');
    assert.equal(response.body.versions[0].label, '方案 B', 'the name rides along in the payload');
    assert.deepEqual(readState(stateFilePath(home)).labels, { source: '方案 B' }, 'and it is durable');

    response = await request('POST', { action: 'demote', sessionId: 'source' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, sessionId: 'source', inMainChat: false, changed: true });
    assert.deepEqual(readState(stateFilePath(home)).demoted, { source: true }, 'the tree owns this one now');

    response = await request('POST', { action: 'promote', sessionId: 'source' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, sessionId: 'source', inMainChat: true, changed: true });
    assert.deepEqual(readState(stateFilePath(home)).demoted, {}, 'and the tree lets go of it again');

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
