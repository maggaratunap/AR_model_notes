// Site alignment: line a 1:1 building model up with the real building.
//
// Method (cheap, reliable, private):
//   1. Once, on a desktop, mark 3-4 control points on the model: sharp floor-level corners.
//   2. On site, in WebXR AR, aim at each real corner and tap. The device's own hit test
//      (ARCore on Android, depth sensing on Quest 3) gives the 3D position; ~0.3 s of samples
//      are median-filtered per tap.
//   3. A yaw + translation least-squares fit (gravity is known, scale is fixed at 1:1)
//      places the model, and leave-one-out residuals tell you how far off it is.
//   4. Lock creates a WebXR anchor so tracking corrections carry the model with them. On
//      Quest the anchor is saved, so next time in the same room the model snaps back in
//      place with no taps at all.
// Nothing leaves the device except the control point file you choose to save. No camera
// frames are read or uploaded.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { makeLabelSprite } from '../notes.js';
import { evaluate, medianPoint } from './solver.js';
import { AlignPanel } from './panel.js';
import { MarkerScanner } from './scanner.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const $ = (id) => document.getElementById(id);
const UA = navigator.userAgent;
const IS_HEADSET = /OculusBrowser|Quest|Pico|Wolvic/i.test(UA);
const IS_IOS = /iPhone|iPad/.test(UA) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(UA));
const ROOM_RE = /^[A-Z0-9]{4,12}$/;
const params = new URLSearchParams(location.search);
const ROOM = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const SAMPLE_TARGET = 12;   // hit-test samples per tap
const SAMPLE_MAX_FRAMES = 45;
const OPACITY_STEPS = [0.85, 0.55, 0.3, 0];
const cm = (m) => `${(m * 100).toFixed(m < 0.1 ? 1 : 0)} cm`;
const uid = () => (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const S = {
  room: ROOM_RE.test(ROOM) ? ROOM : null,
  model: null,          // { root, name, size, version, offset:[x,y,z], extent, dims }
  site: emptySite(),
  selected: null,
  addMode: false,
  snap: true,
  xr: null,
  opacity: OPACITY_STEPS[1],
  loadToken: 0,
};

function emptySite() {
  return { format: 'model-notes-align', version: 1, name: '', model: null, points: [], markerSize: 0.15, markers: {}, updated: 0 };
}

// ---------------------------------------------------------------- scene
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.xr.enabled = true;

const scene = new THREE.Scene();
const BG = new THREE.Color(0x15171c);
scene.background = BG;
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 2000);
camera.position.set(20, 18, 24);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;
scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 0.35));
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(30, 60, 40);
scene.add(sun);

// stage = model -> world transform (identity on desktop, the solved alignment in AR)
const stage = new THREE.Group();
const modelHolder = new THREE.Group();
const markers = new THREE.Group();
stage.add(modelHolder, markers);
scene.add(stage);
const pins = new THREE.Group();     // AR taps, world space
scene.add(pins);
const grid = new THREE.GridHelper(1, 20, 0x5d626c, 0x30343b);
grid.material.transparent = true; grid.material.opacity = 0.5;
scene.add(grid);

const reticle = (() => {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xffd447, depthTest: false, transparent: true });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.035, 0.045, 40).rotateX(-Math.PI / 2), mat);
  const bar = new THREE.BoxGeometry(0.11, 0.001, 0.003);
  const a = new THREE.Mesh(bar, mat), b = new THREE.Mesh(bar, mat);
  b.rotation.y = Math.PI / 2;
  g.add(ring, a, b);
  g.traverse((o) => { o.renderOrder = 999; });
  g.matrixAutoUpdate = false;
  g.visible = false;
  return g;
})();
scene.add(reticle);

const hoverDot = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffd447, depthTest: false, transparent: true, opacity: 0.85 }));
hoverDot.renderOrder = 998;
hoverDot.visible = false;
scene.add(hoverDot);

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(new DRACOLoader().setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/'));
gltfLoader.setKTX2Loader(new KTX2Loader().setTranscoderPath('/vendor/three/examples/jsm/libs/basis/').detectSupport(renderer));
gltfLoader.setMeshoptDecoder(MeshoptDecoder);

const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;

// ---------------------------------------------------------------- small UI helpers
function toast(msg, err = false) {
  // In AR the page's toasts aren't visible (phone overlay shows only #ar; Quest has no DOM),
  // so messages also go into the AR card.
  if (S.xr) S.xr.note = { msg, until: performance.now() + (err ? 7000 : 4500) };
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('toasts').append(el);
  setTimeout(() => el.remove(), err ? 6000 : 3500);
}
function showLoading(frac, text) {
  $('loading').hidden = frac == null;
  if (frac == null) return;
  $('loading-bar').style.width = `${Math.round(frac * 100)}%`;
  if (text) $('loading-text').textContent = text;
}

// ---------------------------------------------------------------- model loading
function disposeObject(root) {
  root.traverse((o) => {
    if (o.geometry) { o.geometry.disposeBoundsTree?.(); o.geometry.dispose(); }
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { for (const v of Object.values(m)) if (v?.isTexture) v.dispose(); m.dispose(); }
  });
}

/**
 * Shift the model so its footprint centre sits at the origin (internal coordinates =
 * model coordinates - offset). BIM exports often sit kilometres from the origin; float32
 * vertex positions that large jitter by centimetres, so in that case bake the shift into
 * the vertices themselves.
 */
function recenter(root, o) {
  let big = false;
  root.traverse((m) => {
    if (!m.isMesh || big) return;
    m.geometry.computeBoundingBox();
    const b = m.geometry.boundingBox;
    if (Math.max(Math.abs(b.min.x), Math.abs(b.max.x), Math.abs(b.min.y), Math.abs(b.max.y), Math.abs(b.min.z), Math.abs(b.max.z)) > 1000) big = true;
  });
  const shift = new THREE.Matrix4().makeTranslation(-o[0], -o[1], -o[2]);
  if (!big) {
    const wrap = new THREE.Group();
    wrap.add(root);
    wrap.applyMatrix4(shift);
    wrap.updateMatrixWorld(true);
    return wrap;
  }
  const meshes = [];
  const uses = new Map();
  root.traverse((m) => { if (m.isMesh) { meshes.push(m); uses.set(m.geometry, (uses.get(m.geometry) || 0) + 1); } });
  const flat = new THREE.Group();
  const im = new THREE.Matrix4();
  for (const m of meshes) {
    const M = shift.clone().multiply(m.matrixWorld);
    if (m.isInstancedMesh) {
      for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, im); im.premultiply(M); m.setMatrixAt(i, im); }
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere(); m.computeBoundingBox?.();
    } else {
      const g = uses.get(m.geometry) > 1 ? m.geometry.clone() : m.geometry;
      g.applyMatrix4(M);
      m.geometry = g;
    }
    m.position.set(0, 0, 0); m.quaternion.identity(); m.scale.set(1, 1, 1);
    flat.add(m);
  }
  flat.updateMatrixWorld(true);
  return flat;
}

async function loadModel(src) {
  const token = ++S.loadToken;
  showLoading(0, `Loading ${src.name}…`);
  try {
    const gltf = src.file
      ? await gltfLoader.parseAsync(await src.file.arrayBuffer(), '')
      : await gltfLoader.loadAsync(src.url, (e) => e.total && showLoading(e.loaded / e.total, `Loading ${src.name}… ${Math.round((e.loaded / e.total) * 100)}%`));
    if (token !== S.loadToken) { disposeObject(gltf.scene); return; }
    gltf.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    if (box.isEmpty()) throw new Error('the file has no visible geometry');
    const c = box.getCenter(new THREE.Vector3());
    const offset = [c.x, box.min.y, c.z];
    const root = recenter(gltf.scene, offset);
    root.traverse((o) => {
      if (o.isMesh && !o.isInstancedMesh && o.geometry?.attributes.position) o.geometry.computeBoundsTree();
      if (o.isMesh) for (const m of [].concat(o.material)) m.userData.baseOpacity ??= m.opacity;
    });
    if (S.model) { modelHolder.remove(S.model.root); disposeObject(S.model.root); }
    modelHolder.add(root);
    const dims = box.getSize(new THREE.Vector3());
    S.model = { root, name: src.name, size: src.size || 0, version: src.version || null, offset, dims, extent: Math.max(dims.x, dims.z) };
    $('empty').hidden = true;
    $('model-name').textContent = src.name;
    showLoading(null);
    renderModelInfo();
    frameCamera();
    await loadSiteFor(src);
    refreshXRButton();
  } catch (err) {
    if (token !== S.loadToken) return;
    console.error(err);
    showLoading(null);
    toast(`Could not load the model: ${err.message || err}`, true);
  }
}

