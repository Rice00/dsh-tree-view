import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// One family (root + an edited branch) and a second conversation that is not
// part of it. Reported twice, in two shapes:
//
//   1. with dsh-tree-view(1) — the branch — open in its Tree tab, clicking
//      dsh-tree-view in the sidebar landed on the root for a flash and then
//      snapped straight back to the branch;
//   2. after that, sending a message in the root jumped to the branch's Tree
//      tab again — the same restore, this time with its `sessions.open` parked
//      in a session-list subscription that only fired when the list changed.
//
// Both come from the restore that remembers which branch was open: it cannot
// tell "the app put me back where I was" from "I asked for this conversation".
const VERSIONS = [
  {
    sessionId: 'session-root',
    createdAt: 1,
    current: true,
    turns: [{ turn: 1, text: 'root one', time: 1 }, { turn: 2, text: 'root two', time: 2 }],
  },
  {
    sessionId: 'session-branch',
    parentSessionId: 'session-root',
    targetTurn: 1,
    operation: 'edit',
    createdAt: 2,
    turns: [{ turn: 1, text: 'branch one', time: 2 }],
  },
  {
    sessionId: 'session-branch2',
    parentSessionId: 'session-root',
    targetTurn: 1,
    operation: 'edit',
    createdAt: 3,
    turns: [{ turn: 1, text: 'branch two', time: 3 }],
  },
  {
    sessionId: 'session-other',
    createdAt: 4,
    turns: [{ turn: 1, text: 'other one', time: 4 }],
  },
];

const PATH_KEY = 'dsh-tree-view:active-path';

/**
 * Boot the shipped bundle and render the user bubble the host asks for, which
 * is where the restore lives. `opened` collects every navigation the plugin
 * performs on its own; the session list is mutable so a test can make a branch
 * appear only after the fact, the way unarchiving does.
 */
