import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hiddenIds, hide, probe, show, support } from '../lib/archive-adapter.js';

// A registry that looks like this build's WorkspaceRegistry: the archive set,
// the supported archive call, and the state discipline unarchiving needs.
function registry(overrides = {}) {
  const state = { archivedSessionIds: ['session-hidden'] };
  return Object.assign({
    get archivedSessionIds() { return state.archivedSessionIds; },
    async archiveSession(id) {
      if (!state.archivedSessionIds.includes(id)) state.archivedSessionIds = [...state.archivedSessionIds, id];
    },
    async enqueueOperation(job) { return job(); },
    requireState() { return { ...state }; },
    async setState(next) { state.archivedSessionIds = [...next.archivedSessionIds]; },
  }, overrides);
}

const ctxWith = (value) => ({ get: (name) => (name === 'workspaceRegistry' ? value : undefined) });

test('a full host probes as fully supported, and both directions work', async () => {
  const probed = probe(ctxWith(registry()));
  assert.deepEqual(support(probed), { ok: true, read: true, hide: true, show: true, missing: [] });
  assert.deepEqual([...hiddenIds(probed)], ['session-hidden']);

  assert.deepEqual(await hide(probed, 'session-hidden'), { ok: true, changed: false }, 'hiding a hidden one changes nothing');
  assert.deepEqual(await hide(probed, 'session-fresh'), { ok: true, changed: true });
  assert.ok(hiddenIds(probed).has('session-fresh'));

  assert.deepEqual(await show(probed, 'session-fresh'), { ok: true, changed: true });
  assert.ok(!hiddenIds(probed).has('session-fresh'), 'unarchiving writes the registry state');
});

test('a host with no registry reports exactly that, and refuses instead of throwing', async () => {
  const probed = probe(ctxWith(undefined));
  assert.deepEqual(support(probed).missing, ['workspaceRegistry']);
  assert.equal(support(probed).ok, false);
  assert.deepEqual(await hide(probed, 'session-a'), { ok: false, reason: 'archive-unavailable' });
  assert.deepEqual(await show(probed, 'session-a'), { ok: false, reason: 'unarchive-unavailable' });
  assert.deepEqual([...hiddenIds(probed)], [], 'an unreadable archive set means "nothing is hidden"');
});

test('a host that cannot archive says which half is missing', async () => {
  const probed = probe(ctxWith(registry({ archiveSession: undefined })));
  assert.deepEqual(support(probed), {
    ok: false, read: true, hide: false, show: true,
    missing: ['workspaceRegistry.archiveSession'],
  });
  assert.deepEqual(await hide(probed, 'session-a'), { ok: false, reason: 'archive-unavailable' });
  assert.equal((await show(probed, 'session-hidden')).ok, true, 'showing is a different code path and still works');
});

test('a host that cannot write registry state cannot unarchive', async () => {
  const probed = probe(ctxWith(registry({ setState: undefined })));
  assert.deepEqual(support(probed), {
    ok: false, read: true, hide: true, show: false,
    missing: ['workspaceRegistry.{enqueueOperation,requireState,setState}'],
  });
  assert.deepEqual(await show(probed, 'session-hidden'), { ok: false, reason: 'unarchive-unavailable' });
  assert.equal((await hide(probed, 'session-a')).ok, true, 'hiding needs no state write of ours');
});

test('an unreadable archive set is not guessed at', async () => {
  // A host that stopped exposing the archive set: hiding can still be attempted
  // (it is idempotent on the host's side), but unarchiving must not pretend it
  // knows whether the session is hidden, and nothing may claim "no sessions are
  // hidden" on its behalf.
  const probed = probe(ctxWith({
    async archiveSession() {},
    async enqueueOperation(job) { return job(); },
    requireState() { return { archivedSessionIds: [] }; },
    async setState() {},
  }));
  assert.equal(probed.canRead, false);
  assert.deepEqual(support(probed).missing, ['workspaceRegistry.archivedSessionIds']);
  assert.deepEqual([...hiddenIds(probed)], []);
  assert.deepEqual(await show(probed, 'session-hidden'), { ok: false, reason: 'archive-state-unreadable' });
  assert.deepEqual(await hide(probed, 'session-a'), { ok: true, changed: true }, 'hiding is still attempted');
});

test('a failing archive call is a value, not an exception', async () => {
  const probed = probe(ctxWith(registry({
    async archiveSession() { throw new Error('registry refused'); },
  })));
  assert.deepEqual(await hide(probed, 'session-a'), {
    ok: false, reason: 'archive-failed', message: 'registry refused',
  });
});