function renderModelInfo() {
  const m = S.model, el = $('model-info');
  el.textContent = '';
  if (!m) return;
  const d = m.dims;
  const line = document.createElement('div');
  line.textContent = `Model size ${d.x.toFixed(1)} × ${d.z.toFixed(1)} m, ${d.y.toFixed(1)} m tall (glTF is metres).`;
  el.append(line);
  const warn = (t) => { const w = document.createElement('div'); w.className = 'warn'; w.textContent = t; el.append(w); };
  if (Math.max(d.x, d.y, d.z) > 2000) warn('This looks like a model exported in millimetres. Re-export in metres, or the alignment will be 1000× off.');
  else if (Math.max(d.x, d.y, d.z) < 1) warn('This model is under 1 m across. Check the export units (feet or inches?).');
  if (Math.hypot(...m.offset) > 1000) {
    const o = document.createElement('div');
    o.textContent = `Model sits ${(Math.hypot(...m.offset) / 1000).toFixed(1)} km from its origin (survey coordinates). Recentred internally for precision; point coordinates stay in model units.`;
    el.append(o);
  }
}

function frameCamera() {
  const m = S.model; if (!m) return;
  const r = Math.max(m.extent, m.dims.y, 2);
  const k = 1 / Math.min(1, camera.aspect); // portrait screens need to back off
  controls.target.set(0, m.dims.y * 0.25, 0);
  camera.position.set(r * 0.75 * k, r * 0.7 * k, r * 0.95 * k);
  camera.near = Math.max(0.02, r / 2000);
  camera.far = Math.max(500, r * 20);
  camera.updateProjectionMatrix();
  grid.scale.setScalar(Math.ceil(r * 1.4));
  controls.maxDistance = r * 6;
  controls.update();
  layoutMarkers();
}

// ---------------------------------------------------------------- site (control points)
const toInternal = (p) => [p[0] - S.model.offset[0], p[1] - S.model.offset[1], p[2] - S.model.offset[2]];
const toModel = (v) => [v.x + S.model.offset[0], v.y + S.model.offset[1], v.z + S.model.offset[2]];
const r4 = (x) => Math.round(x * 1e4) / 1e4;

function siteKey() {
  return S.room ? `room:${S.room}` : `model:${S.model?.name}:${S.model?.size}`;
}

function cleanSite(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.points)) throw new Error('not a control point file');
  const site = emptySite();
  site.name = String(raw.name || '').slice(0, 120);
  site.model = raw.model && typeof raw.model === 'object'
    ? { name: String(raw.model.name || '').slice(0, 200), size: Number(raw.model.size) || 0, version: raw.model.version ?? null }
    : null;
  site.updated = Number(raw.updated) || 0;
  site.points = raw.points.slice(0, 50).map((p, i) => ({
    id: /^[A-Za-z0-9-]{1,40}$/.test(p.id) ? p.id : uid(),
    name: String(p.name || `Point ${i + 1}`).slice(0, 60),
    p: Array.isArray(p.p) && p.p.length === 3 && p.p.every(Number.isFinite) ? p.p.map(Number) : null,
    img: typeof p.img === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(p.img) && p.img.length < 300000 ? p.img : null,
  })).filter((p) => p.p);
  const ms = Number(raw.markerSize);
  site.markerSize = ms >= 0.03 && ms <= 1 ? ms : 0.15;
  // Printed markers learned on site: their 4 corners in model coordinates.
  if (raw.markers && typeof raw.markers === 'object') {
    for (const [k, m] of Object.entries(raw.markers).slice(0, 250)) {
      const id = Number(k);
      if (!Number.isInteger(id) || id < 0 || id > 249 || !m || !Array.isArray(m.c) || m.c.length !== 4) continue;
      if (!m.c.every((q) => Array.isArray(q) && q.length === 3 && q.every(Number.isFinite))) continue;
      const size = Number(m.size);
      site.markers[id] = {
        c: m.c.map((q) => q.map(Number)),
        fit: Number.isFinite(m.fit) ? m.fit : 0.05,
        n: Number.isInteger(m.n) ? m.n : 0,
        learned: Number(m.learned) || 0,
        size: size >= 0.03 && size <= 1 ? size : site.markerSize,
      };
    }
  }
  return site;
}

async function loadSiteFor(src) {
  let site = null;
  try {
    if (params.get('site')) {
      site = cleanSite(await (await fetch(params.get('site'))).json());
    } else if (src.site) {
      site = cleanSite(src.site);
    } else {
      const saved = store.get(`align-site:${siteKey()}`);
      if (saved) site = cleanSite(JSON.parse(saved));
    }
  } catch (e) { toast(`Could not read the saved control points: ${e.message}`, true); }
  S.site = site || emptySite();
  if (site?.model && S.model && site.model.size && S.model.size && site.model.size !== S.model.size) {
    toast('These control points were made on a different version of the model. Check each one before aligning.', true);
  }
  rebuildMarkers();
  renderList();
}

let saveTimer = null;
function saveSite() {
  S.site.updated = Date.now();
  S.site.model = { name: S.model.name, size: S.model.size, version: S.model.version };
  S.site.name ||= S.model.name.replace(/\.glb$/i, '');
  const json = JSON.stringify(S.site);
  if (!store.set(`align-site:${siteKey()}`, json)) toast('Browser storage is full; export the points to keep them.', true);
  if (S.room) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fetch(`/api/rooms/${S.room}/align`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: json })
        .then((r) => { if (!r.ok) throw new Error(r.status); })
        .catch(() => toast('Could not save points to the room (saved on this device).', true));
    }, 600);
  }
  renderList();
  refreshXRButton();
}

// ---------------------------------------------------------------- control point markers
const MARKER_COLORS = { idle: '#ffffff', target: '#ffd447', done: '#2DBE8C', suspect: '#FF6B6B' };
const coneGeo = new THREE.ConeGeometry(0.5, 1, 20).rotateX(Math.PI).translate(0, 0.5, 0); // tip at origin
const markerObjs = new Map();

function rebuildMarkers() {
  for (const m of markerObjs.values()) { markers.remove(m.group); m.label.material.map.dispose(); m.label.material.dispose(); m.cone.material.dispose(); }
  markerObjs.clear();
  if (!S.model) return;
  S.site.points.forEach((pt, i) => {
    const group = new THREE.Group();
    const cone = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({ color: MARKER_COLORS.idle, depthTest: false, transparent: true, opacity: 0.95 }));
    cone.renderOrder = 997;
    const label = makeLabelSprite(`${i + 1}. ${pt.name}`, '#ffd447');
    label.material.depthTest = false; label.renderOrder = 998;
    group.add(cone, label);
    group.position.fromArray(toInternal(pt.p));
    markers.add(group);
    markerObjs.set(pt.id, { group, cone, label });
  });
  rebuildLearned();
  layoutMarkers();
}

// Printed markers the phone has learned, drawn where they are on the model (cyan squares).
const learnedGroup = new THREE.Group();
stage.add(learnedGroup);
function rebuildLearned() {
  for (const o of [...learnedGroup.children]) {
    learnedGroup.remove(o);
    o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose();
  }
  if (S.model) {
    for (const [id, m] of Object.entries(S.site.markers)) {
      const q = m.c.map((p) => new THREE.Vector3().fromArray(toInternal(p)));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([...q, q[0]]), new THREE.LineBasicMaterial({ color: 0x22b8cf, depthTest: false }));
      const quad = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([q[0], q[1], q[2], q[0], q[2], q[3]]),
        new THREE.MeshBasicMaterial({ color: 0x22b8cf, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthTest: false }));
      const label = makeLabelSprite(`#${id}`, '#22b8cf');
      label.material.depthTest = false;
      label.userData.anchor = q.reduce((a, v) => a.add(v), new THREE.Vector3()).multiplyScalar(0.25);
      line.renderOrder = quad.renderOrder = 996; label.renderOrder = 998;
      learnedGroup.add(line, quad, label);
    }
  }
  renderMarkerPanel();
}

function layoutMarkers() {
  // Real-world size in AR; scaled with the model on the desktop so they stay visible.
  const s = S.xr ? 0.1 : Math.max(0.15, (S.model?.extent || 10) / 70);
  for (const { cone, label } of markerObjs.values()) {
    cone.scale.set(s * 0.5, s, s * 0.5);
    label.scale.set(s * 4, s, 1);
    label.position.y = s * 1.6;
  }
  hoverDot.scale.setScalar(s * 0.18);
  for (const o of learnedGroup.children) {
    if (!o.isSprite) continue;
    o.scale.set(s * 2.4, s * 0.6, 1);
    o.position.copy(o.userData.anchor).y += s * 0.6;
  }
}

