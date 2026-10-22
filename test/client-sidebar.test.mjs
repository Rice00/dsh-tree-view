import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Better Sidebar is optional, supports late activation and disposes its registration', async t => {
  let plugin;
  runInNewContext(bundle, { window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => React); } } }, console });
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const views = [];
  ctx.provide('slots', { inject: (_slot, f) => f(), register: spec => { views.push(spec.name); return () => {}; } });
  const fiber = ctx.plugin(plugin);
  await fiber;
  assert.equal(fiber.state, 2);
  assert.ok(views.includes('conversation.view'));
  const tabs = new Map();
  let disposals = 0;
  const sidebarPlugin = ctx.plugin({ apply(scope) {
    scope.provide('betterSidebar', { registerTab(tab) {
      assert.equal(tabs.size, 0);
      tabs.set(tab.id, tab);
      return () => { tabs.delete(tab.id); disposals++; };
    } });
  } });
  await sidebarPlugin;
  await tick();
  assert.equal(tabs.size, 1);
  assert.equal(tabs.get('dsh-tree-view:tree').single, true);
  await sidebarPlugin.dispose();
  await tick();
  assert.equal(tabs.size, 0);
  assert.equal(disposals, 1);
  assert.equal(fiber.state, 2, 'disabling Better Sidebar does not disable standalone Tree');
});

