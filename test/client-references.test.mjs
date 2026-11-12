import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
// The bundle runs in its own VM realm, so the objects it hands the factory carry
// that realm's prototypes. Compare the values, not which realm made them.
const plain = value => JSON.parse(JSON.stringify(value));
const text = value => ({ type: 'text', text: value });
const photo = id => ({ type: 'image', attachment: { id, mimeType: 'image/png' } });
const file = name => ({ type: 'file', attachment: { name, bytes: 4096 } });

// Run the shipped bundle and mount the user-message renderer it registers.
// React and the DOM are real; the host's content factory is a double, because
// what this plugin owes the host is the *input* to that factory. A renderer that
// draws references as plain text never calls it, and that is what these cases
// hold it to.
async function mount(t, data, options = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://tree-view.test/',
  });
  dom.window.localStorage.setItem('dsh-tree-view:style', 'chatgpt');
  const requests = [];
  dom.window.fetch = async (url, init) => {
    requests.push({ url: String(url), body: init && init.body });
    return { ok: true, json: async () => ({ versions: [] }) };
  };
  const previous = new Map();
  const browserErrors = [];
  dom.window.addEventListener('error', event => browserErrors.push(event.error || event.message));
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
  let component;
  const slots = {
    inject(_name, register) { register(); },
    register(spec, view) {
      if (spec.name === 'conversation.chat.node' && spec.key === 'user') component = view;
      return () => {};
    },
  };
  let plugin;
  dom.window.__ModuleLoader__ = {
    load({ id, factory }) {
      assert.equal(id, 'dsh-tree-view');
      plugin = factory(name => {
        assert.equal(name, 'react');
        return React;
      });
    },
  };
  runInNewContext(bundle, {
    window: dom.window, document: dom.window.document, console,
    setTimeout, clearTimeout,
  }, { filename: 'lib/client.js' });
  const ctx = {
    get(name) {
      if (name === 'slots') return slots;
      if (name === 'sessions') {
        return {
          open() {},
          list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: { 'session-test': { id: 'session-test' } } }) },
        };
      }
      return undefined;
    },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  };
  ctx.inject = (deps, callback) => callback(ctx);
  plugin.apply(ctx);
  assert.equal(typeof component, 'function', 'The user-message slot must register');
  const props = {
    sessionId: 'session-test',
    node: { data: { content: data.content ?? [], seq: 2, ...data.node }, location: { turn: { turn: 1 } } },
  };
  if (options.loadImage !== undefined) props.loadImage = options.loadImage;
  if (options.renderFactorySlot !== undefined) props.renderFactorySlot = options.renderFactorySlot;
  await act(async () => root.render(React.createElement(component, props)));
  return { doc: dom.window.document, requests };
}

// The host's content factory, reduced to what these cases assert on: it records
// its input and paints a marker that survives into the DOM.
function hostFactory(calls) {
  return (name, input) => {
    calls.push({ name, input });
    return React.createElement('div', { 'data-host-content': name },
      React.createElement('span', { 'data-message-bubble': '' }, input.content.text),
      input.content.referenceLabels && input.content.referenceLabels.length > 0
        ? React.createElement('span', { 'data-reference-summary': '' }, input.content.referenceLabels.join(' · '))
        : null);
  };
}

test('the message goes through the host content factory, not a hand-built bubble', async t => {
  const calls = [];
  const loadImage = () => {};
  const { doc } = await mount(t, { content: [text('see @a.md and @b.md')] }, {
    renderFactorySlot: hostFactory(calls), loadImage,
  });
  assert.ok(calls.length >= 1, 'The host factory must be asked to draw the message');
  // React may render the row more than once; every render asks the same seat.
  assert.deepEqual([...new Set(calls.map(call => call.name))], ['conversation.chat.user.content']);
  assert.equal(calls[0].input.content.text, 'see @a.md and @b.md');
  // References are only clickable because the host drew them interactively.
  assert.equal(calls[0].input.interactive, true);
  assert.equal(calls[0].input.loadImage, loadImage, 'The host needs the session-authorized loader');
  assert.equal(doc.querySelector('.mtx-content [data-host-content]')?.getAttribute('data-host-content'),
    'conversation.chat.user.content');
  assert.equal(doc.querySelector('.mtx-bubble'), null, 'No second, style-less bubble around the host content');
});