// ---------------------------------------------------------------- printed markers panel (desktop)
function renderMarkerPanel() {
  const size = $('mk-size'), list = $('mk-list');
  if (!size) return;
  if (document.activeElement !== size) size.value = Math.round(S.site.markerSize * 1000);
  $('mk-print').href = `/align-markers.html?size=${Math.round(S.site.markerSize * 1000)}`;
  list.textContent = '';
  const ids = Object.keys(S.site.markers).map(Number).sort((a, b) => a - b);
  if (!ids.length) {
    const li = document.createElement('li'); li.className = 'none';
    li.textContent = 'None learned yet.';
    list.append(li);
    return;
  }
  for (const id of ids) {
    const m = S.site.markers[id];
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.textContent = `#${id} · ±${cm(m.fit)} · ${Math.round(m.size * 1000)} mm · ${m.learned ? new Date(m.learned).toLocaleDateString() : ''}`;
    const b = document.createElement('button'); b.className = 'btn danger'; b.textContent = 'Forget';
    b.onclick = () => { delete S.site.markers[id]; rebuildLearned(); saveSite(); };
    li.append(t, b);
    list.append(li);
  }
}
$('mk-size').onchange = (e) => {
  const mm = Number(e.target.value);
  if (!(mm >= 30 && mm <= 1000)) { toast('Marker size must be 30 to 1000 mm', true); renderMarkerPanel(); return; }
  S.site.markerSize = mm / 1000;
  if (S.model) saveSite(); else renderMarkerPanel();
  if (Object.keys(S.site.markers).length) toast('New size applies to markers learned from now on. Already learned markers keep the size they were learned with.');
};

function colorMarkers() {
  const xr = S.xr;
  S.site.points.forEach((pt, i) => {
    const m = markerObjs.get(pt.id); if (!m) return;
    let c = MARKER_COLORS.idle;
    if (xr) {
      if (xr.ev?.suspect === pt.id) c = MARKER_COLORS.suspect;
      else if (xr.step === 'collect' && i === xr.target) c = MARKER_COLORS.target;
      else if (xr.taps.has(pt.id)) c = MARKER_COLORS.done;
    } else if (S.selected === pt.id) c = MARKER_COLORS.target;
    m.cone.material.color.set(c);
  });
}

// ---------------------------------------------------------------- desktop editing
function setAddMode(on) {
  S.addMode = on;
  $('add-pt').setAttribute('aria-pressed', String(on));
  canvas.style.cursor = on ? 'crosshair' : '';
  if (!on) hoverDot.visible = false;
}
$('add-pt').onclick = () => {
  if (!S.model) return toast('Open a model first', true);
  setAddMode(!S.addMode);
};
$('snap').onchange = (e) => { S.snap = e.target.checked; };
addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (e.key === 'a' || e.key === 'A') $('add-pt').click();
  if (e.key === 'Escape') setAddMode(false);
});

const _ndc = new THREE.Vector2(), _a = new THREE.Vector3(), _sp = new THREE.Vector3(), _hp = new THREE.Vector3(), _im = new THREE.Matrix4();

/** Model hit under the pointer, snapped to the nearest triangle corner within 18 px. */
function pickAt(clientX, clientY) {
  if (!S.model) return null;
  const r = canvas.getBoundingClientRect();
  _ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(_ndc, camera);
  const hit = raycaster.intersectObject(modelHolder, true)[0];
  if (!hit) return null;
  const p = hit.point.clone();
  let snapped = false;
  if (S.snap && hit.face) {
    const pos = hit.object.geometry.attributes.position;
    _hp.copy(hit.point).project(camera);
    let best = Infinity;
    for (const idx of [hit.face.a, hit.face.b, hit.face.c]) {
      _a.fromBufferAttribute(pos, idx);
      if (hit.object.isInstancedMesh && hit.instanceId != null) { hit.object.getMatrixAt(hit.instanceId, _im); _a.applyMatrix4(_im); }
      _a.applyMatrix4(hit.object.matrixWorld);
      _sp.copy(_a).project(camera);
      const px = Math.hypot((_sp.x - _hp.x) * r.width / 2, (_sp.y - _hp.y) * r.height / 2);
      if (px < 18 && px < best) { best = px; p.copy(_a); snapped = true; }
    }
  }
  return { p, snapped };
}

let down = null, hoverRaf = 0;
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (!down || S.xr) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 6 || !S.addMode) return;
  const h = pickAt(e.clientX, e.clientY);
  if (!h) return toast('Click on the model surface', true);
  addPoint(h.p);
});
canvas.addEventListener('pointermove', (e) => {
  if (!S.addMode || S.xr || hoverRaf) return;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    const h = pickAt(e.clientX, e.clientY);
    hoverDot.visible = !!h;
    if (h) { hoverDot.position.copy(h.p); hoverDot.material.color.set(h.snapped ? 0x2dbe8c : 0xffd447); }
  });
});

/**
 * Reference photo for a point: a close-up from the current viewing direction, so on site
 * you can see which corner is meant and what is around it.
 */
const thumbCam = new THREE.PerspectiveCamera(55, 4 / 3, 0.05, 2000);
function snapshot(pt) {
  hoverDot.visible = false;
  const target = new THREE.Vector3().fromArray(toInternal(pt.p));
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.y < 0.25) { dir.y = 0.25; dir.normalize(); } // look slightly down at floor-level corners
  const dist = THREE.MathUtils.clamp(S.model.extent * 0.12, 3, 12);
  thumbCam.position.copy(target).addScaledVector(dir, dist);
  thumbCam.lookAt(target);
  thumbCam.far = camera.far;
  thumbCam.updateProjectionMatrix();
  const size = renderer.getSize(new THREE.Vector2());
  const w = 360, h = 270;
  renderer.setSize(w, h, false);
  renderer.render(scene, thumbCam);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(renderer.domElement, 0, 0, w, h);
  renderer.setSize(size.x, size.y, false);
  renderer.render(scene, camera);
  return c.toDataURL('image/jpeg', 0.75);
}

function addPoint(v) {
  const pt = { id: uid(), name: `Point ${S.site.points.length + 1}`, p: toModel(v).map(r4), img: null };
  S.site.points.push(pt);
  S.selected = pt.id;
  rebuildMarkers(); colorMarkers();
  pt.img = snapshot(pt);
  saveSite();
  setTimeout(() => {
    const input = document.querySelector(`#pt-list li[data-id="${pt.id}"] input`);
    input?.focus(); input?.select();
  }, 30);
}

function renderList() {
  const list = $('pt-list');
  list.textContent = '';
  $('pt-count').textContent = S.site.points.length;
  if (!S.site.points.length) {
    const li = document.createElement('li'); li.className = 'none';
    li.textContent = S.model ? 'No points yet.' : 'Open a model to start.';
    list.append(li);
    return;
  }
  S.site.points.forEach((pt, i) => {
    const li = document.createElement('li');
    li.dataset.id = pt.id;
    li.classList.toggle('sel', S.selected === pt.id);
    const img = document.createElement('img'); img.className = 'thumb'; img.alt = '';
    if (pt.img) img.src = pt.img;
    const body = document.createElement('div');
    const top = document.createElement('div'); top.style.display = 'flex'; top.style.alignItems = 'center';
    const num = document.createElement('span'); num.className = 'num'; num.textContent = i + 1;
    const input = document.createElement('input'); input.value = pt.name; input.maxLength = 60;
    input.onchange = () => { pt.name = input.value.trim() || `Point ${i + 1}`; rebuildMarkers(); saveSite(); };
    input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); };
    top.append(num, input);
    const coords = document.createElement('div'); coords.className = 'coords';
    coords.textContent = pt.p.map((x) => x.toFixed(3)).join(', ');
    const acts = document.createElement('div'); acts.className = 'acts';
    const mk = (label, title, fn) => { const b = document.createElement('button'); b.className = 'btn'; b.textContent = label; b.title = title; b.onclick = fn; acts.append(b); };
    mk('Go to', 'Fly the camera to this point', () => focusPoint(pt));
    mk('Photo', 'Retake the reference photo, looking from the current view direction', () => { S.selected = pt.id; colorMarkers(); pt.img = snapshot(pt); saveSite(); });
    mk('↑', 'Move up the list', () => { if (i > 0) { S.site.points.splice(i - 1, 0, S.site.points.splice(i, 1)[0]); rebuildMarkers(); saveSite(); } });
    mk('Delete', 'Delete this point', () => { S.site.points.splice(i, 1); rebuildMarkers(); saveSite(); });
    acts.lastChild.classList.add('danger');
    body.append(top, coords, acts);
    li.append(img, body);
    li.onclick = (e) => { if (e.target.closest('button, input')) return; S.selected = pt.id; colorMarkers(); renderList(); };
    list.append(li);
  });
}