async function mount(t, { archived = false, holdNavigation = false, delayedSurface = false, legacyController = false, openError = null, eagerSubscription = false, deferredUnarchive = false, staleRetention = false, holdCatalogue = false, unarchiveError = null, statefulArchive = false, delayedTreeCache = false, runningBranch = false, staleSourceArchive = false, archivePhase = 'ready', nativeArchiveFeed = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><button role="tab" aria-selected="true">Chat</button><div id="root"></div></body></html>', { url: 'https://tree.test/', pretendToBeVisual: true });
  let current = 'root';
  let ready = 'root';
  let attempts = 0;
  let releaseUnarchive;
  const unarchiveGate = deferredUnarchive ? new Promise(resolve => { releaseUnarchive = resolve; }) : Promise.resolve();
  const catalogued = new Set(archived && deferredUnarchive ? ['root', 'other'] : ['root', 'other', 'branch']);
  const listListeners = new Set();
  const addCatalogue = id => { catalogued.add(id); listListeners.forEach(f => f()); };
  const mountedListeners = new Set();
  let onSelection = () => {};
  const select = id => { current = id; if (!delayedSurface) ready = id; mountedListeners.forEach(f => f()); onSelection(id); };
  const archiveState = new Set(archived ? ['branch'] : []);
  let cachedTree;
  let requests = 0;
  const opened = [], restored = [], sidebarOpened = [], posts = [], disposers = [];
  const versions = [
    { sessionId: 'root', current: true, createdAt: 1, turns: [{ turn: 1, text: 'Root', time: 1 }] },
    { sessionId: 'other', parentSessionId: 'root', operation: 'edit', targetTurn: 1, createdAt: 3, turns: [{ turn: 1, text: 'Other', time: 3 }] },
    { sessionId: 'branch', parentSessionId: 'root', operation: 'edit', targetTurn: 1, createdAt: 2, archived, turns: [{ turn: 1, text: 'Branch', time: 2 }] },
  ];
  dom.window.fetch = async (_url, options) => {
    if (options?.method === 'POST') {
      const op = JSON.parse(options.body); posts.push(op);
      if (statefulArchive && op.action === 'demote') { archiveState.add(op.sessionId); if (current === op.sessionId) select(undefined); }
      if (statefulArchive && op.action === 'activate') archiveState.delete(op.sessionId);
      return { ok: true, json: async () => ({ ok: true }) };
    }
    requests++;
    const snapshot = statefulArchive ? versions.map(v => ({ ...v, archived: archiveState.has(v.sessionId), running: runningBranch && v.sessionId === 'branch' })) : versions;
    if (!cachedTree) cachedTree = snapshot;
    return { ok: true, json: async () => ({ versions: delayedTreeCache ? cachedTree : staleSourceArchive ? snapshot.map(v => v.sessionId === 'branch' ? { ...v, archived: true } : v) : snapshot }) };
  };
  const old = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    old.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const { flushSync } = await import('react-dom');
  const root = createRoot(dom.window.document.getElementById('root'));
  let plugin, tab, fullView;
  dom.window.__ModuleLoader__ = { load: ({ factory }) => { plugin = factory(() => React); } };
  runInNewContext(bundle, { window: dom.window, document: dom.window.document, console, setTimeout: dom.window.setTimeout.bind(dom.window), clearTimeout: dom.window.clearTimeout.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
  const services = {
    slots: { inject: (_name, f) => f(), register: (spec, component) => { if (spec.name === 'conversation.view') fullView = component; return () => {}; } },
    sessions: { list: { subscribe: f => { listListeners.add(f); return () => listListeners.delete(f); }, getSnapshot: () => ({ byId: Object.fromEntries(versions.filter(v => catalogued.has(v.sessionId)).map(v => [v.sessionId, { id: v.sessionId, retainedBy: v.sessionId === current ? ['main'] : staleRetention && v.sessionId === 'root' ? ['sidebar'] : [] }])) }) } },
    uiWorkspace: { unarchiveSession: async id => { restored.push(id); await unarchiveGate; if (unarchiveError) throw new Error(unarchiveError); if (statefulArchive) archiveState.delete(id); if (!holdCatalogue) addCatalogue(id); }, openSession: id => { opened.push(id); if (!holdNavigation) select(statefulArchive && archiveState.has(id) ? undefined : id); } },
    ...(statefulArchive && nativeArchiveFeed ? { workspaces: { list: { getSnapshot: () => ({ phase: archivePhase, archivedSessionIds: archivePhase === 'ready' ? [...archiveState] : [] }) } } } : {}),
    sidebarRight: { mounted: { getSnapshot: () => current, subscribe: f => { mountedListeners.add(f); if (eagerSubscription) f(); return () => mountedListeners.delete(f); } },
      ...(!legacyController ? { commandTarget: () => ready === current ? { sessionId: current } : undefined } : {}) },
    betterSidebar: { registerTab: value => { tab = value; return () => { tab = null; }; }, openTab: (seed, scope) => { attempts++; if (openError) throw new Error(openError); if (ready !== current) throw new Error('sidebarRight: no session surface is mounted'); sidebarOpened.push({ seed, scope }); } },
  };
  const ctx = { get: name => services[name], inject: (_deps, f) => f(ctx), effect: f => { const d = f(); if (typeof d === 'function') disposers.push(d); } };
  plugin.apply(ctx);
  t.after(async () => {
    await act(async () => root.unmount());
    disposers.reverse().forEach(f => f());
    dom.window.close();
    for (const [key, desc] of old) { if (desc) Object.defineProperty(globalThis, key, desc); else delete globalThis[key]; }
  });
  const render = async (visible, sessionId = 'root') => act(async () => { root.render(React.createElement(tab.component, { visible, scope: { sessionId } })); await tick(); });
  const renderViewsSync = views => flushSync(() => root.render(React.createElement(React.Fragment, null, ...views.map(view => React.createElement('div', { key: view.key, 'data-test-sidebar': view.key }, React.createElement(tab.component, { visible: view.visible !== false, scope: { sessionId: view.sessionId } }))))));
  const renderViews = async views => act(async () => { renderViewsSync(views); await tick(); });
  const click = async (id, viewKey) => {
    const card = dom.window.document.querySelector((viewKey ? '[data-test-sidebar="' + viewKey + '"] ' : '') + '.mtx-card[data-id="' + id + '#t1"]');
    assert.ok(card);
    await act(async () => {
      card.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      card.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, button: 0 }));
      await tick();
      await new Promise(resolve => setTimeout(resolve, 35));
    });
  };
  const renderFull = async () => act(async () => { root.render(React.createElement(fullView, { sessionId: 'root' })); await tick(); });
  return { dom, render, renderFull, click, renderViews, renderViewsSync, onSelection: fn => { onSelection = fn; }, archivedIds: () => [...archiveState], setMain: select, selected: () => current, listObservers: () => listListeners.size, releaseUnarchive: () => releaseUnarchive?.(), addCatalogue, mountSurface: id => { ready = id; }, attempts: () => attempts, listeners: () => mountedListeners.size,
    disable: () => disposers.splice(0).reverse().forEach(f => f()), unmount: async () => act(async () => root.render(null)), opened, restored, sidebarOpened, posts, requests: () => requests };
}

