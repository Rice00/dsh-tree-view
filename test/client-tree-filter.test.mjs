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

async function mountView(t, prefs, versions = VERSIONS, fetchImpl, viewSessionId = 'session-root') {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://tree-view.test/',
    pretendToBeVisual: true,
  });
  // These tests are about the tree's shape, not about the fold, so the stored
  // preferences switch the fold off unless a test asks for it. `'default'`
  // leaves the key out entirely, which is how a fresh install looks — that is
  // the only way to assert on the shipped default.
  const stored = Object.assign({ rememberPath: true, stopOnEdit: true, dropEmptyForks: true, foldSharedAt: 0 }, prefs);
  if (stored.foldSharedAt === 'default') delete stored.foldSharedAt;
  dom.window.localStorage.setItem('dsh-tree-view:prefs', JSON.stringify(stored));
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
  await act(async () => { root.render(React.createElement(view, { sessionId: viewSessionId })); });
  await act(async () => { await Promise.resolve(); });
  const cardIds = () => [...dom.window.document.querySelectorAll('.mtx-card')].map((el) => el.getAttribute('data-id'));
  const offsets = () => [...dom.window.document.querySelectorAll('.mtx-card')].map((el) => el.style.transform);
  const titles = () => [...dom.window.document.querySelectorAll('.mtx-card-title')].map((el) => el.textContent);
  const links = () => [...dom.window.document.querySelectorAll('.mtx-card')]
    .map((el) => ({
      id: el.getAttribute('data-id'),
      parent: el.getAttribute('data-parent'),
      current: el.hasAttribute('data-current'),
      head: el.hasAttribute('data-head'),
    }));
  const tools = () => [...dom.window.document.querySelectorAll('.mtx-graph-tools .mtx-tool')];
  const clickTool = (index) => act(async () => {
    tools()[index].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  // Cards act on pointerup, the way the canvas does: press, release, done.
  const clickCard = (id) => act(async () => {
    const el = dom.window.document.querySelector('.mtx-card[data-id="' + id + '"]');
    assert.ok(el, 'card ' + id + ' is drawn');
    el.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    el.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }));
  });
  const foldCard = () => dom.window.document.querySelector('.mtx-card[data-fold]');
  const confirmTitle = () => (dom.window.document.querySelector('.mtx-confirm-title') || {}).textContent ?? null;
  const confirmButtons = () => [...dom.window.document.querySelectorAll('.mtx-confirm .mtx-btn')].map((b) => b.textContent);
  const clickConfirm = (label) => act(async () => {
    const button = [...dom.window.document.querySelectorAll('.mtx-confirm .mtx-btn')].find((b) => b.textContent === label);
    assert.ok(button, 'confirm button ' + label + ' exists');
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  // A real press is pointerdown → pointerup → click. The canvas pans on the
  // first of those and captures the pointer, so an overlay that the pan handler
  // does not recognise never receives the click at all — which is exactly how
  // Cancel came to do nothing.
  const pressDown = (selector) => act(async () => {
    const el = dom.window.document.querySelector(selector);
    assert.ok(el, 'element ' + selector + ' exists');
    el.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  });
  const graphsPanning = () => {
    const graph = dom.window.document.querySelector('.mtx-graph');
    return !!graph && graph.hasAttribute('data-panning');
  };
  return {
    dom, cardIds, offsets, titles, links, tools, clickTool, clickCard, foldCard,
    confirmTitle, confirmButtons, clickConfirm, pressDown, graphsPanning,
  };
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
  // The stored preference object this harness writes has no schema version,
  // which is also how a pre-migration object looked: only the one key whose
  // meaning changed may be dropped, so this toggle has to arrive intact.
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
  assert.equal(labels.length, 5, 'filter, collect, fold, fit, refresh');
  assert.ok(labels[0].length <= 24, 'the filter tooltip is a line, not a paragraph: ' + labels[0]);
  assert.ok(view.tools()[0].querySelector('svg'), 'the filter uses an icon, not a punctuation mark');
  assert.ok(view.tools()[1].querySelector('svg'), 'and so does collect');
  assert.ok(view.tools()[2].querySelector('svg'), 'and the fold control');

  await view.clickTool(1);
  assert.ok(posts.some((p) => p.action === 'demoteOthers'), 'collect asks the host');
  assert.ok(!posts.some((p) => p.stopRunning === true), 'and does not stop anything before the user says so');
  assert.ok(view.confirmTitle() !== null, 'a running branch is a question, not a silent kill');
  assert.ok(/^Running branches: 1[.]/.test(view.confirmTitle()), 'the question counts the running branches: ' + view.confirmTitle());
  assert.deepEqual(view.confirmButtons(), ['Confirm', 'Cancel']);

  await view.clickConfirm('Confirm');
  assert.ok(posts.some((p) => p.action === 'demoteOthers' && p.stopRunning === true), 'confirmed, it stops and collects');
  assert.equal(view.confirmTitle(), null, 'and the question goes away');
});