function focusPoint(pt) {
  S.selected = pt.id; colorMarkers(); renderList();
  const v = new THREE.Vector3().fromArray(toInternal(pt.p));
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(v);
  camera.position.copy(v).addScaledVector(dir, Math.max(4, S.model.extent * 0.12));
  controls.update();
}

// ---------------------------------------------------------------- files
$('file-glb').onchange = (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) { S.room = null; loadModel({ file: f, name: f.name, size: f.size }); }
};
$('file-site').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (!S.model) return toast('Open the model first, then import its points', true);
  try {
    S.site = cleanSite(JSON.parse(await f.text()));
    rebuildMarkers(); saveSite();
    toast(`Imported ${S.site.points.length} points`);
  } catch (err) { toast(`Could not import: ${err.message}`, true); }
};
$('export-site').onclick = () => {
  if (!S.site.points.length) return toast('No points to export yet', true);
  const blob = new Blob([JSON.stringify(S.site, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(S.site.name || 'site').replace(/[^\w.-]+/g, '_')}-control-points.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
addEventListener('dragleave', () => document.body.classList.remove('dragging'));
addEventListener('drop', (e) => {
  e.preventDefault(); document.body.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f && /\.glb$/i.test(f.name)) { S.room = null; loadModel({ file: f, name: f.name, size: f.size }); }
});

// ---------------------------------------------------------------- materials
function applyOpacity(o) {
  if (!S.model) return;
  S.model.root.traverse((m) => {
    if (!m.isMesh) return;
    for (const mat of [].concat(m.material)) {
      const base = mat.userData.baseOpacity ?? 1;
      mat.opacity = base * (o || 1);
      mat.transparent = o < 1 || base < 1;
      mat.depthWrite = o >= 0.5;
      mat.needsUpdate = true;
    }
  });
}

// ================================================================= AR
let xrSupported = false;
async function setupXR() {
  xrSupported = navigator.xr ? await navigator.xr.isSessionSupported('immersive-ar').catch(() => false) : false;
  refreshXRButton();
}
function refreshXRButton() {
  const n = S.site.points.length;
  const btn = $('enter-ar'), msg = $('xr-msg');
  btn.hidden = !xrSupported || !S.model;
  btn.disabled = n < 2;
  if (!S.model) msg.textContent = '';
  else if (!xrSupported) {
    msg.textContent = IS_IOS
      ? 'iPhone/iPad browsers have no WebXR, so on-site alignment needs an Android phone (Chrome) or Quest 3. You can still set up points here.'
      : 'Set up points here, then open this page on an Android phone (Chrome) or Meta Quest 3 at the building to align.';
  } else msg.textContent = n < 2 ? 'Add at least 2 points (3 or 4 recommended) to align.' : `${n} points ready. Go to the building, then tap Align in AR.`;
  const nm = Object.keys(S.site.markers).length;
  if (S.model && nm) msg.textContent += ` ${nm} printed marker${nm > 1 ? 's' : ''} learned: on Android, pointing the camera at one aligns the model.`;
}
$('enter-ar').onclick = () => startAR();

const usesPointer = () => IS_HEADSET || controllers.some((c) => c.userData.source?.targetRayMode === 'tracked-pointer');

const controllers = [0, 1].map((i) => {
  const c = renderer.xr.getController(i);
  const ray = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }),
  );
  ray.visible = false;
  c.add(ray);
  c.userData = { ray, source: null };
  c.addEventListener('connected', (e) => { c.userData.source = e.data; ray.visible = e.data.targetRayMode === 'tracked-pointer'; });
  c.addEventListener('disconnected', () => { c.userData.source = null; ray.visible = false; });
  c.addEventListener('select', () => onXRSelect(c));
  scene.add(c);
  return c;
});

function xrConfigs() {
  const overlay = { root: $('ar') };
  return [
    { requiredFeatures: ['hit-test'], optionalFeatures: ['local-floor', 'anchors', 'dom-overlay', 'hand-tracking', 'camera-access'], domOverlay: overlay },
    { requiredFeatures: ['hit-test'], optionalFeatures: ['local-floor', 'anchors', 'dom-overlay', 'hand-tracking'], domOverlay: overlay },
    { requiredFeatures: ['hit-test'], optionalFeatures: ['anchors', 'dom-overlay'], domOverlay: overlay },
    { requiredFeatures: ['hit-test'] },
  ];
}

const recordKey = () => `align-anchor:${siteKey()}`;
function loadRecord() {
  try { const r = JSON.parse(store.get(recordKey()) || 'null'); return r?.uuid && Array.isArray(r.K) && r.K.length === 16 ? r : null; } catch { return null; }
}

async function startAR() {
  if (!S.model || S.site.points.length < 2) return;
  setAddMode(false);
  $('ar').hidden = false; // DOM overlay root must be displayed when the session starts
  let session, err1;
  for (const cfg of xrConfigs()) {
    try { session = await navigator.xr.requestSession('immersive-ar', cfg); break; }
    catch (err) { console.warn('AR config rejected', err.name, err.message); err1 ||= err; if (err.name !== 'NotSupportedError') break; }
  }
  if (!session) {
    $('ar').hidden = true;
    return toast(err1?.name === 'NotAllowedError' ? 'AR was blocked. Allow camera / spatial access for this site and try again.' : `AR could not start: ${err1?.message || 'not supported'}. On Android use Chrome with Google Play Services for AR.`, true);
  }
  const ef = session.enabledFeatures || [];
  const floor = session.enabledFeatures ? ef.includes('local-floor') : IS_HEADSET;
  renderer.xr.setReferenceSpaceType(floor ? 'local-floor' : 'local');
  S.xr = {
    session, step: 'safety', target: 0, taps: new Map(), pending: null, ev: null,
    W: null, A: null, K: null, anchor: null, lockRequested: false, lostFrames: 0,
    viewerHit: null, ctrlHit: null, ctrlFor: null, hitPos: null, panel: null,
    domOverlay: !!session.domOverlayState, anchors: !ef.length || ef.includes('anchors'),
    nudgeStep: 0.01, check: null, restored: null, restoreStart: 0, frames: 0,
    source: null, scanner: null, learnedNow: new Set(), markerSig: '', markerFitAt: 0, markerTick: 0, anchorHint: null,
  };
  try { await renderer.xr.setSession(session); }
  catch (err) { S.xr = null; $('ar').hidden = true; session.end().catch(() => {}); return toast(`AR could not start: ${err.message}`, true); }

  document.body.classList.add('in-xr');
  scene.background = null;
  renderer.setClearColor(0x000000, 0);
  controls.enabled = false;
  grid.visible = false;
  hoverDot.visible = false;
  stage.matrixAutoUpdate = false;
  stage.matrix.identity();
  stage.visible = false;
  layoutMarkers();
  applyOpacity(S.opacity);
  session.addEventListener('end', onXREnd);
  session.requestReferenceSpace('viewer')
    .then((vs) => session.requestHitTestSource({ space: vs }))
    .then((src) => { if (S.xr?.session === session) S.xr.viewerHit = src; })
    .catch(() => {});
  // Android: read the camera image to find printed markers.
  if (MarkerScanner.available(session)) {
    const sc = new MarkerScanner(renderer, S.site.markerSize);
    sc.sizeFor = (id) => S.site.markers[id]?.size || S.site.markerSize;
    if (sc.start(session)) S.xr.scanner = sc;
  }
  if (!S.xr.domOverlay) {
    S.xr.panel = new AlignPanel();
    scene.add(S.xr.panel.mesh);
    $('ar').hidden = true;
  }
  if (store.get('align-safety-ok')) afterSafety();
}

function afterSafety() {
  const xr = S.xr;
  const rec = loadRecord();
  if (rec && xr.session.restorePersistentAnchor) tryRestore(rec);
  else gotoCollect(0);
}

async function tryRestore(rec) {
  const xr = S.xr;
  xr.step = 'restoring';
  xr.restoreStart = performance.now();
  try {
    const anchor = await xr.session.restorePersistentAnchor(rec.uuid);
    if (S.xr !== xr || xr.step !== 'restoring') return;
    // K maps the anchor to the model's internal frame at save time. If the model was
    // re-exported with a different centre since, compensate for the offset change.
    const o = S.model.offset, ro = rec.offset || o;
    xr.K = new THREE.Matrix4().fromArray(rec.K).multiply(new THREE.Matrix4().makeTranslation(o[0] - ro[0], o[1] - ro[1], o[2] - ro[2]));
    xr.anchor = anchor;
    xr.restored = rec;
  } catch (err) {
    console.warn('restore failed', err);
    if (S.xr === xr && xr.step === 'restoring') {
      toast('Saved alignment not found here. Align with the points instead.');
      gotoCollect(0);
    }
  }
}

