// dsh-tree-view — client half.
//
// Mimics ChatGPT's edit-message behavior: hover a past prompt to edit it,
// sending branches the conversation from that point (the host half performs
// the true rewind); ‹ 2/3 › switches between versions of the same message;
// a Versions view draws the whole tree.

// Route, CSS prefix, i18n namespace and storage keys all moved off the upstream
// `message-tree` spelling (`/tree-view`, `dsh-tree-view:*`) so this fork and
// dsh-plugin-message-edit can be installed together without their routes,
// locales or persisted UI state colliding. The durable event type keeps the
// upstream name on purpose — see the note in lib/index.js.
const ROUTE = '/tree-view';
const VIEW_ORDER = 16;

function realGlobal() {
  try { if (typeof window !== 'undefined' && window) return window; } catch (e) {}
  try { if (typeof globalThis !== 'undefined' && globalThis) return globalThis; } catch (e) {}
  return null;
}

/* ------------------------------------------------------------- edit style -- */

// Which provider's message-edit LAYOUT to follow. All three put the controls
// below the bubble; what differs is which controls exist (only Claude offers
// retry), whether they wait for hover (ChatGPT and Claude) or stay visible
// (DeepSeek, like DSH itself), and whether the editor's Cancel/confirm sit
// inside the box or below it. Colours stay native in every preset. The choice
// is one attribute on <html>, so the stylesheet keys off it and switching
// takes effect live.
const STYLE_KEY = 'dsh-tree-view:style';
const STYLES = ['chatgpt', 'deepseek', 'claude'];
const DEFAULT_STYLE = 'chatgpt';

const styleStore = {
  value: null,
  listeners: [],
  get() {
    if (this.value === null) {
      const g = realGlobal();
      let stored = null;
      try { stored = g && g.localStorage && g.localStorage.getItem(STYLE_KEY); } catch (e) {}
      this.value = STYLES.indexOf(stored) !== -1 ? stored : DEFAULT_STYLE;
    }
    return this.value;
  },
  set(next) {
    this.value = STYLES.indexOf(next) !== -1 ? next : DEFAULT_STYLE;
    const g = realGlobal();
    try { if (g && g.localStorage) g.localStorage.setItem(STYLE_KEY, this.value); } catch (e) {}
    syncStyleAttribute();
    for (let i = 0; i < this.listeners.length; i++) {
      try { this.listeners[i](); } catch (e) {}
    }
  },
  subscribe(fn) {
    const listeners = this.listeners;
    listeners.push(fn);
    return function () {
      const at = listeners.indexOf(fn);
      if (at !== -1) listeners.splice(at, 1);
    };
  },
};

function syncStyleAttribute() {
  const g = realGlobal();
  const root = g && g.document && g.document.documentElement;
  if (root) root.setAttribute('data-mtx-style', styleStore.get());
}

/* ----------------------------------------------------------- active path -- */

// A version IS a whole session, so "which version am I looking at" is just
// "which session is open". Reopening a conversation lands on whichever session
// the sidebar points at — normally the family root — so a branch you had
// selected is silently dropped and the ring snaps back to 1/N.
//
// Remember the last session viewed for each family, keyed by the family's root,
// and restore it when you land back on that root. Recording happens for every
// family member you view, so walking the ring back to the root records the root
// and the restore then correctly does nothing (no ping-pong).
const PATH_KEY = 'dsh-tree-view:active-path';
const PATH_LIMIT = 200;

const activePathStore = {
  map: null,
  read() {
    if (this.map === null) {
      let parsed = null;
      try {
        const g = realGlobal();
        const raw = g && g.localStorage && g.localStorage.getItem(PATH_KEY);
        parsed = raw ? JSON.parse(raw) : null;
      } catch (e) {}
      this.map = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    return this.map;
  },
  get(rootId) {
    if (!rootId) return undefined;
    const v = this.read()[rootId];
    return typeof v === 'string' ? v : undefined;
  },
  set(rootId, sessionId) {
    if (!rootId || !sessionId) return;
    const map = this.read();
    if (map[rootId] === sessionId) return;
    map[rootId] = sessionId;
    // Bound the map so a long-lived profile cannot grow it without limit.
    // Object key order is insertion order for string keys, so the oldest
    // entries are at the front.
    const keys = Object.keys(map);
    if (keys.length > PATH_LIMIT) {
      for (let i = 0; i < keys.length - PATH_LIMIT; i++) delete map[keys[i]];
    }
    try {
      const g = realGlobal();
      if (g && g.localStorage) g.localStorage.setItem(PATH_KEY, JSON.stringify(map));
    } catch (e) {}
  },
};

/** The family root for `sessionId`: walk parents until one has none. */
function rootOf(versions, sessionId) {
  if (!versions || sessionId === undefined) return undefined;
  const byId = new Map(versions.map(function (v) { return [v.sessionId, v]; }));
  let cursor = byId.get(sessionId);
  if (!cursor) return undefined;
  const seen = new Set();
  while (cursor.parentSessionId && !seen.has(cursor.sessionId)) {
    seen.add(cursor.sessionId);
    const parent = byId.get(cursor.parentSessionId);
    if (!parent) break;
    cursor = parent;
  }
  return cursor.sessionId;
}

// Families already restored in this page load. Without this the restore would
// re-fire on every re-render and fight a deliberate walk back to the root.
const restoredFamilies = new Set();
// Restores that have been triggered but whose navigation has not landed yet.
// While a root is in here we must not record it as the selection.
const pendingRestore = new Set();

/* --------------------------------------------------------------- prefs -- */

// Behaviour toggles, persisted next to the style choice. Both default to the
// behaviour the user asked for rather than the old one.
const PREFS_KEY = 'dsh-tree-view:prefs';
const PREFS_DEFAULTS = {
  // Restore the last-viewed branch when reopening a conversation.
  rememberPath: true,
  // Cancel a still-running turn before an edit forks the conversation.
  stopOnEdit: true,
  // Hide forks that copied the conversation and never added a turn of their own.
  // On by default, because a photocopy drawn as a branch doubles the canvas; the
  // switch in the Tree panel is there for when you want to see them anyway.
  dropEmptyForks: true,
};

const prefsStore = {
  value: null,
  listeners: [],
  get() {
    if (this.value === null) {
      let parsed = null;
      try {
        const g = realGlobal();
        const raw = g && g.localStorage && g.localStorage.getItem(PREFS_KEY);
        parsed = raw ? JSON.parse(raw) : null;
      } catch (e) {}
      const out = {};
      for (const k in PREFS_DEFAULTS) {
        out[k] = parsed && typeof parsed[k] === 'boolean' ? parsed[k] : PREFS_DEFAULTS[k];
      }
      this.value = out;
    }
    return this.value;
  },
  set(patch) {
    const next = Object.assign({}, this.get(), patch);
    this.value = next;
    try {
      const g = realGlobal();
      if (g && g.localStorage) g.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch (e) {}
    for (let i = 0; i < this.listeners.length; i++) {
      try { this.listeners[i](); } catch (e) {}
    }
  },
  subscribe(fn) {
    const listeners = this.listeners;
    listeners.push(fn);
    return function () {
      const at = listeners.indexOf(fn);
      if (at !== -1) listeners.splice(at, 1);
    };
  },
};

function usePrefs() {
  const [, force] = React.useReducer(function (x) { return x + 1; }, 0);
  React.useEffect(function () { return prefsStore.subscribe(force); }, []);
  return prefsStore.get();
}

function useStyle() {
  const [, force] = React.useReducer(function (x) { return x + 1; }, 0);
  React.useEffect(function () { return styleStore.subscribe(force); }, []);
  return styleStore.get();
}

/* ------------------------------------------------------- timeline store -- */

const MAX_CACHED_SESSIONS = 500;
const MAX_CACHED_ROOTS = 50;

// High-performance family-aware tree cache with zero-flicker Stale-While-Revalidate.
const treeStore = {
  bySession: new Map(),
  byRoot: new Map(),
  inflight: new Map(),
  listeners: [],

  get(sessionId) {
    if (!sessionId) return null;
    return this.bySession.get(sessionId) || null;
  },

  notify() {
    for (let i = 0; i < this.listeners.length; i++) {
      try { this.listeners[i](); } catch (e) {}
    }
  },

  subscribe(fn) {
    const listeners = this.listeners;
    listeners.push(fn);
    return function () {
      const at = listeners.indexOf(fn);
      if (at !== -1) listeners.splice(at, 1);
    };
  },

  _prune() {
    while (this.bySession.size > MAX_CACHED_SESSIONS) {
      const oldestKey = this.bySession.keys().next().value;
      this.bySession.delete(oldestKey);
    }
    while (this.byRoot.size > MAX_CACHED_ROOTS) {
      const oldestKey = this.byRoot.keys().next().value;
      this.byRoot.delete(oldestKey);
    }
  },

  setTree(sessionId, versions, timestamp, archiveSupport) {
    if (!Array.isArray(versions)) versions = [];
    const rootId = rootOf(versions, sessionId) || sessionId;
    const updatedAt = typeof timestamp === 'number' ? timestamp : Date.now();
    const existingRoot = this.byRoot.get(rootId);
    if (existingRoot && (existingRoot.updatedAt || 0) > updatedAt) {
      return;
    }

    const entry = {
      versions: versions,
      rootId: rootId,
      loading: false,
      error: null,
      updatedAt: updatedAt,
      // The host's capability report travels with the payload: the panel uses
      // it to disable what cannot work.
      archiveSupport: archiveSupport ?? (existingRoot && existingRoot.archiveSupport) ?? null,
    };
    this.byRoot.set(rootId, entry);

    for (let i = 0; i < versions.length; i++) {
      const v = versions[i];
      if (v && v.sessionId && !v.deleted) {
        this.bySession.set(v.sessionId, entry);
      }
    }
    this.bySession.set(sessionId, entry);
    this._prune();
    this.notify();
  },

  /**
   * Patch one version inside the cached family.
   *
   * The host answers a move immediately, but the refetch that follows is a
   * round trip; without this the menu would still offer "collect into the tree"
   * right after doing exactly that. The refetch then reconciles whatever the
   * host actually settled on.
   */
  patchVersion(sessionId, versionSessionId, patch) {
    const entry = this.bySession.get(sessionId);
    if (!entry || !Array.isArray(entry.versions)) return;
    const versions = entry.versions.map(function (v) {
      return v && v.sessionId === versionSessionId ? Object.assign({}, v, patch) : v;
    });
    this.setTree(sessionId, versions, entry.updatedAt || Date.now());
  },

  async load(sessionId) {
    if (!sessionId) return;
    const g = realGlobal();
    if (!g || typeof g.fetch !== 'function') return;

    if (this.inflight.has(sessionId)) return this.inflight.get(sessionId);

    const existing = this.bySession.get(sessionId);
    const reqTime = Date.now();
    if (existing) {
      this.bySession.set(sessionId, Object.assign({}, existing, { loading: true }));
    } else {
      this.bySession.set(sessionId, { versions: null, loading: true, error: null, updatedAt: 0 });
    }

    const self = this;
    const promise = (async function () {
      try {
        const res = await g.fetch(ROUTE + '?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        self.setTree(sessionId, data.versions, reqTime, data.archiveSupport);
      } catch (e) {
        const errStr = String((e && e.message) || e);
        const prev = self.bySession.get(sessionId);
        self.bySession.set(sessionId, {
          versions: prev ? prev.versions : null,
          loading: false,
          error: errStr,
          updatedAt: prev ? prev.updatedAt : 0,
          archiveSupport: prev ? prev.archiveSupport : null,
        });
        self.notify();
      } finally {
        self.inflight.delete(sessionId);
      }
    })();

    this.inflight.set(sessionId, promise);
    return promise;
  },

  ensure(sessionId) {
    if (!sessionId) return;
    const entry = this.bySession.get(sessionId);
    if (!entry || !entry.versions) {
      this.load(sessionId);
    } else if (Date.now() - (entry.updatedAt || 0) > 8000 && !entry.loading) {
      this.load(sessionId);
    }
  },

  invalidate(sessionId) {
    if (sessionId) {
      const entry = this.bySession.get(sessionId);
      if (entry && entry.rootId) {
        const rootEntry = this.byRoot.get(entry.rootId);
        if (rootEntry) rootEntry.updatedAt = 0;
      }
      this.load(sessionId);
    } else {
      this.bySession.forEach(function (e) { if (e) e.updatedAt = 0; });
      this.byRoot.forEach(function (e) { if (e) e.updatedAt = 0; });
      this.notify();
    }
  },
};

function useTree(sessionId) {
  const [, force] = React.useReducer(function (x) { return x + 1; }, 0);
  React.useEffect(function () { return treeStore.subscribe(force); }, []);
  React.useEffect(function () { if (sessionId) treeStore.ensure(sessionId); }, [sessionId]);
  return sessionId ? treeStore.get(sessionId) : null;
}

/**
 * The ‹ › ring for the message at `turn` while viewing `sessionId`.
 *
 * Versions are whole sessions: an edit creates a child rewound to before the
 * turn. Walking up from the current session, sessions whose edit targets a
 * LATER turn still inherit this one, so they are skipped; landing on a
 * session that targets exactly this turn means we are viewing one of its
 * alternatives, whose original lives in that session's parent.
 */
function ringFor(versions, sessionId, turn) {
  if (!versions) return null;
  const byId = new Map(versions.map(function (v) { return [v.sessionId, v]; }));
  let cursor = byId.get(sessionId);
  if (!cursor) return null;
  while (cursor.parentSessionId && typeof cursor.targetTurn === 'number' && cursor.targetTurn > turn) {
    const parent = byId.get(cursor.parentSessionId);
    if (!parent) break;
    cursor = parent;
  }
  let fork = cursor;
  while (fork.parentSessionId && typeof fork.targetTurn === 'number' && fork.targetTurn === turn) {
    const parent = byId.get(fork.parentSessionId);
    if (!parent) break;
    fork = parent;
  }
  function walksToFork(start) {
    let x = start;
    const seen = new Set();
    while (x && !seen.has(x.sessionId)) {
      seen.add(x.sessionId);
      if (x.sessionId === fork.sessionId) return true;
      if (typeof x.targetTurn !== 'number' || x.targetTurn !== turn) return false;
      x = x.parentSessionId ? byId.get(x.parentSessionId) : null;
    }
    return false;
  }
  // A deleted (ghost) version still anchors the fork and still bridges the
  // parent walks above, but it cannot be opened, so it never appears among
  // the alternatives: the ring renumbers over the survivors.
  const alternatives = versions
    .filter(function (v) {
      return !v.deleted && (v.sessionId === fork.sessionId || (v.targetTurn === turn && walksToFork(v)));
    })
    .sort(function (a, b) {
      return a.createdAt - b.createdAt || String(a.sessionId).localeCompare(String(b.sessionId));
    });
  if (alternatives.length < 2) return null;
  let index = alternatives.findIndex(function (v) { return v.sessionId === cursor.sessionId; });
  if (index === -1) index = alternatives.findIndex(function (v) { return v.sessionId === sessionId; });
  if (index === -1) index = 0;
  return { alternatives: alternatives, index: index };
}

/* ------------------------------------------------------------ mutations -- */

/**
 * Open a version, unarchiving it first when needed. The app cannot navigate
 * to an archived session (it bounces to the workspace picker), so an archived
 * target is activated through the host route before opening. Ghosts (deleted
 * versions) are never openable.
 */
async function openVersionTarget(sessions, v) {
  if (!v || v.deleted || !sessions) return;
  if (v.archived) {
    try {
      await mutate({ action: 'activate', sessionId: v.sessionId });
      treeStore.invalidate();
    } catch (e) {}
  }
  openWhenListed(sessions, v.sessionId);
}

function openWhenListed(sessions, sessionId) {
  const list = sessions.list;
  if (!list || typeof list.getSnapshot !== 'function') { sessions.open(sessionId); return; }
  if (list.getSnapshot().byId[sessionId] !== undefined) { sessions.open(sessionId); return; }
  const stop = list.subscribe(function () {
    if (list.getSnapshot().byId[sessionId] !== undefined) {
      stop();
      sessions.open(sessionId);
    }
  });
}

async function mutate(operation) {
  const g = realGlobal();
  const res = await g.fetch(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(operation),
  });
  const body = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    // The body rides on the error: a refusal carries the list of busy sessions,
    // which is exactly what the panel has to ask about.
    const failure = new Error(body.error || ('HTTP ' + res.status));
    failure.body = body;
    throw failure;
  }
  return body;
}

/* ---------------------------------------------------------------- utils -- */

function contentText(content) {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block && block.type === 'text' && typeof block.text === 'string') {
      out += (out ? '\n' : '') + block.text;
    }
  }
  return out;
}

