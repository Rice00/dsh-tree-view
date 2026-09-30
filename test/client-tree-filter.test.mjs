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

async function mountView(t, prefs, versions = VERSIONS, fetchImpl, viewSessionId = 'session-root', catalogue = {}, host = 'legacy', seed = null, options = {}) {
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
  // Storage the test wants already in place before the plugin loads: the cached
  // tree payload a previous visit would have left behind.
  if (seed) for (const [key, value] of Object.entries(seed)) dom.window.localStorage.setItem(key, value);
  dom.window.fetch = fetchImpl ?? (async () => ({ ok: true, json: async () => ({ versions }) }));
  // jsdom has no ResizeObserver. A test can ask for a double so that code which listens
  // for a change in size — the reading marker follows the card it points at — can be
  // driven from the test instead of hoped for.
  const resizeObservers = [];
  if (options.resizeObserver) {
    dom.window.ResizeObserver = class {
      constructor(callback) { this.callback = callback; this.target = null; resizeObservers.push(this); }
      observe(target) { this.target = target; }
      disconnect() { this.target = null; }
    };
  }
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
  // 0.1.7 opens a session through the workspace service instead; a test that
  // asks for that host shape records here.
  const workspaceOpened = [];
  // Sessions the main view is retaining, and the list subscribers that hear about
  // it — the signal `collectAfterSwitch` waits for.
  const retained = {};
  const listSubscribers = [];
  // Versions brought back out through the workspace service rather than the host
  // route, for the tests about how a collected version is reopened.
  const unarchived = [];
  // Attempts the flaky workspace double has seen, for the retry test, and per-id
  // refusals for the stale-navigation test.
  let workspaceAttempts = 0;
  const workspaceRefusals = {};
  const tabClicks = [];
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
  const ctx = {
    get(name) {
      if (name === 'slots') return slots;
      if (name === 'uiWorkspace' && (host === 'modern' || host === 'flaky' || host === 'slow' || host === 'modern-unarchive')) {
        return {
          openSession: (id) => {
            // A target the client catalogue has not caught up with yet: 0.1.7's
            // `resolveTarget` refuses it, and that refusal is what made a click do
            // nothing at all. `slow` refuses one id a few times and then accepts it —
            // the case where a stale retry can still land after a newer click.
            if (host === 'flaky' && workspaceAttempts++ < 2) throw new Error('unknown session ' + id);
            if (host === 'slow') {
              workspaceRefusals[id] = (workspaceRefusals[id] || 0) + 1;
              if (id === 'session-fork' && workspaceRefusals[id] < 4) throw new Error('unknown session ' + id);
            }
            workspaceOpened.push(id);
          },
          // 0.1.7's workspace can bring a collected version back out, and doing that
          // through the client rather than the host route is what lets the client
          // catalogue learn the session.
          ...(host === 'modern-unarchive' ? {
            unarchiveSession: async (id) => {
              unarchived.push(id);
              retained[id] = true;
            },
          } : {}),
        };
      }
      if (name === 'sessions') {
        return {
          // 0.1.7 dropped `open` from the session controller; `bare` is a host
          // that offers neither navigation route.
          ...(host === 'legacy' ? { open: (id) => { opened.push(id); } } : {}),
          list: {
            subscribe: (fn) => {
              listSubscribers.push(fn);
              return () => { const at = listSubscribers.indexOf(fn); if (at !== -1) listSubscribers.splice(at, 1); };
            },
            getSnapshot: () => ({
              // The host marks the sessions the main view is retaining; opening a
              // session is what puts it in this set, and the deferred collect waits
              // for exactly that.
              byId: Object.fromEntries(versions.map((v) => [v.sessionId,
                Object.assign({ id: v.sessionId }, retained[v.sessionId] ? { retainedBy: [{ kind: 'main' }] } : {})])),
              // DSH keeps a catalogue of subagents per parent session; the tree
              // reads it when the host payload cannot say (an old host half).
              subagentsByParent: catalogue ?? {},
            }),
          },
        };
      }
      return undefined;
    },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  };
  // Optional services ride on `ctx.inject`; the double hands back the same context.
  ctx.inject = (deps, callback) => callback(ctx);
  plugin.apply(ctx);
  assert.equal(typeof view, 'function');
  // The conversation area always has a Chat tab first; showChat() brings it
  // forward, and these tests watch that click land.
  const chatTab = dom.window.document.createElement('div');
  chatTab.setAttribute('role', 'tab');
  chatTab.setAttribute('aria-selected', 'false');
  chatTab.addEventListener('click', () => { tabClicks.push(true); });
  dom.window.document.body.appendChild(chatTab);
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
  // The world transform is how the canvas reports where it has been panned to.
  const worldTransform = () => (dom.window.document.querySelector('.mtx-world') || {}).style?.transform ?? null;
  // A press that moves: the same pointerdown as a click, then pointermoves past
  // the drag threshold, then release.
  const dragFromCard = (id, dx, dy) => act(async () => {
    const el = dom.window.document.querySelector('.mtx-card[data-id="' + id + '"]');
    assert.ok(el, 'card ' + id + ' is drawn');
    const at = (x, y) => ({ bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    el.dispatchEvent(new dom.window.MouseEvent('pointerdown', at(200, 200)));
    for (let i = 1; i <= 4; i++) {
      el.dispatchEvent(new dom.window.MouseEvent('pointermove', at(200 + (dx * i) / 4, 200 + (dy * i) / 4)));
    }
    el.dispatchEvent(new dom.window.MouseEvent('pointerup', at(200 + dx, 200 + dy)));
  });
  // Opening a session makes the main view retain it; the list snapshot says so
  // (`retainedBy`), and that is the signal the deferred collect waits for. It has
  // to come from the host rather than from this component's props: the view is
  // remounted on a switch, so anything kept in a ref dies with it.
  const retain = async (id) => {
    // Exclusive: the main view retains one session at a time, and `mainSession()`
    // reads the first retained entry, so keeping stale ids would misreport it.
    for (const key of Object.keys(retained)) delete retained[key];
    retained[id] = true;
    await act(async () => { for (const fn of [...listSubscribers]) fn(); });
    await act(async () => { await Promise.resolve(); });
  };
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
    worldTransform, dragFromCard, retain, unarchived, resizeObservers,
    opened, workspaceOpened, tabClicks,
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

test('a subagent conversation is marked as one', async (t) => {
  // It shares the family (same cwd, parent session) but is not a version of the
  // reader's message, so its cards have to say what they are.
  const withDelegate = VERSIONS.concat([{
    sessionId: 'session-delegate',
    parentSessionId: 'session-root',
    createdAt: 5,
    subagent: true,
    turns: [{ turn: 1, text: 'delegate one', time: 5 }],
  }]);
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 0 }, withDelegate, undefined, 'session-root');

  const card = view.dom.window.document.querySelector('.mtx-card[data-id="session-delegate#t1"]');
  assert.ok(card, 'the subagent conversation is drawn');
  assert.equal(card.hasAttribute('data-subagent'), true, 'and carries the flag in the open');
  assert.ok(card.textContent.includes('subagent'), 'the card says so: ' + card.textContent);
  assert.equal(view.dom.window.document.querySelectorAll('.mtx-card[data-subagent]').length, 1,
    'only the subagent conversation is marked');
});

test('and marks one the host half has not learned about yet', async (t) => {
  // The host half is loaded by the DSH server, so its new payload field only
  // arrives after a restart. The app's own subagent catalogue is already in the
  // client, so a refresh is enough — this is what the reader reported missing.
  const catalogue = { 'session-root': { entries: [{ kind: 'child', id: 'session-delegate' }] } };
  const withDelegate = VERSIONS.concat([{
    sessionId: 'session-delegate',
    parentSessionId: 'session-root',
    createdAt: 5,
    turns: [{ turn: 1, text: 'delegate one', time: 5 }],
  }]);
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 0 }, withDelegate, undefined, 'session-root', catalogue);

  const card = view.dom.window.document.querySelector('.mtx-card[data-id="session-delegate#t1"]');
  assert.ok(card, 'the subagent conversation is drawn');
  assert.equal(card.hasAttribute('data-subagent'), true, 'the client catalogue is enough to mark it');
  assert.ok(card.textContent.includes('subagent'), 'tag and subtitle: ' + card.textContent);
});