function onXREnd() {
  const xr = S.xr;
  S.xr = null;
  xr?.scanner?.stop();
  xr?.panel && (scene.remove(xr.panel.mesh), xr.panel.dispose());
  for (const p of [...pins.children]) { pins.remove(p); p.geometry?.dispose(); }
  document.body.classList.remove('in-xr');
  $('ar').hidden = true;
  scene.background = BG;
  renderer.setClearColor(0x000000, 1);
  controls.enabled = true;
  grid.visible = true;
  reticle.visible = false;
  stage.matrixAutoUpdate = true;
  stage.position.set(0, 0, 0); stage.rotation.set(0, 0, 0); stage.updateMatrix();
  stage.visible = true;
  applyOpacity(1);
  layoutMarkers(); colorMarkers();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- AR actions
function gotoCollect(i) {
  const xr = S.xr;
  xr.step = 'collect';
  xr.target = ((i % S.site.points.length) + S.site.points.length) % S.site.points.length;
  xr.check = null;
}

function nextUntapped(from) {
  const pts = S.site.points;
  for (let k = 1; k <= pts.length; k++) {
    const j = (from + k) % pts.length;
    if (!S.xr.taps.has(pts[j].id)) return j;
  }
  return -1;
}

function refit() {
  const xr = S.xr;
  const pairs = S.site.points.filter((p) => xr.taps.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, m: toInternal(p.p), w: xr.taps.get(p.id).w }));
  // Taps take over from a marker or restored alignment: drop its anchor.
  if (xr.source !== 'taps') {
    xr.anchor?.delete?.(); xr.anchor = null; xr.A = null; xr.K = null;
    xr.anchorReq = (xr.anchorReq || 0) + 1; xr.lockRequested = false;
  }
  xr.source = pairs.length ? 'taps' : null;
  xr.restored = null;
  xr.ev = pairs.length >= 2 ? evaluate(pairs, S.model.extent) : null;
  xr.W = xr.ev ? new THREE.Matrix4().makeRotationY(xr.ev.sol.yaw).setPosition(...xr.ev.sol.t) : null;
  rebuildPins();
}

const pinGeo = new THREE.SphereGeometry(0.018, 14, 10);
const pinMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
const lineMat = new THREE.LineBasicMaterial({ color: 0xff6b6b, depthTest: false });
function rebuildPins() {
  for (const p of [...pins.children]) { pins.remove(p); if (p.isLine) p.geometry.dispose(); }
  const xr = S.xr; if (!xr) return;
  for (const pt of S.site.points) {
    const tap = xr.taps.get(pt.id); if (!tap) continue;
    const pin = new THREE.Mesh(pinGeo, pinMat); pin.renderOrder = 996;
    pin.position.fromArray(tap.w);
    pins.add(pin);
    if (xr.W) {
      // Red line from the tap to where the model says that point is: the residual, made visible.
      const mp = new THREE.Vector3().fromArray(toInternal(pt.p)).applyMatrix4(xr.W);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([pin.position, mp]), lineMat);
      line.renderOrder = 996;
      pins.add(line);
    }
  }
}

function onXRSelect(c) {
  const xr = S.xr; if (!xr) return;
  if (xr.panel && c.userData.source?.targetRayMode === 'tracked-pointer') {
    rayFromController(c);
    const h = raycaster.intersectObject(xr.panel.mesh, false)[0];
    if (h) { xr.panel.click(h.uv); return; }
  } else if (xr.panel) {
    // Phone without DOM overlay: taps go to the panel if the centre ray hits it.
    raycaster.setFromCamera(_ndc.set(0, 0), renderer.xr.getCamera());
    const h = raycaster.intersectObject(xr.panel.mesh, false)[0];
    if (h) { xr.panel.click(h.uv); return; }
  }
  if (xr.pending) return;
  if (xr.step === 'collect' || xr.step === 'check') {
    xr.pending = { kind: xr.step, id: S.site.points[xr.target]?.id, samples: [], frames: 0, source: c.userData.source };
  }
}

function finishSample() {
  const xr = S.xr, pd = xr.pending;
  xr.pending = null;
  const r = medianPoint(pd.samples);
  if (!r || pd.samples.length < 4) return toast('No surface found there. Aim at the floor right at the corner and try again.', true);
  if (pd.kind === 'collect') {
    xr.taps.set(pd.id, { w: r.p, spread: r.spread });
    if (r.spread > 0.03) toast(`Tracking was unsteady (±${cm(r.spread)}). Hold still and re-tap if the fit looks off.`, true);
    refit();
    const nxt = nextUntapped(xr.target);
    if (nxt >= 0) xr.target = nxt;
    else xr.step = 'review';
  } else {
    // Check: how far is the nearest control point (as placed by the model) from this tap?
    let best = null;
    const tap = new THREE.Vector3().fromArray(r.p);
    for (const pt of S.site.points) {
      const mp = new THREE.Vector3().fromArray(toInternal(pt.p)).applyMatrix4(stage.matrix);
      const d = mp.distanceTo(tap);
      if (!best || d < best.d) best = { name: pt.name, d, h: Math.hypot(mp.x - tap.x, mp.z - tap.z), v: Math.abs(mp.y - tap.y) };
    }
    xr.check = best;
  }
}

function centroidOfTaps() {
  const v = new THREE.Vector3(); let n = 0;
  for (const t of S.xr.taps.values()) { v.add(_a.fromArray(t.w)); n++; }
  return n ? v.divideScalar(n) : null;
}

function lock(force = false) {
  const xr = S.xr;
  if (!xr.W) return;
  if (xr.ev?.grade === 'poor' && !force) { xr.step = 'confirm'; return; }
  xr.step = 'locked';
  xr.restored = null;
  if (xr.source === 'taps') xr.anchorHint = null;
  if (xr.anchors) xr.lockRequested = true;
  else toast('Locked for this session. This browser cannot save anchors, so you will re-tap next time.');
}

/** Runs inside the XR frame callback, where anchors can be created. */
function createLockAnchor(frame) {
  const xr = S.xr;
  xr.lockRequested = false;
  if (!frame.createAnchor) { xr.anchors = false; return; }
  const c = xr.anchorHint?.clone() || centroidOfTaps() || new THREE.Vector3().setFromMatrixPosition(xr.W);
  const quiet = xr.quietLock; xr.quietLock = false;
  const ref = renderer.xr.getReferenceSpace();
  const W = xr.W.clone();
  const req = xr.anchorReq = (xr.anchorReq || 0) + 1;
  frame.createAnchor(new XRRigidTransform({ x: c.x, y: c.y, z: c.z }), ref).then((anchor) => {
    // Stale: the session ended, or a newer alignment asked for its own anchor meanwhile.
    if (S.xr !== xr || req !== xr.anchorReq) { anchor.delete?.(); return; }
    xr.anchor?.delete?.();
    xr.anchor = anchor;
    xr.A = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z);
    xr.K = xr.A.clone().invert().multiply(W);
    persistAnchor(quiet);
  }).catch((err) => { console.warn('anchor failed', err); toast('Locked, but the device could not create an anchor. Keep the session open.'); });
}

async function persistAnchor(quiet = false) {
  const xr = S.xr;
  if (!xr.anchor?.requestPersistentHandle) {
    if (!quiet) toast(xr.scanner ? 'Locked. Now look at each printed marker for 2 seconds so the phone can learn it.' : 'Locked. This device keeps it for this session only.');
    return;
  }
  const old = loadRecord();
  try {
    const uuid = await xr.anchor.requestPersistentHandle();
    if (old?.uuid && old.uuid !== uuid) xr.session.deletePersistentAnchor?.(old.uuid)?.catch(() => {});
    xr.record = {
      uuid, K: xr.K.toArray(), offset: S.model.offset, date: Date.now(),
      fit: xr.ev ? { estimate: xr.ev.estimate, grade: xr.ev.grade, n: xr.ev.n } : null,
    };
    store.set(recordKey(), JSON.stringify(xr.record));
    toast('Locked and saved. Next time in this room the model snaps back on its own.');
  } catch (err) { console.warn('persist failed', err); toast('Locked for this session (could not save the anchor).'); }
}

let saveKTimer = null;
function saveK() {
  const xr = S.xr;
  const rec = xr.record || xr.restored;
  if (!rec?.uuid || !xr.K) return;
  clearTimeout(saveKTimer);
  saveKTimer = setTimeout(() => {
    rec.K = xr.K.toArray(); rec.offset = S.model.offset; rec.date = Date.now();
    store.set(recordKey(), JSON.stringify(rec));
  }, 800);
}