function firstTextBlockIndex(content) {
  if (!Array.isArray(content)) return -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] && content[i].type === 'text') return i;
  }
  return -1;
}

function imageCount(content) {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] && content[i].type === 'image') n += 1;
  }
  return n;
}

function imageParts(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block && block.type === 'image' && block.attachment) out.push({ attachment: block.attachment });
  }
  return out;
}

function clip(text, max) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function timeLabel(ms) {
  try {
    const d = new Date(ms);
    const p = function (n) { return n < 10 ? '0' + n : String(n); };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  } catch (e) {
    return '';
  }
}

/* ---------------------------------------------------------- graph layout -- */

const CARD_W = 176;
const CARD_H = 58;
// A group frame is a card-sized padding plus a strip for its name.
const GROUP_PAD = 14;
const GROUP_HEAD = 20;
const SLOT_X = 206;
const SLOT_Y = 132;

/**
 * Project conversation family versions into a turn-level branching tree.
 */
function buildTurnTree(versions, currentSessionId, options) {
  if (!versions || versions.length === 0) return [];
  const dropEmptyForks = !options || options.dropEmptyForks !== false;
  const kept = versions.filter(function (v) {
    // A fork that copied the history and never added a turn of its own is a
    // photocopy: it doubles the canvas and makes the real history look like it
    // forked twice. The switch in the panel decides whether it is drawn — a
    // photocopy has no new content, so it is the switch's business and nothing
    // else's.
    if (!dropEmptyForks) return true;
    return v.copy !== true;
  });
  if (kept.length === 0) return [];
  const byId = new Map(kept.map(function (v) { return [v.sessionId, v]; }));

  let rootVersion = kept.find(function (v) { return !v.parentSessionId; });
  if (!rootVersion) {
    const rootId = rootOf(kept, currentSessionId) || (kept[0] && kept[0].sessionId);
    rootVersion = (rootId && byId.get(rootId)) || kept[0];
  }
  const rootSessionId = rootVersion.sessionId;

  const activeSessionPath = new Set();
  let cursor = byId.get(currentSessionId);
  const seenSessions = new Set();
  while (cursor && !seenSessions.has(cursor.sessionId)) {
    seenSessions.add(cursor.sessionId);
    activeSessionPath.add(cursor.sessionId);
    cursor = cursor.parentSessionId ? byId.get(cursor.parentSessionId) : null;
  }

  const nodes = [];
  const rootNodeId = rootSessionId + '#root';
  const nodeMap = new Map();

  const rootNode = {
    id: rootNodeId,
    sessionId: rootSessionId,
    turn: 0,
    isRoot: true,
    time: rootVersion.createdAt || 0,
    current: currentSessionId === rootSessionId && (!rootVersion.turns || rootVersion.turns.length === 0),
    onCurrentPath: true,
    deleted: !!rootVersion.deleted,
    archived: !!rootVersion.archived,
    versionLabel: rootVersion.label || undefined,
  };
  nodes.push(rootNode);
  nodeMap.set(rootNodeId, rootNode);

  // Turn numbers are NOT contiguous. A turn that is interrupted or steered into
  // never writes its `turn/end`, so this conversation is missing 13 and 19 while
  // still counting 18 turns. Parenting by `turn - 1` therefore invents nodes that
  // do not exist, and the guard below then re-hangs those nodes on the ROOT —
  // which is exactly the "turn 14 hangs off the original" the user reported.
  //
  // So: build every node first, then link them by what actually exists.
  const byVersion = new Map();
  const plans = new Map();
  for (let i = 0; i < kept.length; i++) {
    const v = kept[i];
    const isCurrentSession = v.sessionId === currentSessionId;
    const turns = Array.isArray(v.turns) && v.turns.length > 0 ? v.turns : [];
    const isFork = typeof v.targetTurn !== 'number' && typeof v.forkTurn === 'number';
    const list = [];
    const push = function (node) {
      nodes.push(node);
      nodeMap.set(node.id, node);
      list.push(node);
    };
    // A fork replays the turn it forked in, and copies every prompt before it.
    // Those are the SAME turns the parent already has — identity here is the
    // prompt text — so drawing them again would put a second "turn 16" on the
    // canvas while the two are one node in the conversation's history. Skip
    // them, and hang the fork's first genuinely new turn off the parent's copy
    // of the last shared turn.
    let sharedThrough = null;
    let ownTurns;
    if (v.parentSessionId === undefined) {
      ownTurns = turns;
    } else {
      const from = isFork ? v.forkTurn + 1 : (typeof v.targetTurn === 'number' ? v.targetTurn : 1);
      const parentVersion = byId.get(v.parentSessionId);
      const parentText = new Map();
      for (const turn of (parentVersion && parentVersion.turns) || []) parentText.set(turn.turn, turn.text || '');
      ownTurns = turns.filter(function (t) { return t.turn >= from; }).filter(function (t) {
        if (!isFork) return true;
        const parent = parentText.get(t.turn);
        if (parent === undefined || parent !== (t.text || '')) return true;
        sharedThrough = t.turn;
        return false;
      });
    }
    const attachTurn = sharedThrough !== null
      ? sharedThrough
      : (isFork ? v.forkTurn : (typeof v.targetTurn === 'number' ? v.targetTurn - 1 : 0));
    plans.set(v.sessionId, { attachTurn: attachTurn, isFork: isFork });

    if (!v.parentSessionId) {
      for (let j = 0; j < turns.length; j++) {
        const t = turns[j];
        push({
          id: v.sessionId + '#t' + t.turn,
          sessionId: v.sessionId,
          turn: t.turn,
          time: t.time || v.createdAt,
          text: t.text || '',
          current: isCurrentSession,
          onCurrentPath: false,
          deleted: !!v.deleted,
          archived: !!v.archived,
          // Every node of a named version carries the name so the group frame
          // can wrap the whole branch, not just the node where it starts.
          versionLabel: v.label || undefined,
        });
      }
    } else if (isFork && ownTurns.length === 0) {
      // A copy the user collected into the tree: one node, at its fork point.
      push({
        id: v.sessionId + '#fork',
        sessionId: v.sessionId,
        turn: v.forkTurn,
        copy: true,
        text: '',
        time: v.createdAt || 0,
        current: isCurrentSession,
        onCurrentPath: false,
        deleted: !!v.deleted,
        archived: !!v.archived,
        versionLabel: v.label || undefined,
      });
    } else if (ownTurns.length === 0) {
      const targetTurn = typeof v.targetTurn === 'number' ? v.targetTurn : 1;
      push({
        id: v.sessionId + '#t' + targetTurn,
        sessionId: v.sessionId,
        turn: targetTurn,
        operation: v.operation || 'edit',
        text: v.after || v.before || '',
        time: v.createdAt || 0,
        current: isCurrentSession,
        onCurrentPath: false,
        deleted: !!v.deleted,
        archived: !!v.archived,
        versionLabel: v.label || undefined,
      });
    } else {
      const targetTurn = isFork ? v.forkTurn + 1 : (typeof v.targetTurn === 'number' ? v.targetTurn : 1);
      for (let j = 0; j < ownTurns.length; j++) {
        const t = ownTurns[j];
        const isForkTurn = t.turn === targetTurn;
        push({
          id: v.sessionId + '#t' + t.turn,
          sessionId: v.sessionId,
          turn: t.turn,
          operation: isForkTurn ? v.operation : undefined,
          text: t.text || (isForkTurn ? (v.after || v.before || '') : ''),
          time: t.time || v.createdAt,
          current: isCurrentSession,
          onCurrentPath: false,
          deleted: !!v.deleted,
          archived: !!v.archived,
          // A version's name belongs to every node it owns, so the group frame
          // wraps the whole branch: the fork point and everything it grows
          // afterwards, but none of its own branches.
          versionLabel: v.label || undefined,
        });
      }
    }
    if (list.length > 0) byVersion.set(v.sessionId, list);
  }

  /** The latest node of `versionId` that sits at or before `turn`. */
  function nearestNodeAt(versionId, turn) {
    const list = byVersion.get(versionId);
    if (!list) return null;
    let best = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i].turn <= turn && (best === null || list[i].turn > best.turn)) best = list[i];
    }
    return best;
  }

  for (let i = 0; i < kept.length; i++) {
    const v = kept[i];
    const list = byVersion.get(v.sessionId);
    if (!list) continue;
    const isFork = typeof v.targetTurn !== 'number' && typeof v.forkTurn === 'number';
    for (let k = 0; k < list.length; k++) list[k].running = v.running === true;
    for (let j = 0; j < list.length; j++) {
      if (j > 0) {
        list[j].parentId = list[j - 1].id;
        continue;
      }
      if (v.parentSessionId === undefined) {
        list[j].parentId = rootNodeId;
        continue;
      }
      // A version's first node hangs off the nearest node its parent actually
      // has at or before the turn it forked from (or the last turn it shares
      // with that parent); the root is the last resort.
      const plan = plans.get(v.sessionId) || {};
      const parent = nearestNodeAt(v.parentSessionId, plan.attachTurn ?? 0);
      list[j].parentId = parent === null ? rootNodeId : parent.id;
    }
  }

  const allIds = new Set(nodes.map(function (n) { return n.id; }));
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].parentId && !allIds.has(nodes[i].parentId)) {
      nodes[i].parentId = rootNodeId;
    }
  }

  const activePathIds = new Set();
  let latestNode = null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.sessionId === currentSessionId) {
      if (!latestNode || (n.turn || 0) >= (latestNode.turn || 0)) {
        latestNode = n;
      }
    }
  }
  let pathCursor = latestNode || nodes[0];
  const seenPath = new Set();
  while (pathCursor && !seenPath.has(pathCursor.id)) {
    seenPath.add(pathCursor.id);
    activePathIds.add(pathCursor.id);
    pathCursor = pathCursor.parentId ? nodeMap.get(pathCursor.parentId) : null;
  }
  activePathIds.add(rootNodeId);

  for (let i = 0; i < nodes.length; i++) {
    nodes[i].onCurrentPath = activePathIds.has(nodes[i].id);
  }

  return nodes;
}

