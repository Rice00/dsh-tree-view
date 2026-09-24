import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// Every colour this plugin pours must come from the host's palette. The bug this
// guards: the plugin asked for `--dsw-alias-accent-primary`, `bg-primary` and
// `border-secondary`, which this DSH build does not define at all, so what it
// actually painted with was the hardcoded dark fallbacks — dark cards on a light
// theme.
//
// The set below was read out of DSH's own theme package (light `body{}` and dark
// `body[data-ds-dark-theme]{}`). When that package is installed locally the
// second test re-derives the set from it and checks against the live palette.
const VERIFIED_ALIASES = new Set([
  'bg-base', 'bg-layer-1', 'bg-layer-2', 'bg-layer-3', 'bg-overlay',
  'bg-mask-1', 'bg-mask-2', 'bg-mask-3',
  'border-l1', 'border-l2', 'border-l3', 'border-l4',
  'label-primary', 'label-secondary', 'label-tertiary', 'label-caption', 'label-dimmed',
  'label-primary-foreground', 'label-primary-bluish',
  'interactive-bg-hover', 'interactive-bg-active',
  'state-business-primary', 'state-error-primary', 'state-warn-primary', 'state-success-primary',
  'brand-primary', 'link', 'button-info-fill',
]);
// Names kept only as a courtesy fallback inside the alias chain. Each must appear
// exactly once — in that chain — or the plugin is painting with it again.
const LEGACY_FALLBACKS = ['accent-primary', 'bg-primary', 'border-secondary', 'status-error', 'status-warning'];

function usedAliases(text) {
  const out = new Set();
  for (const m of text.matchAll(/--dsw-alias-([a-z0-9-]+)/g)) out.add(m[1]);
  return out;
}

function themePackage() {
  const candidates = [
    process.env.DSH_THEME_PACKAGE,
    'C:/_Software/DSH_Desktop/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js',
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const home = process.env.USERPROFILE;
  if (!home) return null;
  const profiles = join(home, '.dsh', 'profiles');
  if (!existsSync(profiles)) return null;
  for (const profile of readdirSync(profiles)) {
    const candidate = join(profiles, profile, 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

test('every theme token the plugin uses is one the host defines', () => {
  const used = usedAliases(bundle);
  assert.ok(used.size >= 8, 'the stylesheet still uses host tokens: ' + [...used].join(', '));

  const unknown = [...used]
    .filter((name) => !VERIFIED_ALIASES.has(name) && !LEGACY_FALLBACKS.includes(name));
  assert.deepEqual(unknown, [], 'not in the verified palette: ' + unknown.join(', '));

  for (const name of LEGACY_FALLBACKS) {
    const occurrences = bundle.split('--dsw-alias-' + name).length - 1;
    assert.equal(occurrences, 1,
      'the legacy name ' + name + ' may appear only inside the alias chain, found ' + occurrences);
  }
  // A hardcoded dark surface would defeat the point of using tokens at all.
  for (const forbidden of ['#1e1e22', '#2c2c2e', 'rgba(30,30,34', 'rgba(0,0,0,']) {
    assert.ok(!bundle.includes(forbidden), 'no hardcoded surface or shadow left: ' + forbidden);
  }
});

test('and the live theme package agrees with the verified list', (t) => {
  const file = themePackage();
  if (file === null) {
    t.skip('no DSH theme package on this machine');
    return;
  }
  const live = new Set();
  for (const m of readFileSync(file, 'utf8').matchAll(/--dsw-alias-([a-z0-9-]+)\s*:/g)) live.add(m[1]);
  assert.ok(live.size > 60, 'the theme package yielded a full palette: ' + live.size);

  const missing = [...usedAliases(bundle)]
    .filter((name) => !LEGACY_FALLBACKS.includes(name) && !live.has(name));
  assert.deepEqual(missing, [],
    'tokens the plugin uses but this DSH build does not define: ' + missing.join(', '));
});