// 30 turns on the conversation with one small fork at turn 5: the shared history
// is turns 1..4, and turns 6..29 are an unbranched run. Long enough that folding
// it changes how much there is to see.
const LONG_LINE = [
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

test('folding and unfolding reframes the canvas', async (t) => {
  // One click can hide or reveal dozens of turns; without a re-fit the tree walks
  // off the canvas and the reader has to hunt for it with ⌖.
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 'default' }, LONG_LINE);
  const scale = () => {
    const world = view.dom.window.document.querySelector('.mtx-world');
    const m = world && /scale\(([\d.]+)\)/.exec(world.style.transform);
    return m ? Number(m[1]) : null;
  };

  const foldedScale = scale();
  assert.ok(foldedScale > 0, 'the folded tree is framed: ' + foldedScale);

  await view.clickCard(view.foldCard().getAttribute('data-id'));
  const unfoldedScale = scale();
  assert.ok(unfoldedScale > 0, 'and so is the unfolded one: ' + unfoldedScale);
  assert.ok(unfoldedScale < foldedScale,
    'unfolding frames the bigger tree instead of keeping the folded zoom: ' + foldedScale + ' -> ' + unfoldedScale);

  await view.clickTool(2);
  assert.ok(scale() > unfoldedScale, 'folding again zooms back in: ' + scale());
});

test('a coincidental repeat does not drag a fork down the parent line', async (t) => {
  // Reported: the branch named "readme" was attached after the current session
  // instead of at its fork point. Real cause: the shared-turn check kept the LAST
  // prompt that matched, and the same "1" had been sent on both sides at turn 42 —
  // so the branch was hung from turn 42, not from the turn 38 it left.
  const versions = [
    {
      sessionId: 'session-root',
      createdAt: 1,
      current: true,
      turns: [1, 2, 3, 4, 5, 6].map((n) => ({ turn: n, text: n <= 4 ? 'shared ' + n : 'root ' + n, time: n })),
    },
    {
      sessionId: 'session-fork',
      parentSessionId: 'session-root',
      createdAt: 2,
      forkTurn: 4,
      turns: [
        ...[1, 2, 3, 4].map((n) => ({ turn: n, text: 'shared ' + n, time: n })),
        { turn: 5, text: 'fork five', time: 5 },
        { turn: 6, text: 'root 6', time: 6 },
      ],
    },
  ];
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 0 }, versions);
  const byId = new Map(view.links().map((l) => [l.id, l]));

  assert.equal((byId.get('session-fork#t5') || {}).parent, 'session-root#t4',
    'the fork hangs off the turn it left from: ' + JSON.stringify(view.links().map((l) => l.id + '<' + l.parent)));
  assert.equal((byId.get('session-fork#t6') || {}).parent, 'session-fork#t5',
    'and its own later turn keeps following it, even though its text repeats the parent\'s');
});

