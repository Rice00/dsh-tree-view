// Host coupling for hiding and showing sessions, in one place.
//
// Everything this plugin does to the sidebar goes through here: reading the
// archive set, archiving a session, and unarchiving one. That is deliberate.
// `ctx.workspaceRegistry` is a first-class cordis service, but this build has no
// unarchive API at all — the plugin has to write the registry's own state — so
// the seam is the part of the plugin most likely to break when the host moves.
// Keeping it in one module means a host change is one file to fix, and one place
// to probe.
//
// The probe is the point of the module. A version gate would only say "the host
// changed"; a capability probe says WHAT is missing, which is what the panel
// needs in order to disable exactly the affordances that cannot work instead of
// failing at click time — or worse, hiding a session it can no longer show.

/** What the running host can actually do, right now. */
export function probe(ctx) {
  const registry = ctx.get('workspaceRegistry');
  const missing = [];
  if (registry === undefined) {
    return { registry: undefined, canRead: false, canHide: false, canShow: false, missing: ['workspaceRegistry'] };
  }
  const canRead = Array.isArray(registry.archivedSessionIds);
  const canHide = typeof registry.archiveSession === 'function';
  // Unarchiving is written by hand, so it needs the whole state discipline the
  // registry uses internally: the same queue, the same read, the same write.
  const canShow = typeof registry.enqueueOperation === 'function'
    && typeof registry.requireState === 'function'
    && typeof registry.setState === 'function';
  if (!canRead) missing.push('workspaceRegistry.archivedSessionIds');
  if (!canHide) missing.push('workspaceRegistry.archiveSession');
  if (!canShow) missing.push('workspaceRegistry.{enqueueOperation,requireState,setState}');
  return { registry, canRead, canHide, canShow, missing };
}

/** The probe, in the shape the browser half gets: what works, what does not. */
export function support(probed) {
  return {
    ok: probed.canRead && probed.canHide && probed.canShow,
    read: probed.canRead,
    hide: probed.canHide,
    show: probed.canShow,
    missing: probed.missing,
  };
}

/** The sessions the sidebar is hiding. Without a readable set: none. */
export function hiddenIds(probed) {
  return new Set(probed.canRead ? probed.registry.archivedSessionIds : []);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Hide a session from the sidebar. Never throws: a refusal is a value, because
 * every caller has a sensible fallback (leave it visible).
 */
export async function hide(probed, sessionId) {
  if (!probed.canHide) return { ok: false, reason: 'archive-unavailable' };
  if (probed.canRead && hiddenIds(probed).has(sessionId)) return { ok: true, changed: false };
  try {
    await probed.registry.archiveSession(sessionId);
    return { ok: true, changed: true };
  } catch (error) {
    return { ok: false, reason: 'archive-failed', message: messageOf(error) };
  }
}

/** Show it again, through the state write this build leaves to us. */
export async function show(probed, sessionId) {
  if (!probed.canShow) return { ok: false, reason: 'unarchive-unavailable' };
  if (!probed.canRead) return { ok: false, reason: 'archive-state-unreadable' };
  if (!hiddenIds(probed).has(sessionId)) return { ok: true, changed: false };
  try {
    await probed.registry.enqueueOperation(async () => {
      const state = probed.registry.requireState();
      if (!state.archivedSessionIds.includes(sessionId)) return;
      await probed.registry.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
      });
    });
    return { ok: true, changed: true };
  } catch (error) {
    return { ok: false, reason: 'unarchive-failed', message: messageOf(error) };
  }
}
