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
      // A subagent session is a child session like a fork, and only `origin`
      // tells the two apart.
      ...spec.origin === undefined ? {} : { origin: spec.origin },
      ...spec.delegationDepth === undefined ? {} : { delegationDepth: spec.delegationDepth },
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
  const archiveMode = options.archive ?? 'full';
  const archivedIds = [...archived];
  const running = new Set(options.running ?? []);
  const stopped = [];
  // The archive seam as a host may hand it over: complete, without the archive
  // call, without our state write path, or absent entirely.
  const registry = archiveMode === 'none' ? undefined : {
    archivedSessionIds: archivedIds,
    ...archiveMode === 'no-archive' ? {} : {
      async archiveSession(id) { if (!archivedIds.includes(id)) archivedIds.push(id); },
    },
    ...archiveMode === 'no-state' ? {} : {
      async enqueueOperation(job) { return job(); },
      requireState() { return { archivedSessionIds: [...archivedIds] }; },
      async setState(next) { archivedIds.splice(0, archivedIds.length, ...next.archivedSessionIds); },
    },
    list: () => [{ sessionIds: [...records.keys()], attachSession: async () => {} }],
  };
  const ctx = {
    get(name) { return name === 'workspaceRegistry' ? registry : this[name]; },
    effect(fn) { fn(); },
    webServer: { register(spec) { route = spec.handler; return () => {}; } },
    sessions: { get: (id) => records.get(id)?.session, flush: async () => {} },
    sessionPersistence: {},
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
    // The agent loop is what says whether a session is mid-turn; the double
    // reports the same shape the panel reads.
    agents: {
      get: (id) => (running.has(id)
        ? { phase: { kind: 'running' }, cancel() { stopped.push(id); }, async whenIdle() {} }
        : { phase: { kind: 'idle' } }),
    },
  };
  apply(ctx);

  async function request(method, payload) {
    const stream = Readable.from(payload === undefined ? [] : [JSON.stringify(payload)]);
    stream.method = method;
    stream.url = '/tree-view?sessionId=' + encodeURIComponent(payload?.sessionId ?? '');
    let status;
    let body;
    await route(stream, {
      writeHead(code) { status = code; },
      end(json) { body = json === undefined ? undefined : JSON.parse(json); },
    });
    return { status, body };
  }

  const get = (sessionId) => request('GET', { sessionId });
  // The returned function is the GET helper; the extras ride along so existing
  // call sites keep working.
  get.post = (payload) => request('POST', payload);
  get.archivedIds = archivedIds;
  get.stopped = stopped;
  get.running = running;
  return get;
}

test('a subagent conversation in the family is flagged as one', async () => {
  // Measured on this machine's real sessions: a subagent session carries
  // `origin: 'subagent'` with `parentSession` pointing at the conversation and the
  // same cwd — which is exactly the family walk's key, so the tree drew it as if
  // it were a branch of the user's own message. The payload has to say what it is.
  const get = harness({
    sessions: [
      { id: 'session-root' },
      { id: 'session-delegate', parent: 'session-root', createdAt: 10, origin: 'subagent', delegationDepth: 1 },
      { id: 'session-sub-delegate', parent: 'session-delegate', createdAt: 11, origin: 'subagent', delegationDepth: 2 },
    ],
  });
  const response = await get('session-root');
  const byId = new Map(response.body.versions.map((v) => [v.sessionId, v]));
  assert.equal(byId.get('session-delegate').subagent, true, 'the subagent session is flagged');
  assert.equal(byId.get('session-sub-delegate').subagent, true, 'and so is its own child');
  assert.equal(byId.get('session-sub-delegate').delegationDepth, 2, 'with the depth when it is nested');
  assert.equal(byId.get('session-root').subagent, undefined, 'the conversation itself is not');
});

test('an archived fork stays in the tree, marked as archived', async () => {
  // Reported: a fork made at turn 44 and archived by hand could not be found in
  // the Tree any more. Archiving is a sidebar action; the tree is where a
  // conversation's versions live, so it must keep drawing it (dimmed, and
  // offering to go back into the main chat).
  const get = harness({
    archived: ['session-fork'],
    sessions: [
      { id: 'session-root' },
      { id: 'session-fork', parent: 'session-root', createdAt: 10 },
    ],
  });
  const response = await get('session-root');
  assert.equal(response.status, 200);
  const byId = new Map(response.body.versions.map((v) => [v.sessionId, v]));
  assert.deepEqual([...byId.keys()], ['session-root', 'session-fork'],
    'the archived fork is still a version of this conversation');
  assert.equal(byId.get('session-fork').archived, true, 'and the payload says how it is stored');

  const fromFork = await get('session-fork');
  assert.deepEqual(fromFork.body.versions.map((v) => v.sessionId), ['session-root', 'session-fork'],
    'asking from the fork itself shows the same family');
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
  // "Collect into the tree" archives the branch, exactly as the app's own archive
  // does; what the tree records is its name and that it did the collecting.
  setDemoted(stateFilePath(HOME), 'session-branch', true);
  setLabel(stateFilePath(HOME), 'session-branch', '方案 B');

  const response = await get('session-root');
  assert.deepEqual(response.body.versions.map((v) => v.sessionId), ['session-root', 'session-branch'],
    'an archived version the tree demoted is still part of the tree');
  assert.equal(response.body.versions[1].archived, true, 'and it still reports being out of the sidebar');
  assert.equal(response.body.versions[1].label, '方案 B', 'its name survives the round trip');

  // Releasing it (promote) drops the intent; the version stays either way, only
  // its archived flag changes.
  setDemoted(stateFilePath(HOME), 'session-branch', false);
  const after = await get('session-root');
  assert.deepEqual(after.body.versions.map((v) => v.sessionId), ['session-root', 'session-branch'],
    'a version is drawn whether or not it sits in the sidebar');
});