async function mountChat(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://tree-view.test/',
    pretendToBeVisual: true,
  });
  // The switch is off by default now, so a test that wants the restore writes
  // the current schema out — which is exactly what a real toggle writes.
  const prefs = options.prefs === undefined ? { v: 2, rememberPath: true } : options.prefs;
  dom.window.localStorage.setItem('dsh-tree-view:prefs', JSON.stringify(prefs));
  if (options.remembered) {
    dom.window.localStorage.setItem(PATH_KEY, JSON.stringify({ 'session-root': options.remembered }));
  }
  const versions = VERSIONS.map((v) => {
    if (options.archiveBranch && v.sessionId === 'session-branch') return Object.assign({}, v, { archived: true });
    if (options.runningBranch && v.sessionId === 'session-branch') return Object.assign({}, v, { running: true });
    return v;
  });
  const posts = [];
  dom.window.fetch = async (url, init) => {
    if (init && init.method === 'POST') posts.push({ url, body: init.body });
    return { ok: true, json: async () => ({ versions }) };
  };

  const byId = {};
  for (const v of versions) {
    if (!options.listed || options.listed.includes(v.sessionId)) byId[v.sessionId] = { id: v.sessionId };
  }
  const subscribers = [];
  const list = {
    subscribe(fn) {
      subscribers.push(fn);
      return () => { const at = subscribers.indexOf(fn); if (at !== -1) subscribers.splice(at, 1); };
    },
    getSnapshot() { return { byId }; },
  };

  const previous = new Map();
  const browserErrors = [];
  dom.window.addEventListener('error', (event) => browserErrors.push(event.error || event.message));
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root'));
  const disposers = [];
  const opened = [];
  t.after(async () => {
    await act(async () => root.unmount());
    for (const dispose of disposers.reverse()) dispose();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    assert.deepEqual(browserErrors, [], 'Browser event handlers must not throw');
  });

  let nodeView;
  const slots = {
    inject(_name, register) { register(); },
    register(spec, component) {
      if (spec.name === 'conversation.chat.node') nodeView = component;
      return () => {};
    },
  };
  let plugin;
  dom.window.__ModuleLoader__ = { load({ factory }) { plugin = factory(() => React); } };
  runInNewContext(bundle, {
    window: dom.window, document: dom.window.document, console, setTimeout, clearTimeout,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  }, { filename: 'lib/client.js' });
  plugin.apply({
    get(name) {
      if (name === 'slots') return slots;
      if (name === 'sessions') return { open: (sessionId) => { opened.push(sessionId); }, list };
      return undefined;
    },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  });
  assert.equal(typeof nodeView, 'function', 'the user bubble must be registered');

  // The host re-renders the bubble with the session it belongs to; the plugin
  // reads the payload through its own store, so one flush is not always enough.
  const render = async (sessionId) => {
    const node = { sessionId, data: { content: [{ type: 'text', text: 'hello' }] }, location: { turn: 1 } };
    await act(async () => { root.render(React.createElement(nodeView, { sessionId, node })); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
  };
  const sessionAppears = async (sessionId) => {
    byId[sessionId] = { id: sessionId };
    await act(async () => { for (const fn of [...subscribers]) fn(); });
    await act(async () => { await Promise.resolve(); });
  };
  return { dom, opened, posts, render, sessionAppears };
}

test('clicking the family root while its branch is open does not snap back', async (t) => {
  const chat = await mountChat(t, { remembered: 'session-branch' });

  await chat.render('session-branch');
  assert.deepEqual(chat.opened, [], 'reading a branch navigates nowhere on its own');

  await chat.render('session-root');
  assert.deepEqual(chat.opened, [],
    'the click on dsh-tree-view must stay on dsh-tree-view, not chase dsh-tree-view(1)');
});

test('a page-load landing on the root leaves you where the app put you', async (t) => {
  const chat = await mountChat(t, { remembered: 'session-branch' });

  await chat.render('session-root');
  assert.deepEqual(chat.opened, [],
    'being put back on a conversation after a reload is not a reason to navigate away from it');
});

test('a branch the sidebar does not list is never chased later', async (t) => {
  // The late jump: the restore used to hand `sessions.open` to a session-list
  // subscription, so it fired whenever the list next changed — which is what
  // sent a half-typed message to the other branch's Tree tab.
  const chat = await mountChat(t, { remembered: 'session-branch', listed: ['session-root', 'session-other'] });

  await chat.render('session-other');
  await chat.render('session-root');
  assert.deepEqual(chat.opened, [], 'a branch that is not in the sidebar is not opened');

  await chat.sessionAppears('session-branch');
  assert.deepEqual(chat.opened, [], 'and it is not opened later, when the list happens to change');
});

test('an archived branch is not unarchived behind your back', async (t) => {
  const chat = await mountChat(t, { remembered: 'session-branch', archiveBranch: true });

  await chat.render('session-other');
  await chat.render('session-root');
  assert.deepEqual(chat.opened, [],
    'an archived branch is not opened, because opening it would mean unarchiving it first');
  assert.deepEqual(chat.posts, [], 'and nothing was asked of the host to make that possible');
});

test('reopening the family from elsewhere still returns to the branch', async (t) => {
  // Also the "turned on in this schema" case: the harness writes v2 above.
  const chat = await mountChat(t, { remembered: 'session-branch' });

  await chat.render('session-other');
  assert.deepEqual(chat.opened, [], 'an unrelated conversation opens nothing');

  await chat.render('session-root');
  assert.deepEqual(chat.opened, ['session-branch'],
    'the branch you last had open is what a fresh landing on the family restores');
});

test('the switch is off by default: nothing navigates, but the memory is kept', async (t) => {
  const chat = await mountChat(t, { prefs: {} });

  await chat.render('session-branch');
  const kept = JSON.parse(chat.dom.window.localStorage.getItem('dsh-tree-view:active-path') || '{}');
  assert.equal(kept['session-root'], 'session-branch',
    'the branch you read is still recorded, so turning the switch on knows where you were');

  await chat.render('session-other');
  await chat.render('session-root');
  assert.deepEqual(chat.opened, [], 'with the switch off the plugin never switches sessions');
});

test('a preference stored before this schema does not carry the old jump forward', async (t) => {
  // The stored object says `rememberPath: true`, but it was written when that
  // was the default — a stored preference cannot be told from an inherited one,
  // which is why the schema version exists. Other toggles in the same object
  // keep their values (client-tree-filter covers that side).
  const chat = await mountChat(t, {
    remembered: 'session-branch',
    prefs: { rememberPath: true, stopOnEdit: false, dropEmptyForks: false },
  });

  await chat.render('session-other');
  await chat.render('session-root');
  assert.deepEqual(chat.opened, [], 'an inherited value is dropped rather than honoured');
});

test('the restore does not fire twice in one page load', async (t) => {
  const chat = await mountChat(t, { remembered: 'session-branch' });

  await chat.render('session-other');
  await chat.render('session-root');
  assert.deepEqual(chat.opened, ['session-branch'], 'the restore fires once');

  await chat.render('session-other');
  await chat.render('session-root');
  assert.deepEqual(chat.opened, ['session-branch'], 'and not again on the next visit');
});

// Collecting the branch you leave is the one thing here that writes: it archives
// a session, so it is off until the setting says otherwise.
const collectOn = { v: 2, rememberPath: false, autoCollectPrevious: true };
const collectOff = { v: 2, rememberPath: false };
const bodies = (chat) => chat.posts.map((p) => JSON.parse(p.body));

test('collecting the branch you leave is off unless asked for', async (t) => {
  const chat = await mountChat(t, { prefs: collectOff });

  await chat.render('session-branch');
  await chat.render('session-branch2');
  assert.deepEqual(bodies(chat), [], 'with the switch off the plugin archives nothing by itself');
});

test('with the switch on, the branch you leave is collected', async (t) => {
  const chat = await mountChat(t, { prefs: collectOn });

  await chat.render('session-branch');
  await chat.render('session-branch2');
  assert.deepEqual(bodies(chat), [{ action: 'demote', sessionId: 'session-branch' }],
    'the branch you left went back into the tree');
});

test('the entry moves with you: the conversation is collected like any other', async (t) => {
  const chat = await mountChat(t, { prefs: collectOn });

  await chat.render('session-root');
  await chat.render('session-branch');
  assert.deepEqual(bodies(chat), [{ action: 'demote', sessionId: 'session-root' }],
    'one entry per conversation means the entry follows the version you open — and that version is never the one collected');
});

test('a branch that is still generating a reply is left alone', async (t) => {
  const chat = await mountChat(t, { prefs: collectOn, runningBranch: true });

  await chat.render('session-branch');
  await chat.render('session-branch2');
  assert.deepEqual(bodies(chat), [],
    'archiving mid-turn would hide work that is still arriving, so it is skipped');
});
