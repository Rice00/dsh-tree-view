import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// The bug this guards: the canvas kept `will-change: transform` on the world (and
// on every card) for good. A promoted layer is rasterised once and then stretched
// by the GPU, so zooming in showed the tree scaled up soft instead of redrawn at
// the scale actually on screen.
//
// Measured on the real composited desktop, same card at scale 1.8: the promoted
// render carried 48% less edge energy (12.91 vs 19.09) than the same card after
// the hint is dropped. CDP screenshots cannot see this — they re-rasterise the
// page for the capture, so both renders come out sharp there. That is why this is
// a source-level guard rather than a pixel test.

function rule(selector) {
  const pattern = new RegExp("'" + selector.replace('.', '\\.') + '\\{[^}]*\\}');
  const match = bundle.match(pattern);
  assert.ok(match, 'the bundle still ships the ' + selector + ' rule');
  return match[0];
}

test('neither the world nor a card is a permanently promoted layer', () => {
  for (const selector of ['.mtx-world', '.mtx-card']) {
    assert.ok(
      !/will-change/.test(rule(selector)),
      selector + ' must not carry will-change: a layer promoted for good keeps the raster drawn'
        + ' for the old scale and the GPU stretches it, which is the blurry zoom this plugin fixed',
    );
  }
});

test('the world is promoted while the canvas moves and released once it settles', () => {
  const start = bundle.indexOf('function applyView()');
  assert.ok(start > 0, 'applyView is still in the bundle');
  const end = bundle.indexOf('function positionGroupNames()', start);
  const body = bundle.slice(start, end > start ? end : start + 900);

  const promoteAt = body.indexOf("el.style.willChange = 'transform'");
  const clearAt = body.indexOf("node.style.willChange = ''");
  assert.ok(promoteAt > 0, 'applyView still promotes the world while it moves');
  assert.ok(clearAt > promoteAt, 'the hint is raised before it is released');

  // Released off a timer, not synchronously: clearing it in the same frame would
  // drop the layer in the middle of a drag, and never clearing it is the bug.
  const timerAt = body.indexOf('setTimeout(function () {');
  assert.ok(timerAt > promoteAt && timerAt < clearAt, 'the release runs on a settle timer');
  assert.match(body, /\}, 160\);/, 'the settle window is still 160ms');

  // The transform must be applied after the hint goes up, or the first frame of a
  // gesture is painted unpromoted.
  const transformAt = body.indexOf("el.style.transform = 'translate('");
  assert.ok(transformAt > promoteAt, 'the hint goes up before the transform changes');
});
