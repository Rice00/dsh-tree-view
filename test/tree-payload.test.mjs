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
    const events = [];
    events.push({ seq: 0, time: 1, type: 'request/header', data: { header: { config: { provider: 'qa', model: 'qa' } } } });
    events.push({ seq: 1, time: 2, type: 'turn/start', data: { turn: 1 } });
    events.push({ seq: 2, time: 3, type: 'user/message', data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: spec.id }] } });
    events.push({ seq: 3, time: 4, type: 'turn/end', data: { turn: 1 } });
    if (spec.marker === true) {
      events.push({ seq: 4, time: 5, type: 'message-tree/version', data: { schemaVersion: 1, sessionId: spec.id, effect: { operation: 'edit', targetTurn: 1 } }, ignorable: true });
    }
    const session = { id: spec.id, header, inheritedEventCount: spec.parent === undefined ? 0 : 4, snapshotEvents: () => Object.freeze([...events]) };
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
