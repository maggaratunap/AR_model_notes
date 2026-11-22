// Marker detection off the main thread. Receives RGBA camera frames, returns ArUco
// markers (ARUCO_MIP_36h12) with sub-pixel corners in pixel-edge coordinates.
/* global AR, MarkerRefine */
importScripts('/vendor/aruco/cv.js', '/vendor/aruco/aruco.js', '/js/align/refine.js');

// 36h12 codes differ in at least 12 bits; accepting up to 3 bit errors keeps false IDs out.
var detector = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12', maxHammingDistance: 3 });

function flipRows(src, w, h) {
  var out = new Uint8ClampedArray(src.length), row = w * 4;
  for (var y = 0; y < h; y++) out.set(src.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
  return out;
}

function run(data, w, h) {
  var found = detector.detect({ width: w, height: h, data: data });
  return found.map(function (m) {
    var raw = m.corners.map(function (c) { return [c.x, c.y]; });
    var ref = MarkerRefine.refineCorners(detector.grey, raw);
    return { id: m.id, hd: m.hammingDistance, corners: ref.map(function (c) { return [c[0] + 0.5, c[1] + 0.5]; }) };
  });
}

self.onmessage = function (e) {
  var msg = e.data, t0 = performance.now();
  var data = new Uint8ClampedArray(msg.buffer);
  // The camera texture's row order is not pinned down by the spec. A vertically flipped
  // image shows mirrored markers, which never decode, so trying the other order is safe.
  var flip = !!msg.flip;
  var markers = run(flip ? flipRows(data, msg.width, msg.height) : data, msg.width, msg.height);
  if (!markers.length && msg.tryOther) {
    var other = run(flip ? data : flipRows(data, msg.width, msg.height), msg.width, msg.height);
    if (other.length) { markers = other; flip = !flip; }
  }
  self.postMessage({ seq: msg.seq, flip: flip, markers: markers, ms: performance.now() - t0, buffer: msg.buffer }, [msg.buffer]);
};