test('the question can be dismissed, and its buttons are not drag handles', async (t) => {
  // Reported: Cancel did nothing. The canvas pans on pointerdown and captures
  // the pointer, which retargets the click that follows to the canvas — so a
  // press on the dialog has to be excluded from the pan handler, or neither
  // button ever receives a click.
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, async (url, options) => {
    if (options && options.method === 'POST') {
      return { ok: false, status: 409, json: async () => ({ error: 'busy', busy: ['session-fork', 'session-copy'] }) };
    }
    return { ok: true, json: async () => ({ versions: VERSIONS }) };
  });

  await view.clickTool(1);
  assert.ok(/^Running branches: 2[.]/.test(view.confirmTitle()), 'both running branches are named: ' + view.confirmTitle());

  await view.pressDown('.mtx-confirm-title');
  assert.equal(view.graphsPanning(), false, 'the dialog body is excluded from panning too');
  assert.ok(view.confirmTitle() !== null, 'and the press alone leaves the question standing');

  await view.pressDown('.mtx-confirm .mtx-btn:last-child');
  assert.equal(view.graphsPanning(), false, 'pressing Cancel must not start a pan under the dialog');

  await view.clickConfirm('Cancel');
  assert.equal(view.confirmTitle(), null, 'Cancel closes the question');
});

test('a host that cannot hide sessions turns those controls off and says so', async (t) => {
  const degraded = {
    versions: VERSIONS,
    archiveSupport: { ok: false, read: true, hide: false, show: false, missing: ['workspaceRegistry.archiveSession'] },
  };
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, async () => ({
    ok: true,
    json: async () => degraded,
  }));

  const collect = view.tools()[1];
  assert.equal(collect.disabled, true, 'collect is off rather than failing at click time');
  assert.ok((collect.getAttribute('title') || '').length > 0, 'and it says why on hover');

  const notice = view.dom.window.document.querySelector('.mtx-notice');
  assert.ok(notice, 'the panel states the degradation once, in place');
  assert.ok(notice.textContent.includes('workspaceRegistry.archiveSession'),
    'naming the missing piece: ' + notice.textContent);

  // Filtering has nothing to do with the archive seam and must stay usable.
  assert.equal(view.tools()[0].disabled, false, 'the filter still works');
});

