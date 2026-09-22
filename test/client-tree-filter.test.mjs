import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// A conversation, a photocopy of it (a fork with no turns of its own), and a
// fork that kept talking. The photocopy is what the "hide forks with no new
// content" switch is about; the layout assertions are there because a broken
// parent link is what turns the tree into a pile of overlapping cards.
const ROOT_TURNS = Array.from({ length: 16 }, (_, i) => ({ turn: i + 1, text: 'root turn ' + (i + 1), time: i + 1 }));
const COPY_TURNS = Array.from({ length: 12 }, (_, i) => ({ turn: i + 1, text: 'copied turn ' + (i + 1), time: i + 1 }));
const FORK_TURNS = Array.from({ length: 17 }, (_, i) => ({ turn: i + 1, text: 'fork turn ' + (i + 1), time: i + 1 }));

const VERSIONS = [
  { sessionId: 'session-root', createdAt: 1, current: true, turns: ROOT_TURNS },
  { sessionId: 'session-copy', parentSessionId: 'session-root', createdAt: 2, forkTurn: 12, copy: true, turns: COPY_TURNS },
  { sessionId: 'session-fork', parentSessionId: 'session-root', createdAt: 3, forkTurn: 15, turns: FORK_TURNS },
];

async function mountView(t, prefs, versions = VERSIONS, fetchImpl) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://tree-view.test/',
    pretendToBeVisual: true,
  });
  dom.window.localStorage.setItem('dsh-tree-view:prefs', JSON.stringify(Object.assign({
    rememberPath: true, stopOnEdit: true, dropEmptyForks: true,
  }, prefs)));
  dom.window.fetch = fetchImpl ?? (async () => ({ ok: true, json: async () => ({ versions }) }));
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
    register(spec, component) { if (spec.name === 'conversation.view') view = component; return () => {}; },
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
          open: () => {},
          list: {
            subscribe: () => () => {},
            getSnapshot: () => ({ byId: Object.fromEntries(versions.map((v) => [v.sessionId, { id: v.sessionId }])) }),
          },
        };
      }
      return undefined;
    },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  });
  assert.equal(typeof view, 'function');
  await act(async () => { root.render(React.createElement(view, { sessionId: 'session-root' })); });
  await act(async () => { await Promise.resolve(); });
  const cardIds = () => [...dom.window.document.querySelectorAll('.mtx-card')].map((el) => el.getAttribute('data-id'));
  const offsets = () => [...dom.window.document.querySelectorAll('.mtx-card')].map((el) => el.style.transform);
  const titles = () => [...dom.window.document.querySelectorAll('.mtx-card-title')].map((el) => el.textContent);
  const links = () => [...dom.window.document.querySelectorAll('.mtx-card')]
    .map((el) => ({ id: el.getAttribute('data-id'), parent: el.getAttribute('data-parent') }));
  const tools = () => [...dom.window.document.querySelectorAll('.mtx-graph-tools .mtx-tool')];
  const clickTool = (index) => act(async () => {
    tools()[index].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  const confirmTitle = () => (dom.window.document.querySelector('.mtx-confirm-title') || {}).textContent ?? null;
  const confirmButtons = () => [...dom.window.document.querySelectorAll('.mtx-confirm .mtx-btn')].map((b) => b.textContent);
  const clickConfirm = (label) => act(async () => {
    const button = [...dom.window.document.querySelectorAll('.mtx-confirm .mtx-btn')].find((b) => b.textContent === label);
    assert.ok(button, 'confirm button ' + label + ' exists');
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  return { dom, cardIds, offsets, titles, links, tools, clickTool, confirmTitle, confirmButtons, clickConfirm };
}

test('the switch decides whether a photocopy is drawn, and the layout stays sane', async (t) => {
  const hidden = await mountView(t, { dropEmptyForks: true });
  const hiddenIds = hidden.cardIds();
  assert.ok(!hiddenIds.some((id) => id.startsWith('session-copy')),
    'with the switch on, the copy is not on the canvas');
  assert.ok(hiddenIds.includes('session-fork#t16'),
    'while a fork that kept talking is drawn from its first own turn');
  assert.ok(!hiddenIds.includes('session-fork#t1'),
    'and never re-draws the history it copied');

  // A dangling parent link is what makes the tree a pile of cards: the layout
  // leaves the node unplaced and every transform turns into NaN.
  for (const offset of hidden.offsets()) {
    assert.ok(!/NaN|undefined/.test(offset), 'every card is placed: ' + offset);
  }
});

test('with the switch off, a photocopy is drawn as one copy node', async (t) => {
  const shown = await mountView(t, { dropEmptyForks: false });
  const ids = shown.cardIds();
  assert.ok(ids.includes('session-copy#fork'), 'the copy gets exactly one node');
  assert.ok(!ids.includes('session-copy#t1'), 'and does not re-draw the history it copied');
  assert.ok(shown.titles().includes('Forked copy'), 'labelled as a copy, not as an edit');
  for (const offset of shown.offsets()) {
    assert.ok(!/NaN|undefined/.test(offset), 'every card is placed: ' + offset);
  }
});

// Turn numbers are not contiguous in real logs: a turn that was interrupted or
// steered into never writes its turn/end, so a conversation can count 18 turns
// while numbering them 1..12 and 14..19. Both reported "turn N should come after
// turn N-2" cases came from chaining on `turn - 1` and falling back to the root
// when that invented node turned out not to exist.
const GAPPED_VERSIONS = [
  {
    sessionId: 'session-root',
    createdAt: 1,
    current: true,
    turns: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19].map((turn) => ({ turn, text: 'root ' + turn, time: turn })),
  },
  {
    sessionId: 'session-gap-fork',
    parentSessionId: 'session-root',
    createdAt: 2,
    forkTurn: 15,
    turns: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20].map((turn) => ({ turn, text: 'fork ' + turn, time: turn })),
  },
];

test('the toolbar says what it does in a line, and asks before stopping work', async (t) => {
  const posts = [];
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, async (url, options) => {
    if (options && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      posts.push(payload);
      if (payload.action === 'demoteOthers' && payload.stopRunning !== true) {
        return { ok: false, status: 409, json: async () => ({ error: 'busy', busy: ['session-fork'] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ versions: VERSIONS }) };
  });

  const labels = view.tools().map((el) => el.getAttribute('title'));
  assert.equal(labels.length, 4, 'filter, collect, fit, refresh');
  assert.ok(labels[0].length <= 24, 'the filter tooltip is a line, not a paragraph: ' + labels[0]);
  assert.ok(view.tools()[0].querySelector('svg'), 'the filter uses an icon, not a punctuation mark');
  assert.ok(view.tools()[1].querySelector('svg'), 'and so does collect');

  await view.clickTool(1);
  assert.ok(posts.some((p) => p.action === 'demoteOthers'), 'collect asks the host');
  assert.ok(!posts.some((p) => p.stopRunning === true), 'and does not stop anything before the user says so');
  assert.ok(view.confirmTitle() !== null, 'a running branch is a question, not a silent kill');
  assert.deepEqual(view.confirmButtons(), ['Stop and collect', 'Cancel']);

  await view.clickConfirm('Stop and collect');
  assert.ok(posts.some((p) => p.action === 'demoteOthers' && p.stopRunning === true), 'confirmed, it stops and collects');
  assert.equal(view.confirmTitle(), null, 'and the question goes away');
});

test('a gap in the turn numbering does not orphan the chain', async (t) => {
  const shown = await mountView(t, { dropEmptyForks: true }, GAPPED_VERSIONS);
  const links = shown.links();
  const parentOf = (id) => (links.find((link) => link.id === id) || {}).parent;

  assert.equal(parentOf('session-root#t14'), 'session-root#t12',
    'turn 14 follows turn 12 — the turn that actually exists before it');
  assert.equal(parentOf('session-root#t15'), 'session-root#t14');
  assert.equal(parentOf('session-gap-fork#t16'), 'session-root#t15',
    'a fork starts on the turn it forked from, not on the root');
  assert.equal(parentOf('session-gap-fork#t20'), 'session-gap-fork#t18',
    'and turn 20 follows turn 18, not the root');

  const ids = new Set(links.map((link) => link.id));
  for (const link of links) {
    if (!link.parent) continue;
    assert.ok(link.parent === 'session-root#root' || ids.has(link.parent),
      'no dangling parent: ' + link.id + ' -> ' + link.parent);
  }
  assert.deepEqual(links.filter((link) => link.parent === 'session-root#root').map((link) => link.id),
    ['session-root#t1'],
    'only the conversation\'s own first turn hangs off the root — the fork hangs off turn 15');
});