test('a long run on one branch folds too, not only the shared history', async (t) => {
  // 30 turns on the conversation with one small fork at turn 5: the shared
  // history is turns 1..4, and turns 6..29 are the unbranched run that only this
  // line continues on. Neither of them decides anything, so both fold.
  const longLine = LONG_LINE;
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

// The swap rule, in the form it was asked for: bringing a version that is
// collected in the tree back out puts the one you were reading away; a version
// that is already in the main chat just opens; a node of the version on screen
// only returns to the Chat tab.
function withArchived(sessionIds) {
  return VERSIONS.map((v) => (sessionIds.includes(v.sessionId) ? Object.assign({}, v, { archived: true }) : v));
}
function recording(posts, versions) {
  return async (url, options) => {
    if (options && options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ versions }) };
  };
}

test('bringing a collected version back out puts the current one away once it is retained', async (t) => {
  const posts = [];
  const versions = withArchived(['session-root']);
  const view = await mountView(t, { dropEmptyForks: true }, versions, recording(posts, versions), 'session-fork');

  await view.clickCard('session-root#root');
  assert.ok(posts.some((p) => p.action === 'activate' && p.sessionId === 'session-root'),
    'the version you clicked is brought out of the tree: ' + JSON.stringify(posts));
  assert.ok(view.opened.includes('session-root'), 'and it is opened');
  // The collect must not be issued while the reveal is still in flight: archiving
  // the session on screen made the workspace re-reveal its own fallback, so the
  // reader stayed on the session they had just left and a second click looked
  // like it had jumped there.
  assert.ok(!posts.some((p) => p.action === 'demote'),
    'nothing is archived before the app retains the target: ' + JSON.stringify(posts));

  await view.retain('session-root');
  assert.ok(posts.some((p) => p.action === 'demote' && p.sessionId === 'session-fork'),
    'once the main view retains the version you asked for, the one you left goes into the tree');
  const activateAt = posts.findIndex((p) => p.action === 'activate' && p.sessionId === 'session-root');
  const demoteAt = posts.findIndex((p) => p.action === 'demote');
  assert.ok(activateAt !== -1 && demoteAt > activateAt, 'and it is issued after the target is brought out');
});

test('a host that never reports retention still puts the left version away', async (t) => {
  // The collect has to happen on every host, including one whose list snapshot
  // carries no retention field: waiting for a signal that never comes is how the
  // collect went missing altogether.
  const posts = [];
  const versions = withArchived(['session-root']);
  const view = await mountView(t, { dropEmptyForks: true }, versions, recording(posts, versions), 'session-fork');

  await view.clickCard('session-root#root');
  assert.ok(!posts.some((p) => p.action === 'demote'), 'not in the click tick');

  // Wait past the bounded fallback (the harness reports no retention).
  for (let i = 0; i < 30 && !posts.some((p) => p.action === 'demote'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(posts.some((p) => p.action === 'demote' && p.sessionId === 'session-fork'),
    'the version you left is collected anyway: ' + JSON.stringify(posts));
});

test('a version already in the main chat just opens — nothing is put away', async (t) => {
  // Reported: a node that had been moved to the main chat still collected the
  // current conversation. It must not: that node is there on purpose.
  const posts = [];
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, recording(posts, VERSIONS), 'session-fork');

  await view.clickCard('session-root#root');
  assert.deepEqual(posts, [], 'no archiving, no unarchiving');
  assert.ok(view.opened.includes('session-root'), 'it just opens');
});

test('a node of the version on screen only goes back to the Chat tab', async (t) => {
  const posts = [];
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, recording(posts, VERSIONS), 'session-fork');

  await view.clickCard('session-fork#t17');
  assert.deepEqual(posts, [], 'nothing is archived and nothing is brought out');
  assert.deepEqual(view.opened, [], 'and the app is not asked to navigate anywhere');
  assert.equal(view.tabClicks.length, 1, 'the Chat tab is brought forward instead');
});

test('a version that is still generating a reply is left alone', async (t) => {
  const versions = withArchived(['session-root'])
    .map((v) => (v.sessionId === 'session-fork' ? Object.assign({}, v, { running: true }) : v));
  const posts = [];
  const view = await mountView(t, { dropEmptyForks: true }, versions, recording(posts, versions), 'session-fork');

  await view.clickCard('session-root#root');
  assert.ok(!posts.some((p) => p.action === 'demote'),
    'archiving mid-turn would hide work that is still arriving, so it is skipped');
  assert.ok(posts.some((p) => p.action === 'activate' && p.sessionId === 'session-root'),
    'the version you clicked is still brought out');
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

test('a 0.1.7 host opens a version through uiWorkspace, not the removed sessions.open', async (t) => {
  // 0.1.7 moved "show this session in the main view" off the session controller
  // and onto the workspace service. The client used to require `sessions.open`
  // and throw without it, and DSH Desktop deselects a plugin whose client half
  // fails to boot — that is how the whole plugin went missing on 0.1.7.
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, undefined, 'session-root', {}, 'modern');
  await view.clickCard('session-fork#t16');
  assert.ok(view.workspaceOpened.length >= 1 && view.workspaceOpened.every((s) => s === 'session-fork'),
    'the workspace service opens the version (open plus its idempotent reinforce): ' + JSON.stringify(view.workspaceOpened));
  assert.deepEqual(view.opened, [], 'the removed sessions.open is never called');
});

test('a host with no navigation service still boots, read-only, instead of failing', async (t) => {
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, undefined, 'session-root', {}, 'bare');
  assert.ok(view.cardIds().length > 0, 'the tree is still drawn');
  await view.clickCard('session-fork#t16');
  assert.deepEqual(view.opened, []);
  assert.deepEqual(view.workspaceOpened, []);
});