test('sidebar reuses the graph, stays dormant while hidden and remounts on session change', async t => {
  const h = await mount(t);
  await h.render(false);
  assert.equal(h.requests(), 0);
  await h.render(true);
  assert.ok(h.dom.window.document.querySelector('.mtx-graph[data-compact]'));
  assert.ok(h.dom.window.document.querySelector('.mtx-card[data-id="root#t1"]'));
  assert.ok(h.dom.window.document.querySelector('.mtx-card[data-id="branch#t1"]'));
  const requests = h.requests();
  await h.render(false);
  assert.equal(h.dom.window.document.querySelector('.mtx-graph'), null);
  assert.equal(h.requests(), requests);
  await h.render(true, 'branch');
  assert.ok(h.dom.window.document.querySelector('.mtx-graph'));
});

test('selecting another version opens its chat and carries the tree to its sidebar', async t => {
  const h = await mount(t);
  await h.render(true);
  await h.click('branch');
  assert.equal(h.opened[0], 'branch');
  assert.equal(h.sidebarOpened.length, 1);
  assert.equal(h.sidebarOpened[0].seed.type, 'dsh-tree-view:tree');
  assert.equal(h.sidebarOpened[0].scope.sessionId, 'branch');
  assert.equal(h.posts.filter(p => p.action === 'demote').length, 0);
});

test('selecting the current version does not reopen the session or sidebar', async t => {
  const h = await mount(t);
  await h.render(true);
  await h.click('root');
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.sidebarOpened, []);
});

test('archived selection preserves the existing client unarchive flow', async t => {
  const h = await mount(t, { archived: true });
  await h.render(true);
  await h.click('branch');
  assert.deepEqual(h.restored, ['branch']);
  assert.equal(h.opened[0], 'branch');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  assert.equal(h.sidebarOpened[0].scope.sessionId, 'branch');
});


test('sidebar and full-page canvases remember independent viewports', async t => {
  const h = await mount(t);
  await h.renderFull();
  const graph = h.dom.window.document.querySelector('.mtx-graph');
  await act(async () => {
    graph.dispatchEvent(new h.dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    graph.dispatchEvent(new h.dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 900, clientY: 600 }));
    graph.dispatchEvent(new h.dom.window.MouseEvent('pointerup', { bubbles: true, button: 0 }));
  });
  const fullTransform = h.dom.window.document.querySelector('.mtx-world').style.transform;
  await h.render(true);
  const sidebarTransform = h.dom.window.document.querySelector('.mtx-world').style.transform;
  assert.notEqual(sidebarTransform, fullTransform, 'a sidebar must not inherit a full-page pan');
  await h.renderFull();
  assert.equal(h.dom.window.document.querySelector('.mtx-world').style.transform, fullTransform);
});


test('an unfinished or superseded navigation cannot reveal the destination sidebar', async t => {
  const h = await mount(t, { holdNavigation: true });
  await h.render(true);
  await h.click('branch');
  assert.equal(h.opened[0], 'branch');
  assert.deepEqual(h.sidebarOpened, [], 'navigation has not landed yet');
  // The host keeps the previous session retained (e.g. the user went Back),
  // even after whenMain exhausts its bounded retry window.
  h.setMain('root');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 3200)); });
  assert.deepEqual(h.sidebarOpened, [], 'timeout must not open Tree for an inactive target');
});

const frames = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 55)); });

test('a selected destination waits for its adopted surface, not just mounted selection', async t => {
  const h = await mount(t, { delayedSurface: true });
  await h.render(true);
  await h.click('branch');
  await frames();
  assert.equal(h.attempts(), 0, 'do not enqueue an open before a surface exists');
  assert.equal(h.listeners(), 2);
  h.mountSurface('branch');
  await frames();
  assert.equal(h.sidebarOpened.length, 1);
  assert.equal(h.listeners(), 1, 'only the bounded navigation intent remains');
});

