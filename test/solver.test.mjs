// npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve, evaluate, applySolution, medianPoint } from '../public/js/align/solver.js';

const truth = { yaw: 0.7312, t: [12.5, -0.03, -4.2] };
const model = [
  [0, 0, 0], [18.3, 0, 0.4], [18, 0, 24.1], [-0.2, 0, 23.8], [9, 0.9, 12], // last one is on a step
];
const noise = (s) => (Math.random() * 2 - 1) * s;
const pairsFrom = (pts, n = 0) => pts.map((m, i) => {
  const w = applySolution(truth, m);
  return { id: `p${i}`, name: `P${i + 1}`, m, w: [w[0] + noise(n), w[1] + noise(n), w[2] + noise(n)] };
});

test('recovers exact yaw and translation from 2 clean points', () => {
  const s = solve(pairsFrom(model.slice(0, 2)));
  assert.ok(Math.abs(s.yaw - truth.yaw) < 1e-9);
  s.t.forEach((v, k) => assert.ok(Math.abs(v - truth.t[k]) < 1e-9));
});

test('handles yaw near ±180°', () => {
  const t2 = { yaw: Math.PI - 0.001, t: [1, 0, 2] };
  const pairs = model.map((m, i) => ({ id: `${i}`, name: `${i}`, m, w: applySolution(t2, m) }));
  const s = solve(pairs);
  const d = Math.atan2(Math.sin(s.yaw - t2.yaw), Math.cos(s.yaw - t2.yaw));
  assert.ok(Math.abs(d) < 1e-9);
});

test('noisy taps (±1.5 cm) give a good grade and a cm-level estimate', () => {
  const ev = evaluate(pairsFrom(model.slice(0, 4), 0.015), 30);
  assert.equal(ev.grade, 'good');
  assert.ok(ev.estimate < 0.03, `estimate ${ev.estimate}`);
  assert.equal(ev.suspect, null);
});

test('one wrong tap (50 cm off) is flagged as the suspect and grade is poor', () => {
  const pairs = pairsFrom(model.slice(0, 4), 0.01);
  pairs[2].w[0] += 0.5;
  const ev = evaluate(pairs, 30);
  assert.equal(ev.suspect, 'p2');
  assert.equal(ev.grade, 'poor');
});

test('millimetre-exported model trips the scale warning', () => {
  const pairs = pairsFrom(model.slice(0, 3)).map((p) => ({ ...p, m: p.m.map((v) => v * 1.1) }));
  const ev = evaluate(pairs, 30);
  assert.ok(ev.warnings.some((w) => /longer|shorter/.test(w)));
});

test('two points close together warn about spread and never grade good', () => {
  const ev = evaluate(pairsFrom([[0, 0, 0], [1.5, 0, 0]]), 30);
  assert.ok(ev.warnings.some((w) => /apart/.test(w)));
  assert.notEqual(ev.grade, 'good');
});

test('height mismatch warns', () => {
  const pairs = pairsFrom(model.slice(0, 3));
  pairs[1].w[1] += 0.2;
  assert.ok(evaluate(pairs).warnings.some((w) => /Heights/.test(w)));
});

test('median sampling ignores a stray hit', () => {
  const samples = [[1, 0, 1], [1.002, 0, 0.999], [0.998, 0.001, 1.001], [1.001, 0, 1], [3, 1, 3]];
  const { p } = medianPoint(samples);
  assert.ok(Math.hypot(p[0] - 1, p[1], p[2] - 1) < 0.003);
});