/** Apply a world-space correction N to the current alignment. */
function nudge(kind, sign) {
  const xr = S.xr;
  const cur = xr.anchor && xr.A && xr.K ? xr.A.clone().multiply(xr.K) : xr.W;
  if (!cur) return;
  const cam = renderer.xr.getCamera();
  const fwd = cam.getWorldDirection(new THREE.Vector3()); fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, THREE.Object3D.DEFAULT_UP).normalize();
  const s = xr.nudgeStep * sign;
  const N = new THREE.Matrix4();
  if (kind === 'x') N.makeTranslation(right.x * s, 0, right.z * s);
  else if (kind === 'z') N.makeTranslation(fwd.x * s, 0, fwd.z * s);
  else if (kind === 'y') N.makeTranslation(0, s, 0);
  else if (kind === 'yaw') {
    // Rotate about the middle of the tapped points (or the user) so nearby geometry barely moves.
    const pv = centroidOfTaps() || cam.getWorldPosition(new THREE.Vector3());
    const deg = xr.nudgeStep >= 0.05 ? 1 : 0.2;
    N.makeTranslation(pv.x, 0, pv.z)
      .multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(deg * sign)))
      .multiply(new THREE.Matrix4().makeTranslation(-pv.x, 0, -pv.z));
  }
  const next = N.multiply(cur);
  if (xr.source === 'markers') xr.markersFrozen = true; // keep the hand-tuned result; stop auto refits
  if (xr.anchor && xr.A) { xr.K = xr.A.clone().invert().multiply(next); saveK(); }
  xr.W = next;
}

function realign() {
  const xr = S.xr;
  xr.anchor?.delete?.();
  xr.anchor = null; xr.A = null; xr.K = null; xr.W = null; xr.ev = null;
  xr.anchorReq = (xr.anchorReq || 0) + 1; xr.lockRequested = false;
  xr.taps.clear(); xr.restored = null; xr.record = null;
  if (xr.source === 'markers') xr.useMarkers = false; // the person rejected the marker fit
  xr.markersFrozen = false;
  xr.source = null; xr.markerSig = ''; xr.anchorHint = null;
  rebuildPins();
  gotoCollect(0);
}

function cycleOpacity() {
  const i = OPACITY_STEPS.indexOf(S.opacity);
  S.opacity = OPACITY_STEPS[(i + 1) % OPACITY_STEPS.length];
  applyOpacity(S.opacity);
}

// ---------------------------------------------------------------- printed markers (Android)
const v3 = (a) => new THREE.Vector3().fromArray(a);

/** Runs a few times a second: align from learned markers, or learn new ones. */
function handleMarkers(now) {
  const xr = S.xr, sc = xr.scanner;
  if (!sc || now - xr.markerTick < 250) return;
  xr.markerTick = now;

  // A) Nobody has aligned yet (no taps, nothing restored): use any learned marker in view.
  const auto = xr.useMarkers !== false && !xr.markersFrozen && !xr.taps.size && xr.source !== 'taps' && !xr.restored
    && ['collect', 'review', 'locked', 'restoring'].includes(xr.step);
  if (auto) {
    const ests = Object.keys(S.site.markers).map(Number)
      .map((id) => sc.estimate(id, now)).filter((e) => e && e.spread < 0.03);
    if (ests.length) {
      const sig = ests.map((e) => `${e.id}${e.n >= 15 ? '+' : ''}`).join(',');
      if (sig !== xr.markerSig || now - xr.markerFitAt > 3000) {
        xr.markerSig = sig; xr.markerFitAt = now;
        alignFromMarkers(ests);
      }
    }
  }

  // B) Aligned from taps with a usable fit: learn every marker the camera holds steady on.
  if (xr.source === 'taps' && xr.W && xr.ev && xr.ev.grade !== 'poor' && ['locked', 'check', 'nudge'].includes(xr.step)) {
    for (const { id } of sc.seen(now, 1500)) {
      if (xr.learnedNow.has(id)) continue;
      const e = sc.estimate(id, now, 10);
      if (!e || e.spread > 0.015 || e.dist > 2.0) continue;
      // Error of the tap alignment at this marker: grows with distance from the tapped points.
      const center = e.w.reduce((a, p) => a.add(v3(p)), new THREE.Vector3()).multiplyScalar(0.25);
      const tc = centroidOfTaps() || center;
      const ev = xr.ev;
      const here = ev.estimate + (Math.max(ev.estimate, 0.01) / Math.max(ev.spread, 0.5)) * Math.hypot(center.x - tc.x, center.z - tc.z);
      const fit = Math.hypot(here, e.spread);
      const old = S.site.markers[id];
      if (old && old.fit <= fit + 0.003) { xr.learnedNow.add(id); continue; } // already known at least as well
      learnMarker(id, e, fit);
    }
  }
}

function learnMarker(id, e, fit) {
  const xr = S.xr;
  const inv = xr.W.clone().invert();
  S.site.markers[id] = {
    c: e.w.map((p) => toModel(v3(p).applyMatrix4(inv)).map(r4)),
    fit: r4(fit), n: e.n, learned: Date.now(),
    size: xr.scanner.sizeFor(id),
  };
  xr.learnedNow.add(id);
  rebuildLearned();
  saveSite();
  toast(`Learned marker #${id} (±${cm(fit)}). Next time, just point a phone at it.`);
}

function alignFromMarkers(ests) {
  const xr = S.xr;
  const pairs = [];
  for (const e of ests) {
    const mk = S.site.markers[e.id];
    e.w.forEach((w, k) => pairs.push({ id: `m${e.id}.${k}`, name: `Marker #${e.id}`, m: toInternal(mk.c[k]), w }));
  }
  const ev = evaluate(pairs, S.model.extent);
  if (!ev) return;
  // The fit only sees how well the squares agree with each other. Add how well each marker
  // was learned and how steady today's sighting is, so the number shown is honest.
  const learnedErr = Math.max(...ests.map((e) => S.site.markers[e.id].fit));
  const measErr = Math.max(...ests.map((e) => e.spread));
  const shapeErr = ev.estimate;
  ev.estimate = Math.hypot(shapeErr, learnedErr, measErr);
  const yawErr = Math.max(shapeErr, measErr, 0.004) / Math.max(ev.spread, 0.05);
  ev.farError = ev.estimate + yawErr * (S.model.extent / 2);
  ev.n = ests.length;
  ev.markerIds = ests.map((e) => e.id);
  ev.suspect = null;
  ev.grade = ev.estimate <= 0.03 ? 'good' : ev.estimate <= 0.08 ? 'ok' : 'poor';
  ev.warnings = ev.warnings.filter((w) => /disagrees/.test(w));
  if (ev.farError > 0.1) ev.warnings.push(`The far end may be off by up to ${cm(ev.farError)}. Look at another marker far from ${ests.length === 1 ? 'this one' : 'these'} to lock the rotation down.`);

  const first = xr.source !== 'markers';
  xr.ev = ev;
  xr.source = 'markers';
  xr.W = new THREE.Matrix4().makeRotationY(ev.sol.yaw).setPosition(...ev.sol.t);
  if (xr.anchor) { xr.anchor.delete?.(); xr.anchor = null; xr.A = null; xr.K = null; }
  xr.anchorReq = (xr.anchorReq || 0) + 1;
  xr.anchorHint = ests.flatMap((e) => e.w).reduce((a, p) => a.add(v3(p)), new THREE.Vector3()).multiplyScalar(1 / (4 * ests.length));
  if (xr.anchors) { xr.lockRequested = true; xr.quietLock = true; }
  if (['collect', 'review', 'restoring'].includes(xr.step)) xr.step = 'locked';
  rebuildPins();
  if (first) toast(`Aligned from marker #${ev.markerIds.join(', #')}.`);
}

function markerStatus(now) {
  const xr = S.xr, sc = xr.scanner;
  if (!sc) return '';
  if (sc.failed) return 'Marker scanning stopped (camera access failed).';
  const learning = xr.source === 'taps' && xr.ev?.grade !== 'poor' && ['locked', 'check', 'nudge'].includes(xr.step);
  const parts = sc.seen(now).map((m) => {
    const known = !!S.site.markers[m.id];
    const st = m.tooFar ? 'move closer (1 to 2 m)' : m.tooOblique ? 'face it more squarely'
      : xr.learnedNow.has(m.id) ? 'learned ✓'
      : learning ? 'learning, hold steady'
      : known ? (xr.source === 'markers' ? 'in use' : 'learned')
      : 'not learned yet';
    return `#${m.id} ${st}`;
  });
  const lines = [];
  if (parts.length) lines.push(`Camera sees marker ${parts.join(', ')}.`);
  if (xr.source === 'taps' && xr.ev?.grade === 'poor') lines.push('Fit too poor to learn markers.');
  return lines.join(' ');
}