test('text blocks concatenate the way the host concatenates them', async t => {
  const calls = [];
  await mount(t, { content: [text('first '), text('second')] }, { renderFactorySlot: hostFactory(calls) });
  assert.equal(calls[0].input.content.text, 'first second');
});

test('attachments reach the host in message order, files included', async t => {
  const calls = [];
  const first = photo('first');
  const doc = file('notes.md');
  await mount(t, { content: [text('compare'), first, text(' with '), doc] }, {
    renderFactorySlot: hostFactory(calls),
  });
  assert.deepEqual(plain(calls[0].input.content.attachments), [
    { type: 'image', image: { attachment: first.attachment } },
    { type: 'file', file: doc.attachment },
  ]);
  assert.deepEqual(plain(calls[0].input.content.extraBlocks), []);
});

test('blocks the plugin cannot place are handed over as extra blocks instead of disappearing', async t => {
  const calls = [];
  const odd = { type: 'tool-note', id: 'n1' };
  await mount(t, { content: [text('hi'), odd] }, { renderFactorySlot: hostFactory(calls) });
  assert.deepEqual(plain(calls[0].input.content.extraBlocks), [odd]);
});

test('session reference labels reach the factory as both content and facts', async t => {
  const calls = [];
  const { doc } = await mount(t, {
    content: [text('@AI工作平台 and @书籍')],
    node: { referenceLabels: ['AI工作平台', '书籍'] },
  }, { renderFactorySlot: hostFactory(calls) });
  assert.deepEqual(plain(calls[0].input.content.referenceLabels), ['AI工作平台', '书籍']);
  assert.deepEqual(plain(calls[0].input.facts.sessionLabels), ['AI工作平台', '书籍']);
  // The reference summary under the bubble is part of the host's rendering, so
  // it only exists because the host was allowed to draw the message.
  assert.match(doc.querySelector('[data-reference-summary]')?.textContent ?? '', /AI工作平台/);
});

test('loaded skill names reach the factory as facts, which is what renders /skill chips', async t => {
  const calls = [];
  await mount(t, {
    content: [text('/pdf-to-interactive-web build it')],
    node: { skillNames: ['pdf-to-interactive-web'] },
  }, { renderFactorySlot: hostFactory(calls) });
  assert.deepEqual(plain(calls[0].input.facts.skillNames), ['pdf-to-interactive-web']);
});

test('a message without labels or skills passes neither key, so the host applies its own defaults', async t => {
  const calls = [];
  await mount(t, { content: [text('plain')] }, { renderFactorySlot: hostFactory(calls) });
  assert.deepEqual(plain(calls[0].input.facts), {});
  assert.equal('referenceLabels' in calls[0].input.content, false);
});

test('a host without a content factory still shows the message as a plain bubble', async t => {
  const { doc } = await mount(t, { content: [text('see @a.md')] });
  assert.equal(doc.querySelector('.mtx-content'), null);
  assert.equal(doc.querySelector('.mtx-bubble')?.textContent, 'see @a.md');
});

test('a factory that refuses the slot leaves the message readable instead of breaking the row', async t => {
  let attempts = 0;
  const { doc } = await mount(t, { content: [text('still here')] }, {
    renderFactorySlot: () => { attempts += 1; throw new Error('no definition for "conversation.chat.user.content"'); },
  });
  // Retried per render — a factory that appears later (a host still booting)
  // must be picked up rather than latched off forever.
  assert.ok(attempts >= 1);
  assert.equal(doc.querySelector('.mtx-bubble')?.textContent, 'still here');
  // The controls still work, so the row is usable rather than half-dead.
  assert.ok(doc.querySelector('.mtx-act[data-act=edit]'));
});