test('a press that lands on a node can still pan the canvas', async (t) => {
  // Reported: once the pointer went down on a card, the canvas could not be
  // dragged at all. A card press is both "open this version" and "grab the canvas
  // here", so the movement decides: under the threshold the release opens the
  // node, past it the press pans and the release opens nothing.
  const view = await mountView(t, { dropEmptyForks: true });
  const before = view.worldTransform();

  await view.dragFromCard('session-root#root', 40, 24);

  assert.notEqual(view.worldTransform(), before, 'the canvas followed the pointer');
  assert.deepEqual(view.opened, [], 'and a drag does not open the node it started on');
  assert.deepEqual(view.tabClicks, [], 'nor does it jump back to the Chat tab');
});

test('the same press without movement still opens the node', async (t) => {
  const view = await mountView(t, { dropEmptyForks: true });
  const before = view.worldTransform();

  await view.clickCard('session-fork#t16');

  assert.equal(view.worldTransform(), before, 'nothing was panned');
  assert.ok(view.opened.includes('session-fork'), 'the node was opened');
});

test('a click retries while the client catalogue catches up, instead of doing nothing', async (t) => {
  // 0.1.7's `uiWorkspace.openSession` throws for a session the client manager does
  // not know yet — exactly the state a version comes out of the tree in, since it
  // was archived until a moment ago. The throw used to escape silently: the click
  // did nothing and the reader stayed on the session they were leaving, which read
  // as "it jumped back to the new session".
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, undefined, 'session-root', {}, 'flaky');

  await view.clickCard('session-fork#t16');
  assert.deepEqual(view.workspaceOpened, [], 'the first two attempts are refused by the manager');

  for (let i = 0; i < 20 && view.workspaceOpened.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(view.workspaceOpened.length >= 1 && view.workspaceOpened.every((s) => s === 'session-fork'),
    'and the retry lands on the version that was clicked: ' + JSON.stringify(view.workspaceOpened));
});

test('a collected version is brought back out through the client, not behind its back', async (t) => {
  // The host route unarchives in the registry without telling the client, and the
  // client catalogue then keeps refusing the session — that is how the way back to
  // a collected version silently landed on the session you were leaving. 0.1.7's
  // workspace owns this operation and refreshes the catalogue with it.
  const posts = [];
  const versions = withArchived(['session-root']);
  const view = await mountView(t, { dropEmptyForks: true }, versions, recording(posts, versions), 'session-fork', {}, 'modern-unarchive');

  await view.clickCard('session-root#root');

  assert.deepEqual(view.unarchived, ['session-root'], 'the client brings the version back out');
  assert.ok(!posts.some((p) => p.action === 'activate'),
    'and the host route is not used for it: ' + JSON.stringify(posts));
  assert.ok(view.workspaceOpened.includes('session-root'), 'then the version is opened');
});

test('a fast second click cancels the first navigation instead of being overridden by it', async (t) => {
  // Reported as "fast clicking still lands on the new conversation": the first
  // click's retries were still pending when the second click happened, so the stale
  // attempt re-opened the version the reader had already left. Only the newest
  // navigation may retry.
  const view = await mountView(t, { dropEmptyForks: false }, VERSIONS, undefined, 'session-root', {}, 'slow');

  await view.clickCard('session-fork#t16');   // refused a few times, then the manager accepts it
  await view.clickCard('session-copy#fork');  // and the reader moves on to this one
  await new Promise((resolve) => setTimeout(resolve, 900));

  assert.ok(view.workspaceOpened.length >= 1 && view.workspaceOpened.every((s) => s === 'session-copy'),
    'only the newest navigation lands (no stale fork): ' + JSON.stringify(view.workspaceOpened));
});

test('the Chat tab opens only once the app is on the version you clicked', async (t) => {
  // Reported: "it flashes the new conversation, then jumps to the target". The Chat
  // tab used to be flipped in the click's own tick, so the conversation area showed
  // the session being left until the switch landed.
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, undefined, 'session-root');
  await view.retain('session-root');
  assert.deepEqual(view.tabClicks, [], 'nothing switched yet');

  await view.clickCard('session-fork#t16');
  assert.deepEqual(view.tabClicks, [], 'and nothing while the switch is in flight');

  await view.retain('session-fork');   // the app lands on the target
  for (let i = 0; i < 30 && view.tabClicks.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(view.tabClicks.length >= 1, 'the Chat tab opens once the target is on screen');
});

test('a click is logged to the host through the log action', async (t) => {
  const posts = [];
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, recording(posts, VERSIONS), 'session-root');
  await view.clickCard('session-fork#t16');
  // The log queue flushes on a timer, so wait for it.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const logPosts = posts.filter((p) => p.action === 'log');
  assert.ok(logPosts.length >= 1, 'a log post reaches the host: ' + JSON.stringify(posts.map((p) => p.action)));
  const messages = logPosts.flatMap((p) => p.entries.map((e) => e.message)).join(' ');
  assert.ok(/click/.test(messages), 'the click decision is logged: ' + messages);
});

