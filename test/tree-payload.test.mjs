import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { apply } from '../lib/index.js';
import { setDemoted, setLabel, stateFilePath } from '../lib/tree-state.js';

// The sidecar is read while the payload is built, so point DSH_HOME at a
// scratch directory: a test must never read or write the real one.
const HOME = mkdtempSync(join(tmpdir(), 'tree-view-payload-'));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = HOME;
test.after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
});

// The tree payload is what the panel draws, so the "no phantom branch" rule is
// asserted here: a side-chat fork (dsh-sidenote forks and archives) must not
// show up as a version, while an archived link that still has descendants is
// kept so surviving chains stay connected.
function harness(options) {
  const { archived = [], sessions } = options;
  const records = new Map();
  for (const spec of sessions) {
    const header = {
      id: spec.id,
      createdAt: spec.createdAt ?? 1,
      cwd: '/qa',
      isSeeded: spec.parent !== undefined,
      ...spec.parent === undefined ? {} : { parentSession: spec.parent },
    };
    // A seeded session's log is [inherited prefix][its own turns]. `forkTurns`
    // is how much history it copied, `ownTurns` what it did afterwards — the
    // difference between a branch and a photocopy.
    const forkTurns = spec.parent === undefined ? 0 : (spec.forkTurns ?? 1);
    const ownTurns = spec.parent === undefined ? 1 : (spec.ownTurns ?? 1);
    const totalTurns = forkTurns + ownTurns;
    const events = [{ seq: 0, time: 1, type: 'request/header', data: { header: { config: { provider: 'qa', model: 'qa' } } } }];
    for (let turn = 1; turn <= totalTurns; turn++) {
      events.push({ seq: events.length, time: turn * 3, type: 'turn/start', data: { turn } });
      events.push({ seq: events.length, time: turn * 3 + 1, type: 'user/message', data: { id: 'm' + turn, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: spec.id + ' t' + turn }] } });
      events.push({ seq: events.length, time: turn * 3 + 2, type: 'turn/end', data: { turn } });
    }
    if (spec.marker === true) {
      events.push({ seq: events.length, time: 99, type: 'message-tree/version', data: { schemaVersion: 1, sessionId: spec.id, effect: { operation: 'edit', targetTurn: forkTurns > 0 ? forkTurns : 1 } }, ignorable: true });
    }
    const inheritedEventCount = forkTurns === 0 ? 0 : 1 + forkTurns * 3;
    const session = { id: spec.id, header, inheritedEventCount, snapshotEvents: () => Object.freeze([...events]) };
    Object.defineProperty(session, 'seq', { get: () => events.length });
    Object.defineProperty(session, 'events', { get: () => { throw new Error('retired .events read'); } });
    records.set(spec.id, { session, events });
  }

  let route;
  const ctx = {
    get(name) { return this[name]; },
    effect(fn) { fn(); },
    webServer: { register(spec) { route = spec.handler; return () => {}; } },
    sessions: { get: (id) => records.get(id)?.session, flush: async () => {} },
    sessionPersistence: {},
    workspaceRegistry: {
      archivedSessionIds: archived,
      list: () => [{ sessionIds: [...records.keys()], attachSession: async () => {} }],
    },
    sessionQuery: {
      listSessions: async () => [...records.values()].map(({ session }) => ({ header: session.header })),
      readSession: async (id) => {
        const record = records.get(id);
        if (!record) throw new Error('not found');
        return {
          session: record.session.header,
          events: structuredClone(record.events),
          inheritedEventCount: record.session.inheritedEventCount,
        };
      },
    },
    agents: { get: () => undefined },
  };
  apply(ctx);

  return async function get(sessionId) {
    const request = Readable.from([]);
    request.method = 'GET';
    request.url = '/tree-view?sessionId=' + encodeURIComponent(sessionId);
    let status;
    let payload;
    await route(request, {
      writeHead(code) { status = code; },
      end(json) { payload = json === undefined ? undefined : JSON.parse(json); },
    });
    return { status, body: payload };
  };
}

test('a side-chat fork archived away from the sidebar is not drawn as a branch', async () => {
  const get = harness({
    archived: ['session-side-chat'],
    sessions: [
      { id: 'session-root' },
      { id: 'session-side-chat', parent: 'session-root', createdAt: 10 },
    ],
  });
  const response = await get('session-root');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.versions.map((v) => v.sessionId), ['session-root'],
    'the archived fork is hidden, so the user sees no branch they never made');

  const fromSideChat = await get('session-side-chat');
  assert.deepEqual(fromSideChat.body.versions.map((v) => v.sessionId), ['session-root'],
    'and asking from the side chat itself still shows the conversation that owns it');
});

test('an archived link with descendants survives, so chains stay connected', async () => {
  const get = harness({
    archived: ['session-middle'],
    sessions: [
      { id: 'session-root' },
      { id: 'session-middle', parent: 'session-root', createdAt: 10, marker: true },
      { id: 'session-leaf', parent: 'session-middle', createdAt: 20 },
    ],
  });
  const response = await get('session-leaf');
  assert.deepEqual(response.body.versions.map((v) => v.sessionId), ['session-root', 'session-middle', 'session-leaf'],
    'the archived middle version is kept because a live branch descends from it');
  assert.equal(response.body.versions[1].archived, true, 'and it is still flagged as archived for the panel');
});