test('collecting the others refuses while something runs, then stops and collects', async () => {
  const get = harness({
    archived: [],
    running: ['session-branch'],
    sessions: [
      { id: 'session-root', forkTurns: 0, ownTurns: 14 },
      { id: 'session-branch', parent: 'session-root', createdAt: 10, marker: true },
    ],
  });

  const refused = await get.post({ action: 'demoteOthers', sessionId: 'session-root' });
  assert.equal(refused.status, 409, 'a running branch is not collected silently');
  assert.deepEqual(refused.body.busy, ['session-branch'], 'and the panel is told which one');
  assert.deepEqual(get.archivedIds, [], 'nothing was archived by the refusal');

  const confirmed = await get.post({ action: 'demoteOthers', sessionId: 'session-root', stopRunning: true });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(confirmed.body.collected, ['session-branch'], 'the other version is collected');
  assert.deepEqual(confirmed.body.stopped, ['session-branch'], 'and its turn was stopped');
  assert.deepEqual(get.stopped, ['session-branch']);
  assert.deepEqual(get.archivedIds, ['session-branch'], 'it left the sidebar');

  const after = await get('session-root');
  assert.deepEqual(after.body.versions.map((v) => v.sessionId), ['session-root', 'session-branch'],
    'a collected branch stays on the tree — that is the whole point of collecting it');
});

test('collecting the others never touches the conversation being viewed', async () => {
  const get = harness({
    archived: [],
    sessions: [
      { id: 'session-root', forkTurns: 0, ownTurns: 14 },
      { id: 'session-branch', parent: 'session-root', createdAt: 10, marker: true },
    ],
  });
  const response = await get.post({ action: 'demoteOthers', sessionId: 'session-root' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.collected, ['session-branch']);
  assert.ok(!get.archivedIds.includes('session-root'), 'the open conversation is never archived');
  assert.deepEqual(response.body.stopped, [], 'and nothing needed stopping');
});

test('the payload states what the host can do about hiding sessions', async () => {
  const full = harness({ archived: [], sessions: [{ id: 'session-root' }] });
  const fullPayload = await full('session-root');
  assert.deepEqual(fullPayload.body.archiveSupport, { ok: true, read: true, hide: true, show: true, missing: [] });

  const noArchive = harness({ archived: [], archive: 'no-archive', sessions: [{ id: 'session-root' }] });
  const degraded = await noArchive('session-root');
  assert.equal(degraded.body.archiveSupport.hide, false);
  assert.deepEqual(degraded.body.archiveSupport.missing, ['workspaceRegistry.archiveSession'],
    'the payload names the missing piece, so the panel can say which control is off');

  const none = harness({ archived: [], archive: 'none', sessions: [{ id: 'session-root' }] });
  assert.deepEqual((await none('session-root')).body.archiveSupport.missing, ['workspaceRegistry']);
});

test('a host that cannot archive refuses the move with a code, not a stack', async () => {
  const get = harness({
    archived: [],
    archive: 'no-archive',
    sessions: [
      { id: 'session-root', forkTurns: 0, ownTurns: 14 },
      { id: 'session-branch', parent: 'session-root', createdAt: 10, marker: true },
    ],
  });
  const demote = await get.post({ action: 'demote', sessionId: 'session-branch' });
  assert.equal(demote.status, 409);
  assert.equal(demote.body.code, 'archive-unavailable');
  assert.deepEqual(get.archivedIds, [], 'and nothing was archived');

  const collect = await get.post({ action: 'demoteOthers', sessionId: 'session-root' });
  assert.equal(collect.status, 200);
  assert.deepEqual(collect.body.collected, [], 'nothing could be collected');
  assert.deepEqual(collect.body.failed, [{ sessionId: 'session-branch', reason: 'archive-unavailable' }],
    'and the panel is told why, per version');
});

test('a host that cannot write registry state refuses to put a branch back', async () => {
  const get = harness({
    archived: ['session-branch'],
    archive: 'no-state',
    sessions: [
      { id: 'session-root', forkTurns: 0, ownTurns: 14 },
      { id: 'session-branch', parent: 'session-root', createdAt: 10, marker: true },
    ],
  });
  const promote = await get.post({ action: 'promote', sessionId: 'session-branch' });
  assert.equal(promote.status, 409);
  assert.equal(promote.body.code, 'unarchive-unavailable');
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
