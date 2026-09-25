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

test('cards are paint-contained, because that is what a zoom burst costs', () => {
  // Measured in the running app: a zoom burst re-rastering 60-odd cards peaked at
  // 94ms, and hiding the cards took the same burst to 5ms — the cards are the
  // whole paint cost. Containment plus `content-visibility` is what keeps a big
  // family from stuttering while zooming.
  const card = rule('.mtx-card');
  assert.match(card, /contain:[^;}]*paint/, 'a card contains its own paint');
  assert.match(card, /content-visibility:auto/, 'and off-screen cards are skipped entirely');
  assert.match(card, /contain-intrinsic-size:auto/, 'with the height it had last time it was rendered');
});

test('the frame loop does not read layout', () => {
  // A layout read inside the animation loop forces layout per edge per frame.
  // Comments are stripped first: this is about code, and the explanation of why
  // the reads were removed is allowed to name them.
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const render = strip(bundle.slice(bundle.indexOf('function renderFrame()'), bundle.indexOf('function measureHeights()')));
  assert.ok(render.length > 0, 'renderFrame is still in the bundle');
  assert.ok(!/offsetHeight/.test(render), 'renderFrame reads no layout');
  assert.match(render, /cardHeights\.current\.get/, 'it uses the heights measured once per layout');
  const groupNames = strip(bundle.slice(bundle.indexOf('function positionGroupNames()'), bundle.indexOf('function renderFrame()')));
  assert.ok(!/offsetHeight/.test(groupNames), 'and so does the sticky group-name clamp');
});

test('the raster is refreshed when a zoom settles, without giving the layer up', () => {
  const start = bundle.indexOf('function applyView()');
  assert.ok(start > 0, 'applyView is still in the bundle');
  const end = bundle.indexOf('function positionGroupNames()', start);
  const body = bundle.slice(start, end > start ? end : start + 1600);

  const promoteAt = body.indexOf("el.style.willChange = 'transform'");
  const clearAt = body.indexOf("node.style.willChange = ''");
  assert.ok(promoteAt > 0, 'applyView still promotes the world while it moves');
  assert.ok(clearAt > promoteAt, 'the hint is raised before it is released');

  // Released off a timer, not synchronously: clearing it in the same frame would
  // drop the layer in the middle of a drag, and never clearing it is the bug.
  const timerAt = body.indexOf('setTimeout(function () {');
  assert.ok(timerAt > promoteAt && timerAt < clearAt, 'the refresh runs on a settle timer');
  assert.match(body, /\}, 400\);/, 'and only after the gesture has settled');

  // The layer comes straight back in the next frame. Dropping it for good means the
  // next gesture re-rasterises the tree mid-drag: measured at 44-90ms per gesture
  // that way, against 3ms while a layer survives to be stretched.
  const backAt = body.indexOf("again.style.willChange = 'transform'");
  assert.ok(backAt > clearAt, 'the layer is taken back after the one-frame refresh');
  assert.match(body, /requestAnimationFrame/, 'in the frame after the release');

  // Only a scale change is worth refreshing: a pan moves the same raster.
  assert.match(body, /const zoomed = rasterScaleRef\.current !== view\.scale;/,
    'pans do not trigger the refresh');

  // The transform must be applied after the hint goes up, or the first frame of a
  // gesture is painted unpromoted.
  const transformAt = body.indexOf("el.style.transform = 'translate('");
  assert.ok(transformAt > promoteAt, 'the hint goes up before the transform changes');
});