// ---------------------------------------------------------------- AR view model
function qualityLine(ev) {
  if (!ev) return null;
  const label = { good: 'Good', ok: 'Usable, check before relying on it', poor: 'Poor' }[ev.grade];
  if (ev.markerIds) {
    return { grade: ev.grade, text: `${label}: ±${cm(ev.estimate)} near the marker${ev.n > 1 ? 's' : ''}, ±${cm(ev.farError)} at the far end · ${ev.n} marker${ev.n > 1 ? 's' : ''}` };
  }
  const est = ev.n >= 3 ? `±${cm(ev.estimate)} at the points` : `distance check ${cm(ev.estimate)}`;
  return {
    grade: ev.grade,
    text: `${label}: ${est}, ±${cm(ev.farError)} at the far end · ${ev.n} pts, ${ev.spread.toFixed(1)} m apart`,
  };
}

function arView() {
  const v = arStepView();
  const ms = ['collect', 'review', 'locked', 'check', 'nudge'].includes(S.xr.step) ? markerStatus(performance.now()) : '';
  if (ms) v.text = v.text ? `${v.text}\n${ms}` : ms;
  const note = S.xr.note;
  if (note && performance.now() < note.until) v.warning = v.warning ? `${note.msg} ${v.warning}` : note.msg;
  return v;
}

/** JSON signature of a view, without handlers and without the (large) photo data. */
function viewSig(v) {
  return JSON.stringify(v, (k, val) => (typeof val === 'function' ? undefined : k === 'img' && val ? val.length + val.slice(-24) : val));
}

function arStepView() {
  const xr = S.xr, pts = S.site.points;
  const exit = { id: 'exit', label: 'Exit', kind: 'danger', onClick: () => xr.session.end() };
  const opac = { id: 'opac', label: S.opacity ? `Model ${Math.round(S.opacity * 100)}%` : 'Model hidden', onClick: cycleOpacity };
  const aim = usesPointer() ? 'Aim the ray at that exact spot on the real floor and pull the trigger (or pinch).' : 'Put the crosshair on that exact spot on the real floor and tap the screen.';
  switch (xr.step) {
    case 'safety': return {
      title: 'Before you start',
      text: 'Watch where you walk: the model can hide real obstacles, so keep it see-through. Stand still while marking points. The overlay can be wrong. Never use it alone for layout, cutting or anything safety-critical.',
      buttons: [{ id: 'ack', label: 'I understand', kind: 'primary', onClick: () => { store.set('align-safety-ok', '1'); afterSafety(); } }, exit],
    };
    case 'restoring': return {
      title: 'Finding saved alignment…',
      text: 'Look around the room slowly for a few seconds.',
      buttons: [{ id: 'skip', label: 'Align with points', onClick: () => gotoCollect(0) }, exit],
    };
    case 'collect': {
      const p = pts[xr.target];
      const tapped = xr.taps.has(p.id);
      const nLearned = Object.keys(S.site.markers).length;
      const markerHint = xr.scanner && nLearned && !xr.taps.size && xr.useMarkers !== false
        ? `Fastest: point the camera at any printed marker from 1 to 2 m away. Or mark this point: `
        : '';
      return {
        title: `Point ${xr.target + 1} of ${pts.length}: ${p.name}${tapped ? ' ✓' : ''}`,
        img: p.img,
        text: xr.pending ? 'Hold still…' : `${markerHint}${aim} Hold still for a moment.${tapped ? ' Tap again to redo it.' : ''}`,
        quality: qualityLine(xr.ev),
        warning: xr.ev?.warnings[0] || null,
        buttons: [
          { id: 'prev', label: '◀ Prev', onClick: () => gotoCollect(xr.target - 1) },
          { id: 'next', label: 'Next ▶', onClick: () => gotoCollect(xr.target + 1) },
          { id: 'undo', label: 'Clear point', disabled: !tapped, onClick: () => { xr.taps.delete(p.id); refit(); } },
          { id: 'done', label: 'Review', kind: 'primary', disabled: xr.taps.size < 2, onClick: () => { xr.step = 'review'; } },
          opac,
          ...(xr.scanner && nLearned && xr.useMarkers === false && !xr.taps.size
            ? [{ id: 'usemk', label: 'Use markers', onClick: () => { xr.useMarkers = true; xr.markerSig = ''; } }] : []),
          exit,
        ],
      };
    }
    case 'review': return {
      title: 'Review alignment',
      text: 'Walk around and compare model edges with the real ones. Red lines show how far each tap is from where the fit put that point.',
      quality: qualityLine(xr.ev),
      warning: xr.ev?.warnings.join(' ') || null,
      buttons: [
        { id: 'lock', label: 'Lock', kind: 'primary', disabled: !xr.W, onClick: () => lock() },
        { id: 'retap', label: xr.ev?.suspect ? 'Re-tap suspect' : 'Add / redo point', onClick: () => gotoCollect(xr.ev?.suspect ? pts.findIndex((p) => p.id === xr.ev.suspect) : Math.max(0, nextUntapped(-1))) },
        { id: 'over', label: 'Start over', onClick: realign },
        opac, exit,
      ],
    };
    case 'confirm': return {
      title: 'This fit looks poor',
      text: `The points disagree by about ${cm(xr.ev.estimate)}. Usually one tap was on the wrong feature or the model differs from what was built. Re-tap or add a point first.`,
      warning: xr.ev.warnings.join(' '),
      buttons: [
        { id: 'back', label: 'Go back', kind: 'primary', onClick: () => { xr.step = 'review'; } },
        { id: 'force', label: 'Lock anyway', kind: 'danger', onClick: () => lock(true) },
      ],
    };
    case 'locked': {
      const rec = xr.restored;
      const lost = xr.lostFrames > 45;
      const fromMarkers = xr.source === 'markers';
      return {
        title: rec ? 'Aligned (restored)' : fromMarkers ? `Aligned from marker #${xr.ev.markerIds.join(', #')}` : 'Aligned',
        text: lost ? 'Tracking lost. Model hidden until the device finds its place again. Hold still and look around.'
          : fromMarkers ? 'Updates as more markers come into view. Use Check on a control point before relying on it.'
          : xr.scanner && xr.source === 'taps' ? 'Now look at each printed marker from 1 to 2 m for 2 seconds so it gets learned. Use Check to measure the error at any control point.'
          : rec ? `Restored the alignment saved ${new Date(rec.date).toLocaleDateString()}. Use Check on any point to confirm it before relying on it.`
          : xr.anchor ? 'Anchored to the room. Use Check to measure the error at any control point, or Nudge to fine-tune.'
          : 'Use Check to measure the error at any control point, or Nudge to fine-tune.',
        quality: rec?.fit ? { grade: rec.fit.grade, text: `Fit when saved: ±${cm(rec.fit.estimate)} with ${rec.fit.n} points` } : qualityLine(xr.ev),
        buttons: [
          { id: 'check', label: 'Check', onClick: () => { xr.step = 'check'; xr.check = null; } },
          { id: 'nudge', label: 'Nudge', onClick: () => { xr.step = 'nudge'; } },
          opac,
          { id: 'realign', label: 'Re-align', onClick: realign },
          exit,
        ],
      };
    }
    case 'nudge': {
      const big = xr.nudgeStep >= 0.05;
      return {
        title: 'Fine-tune',
        text: 'Moves are relative to the way you are facing.',
        buttons: [
          { id: 'l', label: '◀ Left', onClick: () => nudge('x', -1) },
          { id: 'r', label: 'Right ▶', onClick: () => nudge('x', 1) },
          { id: 'f', label: '▲ Away', onClick: () => nudge('z', 1) },
          { id: 'b', label: '▼ Closer', onClick: () => nudge('z', -1) },
          { id: 'ccw', label: `⟲ ${big ? '1°' : '0.2°'}`, onClick: () => nudge('yaw', 1) },
          { id: 'cw', label: `⟳ ${big ? '1°' : '0.2°'}`, onClick: () => nudge('yaw', -1) },
          { id: 'u', label: 'Up', onClick: () => nudge('y', 1) },
          { id: 'd', label: 'Down', onClick: () => nudge('y', -1) },
          { id: 'step', label: big ? 'Step 5 cm' : 'Step 1 cm', active: big, onClick: () => { xr.nudgeStep = big ? 0.01 : 0.05; } },
          { id: 'ndone', label: 'Done', kind: 'primary', onClick: () => { xr.step = 'locked'; } },
        ],
      };
    }
    case 'check': {
      const c = xr.check;
      return {
        title: 'Check a point',
        text: xr.pending ? 'Hold still…'
          : c ? `${c.name}: model is ${cm(c.d)} off (${cm(c.h)} sideways, ${cm(c.v)} in height). Tap another point, or Done.`
          : `Aim at any control point in the real room and ${usesPointer() ? 'pull the trigger' : 'tap'}. Shows how far off the model is there.`,
        quality: c ? { grade: c.d <= 0.03 ? 'good' : c.d <= 0.08 ? 'ok' : 'poor', text: c.d <= 0.03 ? 'Within 3 cm' : c.d <= 0.08 ? 'Within 8 cm' : 'More than 8 cm off: re-align or nudge' } : null,
        buttons: [{ id: 'cdone', label: 'Done', kind: 'primary', onClick: () => { xr.step = 'locked'; } }],
      };
    }
  }
  return { title: '', buttons: [exit] };
}