test('a cold open paints the last tree at once, then the host answer replaces it', async (t) => {
  // The host rebuilds this payload by reading every version's log — 3.7 to 5.2
  // seconds on this conversation's family — and a client that has never loaded the
  // family showed an empty canvas for that whole time. What it saw last time is
  // painted immediately instead, and the fresh answer takes over when it lands.
  const remembered = JSON.stringify({ at: Date.now() - 60000, versions: VERSIONS.slice(0, 1), archiveSupport: null });
  let calls = 0;
  const slowHost = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { ok: true, json: async () => ({ versions: VERSIONS }) };
  };
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, slowHost, 'session-root', {}, 'legacy', {
    'dsh-tree-view:tree:session-root': remembered,
  });

  // A tick for the render the hydration triggers, still far inside the host's
  // 80ms: what matters is that the canvas is not empty while the host works.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const atOnce = view.cardIds().length;
  assert.ok(atOnce > 0, 'the remembered tree is on the canvas before the host answers');
  assert.equal(calls, 1, 'and the host is still asked for the fresh one');

  for (let i = 0; i < 20 && view.cardIds().length <= atOnce; i++) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(view.cardIds().length > atOnce,
    'the host answer replaces what was remembered: ' + atOnce + ' -> ' + view.cardIds().length);
});

test('a branch name follows the view sideways, not only downwards', async (t) => {
  // Reported: the name followed vertically but not horizontally. The clamp kept it
  // inside the visible band on the Y axis only, so panning along a branch (or
  // zooming in) left the name behind at the group's own left edge.
  const labeled = VERSIONS.map((v) => (v.sessionId === 'session-root' ? Object.assign({}, v, { label: '主线' }) : v));
  const view = await mountView(t, { dropEmptyForks: false }, labeled);
  const doc = view.dom.window.document;
  const graph = doc.querySelector('.mtx-graph');
  // jsdom lays nothing out, so the canvas is given the size a real one has: without
  // it the clamp has no viewport to clamp into and correctly does nothing.
  Object.defineProperty(graph, 'clientWidth', { value: 900, configurable: true });
  Object.defineProperty(graph, 'clientHeight', { value: 700, configurable: true });

  const group = doc.querySelector('.mtx-group');
  const name = doc.querySelector('.mtx-group-name');
  assert.ok(group && name, 'the named branch is drawn as a group');
  const nums = (value) => (String(value || '').match(/-?[\d.]+/g) || []).map(Number);
  const groupWidth = parseFloat(group.style.width);
  assert.ok(groupWidth > 260, 'this branch is wider than a single card, so its own left edge can leave the view: ' + groupWidth);

  // Pan just far enough that the group's left edge is 60 world units left of the
  // view's left edge — the group still covers the view, which is the case the clamp
  // exists for. (Panning further would take the whole branch off screen, and there
  // the name must stay with its branch instead.)
  const world0 = nums(doc.querySelector('.mtx-world').style.transform);
  const box0 = nums(group.style.transform);
  const scale = world0[2];
  const targetVisibleLeft = box0[0] + 60;
  const dx = -targetVisibleLeft * scale - world0[0];
  await view.dragFromCard('session-root#root', dx, 0);

  const world = nums(doc.querySelector('.mtx-world').style.transform);
  const box = nums(group.style.transform);
  const label = nums(name.style.transform);
  assert.ok(label.length === 3, 'the name is positioned and counter-scaled by the clamp: ' + JSON.stringify(label));
  assert.ok(Math.abs(label[2] * world[2] - 1) < 1e-6,
    'the counter-scale cancels the world zoom, so the name keeps its size on screen: ' + label[2] + ' * ' + world[2]);

  const visibleLeft = -world[0] / world[2];
  assert.ok(Math.abs(visibleLeft - targetVisibleLeft) < 2, 'the pan landed where it was aimed: ' + visibleLeft);
  assert.ok(box[0] < visibleLeft, 'the group starts left of the view after the pan: ' + box[0] + ' vs ' + visibleLeft);
  assert.ok(label[0] > box[0],
    'so the name moved sideways with the view instead of staying at the frame edge: ' + label[0] + ' vs ' + box[0]);
  assert.ok(label[0] >= visibleLeft - 1,
    'and it is still inside the view: ' + label[0] + ' vs ' + visibleLeft);
  assert.ok(label[0] + 48 / world[2] <= box[0] + groupWidth + 1,
    'without leaving its own frame: ' + (label[0] + 48 / world[2]) + ' vs ' + (box[0] + groupWidth));
});

test('a branch name lines up with its own frame when the whole frame is in view', async (t) => {
  // Reported: the name sat a little inside the frame it names. It now rests on the frame's
  // own left edge and only leaves it when that edge scrolls out of view.
  const labeled = VERSIONS.map((v) => (v.sessionId === 'session-root' ? Object.assign({}, v, { label: '主线' }) : v));
  const view = await mountView(t, { dropEmptyForks: false }, labeled);
  const doc = view.dom.window.document;
  const graph = doc.querySelector('.mtx-graph');
  Object.defineProperty(graph, 'clientWidth', { value: 900, configurable: true });
  Object.defineProperty(graph, 'clientHeight', { value: 700, configurable: true });

  const nums = (value) => (String(value || '').match(/-?[\d.]+/g) || []).map(Number);
  const box = nums(doc.querySelector('.mtx-group').style.transform);
  const label = nums(doc.querySelector('.mtx-group-name').style.transform);
  assert.ok(Math.abs(label[0] - box[0]) < 0.01,
    'the name left edge is the frame left edge: ' + label[0] + ' vs ' + box[0]);
  assert.ok(label[1] >= box[1], 'and it starts at or below the frame top: ' + label[1] + ' vs ' + box[1]);
});

