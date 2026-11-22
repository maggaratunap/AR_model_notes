// End-to-end marker test: render a printed ArUco marker into a synthetic camera image,
// detect it with js-aruco2 (the same detector the phone runs), and check that the 3D
// corners recovered by markerpose.js match the truth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { markerCornersInView, pixelToNormalized } from '../public/js/align/markerpose.js';
import fs from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { AR } = require('js-aruco2');
const dict = new AR.Dictionary('ARUCO_MIP_36h12');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../public/js/align/refine.js', import.meta.url), 'utf8') + ';this.MarkerRefine = MarkerRefine;', ctx);
const { refineCorners } = ctx.MarkerRefine;

/** Detect, refine to sub-pixel, convert to pixel-edge coordinates (what the worker does). */
function detectRefined(data, id) {
  const det = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12', maxHammingDistance: 3 });
  const m = det.detect({ width: W, height: H, data }).find((f) => f.id === id);
  if (!m) return null;
  const raw = m.corners.map((p) => [p.x, p.y]);
  return { raw: raw.map(([x, y]) => [x + 0.5, y + 0.5]), refined: refineCorners(det.grey, raw).map(([x, y]) => [x + 0.5, y + 0.5]) };
}

const W = 960, H = 720, FX = 760; // roughly a phone camera downscaled to 960 px
// WebXR-style projection matrix (column-major) for that camera, principal point slightly off-centre.
const CX = 488, CY = 352;
const P = new Array(16).fill(0);
P[0] = (2 * FX) / W; P[5] = (2 * FX) / H; P[8] = 1 - (2 * CX) / W; P[9] = (2 * CY) / H - 1; P[11] = -1;

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };

/** Marker pose in view space: centre t, in-plane axes ex (right), ey (up). */
function pose(t, normalToward, roll) {
  const n = unit(normalToward);
  let ex = unit(cross([0, 1, 0], n));
  if (!Number.isFinite(ex[0])) ex = [1, 0, 0];
  let ey = cross(n, ex);
  const c = Math.cos(roll), s = Math.sin(roll);
  [ex, ey] = [ex.map((v, i) => c * v + s * ey[i]), ey.map((v, i) => -s * ex[i] + c * v)];
  return { t, n, ex, ey };
}

function render(id, size, ps) {
  const code = dict.codeList[id];
  const data = new Uint8ClampedArray(W * H * 4);
  const h = size / 2, cell = size / 8;
  const sample = (u, v) => {
    // pixel (top-left origin) -> view ray (y up, -Z forward)
    const d = [(u - CX) / FX, -(v - CY) / FX, -1];
    const den = dot(ps.n, d);
    if (Math.abs(den) < 1e-9) return 110;
    const s = dot(ps.n, ps.t) / den;
    if (s <= 0) return 110;
    const q = sub(d.map((x) => x * s), ps.t);
    const x = dot(q, ps.ex), y = dot(q, ps.ey);
    if (Math.abs(x) > h + cell * 1.5 || Math.abs(y) > h + cell * 1.5) return 110; // background
    if (Math.abs(x) > h || Math.abs(y) > h) return 235;                          // white paper margin
    const col = Math.min(7, Math.floor((x + h) / cell)), row = Math.min(7, Math.floor((h - y) / cell));
    if (row === 0 || row === 7 || col === 0 || col === 7) return 20;
    return code[(row - 1) * 6 + (col - 1)] === '1' ? 235 : 20;
  };
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      let g = 0;
      for (const [a, b] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) g += sample(u + a, v + b);
      const i = (v * W + u) * 4;
      data[i] = data[i + 1] = data[i + 2] = g / 4; data[i + 3] = 255;
    }
  }
  const truth = [[-h, h], [h, h], [h, -h], [-h, -h]].map(([x, y]) => ps.t.map((tv, k) => tv + x * ps.ex[k] + y * ps.ey[k]));
  return { data, truth };
}

// Distances and sizes inside the app's gates (marker at least ~60 px across in a 960 px image).
const cases = [
  { name: 'face-on, 1.2 m', id: 7, size: 0.16, t: [0.05, -0.02, -1.2], n: [0, 0, 1], roll: 0, tol: 0.01 },
  { name: 'rolled 90°, 1.5 m', id: 42, size: 0.16, t: [-0.1, 0.08, -1.5], n: [0.1, 0, 1], roll: Math.PI / 2, tol: 0.015 },
  { name: 'oblique 45°, 1.5 m', id: 3, size: 0.16, t: [0.15, 0.1, -1.5], n: [0.7, 0.1, 0.7], roll: 0.3, tol: 0.025 },
  // Phone pitched 40° down at a floor marker 1.6 m away: floor normal in camera space.
  { name: 'floor marker 1.1 m away, phone pitched down', id: 120, size: 0.16, t: [0.1, 0, -1.1], n: [0, 0.766, 0.643], roll: 2.5, tol: 0.025 },
];

for (const c of cases) {
  test(`detects and locates marker: ${c.name}`, () => {
    const ps = pose(c.t, c.n, c.roll);
    const { data, truth } = render(c.id, c.size, ps);
    const d = detectRefined(data, c.id);
    assert.ok(d, `marker ${c.id} not detected`);
    const err = (px) => {
      const r = markerCornersInView(px.map(([x, y]) => pixelToNormalized(x, y, W, H, P)), c.size);
      return Math.max(...r.corners.map((p, i) => Math.hypot(...sub(p, truth[i]))));
    };
    const eRaw = err(d.raw), eRef = err(d.refined);
    console.log(`  ${c.name}: corner error ${(eRaw * 100).toFixed(1)} cm raw, ${(eRef * 100).toFixed(1)} cm refined`);
    // Corner order must match the printed order (TL, TR, BR, BL) whatever the roll.
    assert.ok(eRef < c.tol, `refined corner error ${(eRef * 100).toFixed(1)} cm`);
  });
}

test('mirrored image is not detected (so a flipped camera image fails safe)', () => {
  const ps = pose([0, 0, -1.2], [0, 0, 1], 0);
  const { data } = render(7, 0.16, ps);
  const flipped = new Uint8ClampedArray(data.length);
  for (let v = 0; v < H; v++) flipped.set(data.subarray(v * W * 4, (v + 1) * W * 4), (H - 1 - v) * W * 4);
  const det = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12', maxHammingDistance: 3 });
  assert.equal(det.detect({ width: W, height: H, data: flipped }).length, 0);
});

test('exact corners from exact projections', () => {
  const ps = pose([0.3, -0.2, -2], [0.3, 0.4, 1], 1.1);
  const h = 0.1;
  const truth = [[-h, h], [h, h], [h, -h], [-h, -h]].map(([x, y]) => ps.t.map((tv, k) => tv + x * ps.ex[k] + y * ps.ey[k]));
  const nc = truth.map((p) => [p[0] / -p[2], p[1] / -p[2]]);
  const r = markerCornersInView(nc, 0.2);
  r.corners.forEach((p, i) => assert.ok(Math.hypot(...sub(p, truth[i])) < 1e-9));
});
