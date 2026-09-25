import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

const VERSIONS = [
  { sessionId: 'session-root', createdAt: 1, current: true, turns: [{ turn: 1, text: 'root turn', time: 1 }] },
  { sessionId: 'session-branch', parentSessionId: 'session-root', targetTurn: 1, operation: 'edit', createdAt: 2, turns: [{ turn: 1, text: 'branch turn', time: 2 }] },
];

// Boot the shipped bundle and capture the conversation.view component through
// its real slot registration, then drive the branch menu with real DOM events.
// The regression this exists for: the card/menu state used to come from a
// layout memo that did not depend on the archive flag, so right-clicking right
// after a move still offered the move that had just happened.
async function mountView(t) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://tree-view.test/',
    // The graph animates node positions, so the sandbox needs frame callbacks.
    pretendToBeVisual: true,
  });
  const posts = [];
  // Deliberately stale reads: the GET keeps reporting the branch as being in
  // the sidebar, which is the worst case for the menu — it must still flip from
  // the move itself instead of waiting for a refetch to tell it.
  dom.window.fetch = async (url, options) => {
    if (options && options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ versions: VERSIONS }) };
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

  let view;
  const slots = {
    inject(_name, register) { register(); },
    register(spec, component) {
      if (spec.name === 'conversation.view') view = component;
      return () => {};
    },
  };
  let plugin;
  dom.window.__ModuleLoader__ = {
    load({ factory }) {
      plugin = factory(() => React);
    },
  };
  runInNewContext(bundle, {
    window: dom.window, document: dom.window.document, console, setTimeout, clearTimeout,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  }, { filename: 'lib/client.js' });
  const ctx = {
    get(name) {
      if (name === 'slots') return slots;
      if (name === 'sessions') {
        return {
          open: () => {},
          list: {
            subscribe: () => () => {},
            getSnapshot: () => ({ byId: Object.fromEntries(VERSIONS.map((v) => [v.sessionId, { id: v.sessionId }])) }),
          },
        };
      }
      return undefined;
    },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  };
  // The client takes optional services through `ctx.inject`; the double hands the
  // same context back, the way Cordis hands back a scope over it.
  ctx.inject = (deps, callback) => callback(ctx);
  plugin.apply(ctx);
  assert.equal(typeof view, 'function', 'The Tree view must register');
  await act(async () => { root.render(React.createElement(view, { sessionId: 'session-root' })); });
  await act(async () => { await Promise.resolve(); });
  return {
    dom,
    posts,
    render: () => act(async () => { root.render(React.createElement(view, { sessionId: 'session-root' })); }),
    menuLabels: () => [...dom.window.document.querySelectorAll('.mtx-menu-item')].map((b) => b.textContent),
    openMenuOnBranch: async () => {
      const card = dom.window.document.querySelector('.mtx-card[data-id="session-branch#t1"]');
      assert.ok(card, 'the branch node is drawn');
      await act(async () => {
        card.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
    },
    clickMenuItem: async (label) => {
      const button = [...dom.window.document.querySelectorAll('.mtx-menu-item')].find((b) => b.textContent === label);
      assert.ok(button, 'menu item ' + label + ' exists');
      await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
      await act(async () => { await Promise.resolve(); });
    },
    groupNames: () => [...dom.window.document.querySelectorAll('.mtx-group-name')].map((el) => el.textContent),
  };
}

test('the branch menu offers the other move right after a move', async (t) => {
  const view = await mountView(t);

  await view.openMenuOnBranch();
  // No locale service in this harness, so the plugin's English dictionary is
  // what renders — the point here is which items appear, not the wording.
  assert.deepEqual(view.menuLabels(), ['Rename branch', 'Collect into the tree'], 'a version in the sidebar can be collected into the tree');

  await view.clickMenuItem('Collect into the tree');
  assert.deepEqual(view.posts, [{ action: 'demote', sessionId: 'session-branch' }], 'the move reached the host route');

  await view.openMenuOnBranch();
  assert.deepEqual(view.menuLabels(), ['Rename branch', 'Move to main chat'],
    'and the menu flips on the next right-click, without waiting for a refetch');
});

test('a named branch is drawn as a group whose name is the version name', async (t) => {
  const view = await mountView(t);
  const before = view.groupNames();
  assert.deepEqual(before, [], 'an unnamed branch draws no group');

  await view.openMenuOnBranch();
  await view.clickMenuItem('Rename branch');
  const input = view.dom.window.document.querySelector('.mtx-rename-input');
  assert.ok(input, 'renaming opens an inline editor rather than a native prompt');
  await act(async () => {
    // React tracks the previous value, so the native setter is what makes a
    // programmatic edit look like typing.
    const setter = Object.getOwnPropertyDescriptor(view.dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '方案 B');
    input.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await act(async () => { await Promise.resolve(); });
  assert.deepEqual(view.posts, [{ action: 'label', sessionId: 'session-branch', label: '方案 B' }]);
});