/**
 * Tidy tree layout for turn nodes: leaves claim successive horizontal slots,
 * parents center over their children, siblings ordered by creation time.
 */
function layoutTurnTree(nodes) {
  const byId = new Map(nodes.map(function (n) { return [n.id, n]; }));
  const children = new Map();
  const roots = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.parentId && byId.has(n.parentId)) {
      if (!children.has(n.parentId)) children.set(n.parentId, []);
      children.get(n.parentId).push(n);
    } else {
      roots.push(n);
    }
  }
  children.forEach(function (list) {
    list.sort(function (a, b) { return (a.time || 0) - (b.time || 0) || String(a.id).localeCompare(String(b.id)); });
  });
  roots.sort(function (a, b) { return (a.time || 0) - (b.time || 0) || String(a.id).localeCompare(String(b.id)); });
  const pos = new Map();
  let cursor = 0;
  function walk(n, depth) {
    const kids = children.get(n.id) || [];
    if (kids.length === 0) {
      pos.set(n.id, { x: cursor * SLOT_X, y: depth * SLOT_Y });
      cursor += 1;
      return;
    }
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < kids.length; i++) {
      walk(kids[i], depth + 1);
      const p = pos.get(kids[i].id);
      if (p.x < lo) lo = p.x;
      if (p.x > hi) hi = p.x;
    }
    pos.set(n.id, { x: (lo + hi) / 2, y: depth * SLOT_Y });
  }
  for (let i = 0; i < roots.length; i++) walk(roots[i], 0);
  const edges = [];
  children.forEach(function (kids, parentId) {
    for (let i = 0; i < kids.length; i++) {
      edges.push({ from: parentId, to: kids[i].id, onPath: !!kids[i].onCurrentPath });
    }
  });
  return { pos: pos, edges: edges, byId: byId, nodes: nodes };
}

function edgePath(x1, y1, x2, y2) {
  const dy = Math.max(26, (y2 - y1) * 0.5);
  return 'M' + x1 + ' ' + y1 + ' C' + x1 + ' ' + (y1 + dy) + ', ' + x2 + ' ' + (y2 - dy) + ', ' + x2 + ' ' + y2;
}

/** Bring the Chat view forward; the first conversation tab is always Chat. */
function showChat() {
  const g = realGlobal();
  if (!g || !g.document) return;
  const tab = g.document.querySelector('[role=tab]');
  if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
}

/**
 * After a graph click lands in a session, glide the chat to the version's own
 * message and flash it. Polls because the session view mounts asynchronously.
 */
function flashTurn(sessionId, turn, tries) {
  const g = realGlobal();
  if (!g || !g.document) return;
  const el = g.document.querySelector(
    '.mtx-row[data-session="' + sessionId + '"][data-turn="' + String(turn) + '"]');
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('mtx-flash');
    void el.offsetWidth;
    el.classList.add('mtx-flash');
    return;
  }
  if (tries > 0) setTimeout(function () { flashTurn(sessionId, turn, tries - 1); }, 160);
}

/* ------------------------------------------------------------------ css -- */

