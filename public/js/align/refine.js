// Sub-pixel corner refinement for square markers. js-aruco2 returns corners on whole
// pixels, which at 60 px marker size is a few percent of error in depth and tilt. Here each
// side is re-located from the image gradient at many points along it, a straight line is
// fitted to them, and the corners become the intersections of neighbouring lines.
//
// Classic script (no modules) so the detection worker can importScripts() it; Node tests
// load it with vm.
var MarkerRefine = (function () {
  function sample(img, x, y) {
    var w = img.width, h = img.height, d = img.data;
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return -1;
    var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + w] * (1 - fx) + d[i + w + 1] * fx) * fy;
  }

  // Strongest intensity step along the normal through (px, py), to sub-pixel precision.
  function edgePoint(img, px, py, nx, ny, r) {
    var step = 0.5, n = Math.ceil(r / step), prev = sample(img, px - nx * (n + 1) * step, py - ny * (n + 1) * step);
    var best = -1, bestK = 0, grads = [];
    for (var k = -n; k <= n + 1; k++) {
      var v = sample(img, px + nx * k * step, py + ny * k * step);
      if (v < 0 || prev < 0) return null;
      var g = Math.abs(v - prev);
      grads.push(g);
      if (g > best) { best = g; bestK = grads.length - 1; }
      prev = v;
    }
    if (best < 12 || bestK === 0 || bestK === grads.length - 1) return null;
    var a = grads[bestK - 1], b = grads[bestK], c = grads[bestK + 1];
    var den = a - 2 * b + c;
    var off = den !== 0 ? 0.5 * (a - c) / den : 0;
    // grads[j] is the step between samples (j - n - 1) and (j - n); its centre is at j - n - 0.5
    var t = (bestK + off - n - 0.5) * step;
    return [px + nx * t, py + ny * t];
  }

  // Total-least-squares line through points: returns {cx, cy, dx, dy}.
  function fitLine(pts) {
    var cx = 0, cy = 0, i;
    for (i = 0; i < pts.length; i++) { cx += pts[i][0]; cy += pts[i][1]; }
    cx /= pts.length; cy /= pts.length;
    var sxx = 0, sxy = 0, syy = 0;
    for (i = 0; i < pts.length; i++) {
      var dx = pts[i][0] - cx, dy = pts[i][1] - cy;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    var ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { cx: cx, cy: cy, dx: Math.cos(ang), dy: Math.sin(ang) };
  }

  function intersect(l1, l2) {
    var den = l1.dx * l2.dy - l1.dy * l2.dx;
    if (Math.abs(den) < 1e-9) return null;
    var t = ((l2.cx - l1.cx) * l2.dy - (l2.cy - l1.cy) * l2.dx) / den;
    return [l1.cx + l1.dx * t, l1.cy + l1.dy * t];
  }

  /**
   * @param {{width:number,height:number,data:ArrayLike<number>}} img  greyscale, one byte per pixel
   * @param {number[][]} corners  4 × [x, y] approximate corners (pixels)
   * @returns {number[][]} refined corners (falls back to the input for any corner it can't improve)
   */
  function refineCorners(img, corners) {
    var lines = [];
    for (var s = 0; s < 4; s++) {
      var a = corners[s], b = corners[(s + 1) % 4];
      var ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey);
      if (L < 12) return corners;
      var nx = -ey / L, ny = ex / L, r = Math.max(1.5, Math.min(4, L * 0.07));
      var count = Math.max(6, Math.min(40, Math.round(L / 2))), pts = [];
      for (var k = 0; k < count; k++) {
        var t = 0.12 + 0.76 * (k / (count - 1));
        var p = edgePoint(img, a[0] + ex * t, a[1] + ey * t, nx, ny, r);
        if (p) pts.push(p);
      }
      if (pts.length < 5) return corners;
      lines.push(fitLine(pts));
    }
    var out = [];
    for (var i = 0; i < 4; i++) {
      var q = intersect(lines[(i + 3) % 4], lines[i]);
      out.push(q && Math.hypot(q[0] - corners[i][0], q[1] - corners[i][1]) < 3 ? q : corners[i].slice());
    }
    return out;
  }

  return { refineCorners: refineCorners };
})();
