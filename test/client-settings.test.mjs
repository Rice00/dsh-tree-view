import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// The settings section is the only place a reader learns what the switches do, so
// it is worth asserting on: one name for the section (TreeView), one readable row
// per setting, and a hint under each that says something rather than echoing a
// dictionary key.
async function mountSettings(t) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://tree-view.test/',
    pretendToBeVisual: true,
  });
  dom.window.localStorage.setItem('dsh-tree-view:prefs', JSON.stringify({ v: 2 }));
  dom.window.fetch = async () => ({ ok: true, json: async () => ({ versions: [] }) });
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

  let spec = null;
  let component = null;
  const slots = {
    inject(_name, register) { register(); },
    register(s, c) { if (s.name === 'settings.section') { spec = s; component = c; } return () => {}; },
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
      if (name === 'sessions') return { open() {}, list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: {} }) } };
      return undefined;
    },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  });
  assert.ok(component, 'the settings section must register');
  await act(async () => { root.render(React.createElement(component)); });

  const texts = (selector) => [...dom.window.document.querySelectorAll(selector)].map((el) => el.textContent);
  return {
    dom,
    name: spec.label(),
    rows: () => texts('.mtx-set-label'),
    hints: () => texts('.mtx-set-hint'),
    selects: () => [...dom.window.document.querySelectorAll('.mtx-select')],
    toggles: () => [...dom.window.document.querySelectorAll('.mtx-set-row input[type=checkbox]')],
  };
}

test('the settings section is named TreeView and explains every row', async (t) => {
  const view = await mountSettings(t);

  assert.equal(view.name, 'TreeView', 'one name for the section');
  assert.deepEqual(view.rows(), [
    'Message control style',
    'Open the version I was last reading',
    'Stop the reply that is still being written',
    'Hide forks with no new turns',
    'Fold long straight stretches',
  ]);

  const hints = view.hints();
  assert.equal(hints.length, view.rows().length, 'every row has a hint, including the two selects');
  for (const hint of hints) {
    assert.ok(hint.length > 40, 'a hint says something: ' + hint);
    assert.ok(!/undefined|\{count\}|\{message\}|\{parts\}/.test(hint), 'and is not a raw dictionary key: ' + hint);
  }

  const intro = view.dom.window.document.querySelector('.mtx-set-intro');
  assert.ok(intro && intro.textContent.length > 40, 'the section opens with a line about what it covers');
  assert.equal(view.selects().length, 2, 'two choices: the control style and the fold threshold');
  assert.equal(view.toggles().length, 3, 'three switches, and no more');
});