test('a version the tree put away stays on the tree, name and all', async () => {
  const get = harness({
    archived: ['session-branch'],
    sessions: [
      { id: 'session-root' },
      { id: 'session-branch', parent: 'session-root', createdAt: 10, marker: true },
    ],
  });
  // "Collect into the tree" archives the branch, exactly as a side chat does —
  // what separates them is that we recorded the intent.
  setDemoted(stateFilePath(HOME), 'session-branch', true);
  setLabel(stateFilePath(HOME), 'session-branch', '方案 B');

  const response = await get('session-root');
  assert.deepEqual(response.body.versions.map((v) => v.sessionId), ['session-root', 'session-branch'],
    'an archived version the tree demoted is still part of the tree');
  assert.equal(response.body.versions[1].archived, true, 'and it still reports being out of the sidebar');
  assert.equal(response.body.versions[1].label, '方案 B', 'its name survives the round trip');

  // Releasing it (promote) drops the intent; nothing else changes the payload.
  setDemoted(stateFilePath(HOME), 'session-branch', false);
  const after = await get('session-root');
  assert.deepEqual(after.body.versions.map((v) => v.sessionId), ['session-root'],
    'once promoted it is an ordinary session again, and a branch only if it has descendants');
});

test('a live branch is untouched by the archived filter', async () => {
  const get = harness({
    archived: [],
    sessions: [
      { id: 'session-root' },
      { id: 'session-branch', parent: 'session-root', createdAt: 10, marker: true },
    ],
  });
  const response = await get('session-root');
  assert.deepEqual(response.body.versions.map((v) => v.sessionId), ['session-root', 'session-branch']);
});

test('a fork that only copied history is reported as a copy, never as edit branch', async () => {
  // The reported phantom: DSH's own fork copies the whole conversation, writes
  // no version marker and adds nothing of its own. The payload has to say what
  // it is — whether to draw it is the panel's call, because it has a switch.
  const get = harness({
    archived: [],
    sessions: [
      { id: 'session-root', forkTurns: 0, ownTurns: 14 },
      { id: 'session-copy', parent: 'session-root', createdAt: 10, forkTurns: 12, ownTurns: 0 },
    ],
  });
  const response = await get('session-root');
  const copy = response.body.versions.find((v) => v.sessionId === 'session-copy');
  assert.ok(copy, 'the payload still carries it, so the panel can choose');
  assert.equal(copy.copy, true, 'and marks it as a copy');
  assert.equal(copy.forkTurn, 12, 'with the turn it forked from');
  assert.equal(copy.targetTurn, undefined, 'so it can never be drawn as an edit branch');
  assert.equal(copy.collected, undefined, 'and nothing claims the user collected it');

  // Opening the copy itself must still show the conversation it came from.
  const fromCopy = await get('session-copy');
  assert.ok(fromCopy.body.versions.some((v) => v.sessionId === 'session-root'));
});

test('a copy the user collected into the tree is marked as collected', async () => {
  const get = harness({
    archived: ['session-copy'],
    sessions: [
      { id: 'session-root', forkTurns: 0, ownTurns: 14 },
      { id: 'session-copy', parent: 'session-root', createdAt: 10, forkTurns: 12, ownTurns: 0 },
    ],
  });
  setDemoted(stateFilePath(HOME), 'session-copy', true);
  const collected = await get('session-root');
  assert.deepEqual(collected.body.versions.map((v) => v.sessionId), ['session-root', 'session-copy'],
    'collecting a copy into the tree is an explicit statement that it belongs there');
  const copy = collected.body.versions[1];
  assert.equal(copy.copy, true, 'the panel is still told it is a copy');
  assert.equal(copy.collected, true, 'and that the tree owns it, so the filter keeps it');
  assert.equal(copy.forkTurn, 12, 'with the turn it forked from');
  setDemoted(stateFilePath(HOME), 'session-copy', false);
});

test('a fork that kept talking hangs off the turn it forked from', async () => {
  const get = harness({
    archived: [],
    sessions: [
      { id: 'session-root', forkTurns: 0, ownTurns: 14 },
      { id: 'session-fork', parent: 'session-root', createdAt: 10, forkTurns: 12, ownTurns: 2 },
    ],
  });
  const response = await get('session-root');
  const fork = response.body.versions.find((v) => v.sessionId === 'session-fork');
  assert.ok(fork, 'a fork with turns of its own is a branch');
  assert.equal(fork.forkTurn, 12, 'and it says which of its parent turns it left from');
  assert.equal(fork.targetTurn, undefined, 'it is not an edit branch: it names no target turn');
  assert.deepEqual(fork.turns.map((t) => t.turn), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    'its turns still describe the whole log; the client windows them');
});