test('rapid A to B navigation cancels the pending A handoff', async t => {
  const h = await mount(t, { delayedSurface: true });
  await h.render(true);
  await h.click('branch');
  await h.click('other');
  h.mountSurface('other');
  await frames();
  assert.deepEqual(h.sidebarOpened.map(x => x.scope.sessionId), ['other']);
  assert.equal(h.listeners(), 1, 'only the bounded navigation intent remains');
});

test('leaving a selected destination cancels instead of reopening it on return', async t => {
  const h = await mount(t, { delayedSurface: true });
  await h.render(true);
  await h.click('branch');
  h.setMain(undefined); // a global panel replaces the conversation
  h.setMain('branch');
  h.mountSurface('branch');
  await frames();
  assert.deepEqual(h.sidebarOpened, []);
  assert.equal(h.listeners(), 0);
});

test('disabling the integration cancels a delayed handoff and releases observers', async t => {
  const h = await mount(t, { delayedSurface: true });
  await h.render(true);
  await h.click('branch');
  h.disable();
  h.mountSurface('branch');
  await frames();
  assert.deepEqual(h.sidebarOpened, []);
  assert.equal(h.listeners(), 0);
});

test('source unmount on session switch preserves handoff; destination unmount cancels it', async t => {
  const h = await mount(t, { delayedSurface: true });
  await h.render(true);
  await h.click('branch');
  await h.unmount(); // old source view leaves as target is selected
  assert.equal(h.listeners(), 2);
  await h.render(true, 'branch');
  await h.unmount(); // explicitly close the destination tree before ready
  h.mountSurface('branch');
  await frames();
  assert.deepEqual(h.sidebarOpened, []);
  assert.equal(h.listeners(), 0);
});

test('legacy controllers retry only the known pre-adoption failure', async t => {
  const h = await mount(t, { delayedSurface: true, legacyController: true });
  await h.render(true);
  await h.click('branch');
  assert.ok(h.attempts() >= 1);
  assert.deepEqual(h.sidebarOpened, []);
  h.mountSurface('branch');
  await frames();
  assert.equal(h.sidebarOpened.length, 1);
});

test('unexpected sidebar errors are terminal and visible, not silently retried', async t => {
  const h = await mount(t, { openError: 'unknown tab type' });
  await h.render(true);
  await h.click('branch');
  await frames();
  assert.equal(h.attempts(), 1);
  assert.match(h.dom.window.document.querySelector('[role="alert"]').textContent, /unknown tab type/);
  assert.equal(h.listeners(), 0);
});

test('an unavailable surface reaches a finite, visible deadline and releases observers', async t => {
  const h = await mount(t, { delayedSurface: true });
  await h.render(true);
  await h.click('branch');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5100)); });
  assert.equal(h.attempts(), 0);
  assert.match(h.dom.window.document.querySelector('[role="alert"]').textContent, /5/);
  assert.equal(h.listeners(), 0);
  h.mountSurface('branch');
  await frames();
  assert.deepEqual(h.sidebarOpened, []);
});

test('an eagerly notifying mounted observable cannot leak its subscription', async t => {
  const h = await mount(t, { eagerSubscription: true });
  await h.render(true);
  await h.click('branch');
  await frames();
  assert.equal(h.sidebarOpened.length, 1);
  assert.equal(h.listeners(), 1, 'only the bounded navigation intent remains');
});

test('hiding the destination while waiting cancels the handoff', async t => {
  const h = await mount(t, { delayedSurface: true });
  await h.render(true);
  await h.click('branch');
  await h.render(false, 'branch');
  h.mountSurface('branch');
  await frames();
  assert.deepEqual(h.sidebarOpened, []);
  assert.equal(h.listeners(), 0);
});

test('main to A, A to B, and B back to main follow each newly mounted surface', async t => {
  const h = await mount(t, { delayedSurface: true });
  await h.render(true);
  for (const destination of ['branch', 'other', 'root']) {
    await h.click(destination);
    await h.render(true, destination);
    h.mountSurface(destination);
    await frames();
    assert.equal(h.sidebarOpened.at(-1)?.scope.sessionId, destination);
    assert.equal(h.listeners(), 1, 'only the bounded navigation intent remains');
  }
  assert.deepEqual(h.sidebarOpened.map(x => x.scope.sessionId), ['branch', 'other', 'root']);
});