test('reading a branch makes the shared history read as the same line', async (t) => {
  // Opening the fork: the turns it shares with its parent are that fork's
  // history, so they are highlighted exactly like the turns it adds. What stays
  // plain is the parent's own later turns — the other branch.
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, undefined, 'session-fork');
  const links = view.links();
  const byId = new Map(links.map((link) => [link.id, link]));

  assert.equal(byId.get('session-root#t1').current, true, 'the shared history is on the line');
  assert.equal(byId.get('session-root#t15').current, true, 'including the turn the fork left from');
  assert.equal(byId.get('session-root#root').current, true, 'and the conversation it started from');
  assert.equal(byId.get('session-fork#t17').current, true, 'the fork owns the turns it added');
  assert.equal(byId.get('session-root#t16').current, false,
    'the parent\'s own later turn belongs to the other branch and stays plain');
  assert.equal(links.filter((link) => link.head).length, 1, 'exactly one node marks where you are');
  assert.equal(links.find((link) => link.head).id, 'session-fork#t17');
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

test('a toggle is written with the current preference schema', async (t) => {
  const view = await mountView(t, { dropEmptyForks: true });
  assert.ok(!view.cardIds().includes('session-copy#fork'), 'the copy is hidden while the filter is on');

  await view.clickTool(0);
  assert.ok(view.cardIds().includes('session-copy#fork'), 'the switch draws it again');

  const stored = JSON.parse(view.dom.window.localStorage.getItem('dsh-tree-view:prefs'));
  assert.equal(stored.v, 2, 'the write carries the schema version, so a later read honours the choice');
  assert.equal(stored.dropEmptyForks, false, 'and the toggle that was flipped');
  assert.equal(stored.stopOnEdit, true, 'while the other toggles ride along in the same object');
});

test('a long shared history is drawn as one node', async (t) => {
  // With empty forks hidden, this family's branches share turns 1..14 and part
  // at turn 15 — a stretch that is the same reading in every branch. The shipped
  // default folds it into one card.
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 'default' });

  const card = view.foldCard();
  assert.ok(card, 'the trunk is folded into one card');
  assert.ok(card.textContent.includes('14 shared turns'),
    'the card says how much it hides: ' + card.textContent);
  assert.ok(!view.cardIds().includes('session-root#t5'), 'the turns it hides are off the canvas');
  assert.ok(view.cardIds().includes('session-root#root'), 'the conversation itself stays');
  assert.ok(view.cardIds().includes('session-root#t15'), 'and so does the turn where the branches part');

  const links = view.links();
  const foldId = card.getAttribute('data-id');
  assert.equal((links.find((l) => l.id === foldId) || {}).parent, 'session-root#root',
    'the fold hangs from the conversation');
  assert.equal((links.find((l) => l.id === 'session-root#t15') || {}).parent, foldId,
    'and the branch point hangs from the fold');
  for (const offset of view.offsets()) {
    assert.ok(!/NaN|undefined/.test(offset), 'every card is placed: ' + offset);
  }
});

test('the fold opens when clicked, and the toolbar can close it again', async (t) => {
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 'default' });
  const foldId = view.foldCard().getAttribute('data-id');

  await view.clickCard(foldId);
  assert.equal(view.foldCard(), null, 'unfolded: no fold card is left');
  assert.ok(view.cardIds().includes('session-root#t5'), 'and the shared turns are drawn again');
  assert.equal(view.tools()[2].getAttribute('data-on'), null, 'the toolbar reports it as open');

  await view.clickTool(2);
  assert.ok(view.foldCard(), 'the toolbar folds it again');
  assert.ok(!view.cardIds().includes('session-root#t5'), 'the shared turns are off the canvas again');
  assert.equal(view.tools()[2].getAttribute('data-on'), '', 'and the toolbar reports it as folded');
});

test('a run below the threshold is never folded, not even by hand', async (t) => {
  // Reported: a three-turn run folded. The threshold decides, for the automatic
  // fold and for the toolbar alike — the control is not a way around it.
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 20 });
  assert.equal(view.foldCard(), null, 'a shared stretch below the threshold is left alone');
  assert.ok(view.cardIds().includes('session-root#t5'), 'so its turns are on the canvas');
  assert.equal(view.tools()[2].disabled, true, 'and the control says there is nothing long enough');

  await view.clickTool(2);
  assert.equal(view.foldCard(), null, 'pressing it folds nothing either');
});