const CSS = [
  // User bubble replica: right-aligned rounded panel like the host's, with a
  // hover-revealed edit control to its left, ChatGPT-style.
  '.mtx-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px}',
  '.mtx-line{display:flex;align-items:flex-start;gap:8px;max-width:min(85%,720px)}',
  '.mtx-edit-btn{flex:none;margin-top:8px;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;opacity:0;transition:opacity 120ms ease,background 120ms ease}',
  '.mtx-row:hover .mtx-edit-btn{opacity:1}',
  '.mtx-edit-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.mtx-bubble{background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,150,.14));border-radius:16px;padding:10px 16px;font-size:15px;line-height:26px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}',
  '.mtx-img{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:4px}',

  // Inline editor, ChatGPT-style: the bubble grows into an editing surface
  // with Cancel / Send below-right.
  '.mtx-editor{width:min(85%,720px);background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,150,.14));border-radius:16px;padding:12px 16px;display:flex;flex-direction:column;gap:10px}',
  '.mtx-textarea{width:100%;min-height:72px;resize:vertical;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:15px;line-height:26px}',
  '.mtx-editor-actions{display:flex;justify-content:flex-end;gap:8px}',
  '.mtx-btn{padding:6px 16px;border-radius:999px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.3));background:transparent;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer}',
  '.mtx-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.mtx-btn[data-primary]{background:var(--dsw-alias-accent-primary,#4b8dff);border-color:transparent;color:#fff}',
  '.mtx-btn[data-primary]:hover{filter:brightness(1.08)}',
  '.mtx-btn[disabled]{opacity:.5;cursor:default}',
  '.mtx-error{font-size:12px;color:var(--dsw-alias-status-error,#e5484d)}',

  // Version ring, under the bubble: ‹ 2/3 ›.
  '.mtx-ring{display:flex;align-items:center;gap:2px;font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
  '.mtx-ring button{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:14px}',
  '.mtx-ring button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.mtx-ring button[disabled]{opacity:.35;cursor:default}',

  // Versions graph: a pannable canvas with spring-arranged cards and bezier
  // edges. Cursor communicates state: grab on canvas, pointer on cards.
  '.mtx-graph{position:relative;height:100%;overflow:hidden;cursor:grab;background-image:radial-gradient(color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 22%,transparent) 1px,transparent 1px);background-size:26px 26px;touch-action:none;user-select:none}',
  '.mtx-graph[data-panning]{cursor:grabbing}',
  '.mtx-world{position:absolute;left:0;top:0;will-change:transform}',
  '.mtx-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}',
  '.mtx-edge{fill:none;stroke:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 45%,transparent);stroke-width:1.5}',
  '.mtx-edge[data-path]{stroke:var(--dsw-alias-accent-primary,#4b8dff);stroke-width:2}',
  '.mtx-card{position:absolute;left:0;top:0;width:176px;box-sizing:border-box;display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:13px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 10%,var(--dsw-alias-bg-primary,rgba(30,30,34,.9)));box-shadow:0 2px 10px rgba(0,0,0,.14);cursor:pointer;will-change:transform;transition:box-shadow 180ms ease,border-color 180ms ease;z-index:1}',
  '.mtx-card:hover{box-shadow:0 6px 22px rgba(0,0,0,.24);border-color:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 55%,transparent)}',
  // Two different facts, two different strengths. `data-current` is the session
  // being read right now; `data-path` is the lineage that leads to where you are
  // — and when you open a branch, the shared history above the fork is on that
  // lineage, not "current". It used to show only as a tinted icon, which read as
  // "the highlight disappeared". It gets a visible frame now, defined before the
  // current rule so the session you are in still outranks it.
  '.mtx-card[data-path]{border-color:color-mix(in srgb,var(--dsw-alias-accent-primary,#4b8dff) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4b8dff) 7%,var(--dsw-alias-bg-primary,rgba(30,30,34,.9)))}',
  '.mtx-card[data-current]{border-color:var(--dsw-alias-accent-primary,#4b8dff);box-shadow:0 0 0 1px var(--dsw-alias-accent-primary,#4b8dff),0 6px 24px color-mix(in srgb,var(--dsw-alias-accent-primary,#4b8dff) 30%,transparent)}',
  '.mtx-card[data-dragging]{cursor:grabbing;box-shadow:0 14px 34px rgba(0,0,0,.3);z-index:3}',
  '.mtx-card[data-deleted]{opacity:.55;border-style:dashed;cursor:default}',
  '.mtx-card[data-archived]{opacity:.72}',
  '.mtx-card[data-labeled] .mtx-card-title{color:var(--dsw-alias-accent-primary,#4b8dff)}',
  '.mtx-group{position:absolute;left:0;top:0;box-sizing:border-box;border:1px dashed color-mix(in srgb,var(--dsw-alias-accent-primary,#4b8dff) 45%,transparent);border-radius:20px;background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4b8dff) 7%,transparent);z-index:0;pointer-events:none}',
  '.mtx-group-name{position:absolute;left:14px;top:-10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 9px;border-radius:9px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-accent-primary,#4b8dff);background:var(--dsw-alias-bg-primary,#1e1e22);border:1px solid color-mix(in srgb,var(--dsw-alias-accent-primary,#4b8dff) 45%,transparent)}',
  '.mtx-menu{position:absolute;left:0;top:0;z-index:9;display:flex;flex-direction:column;min-width:148px;padding:4px;border-radius:11px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 34%,transparent);background:var(--dsw-alias-bg-primary,#1e1e22);box-shadow:0 10px 30px rgba(0,0,0,.34)}',
  '.mtx-menu-item{appearance:none;border:0;background:transparent;text-align:left;font-family:inherit;font-size:12.5px;line-height:18px;padding:7px 10px;border-radius:8px;color:var(--dsw-alias-label-primary,#eee);cursor:pointer;white-space:nowrap}',
  '.mtx-menu-item:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
  '.mtx-menu-item[disabled]{color:var(--dsw-alias-label-tertiary,#888);cursor:not-allowed}',
  '.mtx-rename{position:absolute;left:0;top:0;width:176px;box-sizing:border-box;z-index:7}',
  '.mtx-rename-input{width:100%;box-sizing:border-box;font-family:inherit;font-size:12.5px;line-height:17px;padding:9px 11px;border-radius:13px;border:1px solid var(--dsw-alias-accent-primary,#4b8dff);background:var(--dsw-alias-bg-primary,#1e1e22);color:var(--dsw-alias-label-primary,#eee);outline:none;box-shadow:0 6px 22px rgba(0,0,0,.28)}',
  '.mtx-rename-input::placeholder{color:var(--dsw-alias-label-tertiary,#888)}',
  '.mtx-card[data-deleted]:hover{box-shadow:0 2px 10px rgba(0,0,0,.14);border-color:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 30%,transparent)}',
  '.mtx-card-icon{flex:none;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:8px;font-size:12px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 18%,transparent);color:var(--dsw-alias-label-secondary,#bbb)}',
  '.mtx-card[data-path] .mtx-card-icon{background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4b8dff) 20%,transparent);color:var(--dsw-alias-accent-primary,#4b8dff)}',
  '.mtx-card-main{min-width:0;flex:1}',
  '.mtx-card-title{font-size:12.5px;font-weight:600;line-height:17px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.mtx-card-sub{font-size:11px;line-height:15px;margin-top:2px;color:var(--dsw-alias-label-tertiary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
  '.mtx-graph-tools{position:absolute;top:12px;right:14px;display:flex;gap:6px;z-index:4}',
  '.mtx-tool{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border-radius:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 30%,transparent);background:var(--dsw-alias-bg-primary,rgba(30,30,34,.85));color:var(--dsw-alias-label-secondary,#bbb);cursor:pointer;font-size:14px}',
  '.mtx-tool:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
  '.mtx-tool[data-on]{color:var(--dsw-alias-accent-primary,#4b8dff);border-color:color-mix(in srgb,var(--dsw-alias-accent-primary,#4b8dff) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4b8dff) 14%,transparent)}',
  '.mtx-confirm{position:absolute;left:50%;top:38%;transform:translate(-50%,-50%);z-index:10;max-width:330px;padding:14px 16px;border-radius:13px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 34%,transparent);background:var(--dsw-alias-bg-primary,#1e1e22);box-shadow:0 14px 40px rgba(0,0,0,.4)}',
  '.mtx-confirm-title{font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-primary,#eee)}',
  '.mtx-confirm-actions{display:flex;gap:8px;margin-top:12px}',
  '.mtx-btn{appearance:none;font-family:inherit;font-size:12px;padding:6px 12px;border-radius:9px;cursor:pointer;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 34%,transparent);background:transparent;color:var(--dsw-alias-label-primary,#eee)}',
  '.mtx-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
  '.mtx-btn-primary{border-color:var(--dsw-alias-accent-primary,#4b8dff);color:var(--dsw-alias-accent-primary,#4b8dff)}',
  '.mtx-empty{position:absolute;left:0;right:0;bottom:26px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12.5px;pointer-events:none}',
  '.mtx-graph .mtx-link{position:absolute;right:14px;bottom:10px;font-size:12px;color:var(--dsw-alias-label-tertiary);text-decoration:none;z-index:4}',
  '.mtx-link:hover{color:var(--dsw-alias-label-primary)}',
  '.mtx-error{font-size:12px;color:var(--dsw-alias-status-error,#e5484d)}',
  '.mtx-graph .mtx-error{position:absolute;left:14px;top:16px;z-index:4}',
  '.mtx-notice{position:absolute;left:14px;right:14px;bottom:34px;z-index:4;pointer-events:none;padding:7px 10px;border-radius:9px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary,#bbb);background:color-mix(in srgb,var(--dsw-alias-status-warning,#e0a03a) 14%,var(--dsw-alias-bg-primary,rgba(30,30,34,.9)));border:1px solid color-mix(in srgb,var(--dsw-alias-status-warning,#e0a03a) 40%,transparent)}',

  // Flash highlight when a graph click lands on its message.
  '@keyframes mtx-flash-kf{0%,55%{background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4b8dff) 22%,transparent)}100%{background:transparent}}',
  '.mtx-flash .mtx-bubble{animation:mtx-flash-kf 1.4s ease-out}',

  /* ---- action row, below the bubble ------------------------------------ */
  // All three references put the message controls BELOW the bubble, not
  // beside it. What differs is which controls exist and whether they are
  // always visible or revealed on hover.
  '.mtx-actions{display:flex;align-items:center;gap:2px;margin-top:1px}',
  '.mtx-act{width:26px;height:26px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
  '.mtx-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.mtx-act[disabled]{opacity:.4;cursor:default}',
  // ChatGPT and Claude reveal the controls on hover; DeepSeek keeps them out,
  // which is also how DSH itself behaves.
  'html[data-mtx-style=chatgpt] .mtx-actions,html[data-mtx-style=claude] .mtx-actions{opacity:0;transition:opacity 120ms ease}',
  'html[data-mtx-style=chatgpt] .mtx-row:hover .mtx-actions,html[data-mtx-style=chatgpt] .mtx-row:focus-within .mtx-actions,',
  'html[data-mtx-style=claude] .mtx-row:hover .mtx-actions,html[data-mtx-style=claude] .mtx-row:focus-within .mtx-actions{opacity:1}',
  // Only Claude offers a retry control on the user message.
  '.mtx-act[data-act=retry]{display:none}',
  'html[data-mtx-style=claude] .mtx-act[data-act=retry]{display:inline-flex}',

  /* ---- editor button placement ----------------------------------------- */
  // ChatGPT and DeepSeek keep Cancel/Send INSIDE the editor box. Claude puts
  // them OUTSIDE, below it, and names the primary action Save.
  '.mtx-editor-outside{display:none;justify-content:flex-end;align-items:center;gap:8px;margin-top:8px;width:min(85%,720px)}',
  'html[data-mtx-style=claude] .mtx-editor-actions{display:none}',
  'html[data-mtx-style=claude] .mtx-editor-outside{display:flex}',


  /* ---- settings section ------------------------------------------------ */
  '.mtx-set{display:flex;flex-direction:column;gap:12px;max-width:560px;font-size:14px;color:var(--dsw-alias-label-primary)}',
  '.mtx-set-row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
  '.mtx-set-label{font-size:13px}',
  '.mtx-select{border-radius:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 34%,transparent);background:var(--dsw-alias-bg-primary,rgba(30,30,34,.6));color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:6px 10px;outline:none;cursor:pointer}',
  '.mtx-set-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.mtx-preview{margin-top:2px;padding:18px 16px 16px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 7%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 16%,transparent);pointer-events:none}',
  '.mtx-preview .mtx-editor{margin-top:12px}',
  '.mtx-preview .mtx-textarea{min-height:auto}',
  '.mtx-preview .mtx-actions{opacity:1!important}',
  '.mtx-set-link{align-self:flex-end;font-size:12px;color:var(--dsw-alias-label-tertiary);text-decoration:none;pointer-events:auto}',
  '.mtx-set-link:hover{color:var(--dsw-alias-label-primary)}',
].join('');