test('cold archived target survives async restore and background-retained source metadata', async t => {
  const h = await mount(t, { archived: true, deferredUnarchive: true, staleRetention: true, delayedSurface: true });
  await h.render(true);
  await h.click('branch');
  assert.deepEqual(h.opened, [], 'restore has not resolved');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 3200)); });
  assert.deepEqual(h.opened, [], 'reveal timeout must not run ahead of restore');
  assert.equal(h.posts.filter(p => p.action === 'demote').length, 0, 'do not archive source during restore');
  await act(async () => { h.releaseUnarchive(); await tick(); });
  assert.equal(h.selected(), 'branch');
  await h.render(true, 'branch');
  h.mountSurface('branch');
  await frames();
  assert.deepEqual(h.sidebarOpened.map(x => x.scope.sessionId), ['branch']);
  assert.deepEqual(h.posts.filter(p => p.action === 'demote').map(p => p.sessionId), ['root']);
});

test('leaving for Plugins before async restore resolves cannot navigate or reveal later', async t => {
  const h = await mount(t, { archived: true, deferredUnarchive: true, staleRetention: true });
  await h.render(true);
  await h.click('branch');
  h.setMain(undefined); // native mounted clears, retained old sessions remain
  await h.unmount();
  await act(async () => { h.releaseUnarchive(); await new Promise(resolve => setTimeout(resolve, 650)); });
  assert.equal(h.selected(), undefined);
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.sidebarOpened, []);
  assert.equal(h.posts.filter(p => p.action === 'demote').length, 0);
  assert.equal(h.listeners(), 0);
});

test('leaving after archived navigation lands cancels the original 400ms reinforcement', async t => {
  const h = await mount(t, { archived: true, deferredUnarchive: true, staleRetention: true });
  await h.render(true);
  await h.click('branch');
  await act(async () => { h.releaseUnarchive(); await tick(); });
  assert.equal(h.opened.length, 1);
  h.setMain(undefined);
  await h.unmount();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)); });
  assert.equal(h.selected(), undefined, 'Plugins must remain selected');
  assert.equal(h.opened.length, 1, 'no reinforcement navigation after departure');
  assert.equal(h.listeners(), 0);
});

test('a newer click supersedes an older unresolved archive restoration', async t => {
  const h = await mount(t, { archived: true, deferredUnarchive: true });
  await h.render(true);
  await h.click('branch');
  await h.click('other');
  await act(async () => { h.releaseUnarchive(); await new Promise(resolve => setTimeout(resolve, 500)); });
  assert.equal(h.selected(), 'other');
  assert.ok(h.opened.every(x => x === 'other'));
  assert.deepEqual(h.sidebarOpened.map(x => x.scope.sessionId), ['other']);
});

test('leaving during the post-restore catalogue wait releases the subscription', async t => {
  const h = await mount(t, { archived: true, deferredUnarchive: true, holdCatalogue: true });
  await h.render(true);
  const baselineObservers = h.listObservers();
  await h.click('branch');
  await act(async () => { h.releaseUnarchive(); await tick(); });
  assert.deepEqual(h.opened, []);
  h.setMain(undefined);
  await act(async () => { h.addCatalogue('branch'); await tick(); });
  await frames();
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.sidebarOpened, []);
  assert.equal(h.listeners(), 0);
  assert.equal(h.listObservers(), baselineObservers, 'catalogue observer was removed');
});


test('a stale graph scope does not archive the wrong source after restoration', async t => {
  const h = await mount(t, { archived: true, deferredUnarchive: true, staleRetention: true });
  h.setMain('other');
  await h.render(true, 'root'); // retained old Tree slot, actual selected chat is other
  await h.click('branch');
  await act(async () => { h.releaseUnarchive(); await tick(); });
  await frames();
  assert.deepEqual(h.posts.filter(p => p.action === 'demote').map(p => p.sessionId), ['other']);
  assert.deepEqual(h.sidebarOpened.map(x => x.scope.sessionId), ['branch']);
});

