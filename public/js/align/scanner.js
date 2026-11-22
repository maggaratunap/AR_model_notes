// Printed-marker scanner for Android (Chrome WebXR "camera-access").
//
// A few times a second it copies the AR camera image (downscaled) out of the GPU, a worker
// finds ArUco markers in it, and each marker's 3D corners are worked out from its printed
// size and stored in world space. Several frames, ideally from slightly different spots,
// are median-filtered into one stable estimate per marker.
//
// Camera images never leave the device; only marker IDs and corner positions are used.
import { markerCornersInView, pixelToNormalized, transformPoint } from './markerpose.js';
import { medianPoint } from './solver.js';

const MAX_DIM = 1024;       // longest side of the image the detector sees
const INTERVAL = 130;       // ms between grabs
const WINDOW = 6000;        // ms of observations kept per marker
const MAX_OBS = 45;
export const GATES = { minSidePx: 50, maxDist: 2.5, minCos: Math.cos((60 * Math.PI) / 180) };

const VS = `#version 300 es
out vec2 v;
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); v = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
// Row 0 of readPixels is the bottom of the target; sample the camera image upside down so
// the buffer comes out top row first, like an ImageData.
const FS = `#version 300 es
precision mediump float;
in vec2 v; uniform sampler2D cam; out vec4 o;
void main() { o = texture(cam, vec2(v.x, 1.0 - v.y)); }`;

export class MarkerScanner {
  static available(session) {
    return typeof XRWebGLBinding !== 'undefined' && !!session.enabledFeatures?.includes('camera-access');
  }

  constructor(renderer, size) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.size = size;
    this.obs = new Map();
    this.flip = false; this.flipLocked = false;
    this.busy = false; this.last = 0; this.seq = 0;
    this.pool = [];
    this.stats = { grabs: 0, ms: 0, lastSeen: 0 };
    this.failed = false;
  }

  start(session) {
    try {
      this.binding = new XRWebGLBinding(session, this.gl);
      this.worker = new Worker('/js/align/marker-worker.js');
      this.worker.onmessage = (e) => this.onResult(e.data);
      this.worker.onerror = (e) => { console.warn('marker worker failed', e.message); this.failed = true; };
      return true;
    } catch (err) {
      console.warn('camera access unavailable', err);
      return false;
    }
  }

  stop() {
    this.worker?.terminate();
    const gl = this.gl;
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.prog) gl.deleteProgram(this.prog);
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.fbo = this.tex = this.prog = this.vao = null;
  }

  setup(w, h) {
    const gl = this.gl;
    if (!this.prog) {
      const sh = (type, src) => {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      this.prog = p;
      this.uCam = gl.getUniformLocation(p, 'cam');
      this.vao = gl.createVertexArray();
    }
    if (this.w !== w || this.h !== h) {
      if (this.tex) gl.deleteTexture(this.tex);
      if (this.fbo) gl.deleteFramebuffer(this.fbo);
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
      this.w = w; this.h = h;
      this.pool = [];
    }
  }

  /** Call once per XR frame, before rendering. */
  update(frame, ref, now) {
    if (this.busy || this.failed || !this.binding || now - this.last < INTERVAL) return;
    const pose = frame.getViewerPose(ref);
    const view = pose?.views.find((v) => v.camera);
    if (!view) return;
    const gl = this.gl;
    try {
      const camTex = this.binding.getCameraImage(view.camera);
      if (!camTex) return;
      const k = Math.min(1, MAX_DIM / Math.max(view.camera.width, view.camera.height));
      const w = Math.round(view.camera.width * k), h = Math.round(view.camera.height * k);
      this.setup(w, h);
      const buf = this.pool.pop() || new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, w, h);
      for (const cap of [gl.DEPTH_TEST, gl.BLEND, gl.SCISSOR_TEST, gl.CULL_FACE, gl.STENCIL_TEST]) gl.disable(cap);
      gl.colorMask(true, true, true, true);
      gl.useProgram(this.prog);
      gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, camTex);
      gl.uniform1i(this.uCam, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      gl.bindVertexArray(null);
      this.meta = { seq: ++this.seq, w, h, view: Array.from(view.transform.matrix), proj: Array.from(view.projectionMatrix), t: now };
      this.busy = true; this.last = now; this.stats.grabs++;
      this.worker.postMessage({ seq: this.seq, width: w, height: h, buffer: buf.buffer, flip: this.flip, tryOther: !this.flipLocked }, [buf.buffer]);
    } catch (err) {
      console.warn('camera grab failed', err);
      this.failed = true;
    } finally {
      this.renderer.resetState(); // three.js must not trust its cached GL state after raw calls
    }
  }

  onResult(r) {
    this.busy = false;
    const meta = this.meta;
    if (r.buffer && meta && r.buffer.byteLength === meta.w * meta.h * 4) this.pool.push(new Uint8Array(r.buffer));
    this.stats.ms = r.ms;
    if (!meta || r.seq !== meta.seq) return;
    if (r.markers.length) { this.flip = r.flip; this.flipLocked = true; }
    for (const m of r.markers) {
      const c = m.corners;
      const side = Math.min(...c.map((p, i) => Math.hypot(p[0] - c[(i + 1) % 4][0], p[1] - c[(i + 1) % 4][1])));
      this.stats.lastSeen = meta.t;
      const entry = this.obs.get(m.id) || [];
      this.obs.set(m.id, entry);
      entry.seenAt = meta.t;
      if (side < GATES.minSidePx) { entry.tooFar = meta.t; continue; }
      const size = this.sizeFor ? this.sizeFor(m.id) : this.size;
      const res = markerCornersInView(c.map(([x, y]) => pixelToNormalized(x, y, meta.w, meta.h, meta.proj)), size);
      if (!res || res.distance > GATES.maxDist) { entry.tooFar = meta.t; continue; }
      const cosA = -(res.normal[0] * res.center[0] + res.normal[1] * res.center[1] + res.normal[2] * res.center[2]) / res.distance;
      if (cosA < GATES.minCos) { entry.tooOblique = meta.t; continue; }
      entry.push({ t: meta.t, w: res.corners.map((p) => transformPoint(meta.view, p)), dist: res.distance });
      while (entry.length > MAX_OBS) entry.shift();
    }
  }

  /** Stable world-space corners for one marker, or null if not enough recent sightings. */
  estimate(id, now, minObs = 6) {
    const all = this.obs.get(id);
    if (!all) return null;
    const list = all.filter((o) => now - o.t < WINDOW);
    if (list.length < minObs) return null;
    const corners = [0, 1, 2, 3].map((k) => medianPoint(list.map((o) => o.w[k])));
    const dists = list.map((o) => o.dist).sort((a, b) => a - b);
    return {
      id, n: list.length,
      w: corners.map((c) => c.p),
      spread: Math.max(...corners.map((c) => c.spread)),
      dist: dists[dists.length >> 1],
      last: Math.max(...list.map((o) => o.t)),
    };
  }

  /** IDs seen recently, with why they are not being used if they aren't. */
  seen(now, within = 800) {
    const out = [];
    for (const [id, e] of this.obs) {
      if (!e.seenAt || now - e.seenAt > within) continue;
      const usable = e.length && now - e[e.length - 1].t < within;
      out.push({ id, usable, tooFar: !usable && now - (e.tooFar || 0) < within, tooOblique: !usable && now - (e.tooOblique || 0) < within });
    }
    return out.sort((a, b) => a.id - b.id);
  }
}
