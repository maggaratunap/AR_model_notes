// Control-point registration for site alignment.
//
// Both sides already agree on which way is up: a WebXR floor space is levelled by the
// device's IMU, and glTF is Y-up. So only four numbers are unknown: the yaw (rotation
// about the vertical) and a 3D translation. Not estimating roll, pitch or scale keeps the
// fit stable with as few as two points and means one bad tap cannot tilt the building.
//
// Pure math, no three.js, so it can be unit tested in Node.

/** Rotate [x, y, z] about +Y by `yaw` (same convention as three.js Object3D.rotation.y). */
export function rotY(yaw, p) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]];
}

/** Model point -> world point for a solution {yaw, t}. */
export function applySolution(sol, p) {
  const r = rotY(sol.yaw, p);
  return [r[0] + sol.t[0], r[1] + sol.t[1], r[2] + sol.t[2]];
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const hlen = (a) => Math.hypot(a[0], a[2]);

/**
 * Least-squares yaw + translation from point pairs.
 * @param {{m:number[], w:number[], weight?:number}[]} pairs  m = model coords, w = measured world coords
 * @returns {{yaw:number, t:number[]}|null}
 */
export function solve(pairs) {
  if (!pairs || pairs.length < 2) return null;
  let W = 0;
  const mc = [0, 0, 0], wc = [0, 0, 0];
  for (const { m, w, weight = 1 } of pairs) {
    W += weight;
    for (let k = 0; k < 3; k++) { mc[k] += m[k] * weight; wc[k] += w[k] * weight; }
  }
  for (let k = 0; k < 3; k++) { mc[k] /= W; wc[k] /= W; }
  // Closed-form 2D Procrustes on the floor plane (x, z).
  let C = 0, S = 0;
  for (const { m, w, weight = 1 } of pairs) {
    const ax = m[0] - mc[0], az = m[2] - mc[2];
    const bx = w[0] - wc[0], bz = w[2] - wc[2];
    C += weight * (ax * bx + az * bz);
    S += weight * (az * bx - ax * bz);
  }
  if (Math.abs(C) < 1e-12 && Math.abs(S) < 1e-12) return null; // all points on top of each other
  const yaw = Math.atan2(S, C);
  const r = rotY(yaw, mc);
  return { yaw, t: [wc[0] - r[0], wc[1] - r[1], wc[2] - r[2]] };
}

/** Component-wise median of a list of [x, y, z] samples, plus how much they scattered. */
export function medianPoint(samples) {
  if (!samples.length) return null;
  const med = (k) => {
    const v = samples.map((s) => s[k]).sort((a, b) => a - b);
    const h = v.length >> 1;
    return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
  };
  const p = [med(0), med(1), med(2)];
  const d = samples.map((s) => len(sub(s, p))).sort((a, b) => a - b);
  const spread = d[Math.min(d.length - 1, Math.floor(d.length * 0.8))]; // 80th percentile distance
  return { p, spread };
}

export const GRADE = { good: 0.03, ok: 0.08 }; // metres

/**
 * Solve and judge the fit. Everything here is what the person sees before they trust the overlay.
 * @param {{id:string, name:string, m:number[], w:number[]}[]} pairs
 * @param {number} [modelExtent] longest horizontal size of the model, for the far-corner error estimate
 */
export function evaluate(pairs, modelExtent = 0) {
  const n = pairs.length;
  const sol = solve(pairs);
  if (!sol) return null;

  const points = pairs.map((pr) => {
    const e = sub(applySolution(sol, pr.m), pr.w);
    return { id: pr.id, name: pr.name, err: len(e), h: hlen(e), v: Math.abs(e[1]), loo: null };
  });

  // Leave-one-out: fit without point i and see how far off point i lands. With 3+ points this
  // is an honest estimate of the error at a spot the fit was not tuned to.
  if (n >= 3) {
    pairs.forEach((pr, i) => {
      const s = solve(pairs.filter((_, j) => j !== i));
      points[i].loo = s ? len(sub(applySolution(s, pr.m), pr.w)) : null;
    });
  }

  // Pairwise horizontal distances: the tape-measure check. Model vs measured should match.
  let spread = 0, dm2 = 0, dmdw = 0, worstDist = { diff: 0, a: null, b: null };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dm = hlen(sub(pairs[i].m, pairs[j].m));
      const dw = hlen(sub(pairs[i].w, pairs[j].w));
      spread = Math.max(spread, dm);
      dm2 += dm * dm; dmdw += dm * dw;
      const diff = Math.abs(dw - dm);
      if (diff > worstDist.diff) worstDist = { diff, a: pairs[i].name, b: pairs[j].name };
    }
  }
  const scale = dm2 > 0 ? dmdw / dm2 : 1;

  const rms = Math.sqrt(points.reduce((a, p) => a + p.err * p.err, 0) / n);
  // Headline number: leave-one-out RMS with 3+ points; with 2 points the only check is
  // whether the two measured points are the same distance apart as in the model.
  const estimate = n >= 3
    ? Math.sqrt(points.reduce((a, p) => a + (p.loo ?? p.err) ** 2, 0) / n)
    : worstDist.diff;
  // Yaw uncertainty grows error linearly with distance from the points' centroid.
  const yawErr = spread > 0 ? Math.max(estimate, 0.01) / spread : 0;
  const farError = estimate + yawErr * Math.max(0, modelExtent / 2);

  const warnings = [];
  if (n === 2) warnings.push('Only 2 points: the fit cannot check itself. Add a 3rd point for a real error estimate.');
  if (spread < 3) warnings.push(`Points are only ${spread.toFixed(1)} m apart. Small tap errors turn into large errors across the building. Use points at least 5 m apart.`);
  if (spread > 2 && Math.abs(scale - 1) > 0.03) {
    warnings.push(`Measured distances are ${((scale - 1) * 100).toFixed(1)}% ${scale > 1 ? 'longer' : 'shorter'} than in the model. Check the model units, or that each tap was on the right feature.`);
  }
  // Outlier: the one point whose removal makes all the others agree with each other.
  let suspect = null;
  if (n >= 3) {
    const subsets = pairs.map((_, i) => {
      const rest = pairs.filter((__, j) => j !== i);
      const s = solve(rest);
      const r = s ? Math.sqrt(rest.reduce((a, pr) => a + len(sub(applySolution(s, pr.m), pr.w)) ** 2, 0) / rest.length) : Infinity;
      return { i, rms: r };
    }).sort((a, b) => a.rms - b.rms);
    const best = subsets[0], next = subsets[1];
    const p = points[best.i];
    if (p.loo > 0.1 && p.loo > 3 * Math.max(best.rms, 0.01) && next.rms > 2.5 * Math.max(best.rms, 0.005)) {
      suspect = p.id;
      warnings.push(`“${p.name}” disagrees with the other points by ${(p.loo * 100).toFixed(0)} cm. Re-tap it or skip it.`);
    }
  }
  const maxV = Math.max(...points.map((p) => p.v));
  if (maxV > 0.08) warnings.push(`Heights disagree by up to ${(maxV * 100).toFixed(0)} cm. Was a tap on top of an object instead of the floor?`);

  let grade = estimate <= GRADE.good && !suspect ? 'good' : estimate <= GRADE.ok && !suspect ? 'ok' : 'poor';
  // Two points can't reveal a mistake on their own, so never call that fit "good".
  if (n === 2 && grade === 'good') grade = 'ok';
  // Clustered points can agree with each other and still be badly rotated across the building.
  if (spread < 3 && grade === 'good') grade = 'ok';
  return { sol, n, points, rms, estimate, farError, spread, scale, grade, warnings, suspect };
}