test('a branch name follows the view down a tall branch', async (t) => {
  // The sticky follower is a feature, not an accident: a branch is thousands of world
  // units tall, and a name pinned to the frame's top edge scrolls away exactly when the
  // reader is looking at the middle of the branch.
  const labeled = VERSIONS.map((v) => (v.sessionId === 'session-root' ? Object.assign({}, v, { label: '主线' }) : v));
  const view = await mountView(t, { dropEmptyForks: false }, labeled);
  const doc = view.dom.window.document;
  const graph = doc.querySelector('.mtx-graph');
  Object.defineProperty(graph, 'clientWidth', { value: 900, configurable: true });
  Object.defineProperty(graph, 'clientHeight', { value: 700, configurable: true });

  const nums = (value) => (String(value || '').match(/-?[\d.]+/g) || []).map(Number);
  const frame = doc.querySelector('.mtx-group');
  const name = doc.querySelector('.mtx-group-name');
  const frameHeight = parseFloat(frame.style.height);
  assert.ok(frameHeight > 700, 'this branch is taller than the view: ' + frameHeight);

  // Pan up until the frame's top edge is a thousand world units above the view.
  const world0 = nums(doc.querySelector('.mtx-world').style.transform);
  const box0 = nums(frame.style.transform);
  const scale = world0[2];
  const visibleTop0 = -world0[1] / scale;
  const dy = (box0[1] - 1000 - visibleTop0) * scale;
  await view.dragFromCard('session-root#root', 0, dy);

  const world = nums(doc.querySelector('.mtx-world').style.transform);
  const label = nums(name.style.transform);
  const visibleTop = -world[1] / world[2];
  const visibleBottom = visibleTop + 700 / world[2];
  assert.ok(box0[1] < visibleTop, 'the frame top is above the view now: ' + box0[1] + ' vs ' + visibleTop);
  assert.ok(label[1] >= visibleTop, 'but the name is still inside the view: ' + label[1] + ' vs ' + visibleTop);
  assert.ok(label[1] <= visibleBottom, 'and above its bottom edge: ' + label[1] + ' vs ' + visibleBottom);
});

// The conversation is virtualised — three rows of a seventy-turn session were the
// whole DOM when this was written — so a turn far from the reader is not there to
// scroll to. The host's own turn rail is what loads it, and clicking its mark is
// also exactly what the reader does by hand.
function fakeRail(doc, turns, activeTurn) {
  const rail = doc.createElement('div');
  const scroller = doc.createElement('div');
  const list = doc.createElement('div');
  Object.defineProperty(scroller, 'scrollHeight', { value: 700, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true });
  scroller.appendChild(list);
  rail.appendChild(scroller);
  doc.body.appendChild(rail);
  const clicked = [];
  for (const turn of turns) {
    const mark = doc.createElement('button');
    mark.setAttribute('data-index', String(turn - 1));
    mark.setAttribute('aria-label', '跳转到第 ' + turn + ' 轮');
    if (turn === activeTurn) mark.setAttribute('aria-current', 'true');
    mark.addEventListener('click', () => clicked.push(turn));
    list.appendChild(mark);
  }
  return { click: clicked, scroller, list };
}

test('a node click jumps through the host own turn rail', async (t) => {
  const posts = [];
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, recording(posts, VERSIONS), 'session-root');
  const doc = view.dom.window.document;

  // The row the landing is watched for, standing in for the one the host mounts —
  // and mounted only *after* the mark is clicked, which is the order the real host
  // works in: the row for a turn that was never loaded does not exist until the rail
  // asks for it.
  const row = doc.createElement('div');
  row.className = 'mtx-row';
  row.setAttribute('data-session', 'session-fork');
  row.setAttribute('data-turn', '16');
  row.scrollIntoView = () => {};
  const bubble = doc.createElement('div');
  bubble.className = 'mtx-bubble';
  row.appendChild(bubble);

  const rail = fakeRail(doc, [14, 15, 16, 17], null);
  const mark = [...rail.list.querySelectorAll('button[data-index]')].find((el) => el.getAttribute('aria-label') === '跳转到第 16 轮');
  mark.addEventListener('click', () => doc.body.appendChild(row));

  await view.clickCard('session-fork#t16');
  for (let i = 0; i < 40 && !row.classList.contains('mtx-flash'); i++) await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(rail.click, [16], 'the rail mark for that turn is what gets clicked');
  assert.ok(row.classList.contains('mtx-flash'), 'and the row that landed flashes');

  await new Promise((r) => setTimeout(r, 400));
  const logged = posts.filter((p) => p.action === 'log').flatMap((p) => p.entries.map((e) => e.message)).join(' ');
  assert.match(logged, /jump: session-fork turn 16 via rail/, 'the route taken is logged: ' + logged);
});

test('a turn outside the rail window scrolls the rail instead of giving up silently', async (t) => {
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, undefined, 'session-root');
  const doc = view.dom.window.document;
  const rail = fakeRail(doc, [1, 2, 3, 4, 5], null);

  await view.clickCard('session-fork#t16');
  await new Promise((r) => setTimeout(r, 200));

  assert.deepEqual(rail.click, [], 'no mark was clicked — the rail is showing another window');
  assert.ok(rail.scroller.scrollTop > 0, 'the rail was scrolled toward that turn: ' + rail.scroller.scrollTop);
});