test('disabling Tree while unarchive is pending cancels all later navigation', async t => {
  const h = await mount(t, { archived: true, deferredUnarchive: true });
  await h.render(true);
  await h.click('branch');
  h.disable();
  await act(async () => { h.releaseUnarchive(); await tick(); });
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.sidebarOpened, []);
  assert.equal(h.listeners(), 0);
});


test('minimal integration leaves upstream shared navigation and turn-jump helpers byte-identical', () => {
  const source = readFileSync(new URL('../plugin.client.js', import.meta.url), 'utf8');
  { const start = source.indexOf("async function openVersionTarget("); const end = source.indexOf("\nasync function mutate(", start);
    assert.equal(createHash('sha256').update(source.slice(start, end)).digest('hex'), 'ddafd7c7efcd0497d841eb3409e5a353e53b125834d9fc2bf131fd46e506cfc2', 'shared navigation: upstream 108575'); }
  { const start = source.indexOf("function flashTurn("); const end = source.indexOf("\n/**\n * The last turn", start);
    assert.equal(createHash('sha256').update(source.slice(start, end)).digest('hex'), '5b5bb60ec52709aa1f72c7ce83312c223a9cb0f132703db6a86ed9f287018887', 'shared turn jumps: upstream 108575'); }
});


test('cancelled sidebar restoration rejection does not start the upstream HTTP fallback', async t => {
  const h = await mount(t, { archived: true, deferredUnarchive: true, unarchiveError: 'restore refused' });
  await h.render(true);
  await h.click('branch');
  h.setMain(undefined);
  await act(async () => { h.releaseUnarchive(); await tick(); });
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.sidebarOpened, []);
  assert.equal(h.posts.filter(p => p.action === 'activate').length, 0);
});

test('the conversation Tree click path is upstream-identical apart from the optional sidebar hook', () => {
  const source = readFileSync(new URL('../plugin.client.js', import.meta.url), 'utf8');
  const start = source.indexOf('      function openVersion(id) {');
  const end = source.indexOf('\n      /**', start);
  const original = source.slice(start, end).replace("        // Only the optional sidebar supplies this adapter. The conversation\n        // Tree below deliberately retains its original navigation semantics.\n        if (props.onVersionSelect) {\n          props.onVersionSelect(v, node, versions, sessionId);\n          return;\n        }\n", '');
  assert.equal(createHash('sha256').update(original).digest('hex'), 'f11dca6994c93aaab42e389a72b8b1b1175410d6edfb7cad42101952dfed2dfc');
});

for (const mode of ['fresh', 'stale source flag', 'delayed tree cache and stale scope']) {
  test('natural archived A → B → A collects the actual source: ' + mode, async t => {
    const delayedTreeCache = mode === 'delayed tree cache and stale scope';
    const h = await mount(t, { archived: true, statefulArchive: true, delayedTreeCache, staleSourceArchive: mode === 'stale source flag' });
    await h.render(true, 'root');
    await h.click('branch');
    assert.equal(h.selected(), 'branch');
    assert.deepEqual(h.archivedIds(), ['root']);
    assert.equal(h.sidebarOpened.at(-1).scope.sessionId, 'branch');
    await h.render(true, delayedTreeCache ? 'root' : 'branch');
    await h.click('root');
    assert.equal(h.selected(), 'root', 'collecting the wrong source must not clear the new chat');
    assert.deepEqual(h.restored, ['branch', 'root']);
    assert.deepEqual(h.archivedIds(), ['branch']);
    assert.deepEqual(h.posts.filter(p => p.action === 'demote').map(p => p.sessionId), ['root', 'branch']);
    assert.equal(h.sidebarOpened.at(-1).scope.sessionId, 'root');
  });
}

test('sidebar collection still leaves a running source alone with stale cached archive flags', async t => {
  const h = await mount(t, { archived: true, statefulArchive: true, delayedTreeCache: true, runningBranch: true });
  await h.render(true);
  await h.click('branch');
  await h.render(true, 'branch');
  await h.click('root');
  assert.equal(h.selected(), 'root');
  assert.deepEqual(h.archivedIds(), []);
  assert.deepEqual(h.posts.filter(p => p.action === 'demote').map(p => p.sessionId), ['root']);
});

