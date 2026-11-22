// Square-marker geometry: from four detected image corners and the printed size, recover
// where the marker's corners are in 3D. Pure math, no three.js, so Node can test it.
//
// Conventions
//  * View space is WebXR / three.js: x right, y up, camera looks down -Z.
//  * "Normalised" image coordinates are xn = X / -Z, yn = Y / -Z (y up).
//  * Corners are ordered as printed: top-left, top-right, bottom-right, bottom-left
//    (js-aruco2 returns them in this order, clockwise on screen).

/** Solve A x = b (n×n) with partial pivoting. Returns null if singular. */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Homography (row-major 3×3, h33 = 1) mapping 4 source points onto 4 destination points. */
export function homography4(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solveLinear(A, b);
  return h ? [...h, 1] : null;
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

/** Nearest rotation to a 3×3 matrix given as columns (polar decomposition by iteration). */
function orthonormalize(cols) {
  let m = [[cols[0][0], cols[1][0], cols[2][0]], [cols[0][1], cols[1][1], cols[2][1]], [cols[0][2], cols[1][2], cols[2][2]]];
  for (let it = 0; it < 12; it++) {
    const [a, b, c] = m;
    const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    if (Math.abs(det) < 1e-12) return null;
    // inverse transpose = cofactor / det
    const cof = [
      [(b[1] * c[2] - b[2] * c[1]), -(b[0] * c[2] - b[2] * c[0]), (b[0] * c[1] - b[1] * c[0])],
      [-(a[1] * c[2] - a[2] * c[1]), (a[0] * c[2] - a[2] * c[0]), -(a[0] * c[1] - a[1] * c[0])],
      [(a[1] * b[2] - a[2] * b[1]), -(a[0] * b[2] - a[2] * b[0]), (a[0] * b[1] - a[1] * b[0])],
    ];
    m = m.map((row, i) => row.map((v, j) => 0.5 * (v + cof[i][j] / det)));
  }
  return [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]]; // columns
}

/**
 * 3D corners of a square marker of side `size` (metres) seen at normalised image corners `nc`.
 * @param {number[][]} nc  4 × [xn, yn], ordered TL, TR, BR, BL
 * @returns {{corners:number[][], center:number[], normal:number[], distance:number}|null}  view-space metres
 */
export function markerCornersInView(nc, size) {
  const h = size / 2;
  const src = [[-h, h], [h, h], [h, -h], [-h, -h]]; // marker frame: x right, y up, z out of the face
  const H = homography4(src, nc);
  if (!H) return null;
  // H ~ [r1' r2' t'] in the flipped frame (X, Y, -Z), where the image is (x, y) = (X, Y) / -Z.
  const h1 = [H[0], H[3], H[6]], h2 = [H[1], H[4], H[7]], h3 = [H[2], H[5], H[8]];
  let lam = 2 / (norm(h1) + norm(h2));
  if (h3[2] * lam < 0) lam = -lam; // the marker must be in front of the camera
  const F = (v) => [v[0] * lam, v[1] * lam, -v[2] * lam]; // back to view space (z flips)
  const r1 = F(h1), r2 = F(h2), t = F(h3);
  if (t[2] >= 0) return null;
  const R = orthonormalize([r1, r2, cross(r1, r2)]);
  if (!R) return null;
  const corners = src.map(([x, y]) => [0, 1, 2].map((k) => R[0][k] * x + R[1][k] * y + t[k]));
  return { corners, center: t, normal: R[2], distance: norm(t) };
}

/** Image pixel (top-left origin) -> normalised coords, using a WebXR projection matrix (column-major). */
export function pixelToNormalized(px, py, width, height, P) {
  const ndcX = (2 * px) / width - 1;
  const ndcY = 1 - (2 * py) / height;
  return [(ndcX + P[8]) / P[0], (ndcY + P[9]) / P[5]];
}

/** Apply a column-major 4×4 matrix to a point. */
export function transformPoint(M, p) {
  return [
    M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12],
    M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13],
    M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14],
  ];
}
