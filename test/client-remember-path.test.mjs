import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// One family (root + an edited branch) and a second conversation that is not
// part of it. The reported bug: with dsh-tree-view(1) — the branch — open in
// the Tree tab, clicking dsh-tree-view in the sidebar landed on the root for a
// moment and then snapped back to the branch. The remember-the-branch restore
// cannot tell "the app dropped me on the family root" from "I asked for the
// root", and re-firing it once per page load is why it only showed up the first
// time after a restart.
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
    sessionId: 'session-other',
    createdAt: 3,
    turns: [{ turn: 1, text: 'other one', time: 3 }],
  },
];

const PATH_KEY = 'dsh-tree-view:active-path';

/**
 * Boot the shipped bundle and render the user bubble the host asks for, which
 * is where the restore lives. `opened` collects every navigation the plugin
 * performs on its own.
 */
async function mountChat(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://tree-view.test/',
    pretendToBeVisual: true,
  });
  dom.window.localStorage.setItem('dsh-tree-view:prefs', JSON.stringify({ rememberPath: true }));
  if (options.remembered) {
    dom.window.localStorage.setItem(PATH_KEY, JSON.stringify({ 'session-root': options.remembered }));
  }
  dom.window.fetch = async () => ({ ok: true, json: async () => ({ versions: VERSIONS }) });

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
      if (name === 'sessions') {
        return {
          open: (sessionId) => { opened.push(sessionId); },
          list: {
            subscribe: () => () => {},
            getSnapshot: () => ({ byId: Object.fromEntries(VERSIONS.map((v) => [v.sessionId, { id: v.sessionId }])) }),
          },
        };
      }
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
  return { dom, opened, render };
}

test('clicking the family root while its branch is open does not snap back', async (t) => {
  const chat = await mountChat(t, { remembered: 'session-branch' });

  await chat.render('session-branch');
  assert.deepEqual(chat.opened, [], 'reading a branch navigates nowhere on its own');

  await chat.render('session-root');
  assert.deepEqual(chat.opened, [],
    'the click on dsh-tree-view must stay on dsh-tree-view, not chase dsh-tree-view(1)');
});

test('reopening the family from elsewhere still returns to the branch', async (t) => {
  const chat = await mountChat(t, { remembered: 'session-branch' });

  await chat.render('session-other');
  assert.deepEqual(chat.opened, [], 'an unrelated conversation opens nothing');

  await chat.render('session-root');
  assert.deepEqual(chat.opened, ['session-branch'],
    'the branch you last had open is what a fresh landing on the family restores');
});

test('a cold landing on the family root restores the branch, once', async (t) => {
  const chat = await mountChat(t, { remembered: 'session-branch' });

  await chat.render('session-root');
  assert.deepEqual(chat.opened, ['session-branch'], 'the restore still fires on first landing');

  await chat.render('session-root');
  assert.deepEqual(chat.opened, ['session-branch'], 'and it does not fire twice');
});