test('the tree points at the turn the conversation is sitting on', async (t) => {
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, undefined, 'session-root');
  const doc = view.dom.window.document;
  // jsdom lays nothing out: the clamp and the marker both need a canvas size, and
  // without one they (correctly) do nothing at all.
  const graphEl = doc.querySelector('.mtx-graph');
  Object.defineProperty(graphEl, 'clientWidth', { value: 900, configurable: true });
  Object.defineProperty(graphEl, 'clientHeight', { value: 700, configurable: true });

  assert.equal(doc.querySelector('.mtx-here'), null, 'nothing is marked until the host says where the reader is');

  fakeRail(doc, [4, 5, 6], null);
  const mark = [...doc.querySelectorAll('button[data-label], button[data-index]')].find((el) => el.getAttribute('aria-label') === '跳转到第 5 轮');
  await act(async () => {
    mark.setAttribute('aria-current', 'true');
    await new Promise((r) => setTimeout(r, 0));
  });

  const marker = doc.querySelector('.mtx-here');
  assert.ok(marker, 'the marker is drawn');
  assert.equal(marker.getAttribute('data-node'), 'session-root#t5', 'pointing at the node for the turn the host reports');
  assert.equal(marker.getAttribute('title'), 'You are reading this turn', 'and says what it is');

  // The anchor is the card's right edge at its vertical middle — the tip of the
  // triangle, which is what points at the node. Nothing is drawn on the card itself:
  // `contain: paint` would clip anything outside its box.
  const card = doc.querySelector('.mtx-card[data-id="session-root#t5"]');
  const nums = (value) => (String(value || '').match(/-?[\d.]+/g) || []).map(Number);
  const cardBox = nums(card.style.transform);
  const markerPos = nums(marker.style.transform);
  const world = nums(doc.querySelector('.mtx-world').style.transform);
  assert.ok(Math.abs(markerPos[0] - (cardBox[0] + 176)) < 0.01,
    'the anchor sits on the card right edge: ' + markerPos[0] + ' vs ' + (cardBox[0] + 176));
  assert.ok(Math.abs(markerPos[1] - (cardBox[1] + 58 / 2)) < 0.01,
    'and on its vertical middle: ' + markerPos[1] + ' vs ' + (cardBox[1] + 29));
  assert.ok(Math.abs(markerPos[2] * world[2] - 1) < 1e-6,
    'the marker counter-scales, so the triangle keeps its size at any zoom: ' + markerPos[2] + ' * ' + world[2]);
  assert.ok(doc.querySelector('.mtx-here-tip'), 'and the triangle is a counter-scaled child');
  assert.equal(doc.querySelector('.mtx-card[data-here]'), null, 'and nothing is drawn on the card itself');

  // A zoom is not a spring frame: the counter-scale has to be refreshed by the frame
  // that positions the names, or the triangle grows with the zoom. Measured live: the
  // world at 0.59 while the marker still carried the counter-scale for 0.3.
  const beforeScale = nums(doc.querySelector('.mtx-world').style.transform)[2];
  await act(async () => {
    doc.querySelector('.mtx-graph').dispatchEvent(new doc.defaultView.WheelEvent('wheel', { deltaY: -260, cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  const afterScale = nums(doc.querySelector('.mtx-world').style.transform)[2];
  assert.ok(afterScale > beforeScale, 'the wheel zoomed in: ' + beforeScale + ' -> ' + afterScale);
  const afterMarker = nums(doc.querySelector('.mtx-here').style.transform);
  assert.ok(Math.abs(afterMarker[2] * afterScale - 1) < 1e-6,
    'and the marker counter-scaled with it, so the triangle keeps its size: ' + afterMarker[2] + ' * ' + afterScale);
});

test('a jump marks the turn that was asked for, not the one the rail lags to', async (t) => {
  // The host's rail reports the turn at its reading line, and a landing leaves the
  // target just below that line — so after a jump its report is one turn short. The
  // marker follows the request until the reader scrolls themselves.
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, undefined, 'session-root');
  const doc = view.dom.window.document;
  const rail = fakeRail(doc, [9, 10, 11], null);

  // The turn wants to be clickable: turn 11 of the root version.
  const card = doc.querySelector('.mtx-card[data-id="session-root#t11"]');
  assert.ok(card, 'the target node is drawn');
  const r = card.getBoundingClientRect();
  const at = (x, y) => ({ bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  await act(async () => {
    card.dispatchEvent(new doc.defaultView.MouseEvent('pointerdown', at(r.left + 20, r.top + 12)));
    card.dispatchEvent(new doc.defaultView.MouseEvent('pointerup', at(r.left + 20, r.top + 12)));
  });

  assert.equal(doc.querySelector('.mtx-here').getAttribute('data-node'), 'session-root#t11',
    'the marker is on the turn that was clicked');

  // The rail answers with the previous turn, as the real host does mid-landing.
  const lagging = [...rail.list.querySelectorAll('button[data-index]')].find((el) => el.getAttribute('aria-label') === '跳转到第 10 轮');
  await act(async () => {
    lagging.setAttribute('aria-current', 'true');
    await new Promise((r2) => setTimeout(r2, 0));
  });
  assert.equal(doc.querySelector('.mtx-here').getAttribute('data-node'), 'session-root#t11',
    'and the lagging rail report does not move it');

  // A real gesture hands the position back to the host.
  await act(async () => {
    doc.dispatchEvent(new doc.defaultView.Event('wheel', { bubbles: true }));
    await new Promise((r2) => setTimeout(r2, 0));
  });
  assert.equal(doc.querySelector('.mtx-here').getAttribute('data-node'), 'session-root#t10',
    'and scrolling hands it back to the rail');
});

test('a name that is following the view keeps a screen inset, at any zoom', async (t) => {
  // The jitter report: the name followed the view, but its insets were world units, so
  // the distance it kept from the view's edge grew and shrank as the reader zoomed. Every
  // distance in the clamp is a screen distance now, so the inset is the same at any zoom —
  // and the counter-scale keeps the name itself the same size.
  const labeled = VERSIONS.map((v) => (v.sessionId === 'session-root' ? Object.assign({}, v, { label: '主线' }) : v));
  const view = await mountView(t, { dropEmptyForks: false }, labeled);
  const doc = view.dom.window.document;
  const graph = doc.querySelector('.mtx-graph');
  Object.defineProperty(graph, 'clientWidth', { value: 900, configurable: true });
  Object.defineProperty(graph, 'clientHeight', { value: 700, configurable: true });
  const nums = (value) => (String(value || '').match(/-?[\d.]+/g) || []).map(Number);

  // Pan up so the frame's top edge is well above the view: the name is following the view
  // there, which is the case the insets belong to.
  const frame = doc.querySelector('.mtx-group');
  const box0 = nums(frame.style.transform);
  const world0 = nums(doc.querySelector('.mtx-world').style.transform);
  const visibleTop0 = -world0[1] / world0[2];
  const dy = (visibleTop0 - (box0[1] + 400)) * world0[2];
  await view.dragFromCard('session-root#root', 0, dy);

  const insetOnScreen = () => {
    const world = nums(doc.querySelector('.mtx-world').style.transform);
    const name = nums(doc.querySelector('.mtx-group-name').style.transform);
    const visibleTop = -world[1] / world[2];
    return { inset: (name[1] - visibleTop) * world[2], counter: name[2], scale: world[2] };
  };

  const before = insetOnScreen();
  await act(async () => {
    graph.dispatchEvent(new doc.defaultView.WheelEvent('wheel', { deltaY: -300, cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  const after = insetOnScreen();

  assert.notEqual(before.scale, after.scale, 'the wheel zoomed: ' + before.scale + ' -> ' + after.scale);
  assert.ok(Math.abs(before.inset - 8) < 1.5, 'the name keeps an 8px inset from the view edge: ' + before.inset);
  assert.ok(Math.abs(after.inset - 8) < 1.5, 'and the same one after zooming: ' + after.inset);
  assert.ok(Math.abs(after.counter * after.scale - 1) < 1e-6, 'with the counter-scale cancelling the zoom');
});

test('the reading marker is there on the first open after a refresh', async (t) => {
  // Reported: after refreshing the page the marker was missing until the reader had
  // visited the Chat once — the rail only exists there, and the position lived only in
  // memory. The last position is kept in storage now.
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, undefined, 'session-root', {}, 'legacy', {
    'dsh-tree-view:reading': JSON.stringify({ sessionId: 'session-root', turn: 5 }),
  });
  const doc = view.dom.window.document;
  const marker = doc.querySelector('.mtx-here');
  assert.ok(marker, 'the marker is drawn before any rail has been seen');
  assert.equal(marker.getAttribute('data-node'), 'session-root#t5',
    'pointing at the turn the last visit was reading');
});

test('the position the rail reports is remembered for the next visit', async (t) => {
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, undefined, 'session-root');
  const doc = view.dom.window.document;
  fakeRail(doc, [4, 5, 6], null);
  const mark = [...doc.querySelectorAll('button[data-index]')].find((el) => el.getAttribute('aria-label') === '跳转到第 5 轮');
  await act(async () => {
    mark.setAttribute('aria-current', 'true');
    await new Promise((r) => setTimeout(r, 0));
  });
  const stored = JSON.parse(doc.defaultView.localStorage.getItem('dsh-tree-view:reading') || 'null');
  assert.ok(stored && stored.turn === 5, 'the turn is written down for the next load: ' + JSON.stringify(stored));
});

test('the marker re-centres when its card changes height', async (t) => {
  // Reported: centred on a folded node, off-centre on an expanded one. Measured card
  // heights arrive once per layout, so a card that grew left the marker on the old centre;
  // it now listens to the card it points at.
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, undefined, 'session-root', {}, 'legacy', null, { resizeObserver: true });
  const doc = view.dom.window.document;
  fakeRail(doc, [4, 5, 6], null);
  const mark = [...doc.querySelectorAll('button[data-index]')].find((el) => el.getAttribute('aria-label') === '跳转到第 5 轮');
  await act(async () => {
    mark.setAttribute('aria-current', 'true');
    await new Promise((r) => setTimeout(r, 0));
  });

  const card = doc.querySelector('.mtx-card[data-id="session-root#t5"]');
  const watcher = view.resizeObservers.find((observer) => observer.target === card);
  assert.ok(watcher, 'the marker listens to the card it points at');

  const nums = (value) => (String(value || '').match(/-?[\d.]+/g) || []).map(Number);
  const markerBefore = nums(doc.querySelector('.mtx-here').style.transform);
  const cardY = nums(card.style.transform)[1];

  // The card grows: 58px is the nominal height it was centred for.
  Object.defineProperty(card, 'offsetHeight', { value: 104, configurable: true });
  await act(async () => {
    watcher.callback();
    await new Promise((r) => setTimeout(r, 0));
  });

  const markerAfter = nums(doc.querySelector('.mtx-here').style.transform);
  assert.ok(Math.abs(markerBefore[1] - (cardY + 58 / 2)) < 0.01, 'it started on the nominal centre: ' + markerBefore[1]);
  assert.ok(Math.abs(markerAfter[1] - (cardY + 104 / 2)) < 0.01,
    'and moved to the new one: ' + markerAfter[1] + ' (wanted ' + (cardY + 52) + ')');
});
