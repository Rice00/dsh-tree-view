import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// Opening a large family used to hitch. Three things paid for it on the frame
// that first drew the tree, and all three scale with the size of the family:
//
//   1. every node was born at its parent's position and sprung into place, so a
//      first fill wrote every card and every edge on every frame until it settled;
//   2. card heights were measured in the frame *before* the first paint, forcing a
//      layout over the whole tree ahead of the thing the reader was waiting for;
//   3. the fit promoted the world to one GPU layer, and the browser then rasterised
//      the entire tree into it before anything had moved.
//
// These are source-level guards for the same reason the crisp-zoom ones are: the
// cost is a compositor and layout cost, and a headless page cannot measure it
// honestly. The runtime evidence lives in the app log — the layout line reports
// node count, edge count and milliseconds, and says whether it settled outright.

const code = bundle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function between(from, to) {
  // Both indices come from the comment-stripped text: mixing offsets between the
  // stripped and the raw bundle silently slices the wrong region.
  const start = code.indexOf(from);
  assert.ok(start > 0, from + ' is still in the bundle');
  const end = code.indexOf(to, start);
  assert.ok(end > start, to + ' still follows ' + from);
  return code.slice(start, end);
}

test('a first fill is placed outright instead of animating the whole family', () => {
  assert.match(code, /const BIRTH_ANIMATION_CAP = \d+;/, 'the animation cap is still a named constant');
  assert.match(code, /const born = !fittedRef\.current \? 0 : added;/,
    'a first fill (nothing fitted yet) never animates, however many nodes it adds');
  assert.match(code, /const animateBirth = born > 0 && born <= BIRTH_ANIMATION_CAP;/,
    'a crowd of new nodes is placed instead of animated');
  assert.match(code, /if \(animateBirth\) kick\(\);/,
    'the frame loop only runs for a layout that actually animates — a settled fill is already drawn');
});

test('card heights are measured after the paint, not before it', () => {
  const measure = between('function measureHeights()', '\n      function ');
  assert.match(measure, /requestIdleCallback/, 'the pass waits for idle time when the renderer has it');
  assert.match(measure, /requestAnimationFrame\(function \(\) \{\s*measureRef\.current = requestAnimationFrame\(run\);/,
    'and otherwise waits two frames: the first runs before this paint, the second after it');
  assert.match(measure, /offsetHeight/, 'it still measures once per layout, outside the frame loop');
});

test('the world layer is raised by a gesture, not by the opening fit', () => {
  const apply = between('function applyView()', 'function promoteWorld()');
  assert.match(apply, /if \(worldPromotedRef\.current\) \{/,
    'only an already-promoted world gets the promotion and the refresh dance');
  assert.match(apply, /const zoomed = rasterScaleRef\.current !== view\.scale;/,
    'the scale comparison that drives the refresh is unchanged');
  assert.match(apply, /el\.style\.transform = /, 'the transform is written whether or not the layer is up');
  assert.ok(bundle.includes('function promoteWorld()'), 'the gesture path can raise the layer itself');
  const pan = between('function onPointerMove(', 'function onPointerUp()');
  assert.match(pan, /promoteWorld\(\);/,
    'a pan that leaves the threshold promotes the world, so the gesture is a transform and not a repaint per frame');
  const wheel = between("const onWheel = function (ev) {", 'el.addEventListener');
  assert.match(wheel, /promoteWorld\(\);/,
    'and so does a zoom, before the scale changes');
});

test('the layer is raised in idle time, and only once a tree exists', () => {
  const schedule = between('function schedulePromotion()', '\n      function ');
  assert.match(schedule, /requestIdleCallback\(run, \{ timeout: 400 \}\)/,
    'the raster happens in idle time — ready for the first gesture, never during the first paint');
  assert.match(schedule, /if \(worldPromotedRef\.current\) return;/, 'raising it twice is a no-op');
  assert.match(code, /if \(lay\.pos\.size > 0\) schedulePromotion\(\);/,
    'an empty world is not promoted: that would raise the layer before the first card paints');
  assert.match(code, /rasterScaleRef\.current = viewRef\.current\.scale;/,
    'promoting records the scale the raster was drawn at, so the next pan needs no refresh');
});

test('an overview drops what cannot be seen at that scale', () => {
  // Measured in the running app on a 73-card family: hiding every card still left a
  // ~54ms reveal frame (that part is the host's own tab switch), and the tree's own
  // share was almost entirely the cards' blurred shadows and their subtitles — both
  // sub-pixel at the scale a fit lands on. Dropping them took the cold reveal from
  // 132ms to 84ms on the same machine.
  assert.match(code, /const FAR_SCALE = 0\.5;/, 'the overview threshold is a named constant');
  assert.ok(bundle.includes('.mtx-graph[data-far] .mtx-card{box-shadow:none'), 'the blurred shadow is dropped in the overview');
  assert.ok(bundle.includes('.mtx-graph[data-far] .mtx-card-sub{display:none'), 'and so is the subtitle, which is unreadable there');
  assert.ok(bundle.includes('.mtx-graph[data-far] .mtx-card[data-current]{box-shadow:0 0 0 1px'),
    'the "where am I" ring survives the overview: it is spread-only, so it costs nothing');
  assert.ok(bundle.includes('.mtx-graph[data-far] .mtx-card[data-head]{box-shadow:0 0 0 2px'),
    'and so does the head ring');
  const apply = between('function applyView()', 'function promoteWorld()');
  assert.match(apply, /const far = view\.scale < FAR_SCALE;/, 'the canvas decides it from the scale on screen');
  assert.match(apply, /if \(far !== graph\.hasAttribute\('data-far'\)\) \{/,
    'and writes it only when it changes — a write per pan frame would recalculate style for every card');
});

test('the canvas size is kept, not read, so the sticky clamp never forces layout', () => {
  const clamp = between('function positionGroupNames()', 'function renderFrame()');
  // The clamp runs on every pan frame. It reads the remembered size first; the
  // direct read is only a fallback for a renderer whose observer never ran.
  assert.match(clamp, /const height = graphSizeRef\.current\.h \|\| graphEl\.clientHeight \|\| 0;/,
    'the sticky clamp prefers the remembered size and only falls back to reading');
  assert.match(code, /const graphSizeRef = React\.useRef\(\{ w: 0, h: 0 \}\);/, 'the size lives in a ref');
  assert.match(code, /new ResizeObserver\(remember\)/, 'a ResizeObserver keeps it up to date');
  assert.match(code, /const w = size\.w \|\| el\.clientWidth \|\| 600;/, 'the fit prefers the remembered size too');
});
