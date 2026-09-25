import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function load() {
  let plugin;
  const warnings = [];
  runInNewContext(bundle, {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({})); } } },
    console: { warn: (...args) => warnings.push(args) },
  });
  return { plugin, warnings };
}

// A context double with the two verbs the client uses: `get` for lookups and
// `inject` for optional services (Cordis hands the callback a scope over the
// same context, so the double hands back itself).
function ctxDouble({ get, effect = fn => fn() }) {
  const ctx = { get, effect };
  ctx.inject = (_deps, callback) => { callback(ctx); return () => {}; };
  return ctx;
}

test('declared client dependencies make the UI services available for registration', () => {
  const { plugin } = load();
  const registered = [];
  // This loader double follows the relevant DSH dependency contract: services
  // are available only when their providing client module is injected.
  const slots = {
    inject: (_name, register) => register(),
    register: spec => { registered.push(spec.name); return () => {}; },
  };
  plugin.apply(ctxDouble({
    get: name => name === 'slots' && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-renderer') ? slots
      : name === 'sessions' && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-api-session-controller') ? { open() {} } : undefined,
  }));
  assert.deepEqual(registered, ['settings.section', 'conversation.chat.node', 'conversation.view']);
});

test('a missing slots service fails visibly instead of silently disabling the module', () => {
  const { plugin } = load();
  assert.throws(() => plugin.apply(ctxDouble({ get: () => undefined })), /Missing DSH slots service.*inject/);
});

test('the client applies without the session service, and takes it when it arrives', async t => {
  // 0.1.7 moved `open` off the session service, and a host in between could move
  // the service itself. Declaring it as a hard `inject` parked the plugin until
  // the service appeared — forever, if the host had renamed it — and DSH Desktop
  // deselects a client plugin whose boot never finishes. So `slots` alone decides
  // whether the client runs, and `sessions` is taken through `ctx.inject`.
  const { plugin } = load();
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const registered = [];
  ctx.provide('slots', {
    inject: (_name, register) => register(),
    register: spec => { registered.push(spec.name); return () => {}; },
  });
  const fiber = ctx.plugin(plugin);
  await fiber;
  assert.equal(fiber.state, 2, 'the client applies as soon as its essential service is there');
  assert.deepEqual(registered, ['settings.section', 'conversation.chat.node', 'conversation.view']);

  // The optional service lands later; nothing about the applied plugin breaks.
  ctx.provide('sessions', { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: {} }) } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fiber.state, 2);
  assert.deepEqual(registered, ['settings.section', 'conversation.chat.node', 'conversation.view']);
});

test('a user-renderer collision is reported while the other UI entries still register', () => {
  const { plugin, warnings } = load();
  const registered = [];
  plugin.apply(ctxDouble({
    get: name => name === 'slots' ? {
      inject: (_name, register) => register(),
      register(spec) {
        if (spec.name === 'conversation.chat.node') throw new Error('duplicate renderer');
        registered.push(spec.name);
        return () => {};
      },
    } : name === 'sessions' ? { open() {} } : undefined,
  }));
  assert.deepEqual(registered, ['settings.section', 'conversation.view']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /editing is unavailable/);
});