for (const archivePhase of ['pending', 'disconnected']) {
  test('a ' + archivePhase + ' native archive feed does not override the tree restore flag', async t => {
    const h = await mount(t, { archived: true, statefulArchive: true, archivePhase });
    await h.render(true);
    await h.click('branch');
    assert.deepEqual(h.restored, ['branch']);
    assert.equal(h.selected(), 'branch');
    assert.deepEqual(h.archivedIds(), ['root']);
  });
}

test('legacy host without native archive feed collects selected source despite its stale graph flag', async t => {
  const h = await mount(t, { archived: true, statefulArchive: true, nativeArchiveFeed: false, staleSourceArchive: true });
  await h.render(true);
  await h.click('branch');
  await h.render(true, 'branch');
  await h.click('root');
  assert.equal(h.selected(), 'root');
  assert.deepEqual(h.archivedIds(), ['branch']);
});


for (const replacement of ['unmount', 'visibility cleanup', 'hide cleanup', 'hidden sibling mount']) {
  test('return navigation survives stale target instance ' + replacement + ' before arrival', async t => {
    const h = await mount(t, { archived: true, statefulArchive: true });
    const a = { key: 'old-A', sessionId: 'root' };
    const b = { key: 'B', sessionId: 'branch' };
    await h.renderViews([a]);
    await h.click('branch', 'old-A');
    await h.renderViews([{ ...a, visible: replacement === 'hide cleanup' }, b]);
    h.onSelection(id => {
      if (id !== 'root') return;
      const targetViews = replacement === 'unmount' ? [b]
        : replacement === 'visibility cleanup' ? [a, b]
        : replacement === 'hide cleanup' ? [{ ...a, visible: false }, b]
        : [{ ...a, visible: false }, b, { key: 'unowned-A', sessionId: 'root', visible: false }];
      h.renderViewsSync(targetViews);
    });
    await h.click('root', 'B');
    assert.equal(h.selected(), 'root');
    assert.deepEqual(h.archivedIds(), ['branch']);
    assert.deepEqual(h.posts.filter(p => p.action === 'demote').map(p => p.sessionId), ['root', 'branch']);
    assert.equal(h.sidebarOpened.at(-1).scope.sessionId, 'root');
  });
}

for (const close of ['unmount', 'hide']) {
  test('the initiating instance can still ' + close + ' and cancel its own pending restore', async t => {
    const h = await mount(t, { archived: true, deferredUnarchive: true, statefulArchive: true });
    await h.render(true);
    await h.click('branch');
    if (close === 'unmount') await h.unmount();
    else await h.render(false);
    await act(async () => { h.releaseUnarchive(); await tick(); });
    await frames();
    assert.equal(h.selected(), 'root');
    assert.deepEqual(h.opened, []);
    assert.deepEqual(h.sidebarOpened, []);
    assert.deepEqual(h.posts.filter(p => p.action === 'demote'), []);
    assert.equal(h.listeners(), 0);
  });

  test('a newly attached destination instance can ' + close + ' after stale target cleanup', async t => {
    const h = await mount(t, { archived: true, statefulArchive: true, delayedSurface: true });
    const a = { key: 'old-A', sessionId: 'root' };
    const b = { key: 'B', sessionId: 'branch' };
    const fresh = { key: 'new-A', sessionId: 'root' };
    await h.renderViews([a]);
    await h.click('branch', 'old-A');
    h.mountSurface('branch');
    await frames();
    await h.renderViews([{ ...a, visible: false }, b]);
    h.onSelection(id => { if (id === 'root') h.renderViewsSync([b, fresh]); });
    await h.click('root', 'B');
    assert.deepEqual(h.archivedIds(), ['branch']);
    assert.equal(h.listeners(), 2, 'navigation and pending surface wait are both live');
    await h.renderViews(close === 'unmount' ? [b] : [b, { ...fresh, visible: false }]);
    h.mountSurface('root');
    await frames();
    assert.equal(h.selected(), 'root');
    assert.deepEqual(h.sidebarOpened.map(x => x.scope.sessionId), ['branch']);
    assert.equal(h.listeners(), 0);
  });
}