test('a long run on one branch folds too, not only the shared history', async (t) => {
  // 30 turns on the conversation with one small fork at turn 5: the shared
  // history is turns 1..4, and turns 6..29 are the unbranched run that only this
  // line continues on. Neither of them decides anything, so both fold.
  const longLine = [
    {
      sessionId: 'session-root',
      createdAt: 1,
      current: true,
      turns: Array.from({ length: 30 }, (_, i) => ({ turn: i + 1, text: 'root ' + (i + 1), time: i + 1 })),
    },
    {
      sessionId: 'session-short-fork',
      parentSessionId: 'session-root',
      createdAt: 2,
      forkTurn: 5,
      turns: [1, 2, 3, 4, 5, 6, 7].map((turn) => ({ turn, text: 'fork ' + turn, time: turn })),
    },
  ];
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 'default' }, longLine);
  const cards = () => [...view.dom.window.document.querySelectorAll('.mtx-card[data-fold]')];
  const titles = () => cards().map((c) => c.querySelector('.mtx-card-title').textContent);

  assert.equal(cards().length, 1, 'only the long run is folded: ' + titles().join(' / '));
  assert.ok(titles().includes('24 turns in a row'), 'the run this branch continues on: ' + titles().join(' / '));

  const ids = view.cardIds();
  assert.ok(ids.includes('session-root#t30'), 'the turn you are at stays drawn');
  assert.ok(!ids.includes('session-root#t20'), 'the middle of the long run is hidden');
  assert.ok(ids.includes('session-root#t5'), 'while the turn the branches part at stays');
  assert.ok(ids.includes('session-root#t1'), 'and a short run stays drawn — the threshold is per run');

  const links = view.links();
  const runFold = cards()[0].getAttribute('data-id');
  assert.equal((links.find((l) => l.id === runFold) || {}).parent, 'session-root#t5',
    'the run fold hangs off the turn before it');
  assert.equal((links.find((l) => l.id === 'session-root#t30') || {}).head, true,
    'the head of the line is never hidden inside a fold');

  await view.clickTool(2);
  assert.equal(cards().length, 0, 'the toolbar unfolds the stretches');
  await view.clickTool(2);
  assert.equal(cards().length, 1, 'and folds them again, still only the ones the threshold allows');
  assert.ok(view.cardIds().includes('session-root#t1'), 'the short shared run stays drawn throughout');
});

test('clicking a node of another version collects the one you were reading', async (t) => {
  // Reported: clicking a node never put the previous one away. The switch used to
  // hang off the chat view's session transition, which is not happening while the
  // Tree tab is in front — so the flow it exists for never fired.
  const posts = [];
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS,
    async (url, options) => {
      if (options && options.method === 'POST') {
        posts.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ versions: VERSIONS }) };
    }, 'session-fork');

  await view.clickCard('session-root#root');
  assert.deepEqual(posts, [{ action: 'demote', sessionId: 'session-fork' }],
    'the version the tree was showing goes back into the tree');
});

test('clicking a node inside the version on screen collects nothing', async (t) => {
  // The rule asked for: only a node that is NOT in the active conversation is a
  // switch. This one is a turn of the version already open.
  const posts = [];
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, async (url, options) => {
    if (options && options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ versions: VERSIONS }) };
  }, 'session-fork');

  await view.clickCard('session-fork#t17');
  assert.deepEqual(posts, [], 'no switch happened, so nothing is put away');
});

test('a version that is still generating a reply is left alone', async (t) => {
  const running = VERSIONS.map((v) => (v.sessionId === 'session-fork' ? Object.assign({}, v, { running: true }) : v));
  const posts = [];
  const view = await mountView(t, { dropEmptyForks: true }, running, async (url, options) => {
    if (options && options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ versions: running }) };
  }, 'session-fork');

  await view.clickCard('session-root#root');
  assert.deepEqual(posts, [],
    'archiving mid-turn would hide work that is still arriving, so it is skipped');
});

test('a family with nothing worth folding keeps the control out of the way', async (t) => {
  // Two turns and no branches: the only thing a fold could hide is one turn,
  // which trades a card for a card.
  const flat = [{
    sessionId: 'session-only',
    createdAt: 1,
    current: true,
    turns: [
      { turn: 1, text: 'one', time: 1 },
      { turn: 2, text: 'two', time: 2 },
    ],
  }];
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 'default' }, flat, undefined, 'session-only');
  assert.equal(view.foldCard(), null, 'nothing is folded');
  assert.equal(view.tools()[2].disabled, true, 'and the fold control says it has nothing to do');
});