// Phone overlay rendering (the same view model, as DOM).
let overlaySig = '', overlayHandlers = new Map();
function renderOverlay(v) {
  const sig = viewSig(v);
  if (sig === overlaySig) return;
  overlaySig = sig;
  $('ar-title').textContent = v.title || '';
  $('ar-text').textContent = v.text || '';
  const img = $('ar-img');
  img.hidden = !v.img; if (v.img && img.src !== v.img) img.src = v.img;
  const q = $('ar-quality');
  q.className = v.quality?.grade || ''; q.textContent = v.quality?.text || '';
  $('ar-warning').textContent = v.warning || '';
  const box = $('ar-buttons');
  box.textContent = '';
  overlayHandlers = new Map();
  for (const b of v.buttons || []) {
    const el = document.createElement('button');
    el.className = `btn${b.kind === 'primary' ? ' primary' : ''}${b.kind === 'danger' ? ' danger' : ''}${b.active ? ' active' : ''}`;
    el.textContent = b.label; el.disabled = !!b.disabled; el.dataset.id = b.id;
    overlayHandlers.set(b.id, b.onClick);
    box.append(el);
  }
  $('crosshair').hidden = !(S.xr && (S.xr.step === 'collect' || S.xr.step === 'check'));
}
$('ar-buttons').addEventListener('click', (e) => {
  const id = e.target.closest('button')?.dataset.id;
  if (id && overlayHandlers.has(id)) { overlayHandlers.get(id)(); overlaySig = ''; }
});
// Taps on the card must not also count as AR taps.
$('ar-card').addEventListener('beforexrselect', (e) => e.preventDefault());

// ---------------------------------------------------------------- AR frame loop
const _m4 = new THREE.Matrix4(), _camPos = new THREE.Vector3(), _fwd = new THREE.Vector3();
function rayFromController(c) {
  c.updateMatrixWorld(true);
  _m4.identity().extractRotation(c.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_m4);
  raycaster.camera = renderer.xr.getCamera();
}

function currentHit(frame) {
  const xr = S.xr, session = xr.session;
  const pointer = controllers.find((c) => c.userData.source?.targetRayMode === 'tracked-pointer' && c.userData.source.handedness !== 'left')
    || controllers.find((c) => c.userData.source?.targetRayMode === 'tracked-pointer');
  const src = xr.pending?.source?.targetRayMode === 'tracked-pointer' ? xr.pending.source : pointer?.userData.source;
  if (src && xr.ctrlFor !== src && session.requestHitTestSource) {
    xr.ctrlFor = src;
    xr.ctrlHit?.cancel?.();
    xr.ctrlHit = null;
    session.requestHitTestSource({ space: src.targetRaySpace }).then((h) => { if (S.xr === xr && xr.ctrlFor === src) xr.ctrlHit = h; }).catch(() => {});
  }
  const ref = renderer.xr.getReferenceSpace();
  for (const h of [xr.ctrlHit, xr.viewerHit]) {
    if (!h) continue;
    const r = frame.getHitTestResults(h);
    if (r.length) return r[0].getPose(ref);
  }
  return null;
}

function placePanel(dt) {
  const panel = S.xr.panel; if (!panel) return;
  const cam = renderer.xr.getCamera();
  cam.getWorldPosition(_camPos);
  cam.getWorldDirection(_fwd); _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-6) return;
  const onPhone = !IS_HEADSET;
  _fwd.normalize().applyAxisAngle(THREE.Object3D.DEFAULT_UP, onPhone ? 0 : 0.55);
  const desired = _camPos.clone().addScaledVector(_fwd, onPhone ? 0.7 : 0.55);
  desired.y = _camPos.y - (onPhone ? 0.18 : 0.28);
  if (!panel.placed || desired.distanceTo(panel.target) > 0.3) panel.target = desired;
  if (!panel.placed) { panel.mesh.position.copy(desired); panel.placed = true; }
  panel.mesh.position.lerp(panel.target, 1 - Math.exp(-dt * 5));
  panel.mesh.lookAt(_camPos);

  let hover = null;
  for (const c of controllers) {
    if (c.userData.source?.targetRayMode !== 'tracked-pointer') continue;
    rayFromController(c);
    const h = raycaster.intersectObject(panel.mesh, false)[0];
    c.userData.ray.scale.z = h ? h.distance : 3;
    if (h) hover = panel.buttonAt(h.uv);
  }
  panel.setHover(hover);
}

function xrFrame(frame, dt) {
  const xr = S.xr;
  xr.frames++;
  const ref = renderer.xr.getReferenceSpace();

  const aiming = xr.step === 'collect' || xr.step === 'check';
  const pose = aiming ? currentHit(frame) : null;
  reticle.visible = !!pose;
  if (pose) reticle.matrix.fromArray(pose.transform.matrix);

  if (xr.pending) {
    xr.pending.frames++;
    if (pose) { const p = pose.transform.position; xr.pending.samples.push([p.x, p.y, p.z]); }
    if (xr.pending.samples.length >= SAMPLE_TARGET || xr.pending.frames >= SAMPLE_MAX_FRAMES) finishSample();
  }

  if (xr.scanner) { xr.scanner.update(frame, ref, performance.now()); handleMarkers(performance.now()); }

  if (xr.lockRequested) createLockAnchor(frame);

  if (xr.anchor && xr.K) {
    const ap = frame.trackedAnchors?.has(xr.anchor) !== false ? frame.getPose(xr.anchor.anchorSpace, ref) : null;
    if (ap) {
      xr.lostFrames = 0;
      xr.A = (xr.A || new THREE.Matrix4()).fromArray(ap.transform.matrix);
      xr.W = xr.A.clone().multiply(xr.K);
      if (xr.step === 'restoring') xr.step = 'locked';
    } else xr.lostFrames++;
  }
  if (xr.step === 'restoring' && performance.now() - xr.restoreStart > 10000) {
    toast('Could not find the saved alignment. Align with the points instead.');
    xr.anchor = null; xr.K = null; xr.restored = null;
    gotoCollect(0);
  }

  if (xr.W) { stage.matrix.copy(xr.W); stage.matrixWorldNeedsUpdate = true; }
  const lost = xr.anchor && xr.lostFrames > 45;
  stage.visible = !!xr.W && !lost && xr.step !== 'restoring';
  modelHolder.visible = S.opacity > 0;
  pins.visible = xr.step === 'collect' || xr.step === 'review' || xr.step === 'confirm';
  colorMarkers();

  const view = arView();
  if (xr.panel) { placePanel(dt); xr.panel.update(view); }
  else renderOverlay(view);
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
renderer.setAnimationLoop((t, frame) => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (S.xr && frame) xrFrame(frame, dt);
  else if (!S.xr) controls.update();
  renderer.render(scene, camera);
});
addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- start
if (S.room) $('back-link').href = `/?room=${S.room}`;
renderList();
setupXR();
(async () => {
  try {
    if (S.room) {
      const r = await fetch(`/api/rooms/${S.room}/align`);
      if (!r.ok) throw new Error(`room ${S.room} not found`);
      const { model, site } = await r.json();
      if (!model) { toast(`Room ${S.room} has no model yet. Upload one in the room, or open a GLB here.`, true); return; }
      await loadModel({ url: model.url, name: model.name, size: model.size, version: model.version, site });
    } else if (params.get('model')) {
      const url = params.get('model');
      await loadModel({ url, name: decodeURIComponent(url.split('/').pop() || 'model.glb') });
    }
  } catch (err) { toast(`Could not open the room: ${err.message}`, true); }
})();

// For automated checks.
window.__align = { S, scene, camera, renderer, addPoint, pickAt, evaluate, arView, renderOverlay, refit, AlignPanel, handleMarkers, alignFromMarkers };