return {
  // Module dependencies load code; Cordis injection waits for its services.
  // The session controller becomes ready asynchronously after connection.
  inject: ['slots', 'sessions', 'locale'],
  apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) {
      throw new Error('[dsh-tree-view] Missing DSH slots service. Check dsh.client.inject and restart DSH.');
    }
    ctx.effect(function () { return styles.insert(CSS); });
    // Reflect the chosen edit style onto <html> now and on every change.
    ctx.effect(function () { syncStyleAttribute(); return styleStore.subscribe(syncStyleAttribute); });

    const sessions = ctx.get('sessions');
    if (!sessions || typeof sessions.open !== 'function') {
      throw new Error('[dsh-tree-view] Missing DSH session navigation service. Check client dependencies and restart DSH.');
    }

    ctx.effect(function () {
      if (sessions && sessions.list && typeof sessions.list.subscribe === 'function') {
        return sessions.list.subscribe(function () { treeStore.invalidate(); });
      }
    });

    // Session-list state straight from the service, so this works no matter
    // what props the host chooses to pass slot components.
    function useSessionList() {
      const [, force] = React.useReducer(function (x) { return x + 1; }, 0);
      React.useEffect(function () {
        if (!sessions || !sessions.list || typeof sessions.list.subscribe !== 'function') return undefined;
        return sessions.list.subscribe(force);
      }, []);
      return sessions && sessions.list && typeof sessions.list.getSnapshot === 'function'
        ? sessions.list.getSnapshot()
        : { byId: {} };
    }

    const I18N_NS = 'dsh-tree-view';
    const I18N = {
      en: {
        view: 'Tree',
        edit: 'Edit message',
        cancel: 'Cancel',
        send: 'Send',
        save: 'Save',
        copy: 'Copy',
        copied: 'Copied',
        retry: 'Retry this turn',
        regen: 'Regenerate from here',
        original: 'Original conversation',
        turn: 'Turn {turn}',
        edited: 'Edited turn {turn}',
        retried: 'Regenerated turn {turn}',
        branch: 'Branch',
        refresh: 'Refresh',
        fit: 'Center view',
        empty: 'No versions yet — edit any of your messages to branch this conversation. Drag to pan, scroll to zoom.',
        images: '{count} image(s) kept as-is',
        nav: 'Message Edit',
        styleLabel: 'Edit interface style',
        styleHint: 'Where the message controls sit and which ones appear. Changes apply live.',
        style_chatgpt: 'ChatGPT',
        style_deepseek: 'DeepSeek',
        style_claude: 'Claude',
        styleDesc_chatgpt: 'Copy and edit under the bubble, revealed on hover. Cancel and Send sit inside the editor.',
        styleDesc_deepseek: 'Copy and edit under the bubble, always visible — closest to DSH itself. Cancel and Send sit inside the editor.',
        styleDesc_claude: 'Retry, edit and copy under the bubble, revealed on hover. Cancel and Save sit below the editor.',
        deletedVersion: 'Deleted version',
        archivedTag: 'Archived',
        rememberPathLabel: 'Remember the version I was viewing',
        rememberPathHint: 'Reopening a conversation returns to the branch you last had open instead of the original. Off means it always opens the first version.',
        stopOnEditLabel: 'Stop the running reply when I edit',
        stopOnEditHint: 'Editing or retrying cancels every reply still being generated in this conversation before branching, including other versions, so no superseded answer keeps spending tokens. This also lets you edit mid-reply. Off leaves them running.',
        renamePrompt: 'Rename this branch',
        renameHint: 'Right-click to rename this branch',
        renameEmptyHint: 'Leave it empty to clear the name',
        renameFailed: 'Rename failed: {message}',
        menuHint: 'Right-click for branch actions',
        copyBranch: 'Forked copy',
        forkedAt: 'forked at turn {turn}',
        dropForksLabel: 'Hide content-less forks',
        dropForksHint: 'A fork that only copied this conversation is not drawn.',
        collectOthers: 'Collect every other branch',
        collectRunning: '{count} branch(es) are still running a task.',
        collectStop: 'Stop and collect',
        collectFailed: 'Collect failed: {message}',
        runningTag: 'running',
        archiveUnavailable: 'This build cannot do that yet — see the note in the panel',
        archivePartial: 'This DSH build is missing part of the archive interface ({parts}), so collecting and putting back branches is off. Everything else still works.',
        menuRename: 'Rename branch',
        menuPromote: 'Move to main chat',
        menuDemote: 'Collect into the tree',
        menuDemoteOpen: 'This is the conversation you have open',
        moveFailed: 'Move failed: {message}',
        previewUser: 'Rewrite this paragraph to be more concise.',
      },
      zh: {
        view: 'Tree',
        edit: '编辑消息',
        cancel: '取消',
        send: '发送',
        save: '保存',
        copy: '复制',
        copied: '已复制',
        retry: '重试本轮',
        regen: '从这里重新生成',
        original: '原始对话',
        turn: '第 {turn} 轮',
        edited: '编辑了第 {turn} 轮',
        retried: '重新生成第 {turn} 轮',
        branch: '分支',
        refresh: '刷新',
        fit: '居中显示',
        empty: '还没有版本——编辑任意一条你的消息即可创建分支。拖动平移，滚轮缩放。',
        images: '{count} 张图片将原样保留',
        nav: '消息编辑',
        styleLabel: '编辑界面风格',
        styleHint: '消息操作按钮的位置与种类。修改即时生效。',
        style_chatgpt: 'ChatGPT',
        style_deepseek: 'DeepSeek',
        style_claude: 'Claude',
        styleDesc_chatgpt: '气泡下方为复制与编辑，悬停时显示；「取消 / 发送」位于编辑框内部。',
        styleDesc_deepseek: '气泡下方为复制与编辑，始终显示——最接近 DSH 原生；「取消 / 发送」位于编辑框内部。',
        styleDesc_claude: '气泡下方为重试、编辑与复制，悬停时显示；「取消 / 保存」位于编辑框下方。',
        deletedVersion: '已删除的版本',
        archivedTag: '已归档',
        rememberPathLabel: '记住我正在查看的版本',
        rememberPathHint: '重新打开会话时回到上次查看的分支，而不是最初那条。关闭后始终打开第一个版本。',
        stopOnEditLabel: '编辑时中止正在生成的回复',
        stopOnEditHint: '编辑或重试时，先取消该会话中所有仍在生成的回复（包括其它版本）再分支，避免被取代的回答继续消耗额度；同时允许在回复过程中直接编辑。关闭后它们会继续跑完。',
        renamePrompt: '重命名这个分支',
        renameHint: '右键重命名该分支',
        renameEmptyHint: '留空即清除名字',
        renameFailed: '重命名失败：{message}',
        menuHint: '右键打开分支操作',
        copyBranch: '分叉副本',
        forkedAt: '分叉于第 {turn} 轮',
        dropForksLabel: '剔除空 Fork',
        dropForksHint: '只复制了本对话、自己没聊出新内容的 Fork 不画出来。',
        collectOthers: '收起其它分支',
        collectRunning: '有 {count} 个分支正在跑任务。',
        collectStop: '中止任务并收起',
        collectFailed: '收起失败：{message}',
        runningTag: '运行中',
        archiveUnavailable: '此 DSH 版本还不支持这个操作，面板上有说明',
        archivePartial: '此 DSH 版本缺少归档接口的一部分（{parts}），因此「收起 / 放到主对话」已停用；树视图其余功能不受影响。',
        menuRename: '重命名分支',
        menuPromote: '放到主对话',
        menuDemote: '收到 Tree 里',
        menuDemoteOpen: '这就是你当前打开的会话',
        moveFailed: '移动失败：{message}',
        previewUser: '把这段话改写得更简洁一些。',
      },
    };
    let t = function (key, params) {
      let out = I18N.en[key] || key;
      if (params) for (const k in params) out = out.replace('{' + k + '}', String(params[k]));
      return out;
    };
    try {
      const locale = ctx.get('locale');
      if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
        ctx.effect(function () { return locale.register(I18N_NS, I18N); });
        t = locale.bind(I18N_NS);
      }
    } catch (e) {
      console.warn('[dsh-tree-view] Failed to register translations; using English.', e);
    }

    /**
     * Two branches off one stem — the second one dashed while empty forks are
     * filtered out, solid while they are shown. The icon states what the button
     * does instead of needing a sentence.
     */
    function ForkIcon(props) {
      const filtered = props && props.filtered;
      return React.createElement('svg', {
        width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      },
        React.createElement('path', {
          d: 'M4.2 13.4V3.2M4.2 5.6h7.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }),
        React.createElement('circle', { cx: 11.8, cy: 5.6, r: 1.7, fill: 'currentColor' }),
        React.createElement('path', {
          d: 'M4.2 9.4h4.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
          strokeDasharray: filtered ? '2 2.2' : undefined,
        }),
        React.createElement('circle', {
          cx: 11.8, cy: 9.4, r: 1.7, fill: 'currentColor', opacity: filtered ? 0.35 : 1,
        }));
    }

    /** Everything funnelled back into one place: collect the other branches. */
    function CollectIcon() {
      return React.createElement('svg', {
        width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      },
        React.createElement('path', {
          d: 'M2.4 12.6h11.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }),
        React.createElement('path', {
          d: 'M3.6 3.2v3.4a2 2 0 0 0 2 2h4.8', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }),
        React.createElement('path', {
          d: 'M12.4 3.2v3.4a2 2 0 0 1-2 2H8.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }),
        React.createElement('path', {
          d: 'M8 6.4v5.6m0 0-1.8-1.8M8 12l1.8-1.8', stroke: 'currentColor', strokeWidth: 1.3,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }));
    }

    function PencilIcon() {
      return React.createElement('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        React.createElement('path', {
          d: 'M11.1 2.4a1.6 1.6 0 012.3 2.3l-7.2 7.2-3 .8.8-3 7.1-7.3z',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
        }));
    }

    function CopyIcon() {
      return React.createElement('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        React.createElement('rect', {
          x: 5.4, y: 5.4, width: 8.2, height: 8.2, rx: 2,
          stroke: 'currentColor', strokeWidth: 1.3,
        }),
        React.createElement('path', {
          d: 'M10.6 5.2V4.2a1.8 1.8 0 00-1.8-1.8H4.2a1.8 1.8 0 00-1.8 1.8v4.6a1.8 1.8 0 001.8 1.8h1',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }));
    }

    function RetryIcon() {
      return React.createElement('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        React.createElement('path', {
          d: 'M13.2 8a5.2 5.2 0 11-1.6-3.75',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }),
        React.createElement('path', {
          d: 'M13.4 2.3v3.1h-3.1',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        }));
    }

    /** Ring beneath a bubble: ‹ i/m › switching whole version sessions. */
    function VersionRing(props) {
      const ring = props.ring;
      if (!ring) return null;
      const go = function (delta) {
        const next = ring.alternatives[ring.index + delta];
        if (next) openVersionTarget(sessions, next);
      };
      return React.createElement('div', { className: 'mtx-ring' },
        React.createElement('button', {
          type: 'button', disabled: ring.index <= 0,
          onClick: function () { go(-1); },
        }, '‹'),
        React.createElement('span', null, (ring.index + 1) + '/' + ring.alternatives.length),
        React.createElement('button', {
          type: 'button', disabled: ring.index >= ring.alternatives.length - 1,
          onClick: function () { go(1); },
        }, '›')
      );
    }

    function UserMessageView(props) {
      const node = props.node;
      const data = node.data || {};
      const text = contentText(data.content);
      const images = imageCount(data.content);
      const messageImages = imageParts(data.content);
      const sessionId = props.sessionId !== undefined ? props.sessionId : (node.sessionId);
      // location.turn is a turn-group object ({turn, start, end, steps}); the
      // turn number lives one level down.
      const rawTurn = node.location ? node.location.turn : undefined;
      const turn = typeof rawTurn === 'number' ? rawTurn
        : (rawTurn && typeof rawTurn.turn === 'number' ? rawTurn.turn : undefined);
      const list = useSessionList();
      const summary = sessionId !== undefined ? list.byId[sessionId] : undefined;
      const running = !!(summary && summary.running);
      const tree = useTree(sessionId);
      const ring = typeof turn === 'number' ? ringFor(tree && tree.versions, sessionId, turn) : null;

      // Remember which branch of this family is open, and restore it when we
      // land back on the family root. Runs per bubble, so every step is either
      // idempotent or guarded — see activePathStore.
      const versions = tree && tree.versions;
      const prefs = usePrefs();
      React.useEffect(function () {
        if (!prefs.rememberPath) return;
        if (!versions || sessionId === undefined) return;
        const root = rootOf(versions, sessionId);
        if (!root) return;
        if (sessionId !== root) {
          // Arrived at a branch: that is now the remembered view, and any
          // restore we kicked off has landed.
          pendingRestore.delete(root);
          activePathStore.set(root, sessionId);
          return;
        }
        // On the root. Don't record while a restore we triggered is still in
        // flight, or we would overwrite the target with the root we are leaving.
        if (pendingRestore.has(root)) return;
        const remembered = activePathStore.get(root);
        if (!remembered || remembered === root) return;
        if (restoredFamilies.has(root)) {
          // Already restored once this page load and the user walked back to
          // the root deliberately — honour that as the new selection.
          activePathStore.set(root, root);
          return;
        }
        // Never chase a branch that no longer exists (a deleted branch may
        // still appear here as a non-openable ghost).
        const target = versions.find(function (v) { return v.sessionId === remembered; });
        if (!target || target.deleted) return;
        restoredFamilies.add(root);
        pendingRestore.add(root);
        openVersionTarget(sessions, target);
      }, [versions, sessionId, sessions, prefs.rememberPath]);

      const [editing, setEditing] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [copied, setCopied] = React.useState(false);

      // Editing used to require an idle session, because forking calls
      // `runMaintenance`, which throws while a turn is live. With stopOnEdit the
      // host cancels that turn first, so editing mid-answer is allowed — and is
      // the point: it stops the superseded turn instead of leaving it streaming.
      const canEdit = (!running || prefs.stopOnEdit)
        && sessionId !== undefined && typeof turn === 'number' && text !== '' && !editing;

      function beginEdit() {
        setDraft(text);
        setError(null);
        setEditing(true);
      }

      async function submit() {
        const blockIndex = firstTextBlockIndex(data.content);
        // An unchanged draft is still a resend: it branches and regenerates.
        if (blockIndex === -1 || draft.trim() === '') { setEditing(false); return; }
        setBusy(true);
        setError(null);
        try {
          const result = await mutate({
            action: 'edit',
            sessionId: sessionId,
            eventSeq: data.seq,
            blockIndex: blockIndex,
            text: draft,
            stopPrevious: prefs.stopOnEdit,
          });
          const currentTree = treeStore.get(sessionId);
          if (currentTree && Array.isArray(currentTree.versions)) {
            const newV = {
              sessionId: result.sessionId,
              parentSessionId: sessionId,
              targetTurn: turn,
              operation: 'edit',
              createdAt: Date.now(),
              current: true,
              onCurrentPath: true,
              after: draft,
              turns: [{ turn: turn, text: draft, time: Date.now() }],
            };
            treeStore.setTree(result.sessionId, currentTree.versions.concat([newV]));
          }
          treeStore.load(result.sessionId);
          setEditing(false);
          if (sessions) openWhenListed(sessions, result.sessionId);
        } catch (e) {
          setError(String(e && e.message || e));
        }
        setBusy(false);
      }

      async function retry() {
        if (typeof turn !== 'number') return;
        setBusy(true);
        setError(null);
        try {
          const result = await mutate({
            action: 'retry', sessionId: sessionId, turn: turn, stopPrevious: prefs.stopOnEdit,
          });
          const currentTree = treeStore.get(sessionId);
          if (currentTree && Array.isArray(currentTree.versions)) {
            const newV = {
              sessionId: result.sessionId,
              parentSessionId: sessionId,
              targetTurn: turn,
              operation: 'retry',
              createdAt: Date.now(),
              current: true,
              onCurrentPath: true,
              before: text,
              turns: [{ turn: turn, text: text, time: Date.now() }],
            };
            treeStore.setTree(result.sessionId, currentTree.versions.concat([newV]));
          }
          treeStore.load(result.sessionId);
          if (sessions) openWhenListed(sessions, result.sessionId);
        } catch (e) {
          setError(String(e && e.message || e));
        }
        setBusy(false);
      }

      function copy() {
        const g = realGlobal();
        try {
          if (g && g.navigator && g.navigator.clipboard) g.navigator.clipboard.writeText(text);
        } catch (e) {}
        setCopied(true);
        setTimeout(function () { setCopied(false); }, 1200);
      }

      if (editing) {
        // Both action rows are rendered; CSS shows the one this preset wants —
        // inside the box (ChatGPT, DeepSeek) or below it (Claude).
        const cancelButton = function (key) {
          return React.createElement('button', {
            key: key, type: 'button', className: 'mtx-btn', disabled: busy,
            onClick: function () { setEditing(false); },
          }, t('cancel'));
        };
        const confirmButton = function (key, label) {
          return React.createElement('button', {
            key: key, type: 'button', className: 'mtx-btn', 'data-primary': '',
            disabled: busy || draft.trim() === '',
            onClick: submit,
          }, label);
        };
        return React.createElement('div', { className: 'mtx-row' },
          React.createElement('div', { className: 'mtx-editor' },
            React.createElement('textarea', {
              className: 'mtx-textarea',
              value: draft,
              autoFocus: true,
              onChange: function (e) { setDraft(e.target.value); },
              onKeyDown: function (e) {
                if (e.key === 'Escape') setEditing(false);
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
              },
            }),
            images > 0 ? React.createElement('div', { className: 'mtx-img' }, t('images', { count: images })) : null,
            error ? React.createElement('div', { className: 'mtx-error' }, error) : null,
            React.createElement('div', { className: 'mtx-editor-actions' },
              cancelButton('c-in'), confirmButton('s-in', t('send'))
            )
          ),
          React.createElement('div', { className: 'mtx-editor-outside' },
            cancelButton('c-out'), confirmButton('s-out', t('save'))
          )
        );
      }

      return React.createElement('div', { className: 'mtx-row', 'data-turn': turn, 'data-session': sessionId },
        React.createElement('div', { className: 'mtx-line' },
          React.createElement('div', { className: 'mtx-bubble' },
            text,
            // The host renders attachments through its images slot (native
            // gallery plus lightbox); keep the placeholder only when the slot
            // owner props do not carry the callback.
            messageImages.length > 0 && typeof props.renderMessageImages === 'function'
              ? props.renderMessageImages({ images: messageImages, align: 'end' })
              : (images > 0 ? React.createElement('div', { className: 'mtx-img' }, t('images', { count: images })) : null)
          )
        ),
        // The controls sit under the bubble in all three references. Which
        // ones exist, and whether they wait for hover, is what differs.
        React.createElement('div', { className: 'mtx-actions' },
          React.createElement(VersionRing, { ring: ring }),
          React.createElement('button', {
            type: 'button', className: 'mtx-act', 'data-act': 'retry',
            title: t('retry'), disabled: !canEdit || busy, onClick: retry,
          }, RetryIcon()),
          React.createElement('button', {
            type: 'button', className: 'mtx-act', 'data-act': 'edit',
            title: t('edit'), disabled: !canEdit, onClick: beginEdit,
          }, PencilIcon()),
          React.createElement('button', {
            type: 'button', className: 'mtx-act', 'data-act': 'copy',
            title: copied ? t('copied') : t('copy'), onClick: copy,
          }, CopyIcon())
        ),
        error ? React.createElement('div', { className: 'mtx-error' }, error) : null
      );
    }

    /**
     * The Versions view: a live graph. Cards spring into a tidy tree, edges
     * follow every frame, the canvas pans and zooms, and clicking a card
     * jumps straight to that version's message.
     */
    function VersionsView(props) {
      const sessionId = props.sessionId;
      const tree = useTree(sessionId);
      const titles = useSessionList().byId;
      const versions = (tree && tree.versions) || [];
      const prefs = usePrefs();
      // What this host can actually do about hiding sessions. A host that lost
      // part of that seam disables exactly those controls — instead of letting
      // them fail at click time, or hiding a session it could no longer show.
      const archive = (tree && tree.archiveSupport) || { ok: true, read: true, hide: true, show: true, missing: [] };

      const graphRef = React.useRef(null);
      const worldRef = React.useRef(null);
      const cardEls = React.useRef(new Map());
      const edgeEls = React.useRef(new Map());
      const groupNameEls = React.useRef(new Map());
      const renameErrorState = React.useState(null);
      const renameError = renameErrorState[0];
      const setRenameError = renameErrorState[1];
      // The rename editor is drawn inside the graph, not through window.prompt:
      // the Desktop shell does not implement prompt(), so a native dialog would
      // silently do nothing there. The pending draft lives in a ref as well as
      // in state so Enter and the blur that follows it cannot commit twice.
      const renameEditorState = React.useState(null);
      const renaming = renameEditorState[0];
      const setRenaming = renameEditorState[1];
      const pendingRename = React.useRef(null);
      // Right-click opens a menu rather than jumping straight into renaming:
      // a branch can also be moved between the main conversation and the tree.
      const menuState = React.useState(null);
      const menu = menuState[0];
      const setMenu = menuState[1];
      // Versions the host refused to collect because they are mid-turn; the
      // panel asks about stopping them instead of killing work silently.
      const confirmState = React.useState(null);
      const confirmBusy = confirmState[0];
      const setConfirmBusy = confirmState[1];
      const springs = React.useRef(new Map());
      const layoutRef = React.useRef(null);
      const viewRef = React.useRef({ x: 60, y: 42, scale: 1 });
      const dragRef = React.useRef(null);
      const rafRef = React.useRef(0);
      const fittedRef = React.useRef(false);

      const turnNodes = React.useMemo(function () {
        return buildTurnTree(versions, sessionId, { dropEmptyForks: prefs.dropEmptyForks });
      }, [versions, sessionId, prefs.dropEmptyForks]);

      const layoutKey = turnNodes.map(function (n) {
        return n.id + ':' + (n.parentId || '') + ':' + (n.onCurrentPath ? 1 : 0);
      }).join('|');
      const layout = React.useMemo(function () { return layoutTurnTree(turnNodes); }, [layoutKey]);
      layoutRef.current = layout;

      // Named branches are drawn as groups, the way a node editor boxes a set of
      // nodes: one rounded frame behind the branch with the name on its edge.
      // Geometry comes from the settled layout, so a group is exactly the
      // bounding box of the nodes that belong to that version.
      const groupBoxes = (function () {
        const byVersion = new Map();
        for (const n of turnNodes) {
          if (!n.versionLabel) continue;
          const list = byVersion.get(n.sessionId);
          if (list === undefined) byVersion.set(n.sessionId, [n]);
          else list.push(n);
        }
        const boxes = [];
        byVersion.forEach(function (nodes, versionId) {
          let left = Infinity;
          let right = -Infinity;
          let top = Infinity;
          let bottom = -Infinity;
          for (const n of nodes) {
            const pos = layout.pos.get(n.id);
            if (!pos) continue;
            left = Math.min(left, pos.x - CARD_W / 2);
            right = Math.max(right, pos.x + CARD_W / 2);
            top = Math.min(top, pos.y);
            bottom = Math.max(bottom, pos.y + CARD_H);
          }
          if (!Number.isFinite(left)) return;
          boxes.push({
            key: 'group-' + versionId,
            label: nodes[0].versionLabel,
            left: left - GROUP_PAD,
            top: top - GROUP_PAD - GROUP_HEAD,
            width: (right - left) + GROUP_PAD * 2,
            height: (bottom - top) + GROUP_PAD * 2 + GROUP_HEAD,
          });
        });
        return boxes;
      })();

      function applyView() {
        const el = worldRef.current;
        const view = viewRef.current;
        if (el) el.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.scale + ')';
        positionGroupNames();
      }

      /**
       * Keep every group name inside the visible band of its own frame.
       *
       * A group can be thousands of world units tall (one branch of a long
       * conversation is a long chain), so a name pinned to the frame's top edge
       * scrolls away exactly when the reader is looking at the middle of the
       * branch. The name is clamped to the visible part instead, the way a
       * sticky header behaves.
       */
      function positionGroupNames() {
        const graphEl = graphRef.current;
        const view = viewRef.current;
        if (!graphEl || graphEl.clientHeight === 0) return;
        const visibleTop = (-view.y) / view.scale;
        const visibleBottom = visibleTop + graphEl.clientHeight / view.scale;
        groupNameEls.current.forEach(function (entry) {
          const el = entry.el;
          if (!el) return;
          const nameHeight = (el.offsetHeight || 20) / view.scale;
          const minTop = 6;
          const maxTop = Math.max(minTop, entry.height - nameHeight - 6);
          const wanted = Math.max(visibleTop + 8, entry.top + minTop) - entry.top;
          const clamped = Math.max(minTop, Math.min(Math.min(wanted, visibleBottom - nameHeight - 8 - entry.top), maxTop));
          el.style.top = clamped + 'px';
        });
      }

      function renderFrame() {
        springs.current.forEach(function (s, id) {
          const el = cardEls.current.get(id);
          if (el) el.style.transform = 'translate(' + (s.x - CARD_W / 2) + 'px,' + s.y + 'px)';
        });
        const lay = layoutRef.current;
        if (!lay) return;
        for (let i = 0; i < lay.edges.length; i++) {
          const e = lay.edges[i];
          const el = edgeEls.current.get(e.from + '>' + e.to);
          const a = springs.current.get(e.from);
          const b = springs.current.get(e.to);
          if (!el || !a || !b) continue;
          const fromEl = cardEls.current.get(e.from);
          const h = fromEl ? fromEl.offsetHeight : 58;
          el.setAttribute('d', edgePath(a.x, a.y + h, b.x, b.y));
        }
      }

      function kick() {
        if (rafRef.current) return;
        let last = 0;
        const step = function (now) {
          rafRef.current = 0;
          const dt = last === 0 ? 1 / 60 : Math.min(0.05, (now - last) / 1000);
          last = now;
          let alive = false;
          springs.current.forEach(function (s, id) {
            const d = dragRef.current;
            if (d && d.kind === 'node' && d.id === id) { alive = true; return; }
            const k = 190, c = 24;
            s.vx += ((s.tx - s.x) * k - s.vx * c) * dt;
            s.vy += ((s.ty - s.y) * k - s.vy * c) * dt;
            s.x += s.vx * dt;
            s.y += s.vy * dt;
            if (Math.abs(s.vx) + Math.abs(s.vy) + Math.abs(s.tx - s.x) + Math.abs(s.ty - s.y) > 0.5) alive = true;
            else { s.x = s.tx; s.y = s.ty; s.vx = 0; s.vy = 0; }
          });
          renderFrame();
          if (alive) rafRef.current = requestAnimationFrame(step);
        };
        rafRef.current = requestAnimationFrame(step);
      }

      function fitView() {
        const el = graphRef.current;
        const lay = layoutRef.current;
        if (!el || !lay) return;
        let lo = Infinity, hi = -Infinity, bot = 100;
        lay.pos.forEach(function (p) {
          lo = Math.min(lo, p.x - CARD_W / 2);
          hi = Math.max(hi, p.x + CARD_W / 2);
          bot = Math.max(bot, p.y + 90);
        });
        if (lo === Infinity) { lo = 0; hi = CARD_W; }
        const w = el.clientWidth || 600;
        const h = el.clientHeight || 400;
        const scale = Math.min(1, (w - 70) / Math.max(1, hi - lo), (h - 70) / bot);
        viewRef.current = {
          x: (w - (hi - lo) * scale) / 2 - lo * scale,
          y: Math.max(30, (h - bot * scale) / 2),
          scale: scale,
        };
        applyView();
      }

      // Retarget springs on every layout change; new cards are born at their
      // parent's position so they visibly grow out of it.
      React.useEffect(function () {
        const lay = layout;
        const alive = new Set();
        lay.pos.forEach(function (p, id) {
          alive.add(id);
          let s = springs.current.get(id);
          if (!s) {
            const n = lay.byId.get(id);
            const pp = n && n.parentId ? lay.pos.get(n.parentId) : null;
            const born = pp || p;
            springs.current.set(id, { x: born.x, y: born.y, vx: 0, vy: 0, tx: p.x, ty: p.y });
          } else {
            s.tx = p.x;
            s.ty = p.y;
          }
        });
        springs.current.forEach(function (_, id) { if (!alive.has(id)) springs.current.delete(id); });
        if (!fittedRef.current && lay.pos.size > 0) {
          fittedRef.current = true;
          fitView();
        }
        applyView();
        kick();
        return function () {
          if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
        };
      }, [layout]);

      // Wheel zoom around the pointer (non-passive so we may preventDefault).
      React.useEffect(function () {
        const el = graphRef.current;
        if (!el) return undefined;
        const onWheel = function (ev) {
          ev.preventDefault();
          const view = viewRef.current;
          const rect = el.getBoundingClientRect();
          const mx = ev.clientX - rect.left;
          const my = ev.clientY - rect.top;
          const next = Math.min(1.8, Math.max(0.3, view.scale * Math.exp(-ev.deltaY * 0.0013)));
          const f = next / view.scale;
          view.x = mx - (mx - view.x) * f;
          view.y = my - (my - view.y) * f;
          view.scale = next;
          applyView();
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return function () { el.removeEventListener('wheel', onWheel); };
      }, []);

      function openVersion(id) {
        const lay = layoutRef.current;
        const node = lay && lay.byId.get(id);
        if (!node || node.deleted || !sessions) return;
        const v = versions.find(function (item) { return item.sessionId === node.sessionId; });
        if (!v) return;
        openVersionTarget(sessions, v);
        showChat();
        if (typeof node.turn === 'number' && node.turn > 0) flashTurn(node.sessionId, node.turn, 45);
      }

      /**
       * Collect every other version of this conversation into the tree, so the
       * sidebar keeps one entry. The host refuses while a version is mid-turn;
       * only the confirmed second call (`stopRunning`) has those turns stopped.
       */
      function collectOthers(stopRunning) {
        setMenu(null);
        setRenameError(null);
        mutate({ action: 'demoteOthers', sessionId: sessionId, stopRunning: stopRunning === true })
          .then(function () {
            setConfirmBusy(null);
            treeStore.load(sessionId);
          })
          .catch(function (error) {
            const busy = error && error.body && Array.isArray(error.body.busy) ? error.body.busy : null;
            if (busy !== null && busy.length > 0 && stopRunning !== true) {
              setConfirmBusy(busy);
              return;
            }
            const message = error && error.message ? error.message : String(error);
            setRenameError(t('collectFailed', { message: message }));
          });
      }

      /**
       * Rename the branch a node belongs to. This writes our sidecar through
       * the host route and nothing else: the session's own title in the sidebar
       * stays host-owned, which is the split the user asked for. Clearing the
       * text removes the name again.
       */
      function beginRename(n) {
        if (n.deleted) return;
        setMenu(null);
        setRenameError(null);
        pendingRename.current = { nodeId: n.id, sessionId: n.sessionId, value: n.versionLabel || '' };
        setRenaming({ ...pendingRename.current });
      }

      function beginMenu(n) {
        if (n.deleted) return;
        pendingRename.current = null;
        setRenaming(null);
        setRenameError(null);
        setMenu({ nodeId: n.id, sessionId: n.sessionId });
      }

      /**
       * Move a version between the main conversation and this tree. Promotion
       * unarchives it (a sidebar session again); demotion archives it (it lives
       * only here). Both are host-side, one call each, and both end with a
       * reload so the sidebar state and the tree agree.
       */
      function moveVersion(n, action) {
        setMenu(null);
        setRenameError(null);
        mutate({ action: action, sessionId: n.sessionId })
          .then(function (result) {
            // The host answers with the membership it settled on, so the menu
            // flips immediately. It is re-asserted after the refetch as well:
            // the read is authoritative for everything else, but it must not be
            // able to walk back the move we were just told succeeded.
            const archived = !(result && result.inMainChat === true);
            treeStore.patchVersion(sessionId, n.sessionId, { archived: archived });
            return treeStore.load(sessionId).then(function () {
              treeStore.patchVersion(sessionId, n.sessionId, { archived: archived });
            });
          })
          .catch(function (error) {
            const message = error && error.message ? error.message : String(error);
            setRenameError(t('moveFailed', { message: message }));
            console.warn('[dsh-tree-view] ' + action + ' failed', error);
          });
      }

      function commitRename() {
        const draft = pendingRename.current;
        pendingRename.current = null;
        setRenaming(null);
        if (!draft) return;
        const next = draft.value.trim();
        const version = versions.find(function (item) { return item.sessionId === draft.sessionId; });
        const current = (version && version.label) || '';
        if (next === current) return;
        mutate({ action: 'label', sessionId: draft.sessionId, label: next })
          .then(function () { treeStore.load(sessionId); })
          .catch(function (error) {
            const message = error && error.message ? error.message : String(error);
            setRenameError(t('renameFailed', { message: message }));
            console.warn('[dsh-tree-view] branch rename failed', error);
          });
      }

      function cancelRename() {
        pendingRename.current = null;
        setRenaming(null);
      }

      // The Tree is a view of the conversation, not a chat: while it is open the
      // host's composer block and the view's own width handles are hidden. Both
      // live outside this React tree, so they are addressed through a generated
      // stylesheet. The conversation module's class prefix is read off our own
      // ancestor rather than hard-coded: the hashed scope changes between host
      // builds, and a rename should degrade to "the chrome stays", never to a
      // broken panel. The host unmounts inactive views, so mount/unmount is
      // exactly the right lifetime.
      React.useEffect(function () {
        const graphEl = graphRef.current;
        if (!graphEl) return undefined;
        let scope = null;
        for (let node = graphEl; node && node !== document.body; node = node.parentElement) {
          const cls = typeof node.className === 'string' ? node.className : '';
          const match = /(?:^|\s)(_[A-Za-z0-9]+_)[A-Za-z]/.exec(cls);
          if (match) { scope = match[1]; break; }
        }
        if (scope === null) return undefined;
        const style = document.createElement('style');
        style.setAttribute('data-tree-view-chrome', '');
        style.textContent = 'html.dsh-tree-view-active [class^="' + scope + 'composerStack"]{display:none !important}'
          + 'html.dsh-tree-view-active [class^="' + scope + 'widthHandle"]{display:none !important}';
        document.head.appendChild(style);
        document.documentElement.classList.add('dsh-tree-view-active');
        return function () {
          document.documentElement.classList.remove('dsh-tree-view-active');
          style.remove();
        };
      }, []);

      // A menu is dismissed by clicking anywhere else, by Escape, or by the
      // panel going away (the host unmounts it).
      React.useEffect(function () {
        if (menu === null) return undefined;
        const onDown = function (ev) {
          if (ev.target && ev.target.closest && ev.target.closest('.mtx-menu')) return;
          setMenu(null);
        };
        const onKey = function (ev) { if (ev.key === 'Escape') setMenu(null); };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey);
        return function () {
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('keydown', onKey);
        };
      }, [menu === null]);

      // Group names follow the view: panning, zooming and refits all move them.
      React.useEffect(function () {
        positionGroupNames();
      });

      function onPointerDown(ev) {
        if (ev.button !== 0) return;
        const cardEl = ev.target.closest ? ev.target.closest('.mtx-card') : null;
        if (ev.target.closest && ev.target.closest('.mtx-tool,.mtx-link,.mtx-rename,.mtx-menu')) return;
        if (cardEl) {
          // A press on a node only selects it: nodes stay where the layout put
          // them. Dragging them around was a way to lose the shape of a branch,
          // and a tree is meant to be read, not hand-arranged.
          const id = cardEl.getAttribute('data-id');
          if (!springs.current.get(id)) return;
          dragRef.current = { kind: 'node', id: id, moved: false, sx: ev.clientX, sy: ev.clientY };
        } else {
          const view = viewRef.current;
          dragRef.current = { kind: 'pan', moved: false, sx: ev.clientX, sy: ev.clientY, ox: view.x, oy: view.y };
          graphRef.current.setAttribute('data-panning', '');
        }
        try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (e) {}
      }

      function onPointerMove(ev) {
        const d = dragRef.current;
        if (!d) return;
        const dx = ev.clientX - d.sx;
        const dy = ev.clientY - d.sy;
        if (!d.moved && Math.abs(dx) + Math.abs(dy) > 5) d.moved = true;
        if (!d.moved) return;
        if (d.kind === 'pan') {
          viewRef.current.x = d.ox + dx;
          viewRef.current.y = d.oy + dy;
          applyView();
        }
      }

      function onPointerUp() {
        const d = dragRef.current;
        dragRef.current = null;
        if (graphRef.current) graphRef.current.removeAttribute('data-panning');
        if (!d) return;
        if (d.kind === 'node' && !d.moved) openVersion(d.id);
      }

      function cardTitle(n) {
        if (n.deleted) return t('deletedVersion');
        if (n.copy) return t('copyBranch');
        if (n.isRoot) return t('original');
        if (n.operation === 'edit') return t('edited', { turn: n.turn });
        if (n.operation === 'retry') return t('retried', { turn: n.turn });
        return t('turn', { turn: n.turn });
      }

      return React.createElement('div', {
        className: 'mtx-graph',
        ref: graphRef,
        onPointerDown: onPointerDown,
        onPointerMove: onPointerMove,
        onPointerUp: onPointerUp,
        onPointerCancel: onPointerUp,
      },
        React.createElement('div', { className: 'mtx-world', ref: worldRef },
          groupBoxes.map(function (g) {
            return React.createElement('div', {
              key: g.key,
              className: 'mtx-group',
              style: { transform: 'translate(' + g.left + 'px,' + g.top + 'px)', width: g.width + 'px', height: g.height + 'px' },
            }, React.createElement('span', {
              className: 'mtx-group-name',
              ref: function (el) {
                if (el) groupNameEls.current.set(g.key, { el: el, top: g.top, height: g.height });
                else groupNameEls.current.delete(g.key);
              },
            }, g.label));
          }),
          React.createElement('svg', { className: 'mtx-edges' },
            layout.edges.map(function (e) {
              const key = e.from + '>' + e.to;
              const a = springs.current.get(e.from) || layout.pos.get(e.from);
              const b = springs.current.get(e.to) || layout.pos.get(e.to);
              return React.createElement('path', {
                key: key,
                className: 'mtx-edge',
                'data-path': e.onPath || undefined,
                d: a && b ? edgePath(a.x, a.y + 58, b.x, b.y) : undefined,
                ref: function (el) { if (el) edgeEls.current.set(key, el); else edgeEls.current.delete(key); },
              });
            })
          ),
          // Cards render from turnNodes, the version data of THIS render, and
          // take only geometry from the layout memo. Rendering from the layout
          // held stale node objects whenever the layout key had not changed —
          // which is exactly what an archive flag change looks like — so a menu
          // kept offering the move that had just been done.
          turnNodes.map(function (n) {
            const s = springs.current.get(n.id) || layout.pos.get(n.id) || { x: 0, y: 0 };
            const summary = titles[n.sessionId];
            // A named branch reads as a group: the name belongs to the box drawn
            // around the branch, and the node keeps saying what it is ("edited
            // turn 3"), so neither piece of information displaces the other.
            const sub = (n.running ? t('runningTag') + ' · ' : '')
              + (n.copy ? t('forkedAt', { turn: n.turn }) + ' · ' : '')
              + (n.archived ? t('archivedTag') + ' · ' : '')
              + (n.text ? '“' + clip(n.text, 44) + '” · ' : '')
              + (n.isRoot && !n.text && summary && summary.displayTitle ? clip(summary.displayTitle, 24) + ' · ' : '')
              + timeLabel(n.time);
            return React.createElement('div', {
              key: n.id,
              className: 'mtx-card',
              'data-id': n.id,
              // The node this one hangs from, in the open: a broken parent link
              // is what turns the tree into a pile of cards, and the layout test
              // asserts on this attribute directly.
              'data-parent': n.parentId || undefined,
              'data-current': n.current || undefined,
              'data-path': n.onCurrentPath || undefined,
              'data-deleted': n.deleted || undefined,
              'data-archived': n.archived || undefined,
              'data-running': n.running || undefined,
              title: n.deleted ? undefined : t('menuHint'),
              onContextMenu: function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                beginMenu(n);
              },
              style: { transform: 'translate(' + (s.x - CARD_W / 2) + 'px,' + s.y + 'px)' },
              ref: function (el) { if (el) cardEls.current.set(n.id, el); else cardEls.current.delete(n.id); },
            },
              React.createElement('span', { className: 'mtx-card-icon' },
                n.deleted ? '∅' : n.isRoot ? '●' : (n.operation === 'retry' ? '↻' : (n.operation === 'edit' ? '✎' : '💬'))),
              React.createElement('span', { className: 'mtx-card-main' },
                React.createElement('span', { className: 'mtx-card-title' }, cardTitle(n)),
                React.createElement('span', { className: 'mtx-card-sub' }, sub)
              )
            );
          }),
          // The rename editor renders inside the world so it inherits the same
          // pan/zoom transform as the card it replaces.
          renaming === null ? null : (function () {
            const s = springs.current.get(renaming.nodeId) || layout.pos.get(renaming.nodeId) || { x: 0, y: 0 };
            return React.createElement('div', {
              className: 'mtx-rename',
              key: 'rename-editor',
              style: { transform: 'translate(' + (s.x - CARD_W / 2) + 'px,' + s.y + 'px)' },
            },
              React.createElement('input', {
                type: 'text',
                className: 'mtx-rename-input',
                value: renaming.value,
                autoFocus: true,
                maxLength: 60,
                placeholder: t('renamePrompt'),
                title: t('renameEmptyHint'),
                onChange: function (ev) {
                  if (pendingRename.current) pendingRename.current.value = ev.target.value;
                  setRenaming({ nodeId: renaming.nodeId, sessionId: renaming.sessionId, value: ev.target.value });
                },
                onKeyDown: function (ev) {
                  if (ev.key === 'Enter') { ev.preventDefault(); commitRename(); }
                  else if (ev.key === 'Escape') { ev.preventDefault(); cancelRename(); }
                },
                onBlur: function () { commitRename(); },
                onPointerDown: function (ev) { ev.stopPropagation(); },
                onClick: function (ev) { ev.stopPropagation(); },
                onContextMenu: function (ev) { ev.preventDefault(); ev.stopPropagation(); },
              })
            );
          })(),
          // The context menu renders inside the world too, so it sits next to
          // the node it belongs to at any zoom level.
          menu === null ? null : (function () {
            const node = turnNodes.find(function (n) { return n.id === menu.nodeId; });
            if (!node) return null;
            const s = springs.current.get(menu.nodeId) || layout.pos.get(menu.nodeId) || { x: 0, y: 0 };
            const inMainChat = node.archived !== true;
            const isOpenSession = node.sessionId === sessionId;
            const items = [{
              key: 'rename',
              label: t('menuRename'),
              hint: null,
              disabled: false,
              run: function () { beginRename(node); },
            }];
            items.push(inMainChat ? {
              key: 'demote',
              label: t('menuDemote'),
              // Archiving the session that is currently open would put the app
              // in a state it cannot navigate out of, so the open one stays.
              hint: !archive.hide ? t('archiveUnavailable') : (isOpenSession ? t('menuDemoteOpen') : null),
              disabled: isOpenSession || !archive.hide,
              run: function () { moveVersion(node, 'demote'); },
            } : {
              key: 'promote',
              label: t('menuPromote'),
              hint: !archive.show ? t('archiveUnavailable') : null,
              disabled: !archive.show,
              run: function () { moveVersion(node, 'promote'); },
            });
            return React.createElement('div', {
              className: 'mtx-menu',
              key: 'context-menu',
              style: { transform: 'translate(' + (s.x + CARD_W / 2 + 6) + 'px,' + s.y + 'px)' },
              onPointerDown: function (ev) { ev.stopPropagation(); },
            },
              items.map(function (item) {
                return React.createElement('button', {
                  key: item.key,
                  type: 'button',
                  className: 'mtx-menu-item',
                  disabled: item.disabled || undefined,
                  title: item.hint || undefined,
                  onClick: function (ev) { ev.stopPropagation(); item.run(); },
                }, item.label);
              })
            );
          })()
        ),
        React.createElement('div', { className: 'mtx-graph-tools' },
          // Two controls over what the canvas shows, drawn as what they do: the
          // fork icon loses its second branch while empty forks are filtered
          // out, so the button does not need a sentence to explain itself.
          React.createElement('button', {
            type: 'button',
            className: 'mtx-tool',
            'data-on': prefs.dropEmptyForks ? '' : undefined,
            'aria-pressed': prefs.dropEmptyForks ? 'true' : 'false',
            title: t('dropForksLabel'),
            onClick: function () { prefsStore.set({ dropEmptyForks: !prefs.dropEmptyForks }); },
          }, ForkIcon({ filtered: prefs.dropEmptyForks })),
          React.createElement('button', {
            type: 'button',
            className: 'mtx-tool',
            title: archive.hide ? t('collectOthers') : t('archiveUnavailable'),
            disabled: !archive.hide || undefined,
            onClick: function () { collectOthers(false); },
          }, CollectIcon()),
          React.createElement('button', {
            type: 'button', className: 'mtx-tool', title: t('fit'),
            onClick: function () { fitView(); },
          }, '⌖'),
          React.createElement('button', {
            type: 'button', className: 'mtx-tool', title: t('refresh'),
            onClick: function () { treeStore.load(sessionId); },
          }, '↻')
        ),
        tree && tree.error ? React.createElement('div', { className: 'mtx-error' }, tree.error) : null,
        renameError ? React.createElement('div', { className: 'mtx-error' }, renameError) : null,
        // A degraded host is stated once, in place, rather than discovered by
        // clicking something that silently does nothing.
        archive.ok ? null : React.createElement('div', { className: 'mtx-notice' },
          t('archivePartial', { parts: archive.missing.join('、') })),
        // Tidying up never kills work quietly: a version that is mid-turn gets
        // this question first. Drawn in the panel because the desktop shell
        // implements neither prompt() nor confirm().
        confirmBusy === null ? null : React.createElement('div', { className: 'mtx-confirm' },
          React.createElement('div', { className: 'mtx-confirm-title' }, t('collectRunning', { count: confirmBusy.length })),
          React.createElement('div', { className: 'mtx-confirm-actions' },
            React.createElement('button', {
              type: 'button', className: 'mtx-btn mtx-btn-primary',
              onClick: function () { collectOthers(true); },
            }, t('collectStop')),
            React.createElement('button', {
              type: 'button', className: 'mtx-btn',
              onClick: function () { setConfirmBusy(null); },
            }, t('cancel'))
          )
        ),
        turnNodes.length <= 1 ? React.createElement('div', { className: 'mtx-empty' }, t('empty')) : null,
        React.createElement('a', {
          className: 'mtx-link',
          href: 'https://github.com/Rice00/dsh-tree-view',
          target: '_blank', rel: 'noreferrer',
        }, 'GitHub ↗')
      );
    }

    // Settings: pick the edit-interface style, with a live preview that
    // renders in the currently-selected look.
    function Toggle(props) {
      return React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'mtx-set-row' },
          React.createElement('span', { className: 'mtx-set-label' }, props.label),
          React.createElement('input', {
            type: 'checkbox', checked: props.checked, onChange: props.onChange,
          })
        ),
        React.createElement('div', { className: 'mtx-set-hint' }, props.hint)
      );
    }

    function StyleSettings() {
      const style = useStyle();
      const prefs = usePrefs();
      return React.createElement('div', { className: 'mtx-set' },
        React.createElement('div', { className: 'mtx-set-row' },
          React.createElement('span', { className: 'mtx-set-label' }, t('styleLabel')),
          React.createElement('select', {
            className: 'mtx-select', value: style,
            onChange: function (e) { styleStore.set(e.target.value); },
          },
            STYLES.map(function (s) {
              return React.createElement('option', { key: s, value: s }, t('style_' + s));
            })
          )
        ),
        React.createElement('div', { className: 'mtx-set-hint' }, t('styleDesc_' + style)),
        React.createElement(Toggle, {
          label: t('rememberPathLabel'),
          hint: t('rememberPathHint'),
          checked: prefs.rememberPath,
          onChange: function (e) { prefsStore.set({ rememberPath: e.target.checked }); },
        }),
        React.createElement(Toggle, {
          label: t('stopOnEditLabel'),
          hint: t('stopOnEditHint'),
          checked: prefs.stopOnEdit,
          onChange: function (e) { prefsStore.set({ stopOnEdit: e.target.checked }); },
        }),
        // The panel's toolbar carries the same switch with a one-line tooltip;
        // this is where the full explanation lives.
        React.createElement(Toggle, {
          label: t('dropForksLabel'),
          hint: t('dropForksHint'),
          checked: prefs.dropEmptyForks,
          onChange: function (e) { prefsStore.set({ dropEmptyForks: e.target.checked }); },
        }),
        React.createElement('div', { className: 'mtx-preview' },
          React.createElement('div', { className: 'mtx-row' },
            React.createElement('div', { className: 'mtx-line' },
              React.createElement('div', { className: 'mtx-bubble' }, t('previewUser'))
            ),
            React.createElement('div', { className: 'mtx-actions' },
              React.createElement('div', { className: 'mtx-ring' },
                React.createElement('button', { type: 'button', disabled: true }, '‹'),
                React.createElement('span', null, '2/3'),
                React.createElement('button', { type: 'button', disabled: true }, '›')
              ),
              React.createElement('span', { className: 'mtx-act', 'data-act': 'retry' }, RetryIcon()),
              React.createElement('span', { className: 'mtx-act', 'data-act': 'edit' }, PencilIcon()),
              React.createElement('span', { className: 'mtx-act', 'data-act': 'copy' }, CopyIcon())
            )
          ),
          React.createElement('div', { className: 'mtx-editor' },
            React.createElement('div', { className: 'mtx-textarea' }, t('previewUser')),
            React.createElement('div', { className: 'mtx-editor-actions' },
              React.createElement('span', { className: 'mtx-btn' }, t('cancel')),
              React.createElement('span', { className: 'mtx-btn', 'data-primary': '' }, t('send'))
            )
          ),
          React.createElement('div', { className: 'mtx-editor-outside' },
            React.createElement('span', { className: 'mtx-btn' }, t('cancel')),
            React.createElement('span', { className: 'mtx-btn', 'data-primary': '' }, t('save'))
          )
        ),
        React.createElement('a', {
          className: 'mtx-set-link',
          href: 'https://github.com/Rice00/dsh-tree-view',
          target: '_blank', rel: 'noreferrer',
        }, 'GitHub ↗')
      );
    }

    slots.inject('settings.section', function () {
      return slots.register(
        { name: 'settings.section', id: 'tree-view', order: 210, label: function () { return t('nav'); } },
        StyleSettings
      );
    });

    // Shadow only the plain user bubble; steering and context rows keep the
    // host renderer. A collision with another user-bubble plugin degrades to
    // "they win" rather than failing this plugin's other registrations.
    slots.inject('conversation.chat.node', function () {
      try {
        return slots.register(
          { name: 'conversation.chat.node', key: 'user', priority: -1 },
          UserMessageView
        );
      } catch (e) {
        console.warn('[dsh-tree-view] Failed to register the user-message view; editing is unavailable.', e);
        return function () {};
      }
    });

    slots.inject('conversation.view', function () {
      return slots.register(
        {
          name: 'conversation.view',
          id: 'tree-view',
          order: VIEW_ORDER,
          label: function () { return t('view'); },
          inject: function (sessionId) { return { sessionId: sessionId }; },
        },
        VersionsView
      );
    });
  }
};
