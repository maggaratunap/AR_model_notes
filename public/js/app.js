import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { PALETTE, NoteObject, Avatar } from './notes.js';
import { XRMenu, XRKeyboard } from './xr-ui.js';

// Fast raycasting against large (BIM-sized) meshes.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const $ = (id) => document.getElementById(id);
const UA = navigator.userAgent;
const IS_TOUCH_MAC = navigator.maxTouchPoints > 1 && /Macintosh/.test(UA);
const DEVICE = /OculusBrowser|Quest|Pico|Wolvic/i.test(UA) ? 'headset'
  : /iPad|Tablet/i.test(UA) || IS_TOUCH_MAC || (/Android/i.test(UA) && !/Mobile/i.test(UA)) ? 'tablet'
  : /Android|iPhone|Mobile/i.test(UA) ? 'phone' : 'desktop';
const DEVICE_LABEL = { headset: 'Headset', phone: 'Phone', tablet: 'Tablet', desktop: 'Desktop' };
const IS_IOS = /iPhone|iPad/.test(UA) || IS_TOUCH_MAC;
const USER_COLORS = ['#4F8EF7', '#F76B4F', '#2DBE8C', '#B46BF7', '#F7B84F', '#22B8CF', '#F74FA3'];
const SCALE_TARGET = { table: 0.5, large: 2.0 }; // meters across the longest side; 'real' keeps native size
const ROT_STEP = Math.PI / 12;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'n' + Math.random().toString(36).slice(2) + Date.now().toString(36));
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const S = {
  room: null, name: '', myColor: store.get('amn-color') || USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)],
  me: null, users: new Map(), avatars: new Map(), notes: new Map(),
  model: null, modelVersion: null, scaleMode: 'table', modelScale: 1,
  addMode: false, color: PALETTE[0], editing: null, moving: null,
  xr: null, xrModes: { ar: false, vr: false }, loadToken: 0, camTween: null,
};
store.set('amn-color', S.myColor);

// ---------------------------------------------------------------- renderer / scene
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.xr.enabled = true;

const scene = new THREE.Scene();
// The 3D view draws its own opaque backdrop; AR clears to transparent so the camera feed shows through.
const backdrop = (() => {
  const c = document.createElement('canvas'); c.width = 2; c.height = 256;
  const g = c.getContext('2d').createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#22262e'); g.addColorStop(1, '#0c0d10');
  const ctx = c.getContext('2d'); ctx.fillStyle = g; ctx.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const VR_BG = new THREE.Color(0x1a1d23);
function setBackdrop(mode) {
  scene.background = mode === 'ar' ? null : mode === 'vr' ? VR_BG : backdrop;
  renderer.setClearColor(0x000000, mode === 'ar' ? 0 : 1);
}
setBackdrop('3d');
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 500);
camera.position.set(0.6, 0.5, 0.8);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0, 0.12, 0);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 0.3));
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(3, 6, 4);
scene.add(sun);

// stage (placement in the room) > scaler (display scale) > content (model coordinates)
const stage = new THREE.Group();
const scaler = new THREE.Group();
const content = new THREE.Group();
const modelHolder = new THREE.Group();
const notesGroup = new THREE.Group();
const avatarsGroup = new THREE.Group();
scene.add(stage); stage.add(scaler); scaler.add(content);
content.add(modelHolder, notesGroup, avatarsGroup);
notesGroup.visible = false;

const grid = new THREE.GridHelper(1, 20, 0x5d626c, 0x30343b);
grid.material.transparent = true; grid.material.opacity = 0.55;
scene.add(grid);

const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.05, 0.065, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffd447, depthTest: false, transparent: true }),
);
reticle.renderOrder = 999;
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(new DRACOLoader().setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/'));
gltfLoader.setKTX2Loader(new KTX2Loader().setTranscoderPath('/vendor/three/examples/jsm/libs/basis/').detectSupport(renderer));
gltfLoader.setMeshoptDecoder(MeshoptDecoder);

// ---------------------------------------------------------------- small UI helpers
function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('toasts').append(el);
  setTimeout(() => el.remove(), err ? 6000 : 3500);
  if (xrUI.menu && S.xr) {
    xrUI.menu.setStatus(msg);
    clearTimeout(xrUI.statusTimer);
    xrUI.statusTimer = setTimeout(() => xrUI.menu?.setStatus(''), 3500);
  }
}
function setHint(text) {
  $('hint').hidden = !text;
  $('hint').textContent = text || '';
  if (xrUI.menu && S.xr) xrUI.menu.setStatus(text || '');
}
function showLoading(frac, text) {
  $('loading').hidden = frac == null;
  if (frac == null) return;
  $('loading-bar').style.width = `${Math.round(frac * 100)}%`;
  if (text) $('loading-text').textContent = text;
}
const displaySize = () => (S.model ? S.model.maxDim * S.modelScale : 0.5);
const noteWorldSize = () => THREE.MathUtils.clamp(0.1 * Math.sqrt(Math.max(displaySize(), 0.3) / 0.5), 0.06, 0.6);
const avatarSize = () => noteWorldSize() / 0.1;

// ---------------------------------------------------------------- model
function disposeObject(root) {
  root.traverse((o) => {
    if (o.geometry) { o.geometry.disposeBoundsTree?.(); o.geometry.dispose(); }
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose();
    }
  });
}

function clearModel() {
  if (S.model) { modelHolder.remove(S.model.root); disposeObject(S.model.root); }
  S.model = null;
  notesGroup.visible = false;
}

async function loadModel(meta) {
  const token = ++S.loadToken;
  clearModel();
  S.modelVersion = meta?.version ?? null;
  $('empty').hidden = !!meta;
  if (!meta) { showLoading(null); return; }
  showLoading(0, `Loading ${meta.name}…`);
  try {
    const gltf = await gltfLoader.loadAsync(meta.url, (e) => {
      if (e.total) showLoading(e.loaded / e.total, `Loading ${meta.name}… ${Math.round((e.loaded / e.total) * 100)}%`);
    });
    if (token !== S.loadToken) { disposeObject(gltf.scene); return; }
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) throw new Error('the file has no visible geometry');
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    root.traverse((o) => {
      if (o.isMesh && !o.isSkinnedMesh && !o.isInstancedMesh && o.geometry?.attributes.position) o.geometry.computeBoundsTree();
    });
    modelHolder.add(root);
    content.position.set(-center.x, -box.min.y, -center.z);
    S.model = { meta, root, size, maxDim: Math.max(size.x, size.y, size.z) || 1 };
    notesGroup.visible = true;
    showLoading(null);
    applyLayout(true);
  } catch (err) {
    if (token !== S.loadToken) return;
    console.error(err);
    showLoading(null);
    $('empty').hidden = false;
    toast(`Could not load the model: ${err.message || err}`, true);
  }
}

function applyLayout(reframe = false) {
  if (!S.model) return;
  const target = S.scaleMode === 'real' ? S.model.maxDim : SCALE_TARGET[S.scaleMode];
  S.modelScale = target / S.model.maxDim;
  scaler.scale.setScalar(S.modelScale);
  const w = noteWorldSize();
  for (const n of S.notes.values()) n.layout(w, S.modelScale);
  const d = displaySize();
  grid.scale.setScalar(Math.max(1, Math.ceil(d * 2.5)));
  camera.far = Math.max(200, d * 40);
  camera.near = Math.max(0.005, Math.min(0.05, d / 500));
  camera.updateProjectionMatrix();
  if (!S.xr && reframe) frameCamera();
  if (S.xr?.mode === 'vr') S.xr.needsVRPlace = true;
}

function frameCamera() {
  const d = displaySize();
  const h = S.model ? S.model.size.y * S.modelScale : 0.25;
  const dist = d * 1.5 + 0.25;
  controls.target.set(0, h * 0.4, 0);
  camera.position.set(dist * 0.62, h * 0.4 + dist * 0.55, dist * 0.82);
  controls.maxDistance = d * 12 + 5;
  controls.update();
}

// ---------------------------------------------------------------- notes
function upsertNote(data) {
  let n = S.notes.get(data.id);
  if (n) n.update(data);
  else {
    n = new NoteObject(data);
    S.notes.set(data.id, n);
    notesGroup.add(n.group);
  }
  if (S.model) n.layout(noteWorldSize(), S.modelScale);
  renderNotesList();
  return n;
}

function removeNote(id) {
  const n = S.notes.get(id);
  if (!n) return;
  if (S.editing === id) closeEditor({ keepEmpty: true });
  if (S.moving === id) cancelMove();
  notesGroup.remove(n.group);
  n.dispose();
  S.notes.delete(id);
  renderNotesList();
}

function clearNotes() {
  for (const id of [...S.notes.keys()]) removeNote(id);
}

const pending = new Map();
let pendingTimer = null;
function queueUpdate(id, fields) {
  pending.set(id, { ...(pending.get(id) || {}), ...fields });
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(flushUpdates, 220);
}
function flushUpdates() {
  clearTimeout(pendingTimer);
  for (const [id, f] of pending) send({ type: 'note-update', note: { id, ...f } });
  pending.clear();
}

function contentHit(hit) {
  const p = content.worldToLocal(hit.point.clone());
  const n = new THREE.Vector3(0, 1, 0);
  if (hit.face) {
    n.copy(hit.face.normal).applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
    if (n.dot(raycaster.ray.direction) > 0) n.negate();
    n.applyQuaternion(content.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
  }
  return { position: p.toArray().map(r4), normal: n.toArray().map(r4) };
}

function addNoteAt(hit) {
  const { position, normal } = contentHit(hit);
  const note = { id: uid(), position, normal, color: S.color, text: '', author: S.name, authorId: S.me?.id, created: Date.now() };
  upsertNote(note);
  send({ type: 'note-add', note });
  openEditor(note.id, true);
}

function deleteNote(id) {
  pending.delete(id);
  send({ type: 'note-delete', id });
  removeNote(id);
}

function startMove(id) {
  flushUpdates();
  closeEditor({ keepEmpty: true });
  S.moving = id;
  S.notes.get(id)?.setSelected(true);
  setHint(S.xr && !S.xr.domOverlay ? 'Point at the model and pull the trigger to move the note' : 'Tap the model where the note should go  (Esc to cancel)');
}
function cancelMove() {
  S.notes.get(S.moving)?.setSelected(false);
  S.moving = null;
  setHint(null);
}
function moveNoteTo(id, hit) {
  const n = S.notes.get(id);
  if (!n) return cancelMove();
  const { position, normal } = contentHit(hit);
  n.update({ position, normal });
  n.layout(noteWorldSize(), S.modelScale);
  send({ type: 'note-update', note: { id, position, normal } });
  cancelMove();
}

// ---------------------------------------------------------------- editor (DOM + headset keyboard)
const editorText = $('editor-text');
const useXRKeyboard = () => S.xr && !S.xr.domOverlay;

function openEditor(id, isNew = false) {
  const n = S.notes.get(id);
  if (!n) return;
  if (S.editing && S.editing !== id) closeEditor();
  S.editing = id;
  n.setSelected(true);
  if (useXRKeyboard()) return openXRKeyboard(n);
  editorText.value = n.data.text || '';
  syncEditorChrome(n);
  $('editor-wrap').hidden = false;
  if (isNew || DEVICE === 'desktop') setTimeout(() => editorText.focus(), 30);
}

function syncEditorChrome(n) {
  editorText.style.setProperty('--note', n.data.color);
  const when = n.data.updated || n.data.created;
  const by = n.data.author ? `${n.data.author}` : '';
  $('editor-meta').textContent = [by, when ? new Date(when).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '']
    .filter(Boolean).join(' · ') + (n.data.editedBy && n.data.editedBy !== n.data.author ? ` · edited by ${n.data.editedBy}` : '');
  buildSwatches($('editor-swatches'), n.data.color, (c) => setNoteColor(n.data.id, c));
}

function setNoteColor(id, color) {
  const n = S.notes.get(id);
  if (!n) return;
  n.update({ color });
  send({ type: 'note-update', note: { id, color } });
  if (S.editing === id) {
    if (useXRKeyboard()) xrUI.keyboard?.setColor(color); else syncEditorChrome(n);
  }
  S.color = color;
  buildSwatches($('swatches'), S.color, setColor);
}

function closeEditor({ keepEmpty = false } = {}) {
  const id = S.editing;
  if (!id) return;
  flushUpdates();
  S.editing = null;
  $('editor-wrap').hidden = true;
  editorText.blur();
  if (xrUI.keyboard) xrUI.keyboard.mesh.visible = false;
  if (xrUI.menu && S.xr) xrUI.menu.mesh.visible = true;
  const n = S.notes.get(id);
  if (!n) return;
  n.setSelected(false);
  if (!keepEmpty && !n.data.text.trim()) deleteNote(id);
}

editorText.addEventListener('input', () => {
  const id = S.editing; const n = S.notes.get(id);
  if (!n) return;
  n.update({ text: editorText.value });
  queueUpdate(id, { text: editorText.value });
  renderNotesList();
});
$('editor-done').onclick = () => closeEditor();
$('editor-close').onclick = () => closeEditor();
$('editor-delete').onclick = () => S.editing && deleteNote(S.editing);
$('editor-move').onclick = () => S.editing && startMove(S.editing);
$('editor-wrap').addEventListener('pointerdown', (e) => { if (e.target === $('editor-wrap')) closeEditor(); });

// ---------------------------------------------------------------- toolbar
function buildSwatches(el, active, onPick) {
  el.replaceChildren(...PALETTE.map((c) => {
    const b = document.createElement('button');
    b.className = 'swatch'; b.style.background = c;
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(c === active));
    b.setAttribute('aria-label', `Color ${c}`);
    b.onclick = () => onPick(c);
    return b;
  }));
}
function setColor(c) {
  S.color = c;
  buildSwatches($('swatches'), c, setColor);
}
buildSwatches($('swatches'), S.color, setColor);

function setAddMode(on) {
  S.addMode = on;
  $('add-btn').setAttribute('aria-pressed', String(on));
  canvas.style.cursor = on ? 'crosshair' : '';
  if (on && S.moving) cancelMove();
  if (on) setHint(S.xr && !S.xr.domOverlay ? 'Point at the model and pull the trigger to pin a note' : 'Tap the model to pin a note');
  else if (!S.moving && !(S.xr && !S.xr.placed)) setHint(null);
}
$('add-btn').onclick = () => {
  if (!S.model) return toast('Upload a model first', true);
  setAddMode(!S.addMode);
};

$('scale-select').onchange = (e) => setScale(e.target.value);
function setScale(mode) {
  S.scaleMode = mode;
  $('scale-select').value = mode;
  applyLayout(true);
  send({ type: 'scale', scaleMode: mode });
}

$('list-btn').onclick = () => { $('notes-drawer').hidden = !$('notes-drawer').hidden; renderNotesList(); };
$('drawer-close').onclick = () => { $('notes-drawer').hidden = true; };

function renderNotesList() {
  $('note-count').textContent = S.notes.size;
  if ($('notes-drawer').hidden) return;
  const list = $('notes-list');
  const notes = [...S.notes.values()].map((n) => n.data).sort((a, b) => (a.created || 0) - (b.created || 0));
  if (!notes.length) {
    list.innerHTML = '<li class="none">No notes yet. Turn on “Add note” and tap the model.</li>';
    return;
  }
  list.replaceChildren(...notes.map((d) => {
    const li = document.createElement('li');
    li.style.background = d.color;
    li.textContent = d.text || '(empty)';
    const meta = document.createElement('small');
    meta.textContent = d.author || '';
    li.append(meta);
    li.onclick = () => focusNote(d.id);
    return li;
  }));
}

function focusNote(id) {
  const n = S.notes.get(id);
  if (!n || S.xr) return openEditor(id);
  const target = n.card.getWorldPosition(new THREE.Vector3());
  const offset = camera.position.clone().sub(controls.target).normalize().multiplyScalar(noteWorldSize() * 7 + displaySize() * 0.3);
  S.camTween = { t: 0, fromT: controls.target.clone(), toT: target, fromP: camera.position.clone(), toP: target.clone().add(offset), then: () => openEditor(id) };
}

// ---------------------------------------------------------------- upload
$('file-input').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadFile(f); };

function uploadFile(file) {
  if (!/\.glb$/i.test(file.name)) return toast('Please choose a .glb file (binary glTF).', true);
  if (S.notes.size && !confirm(`Replacing the model removes its ${S.notes.size} note(s) for everyone. Continue?`)) return;
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/rooms/${S.room}/model`);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
  xhr.setRequestHeader('x-user-name', encodeURIComponent(S.name));
  xhr.upload.onprogress = (e) => e.lengthComputable && showLoading(e.loaded / e.total, `Uploading ${file.name}… ${Math.round((e.loaded / e.total) * 100)}%`);
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) return; // the server broadcasts the new model to everyone
    showLoading(null);
    let msg = `Upload failed (${xhr.status})`;
    try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* not JSON */ }
    toast(msg, true);
  };
  xhr.onerror = () => { showLoading(null); toast('Upload failed: network error', true); };
  showLoading(0, `Uploading ${file.name}…`);
  xhr.send(file);
}

let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); if (S.room) { dragDepth++; document.body.classList.add('dragging'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (f && S.room) uploadFile(f);
});

// ---------------------------------------------------------------- users / avatars
function renderUsers() {
  const el = $('users');
  const users = [...S.users.values()].sort((a, b) => (a.id === S.me?.id ? -1 : b.id === S.me?.id ? 1 : 0));
  el.replaceChildren(...users.map((u) => {
    const d = document.createElement('span');
    d.className = 'user';
    const i = document.createElement('i');
    i.style.background = u.color; i.textContent = (u.name[0] || '?').toUpperCase();
    const name = document.createElement('span');
    name.textContent = u.id === S.me?.id ? `${u.name} (you)` : u.name;
    const dev = document.createElement('small');
    dev.textContent = DEVICE_LABEL[u.device] || '';
    d.append(i, name, dev);
    return d;
  }));
}
function addUser(u) {
  S.users.set(u.id, u);
  if (u.id !== S.me?.id) {
    S.avatars.get(u.id)?.dispose();
    if (S.avatars.has(u.id)) avatarsGroup.remove(S.avatars.get(u.id).group);
    const a = new Avatar(u);
    S.avatars.set(u.id, a);
    avatarsGroup.add(a.group);
  }
}
function removeUser(id) {
  S.users.delete(id);
  const a = S.avatars.get(id);
  if (a) { avatarsGroup.remove(a.group); a.dispose(); S.avatars.delete(id); }
}

let lastPoseSent = 0, lastPoseKey = '';
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _cq = new THREE.Quaternion();
function maybeSendPose(now) {
  if (!S.model || !S.me || now - lastPoseSent < 100) return;
  if (S.xr && !S.xr.placed) return;
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  cam.getWorldPosition(_p); cam.getWorldQuaternion(_q);
  content.worldToLocal(_p);
  content.getWorldQuaternion(_cq).invert().multiply(_q);
  const p = _p.toArray().map(r4), q = _cq.toArray().map((v) => Math.round(v * 1000) / 1000);
  const key = p.join() + q.join();
  if (key === lastPoseKey && now - lastPoseSent < 2000) return;
  lastPoseKey = key; lastPoseSent = now;
  send({ type: 'pose', p, q, mode: S.xr ? S.xr.mode : '3d' });
}

// ---------------------------------------------------------------- networking
let ws = null, retry = 0;
function send(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }
function setLive(on) {
  const dot = document.querySelector('#room-chip .dot');
  dot.classList.toggle('live', on); dot.classList.toggle('off', !on);
}
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 0;
    setLive(true);
    send({ type: 'join', room: S.room, name: S.name, color: S.myColor, device: DEVICE });
  };
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => {
    setLive(false);
    setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
  };
}

function keepLocalEdits(data, from) {
  // While I'm typing in a note, my local text/color are newer than any echo.
  if (S.editing === data.id && (from === S.me?.id || (!from && data.authorId === S.me?.id))) {
    const local = S.notes.get(data.id)?.data;
    if (local) return { ...data, text: local.text, color: local.color };
  }
  return data;
}

function handle(msg) {
  switch (msg.type) {
    case 'state': {
      S.me = msg.you;
      for (const id of [...S.users.keys()]) removeUser(id);
      for (const u of msg.users) addUser(u);
      addUser(S.me);
      renderUsers();
      S.scaleMode = msg.scaleMode;
      $('scale-select').value = msg.scaleMode;
      const ids = new Set(msg.notes.map((n) => n.id));
      for (const id of [...S.notes.keys()]) if (!ids.has(id)) removeNote(id);
      for (const n of msg.notes) upsertNote(keepLocalEdits(n));
      if ((msg.model?.version ?? null) !== S.modelVersion) loadModel(msg.model);
      else applyLayout(null);
      break;
    }
    case 'model':
      clearNotes();
      setAddMode(false);
      loadModel(msg.model);
      if (msg.model) toast(`${msg.model.uploadedBy} uploaded ${msg.model.name}`);
      break;
    case 'note': {
      const n = upsertNote(keepLocalEdits(msg.note, msg.from));
      if (S.editing === msg.note.id && msg.from && msg.from !== S.me?.id) {
        if (useXRKeyboard()) xrUI.keyboard?.open(n.data);
        else {
          if (document.activeElement !== editorText) editorText.value = n.data.text;
          syncEditorChrome(n);
        }
      }
      break;
    }
    case 'note-delete':
      removeNote(msg.id);
      break;
    case 'scale':
      S.scaleMode = msg.scaleMode;
      $('scale-select').value = msg.scaleMode;
      applyLayout(true);
      toast(`${msg.by} set scale to ${$('scale-select').selectedOptions[0].textContent}`);
      break;
    case 'user-joined':
      if (!S.users.has(msg.user.id)) toast(`${msg.user.name} joined`);
      addUser(msg.user); renderUsers();
      break;
    case 'user-left': {
      const u = S.users.get(msg.id);
      removeUser(msg.id); renderUsers();
      if (u) toast(`${u.name} left`);
      break;
    }
    case 'pose':
      S.avatars.get(msg.id)?.setPose(msg.p, msg.q);
      break;
  }
}

// ---------------------------------------------------------------- picking
const raycaster = new THREE.Raycaster();
raycaster.params.Line.threshold = 0;

function isShown(o) { for (; o; o = o.parent) if (!o.visible) return false; return true; }

function pickNote() {
  if (!notesGroup.visible) return null;
  raycaster.camera = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  return raycaster.intersectObjects(notesGroup.children, true).find((h) => h.object.userData.noteId && isShown(h.object)) || null;
}
function pickModel() {
  if (!S.model) return null;
  raycaster.firstHitOnly = true;
  const hits = raycaster.intersectObject(S.model.root, true);
  raycaster.firstHitOnly = false;
  return hits.find((h) => isShown(h.object)) || null;
}

function handleSelect() {
  const nh = pickNote();
  const mh = pickModel();
  if (S.moving) {
    if (mh) moveNoteTo(S.moving, mh); else setHint('That missed the model. Try again, or press Esc to cancel');
    return;
  }
  if (nh && (!mh || nh.distance <= mh.distance + 0.02)) { openEditor(nh.object.userData.noteId); return; }
  if (S.editing) { closeEditor(); return; }
  if (S.addMode) { if (mh) addNoteAt(mh); return; }
  if (mh && !S.xr) setHint('Turn on “Add note” (or press N) to pin a note');
}

// mouse / touch in the regular 3D view
const pointers = new Map();
let tapStart = null;
canvas.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, e);
  tapStart = pointers.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null;
});
canvas.addEventListener('pointerup', (e) => {
  pointers.delete(e.pointerId);
  if (!tapStart || tapStart.id !== e.pointerId || S.xr) return;
  if (Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) < 8 && performance.now() - tapStart.t < 600) {
    raycaster.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
    handleSelect();
  }
  tapStart = null;
});
canvas.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); tapStart = null; });
let hoverQueued = false;
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || hoverQueued || S.xr) return;
  hoverQueued = true;
  requestAnimationFrame(() => {
    hoverQueued = false;
    raycaster.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
    canvas.style.cursor = pickNote() ? 'pointer' : S.addMode || S.moving ? 'crosshair' : '';
  });
});

addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) {
    if (e.key === 'Escape') closeEditor();
    return;
  }
  if (e.key === 'Escape') {
    if (S.moving) cancelMove(); else if (S.addMode) setAddMode(false);
    $('share-wrap').hidden = true;
  } else if (e.key === 'n' || e.key === 'N') $('add-btn').click();
});

// ---------------------------------------------------------------- WebXR
const xrUI = { menu: null, keyboard: null, statusTimer: null, lastSig: '' };
const controllers = [0, 1].map((i) => {
  const c = renderer.xr.getController(i);
  const ray = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }),
  );
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.006, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd447, depthTest: false }));
  dot.renderOrder = 1001;
  ray.visible = dot.visible = false;
  c.add(ray, dot);
  c.userData = { ray, dot, source: null };
  c.addEventListener('connected', (e) => {
    c.userData.source = e.data;
    ray.visible = dot.visible = e.data.targetRayMode === 'tracked-pointer';
  });
  c.addEventListener('disconnected', () => { c.userData.source = null; ray.visible = dot.visible = false; });
  c.addEventListener('select', () => onXRSelect(c));
  scene.add(c);
  return c;
});

const _m4 = new THREE.Matrix4();
function rayFromController(c) {
  c.updateMatrixWorld(true);
  _m4.identity().extractRotation(c.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_m4);
  raycaster.camera = renderer.xr.getCamera();
}
function pickPanel() {
  const meshes = [xrUI.menu?.mesh, xrUI.keyboard?.mesh].filter((m) => m?.visible);
  return meshes.length ? raycaster.intersectObjects(meshes, false)[0] || null : null;
}

function onXRSelect(c) {
  if (!S.xr) return;
  rayFromController(c);
  const ph = pickPanel();
  if (ph) { ph.object.userData.panel.click(ph.uv); return; }
  if (!S.xr.placed) { placeHere(); return; }
  handleSelect();
}

async function setupXR() {
  if (!navigator.xr) {
    $('xr-support').textContent = IS_IOS
      ? 'iPhone and iPad browsers do not support WebXR AR yet. You can still view the model and notes in 3D here, synced live.'
      : 'This browser has no WebXR. Use Chrome on Android or Meta Quest Browser for AR. The 3D view still works here.';
    return;
  }
  const [ar, vr] = await Promise.all([
    navigator.xr.isSessionSupported('immersive-ar').catch(() => false),
    navigator.xr.isSessionSupported('immersive-vr').catch(() => false),
  ]);
  S.xrModes = { ar, vr };
  const btn = $('xr-btn');
  if (ar || vr) {
    btn.hidden = false;
    btn.textContent = ar ? 'Enter AR' : 'Enter VR';
    btn.onclick = () => startXR(ar ? 'ar' : 'vr');
  }
  $('xr-support').textContent = ar ? 'This device supports AR.' : vr ? 'This device supports VR (no passthrough AR).'
    : 'This device cannot start an AR session. The 3D view still works and stays in sync.';
}

async function startXR(mode) {
  if (!S.model) return toast('Upload a model first', true);
  if (S.editing) closeEditor();
  const opts = { optionalFeatures: ['local-floor', 'hit-test', 'hand-tracking'] };
  if (mode === 'ar') { opts.optionalFeatures.push('dom-overlay'); opts.domOverlay = { root: $('ui') }; }
  let session;
  try {
    session = await navigator.xr.requestSession(mode === 'ar' ? 'immersive-ar' : 'immersive-vr', opts);
  } catch (err) {
    return toast(`Could not start ${mode.toUpperCase()}: ${err.message}`, true);
  }
  const ef = session.enabledFeatures;
  const floor = ef ? ef.includes('local-floor') : DEVICE === 'headset';
  renderer.xr.setReferenceSpaceType(floor ? 'local-floor' : 'local');
  S.xr = { session, mode, floor, placed: false, domOverlay: !!session.domOverlayState, viewerHit: null, ctrlHit: null, ctrlHitFor: null, needsVRPlace: mode === 'vr' };
  try {
    await renderer.xr.setSession(session);
  } catch (err) {
    S.xr = null;
    session.end().catch(() => {});
    return toast(`Could not start ${mode.toUpperCase()}: ${err.message}`, true);
  }
  document.body.classList.add('in-xr');
  setBackdrop(mode);
  $('notes-drawer').hidden = true;
  controls.enabled = false;
  grid.visible = mode === 'vr';
  stage.rotation.set(0, 0, 0);
  session.addEventListener('end', onXREnd);

  if (mode === 'ar' && (!ef || ef.includes('hit-test'))) {
    session.requestReferenceSpace('viewer')
      .then((vs) => session.requestHitTestSource({ space: vs }))
      .then((src) => { if (S.xr?.session === session) S.xr.viewerHit = src; })
      .catch(() => {});
  }
  if (!S.xr.domOverlay) createXRPanels();
  if (mode === 'ar') {
    stage.visible = false;
    setHint(DEVICE === 'headset' || !S.xr.domOverlay
      ? 'Aim at a table or the floor and pull the trigger to place the model'
      : 'Slowly move your phone to find a surface, then tap to place the model');
  } else {
    S.xr.placed = true;
    setHint(null);
  }
}

function onXREnd() {
  const wasEditing = S.editing;
  if (wasEditing) closeEditor();
  S.xr = null;
  document.body.classList.remove('in-xr');
  setBackdrop('3d');
  for (const p of [xrUI.menu, xrUI.keyboard]) if (p) { scene.remove(p.mesh); p.texture.dispose(); p.mesh.geometry.dispose(); p.mesh.material.dispose(); }
  xrUI.menu = xrUI.keyboard = null;
  reticle.visible = false;
  stage.visible = true;
  stage.position.set(0, 0, 0);
  stage.rotation.set(0, 0, 0);
  grid.visible = true;
  grid.position.set(0, 0, 0);
  controls.enabled = true;
  setHint(S.addMode ? 'Tap the model to pin a note' : null);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  applyLayout(true);
}

function createXRPanels() {
  xrUI.menu = new XRMenu({
    toggleAdd: () => setAddMode(!S.addMode),
    rotate: (dir) => rotateStage(dir),
    replace: () => startReplace(),
    setColor: (c) => setColor(c),
    setScale: (m) => setScale(m),
    exit: () => S.xr?.session.end(),
  }, () => ({
    room: S.room, users: S.users.size, notes: S.notes.size, addMode: S.addMode,
    placing: S.xr ? !S.xr.placed : false, color: S.color, scaleMode: S.scaleMode,
  }));
  xrUI.keyboard = new XRKeyboard({
    change: (text) => {
      const n = S.notes.get(S.editing); if (!n) return;
      n.update({ text }); queueUpdate(n.data.id, { text });
    },
    setColor: (c) => S.editing && setNoteColor(S.editing, c),
    done: () => closeEditor(),
    del: () => S.editing && deleteNote(S.editing),
    move: () => S.editing && startMove(S.editing),
  });
  xrUI.keyboard.mesh.visible = false;
  xrUI.menu.placed = false;
  scene.add(xrUI.menu.mesh, xrUI.keyboard.mesh);
}

function openXRKeyboard(n) {
  const kb = xrUI.keyboard;
  kb.open(n.data);
  const cam = renderer.xr.getCamera();
  const pos = cam.getWorldPosition(new THREE.Vector3());
  const fwd = cam.getWorldDirection(new THREE.Vector3()); fwd.y = 0; fwd.normalize();
  kb.mesh.position.copy(pos).addScaledVector(fwd, 0.5); kb.mesh.position.y -= 0.22;
  kb.mesh.lookAt(pos);
  kb.mesh.visible = true;
  xrUI.menu.mesh.visible = false;
}

function rotateStage(dir) {
  stage.rotation.y += dir * ROT_STEP;
  if (S.xr) S.xr.yawOffset = (S.xr.yawOffset || 0) + dir * ROT_STEP;
}
function startReplace() {
  if (!S.xr) return;
  if (S.xr.mode === 'vr') { S.xr.needsVRPlace = true; return; }
  S.xr.placed = false;
  setHint(S.xr.domOverlay ? 'Tap to place the model' : 'Aim at a surface and pull the trigger to place the model');
}
$('rot-left').onclick = () => rotateStage(1);
$('rot-right').onclick = () => rotateStage(-1);
$('replace-btn').onclick = () => startReplace();
$('xr-exit').onclick = () => S.xr?.session.end();
// Taps on overlay controls must not also count as taps in the AR scene.
for (const el of document.querySelectorAll('.xr-block, .modal-wrap')) el.addEventListener('beforexrselect', (e) => e.preventDefault());

const _v = new THREE.Vector3(), _camPos = new THREE.Vector3(), _fwd = new THREE.Vector3();
function faceCamera(pos) {
  const cam = renderer.xr.getCamera();
  cam.getWorldPosition(_camPos);
  return Math.atan2(_camPos.x - pos.x, _camPos.z - pos.z) + (S.xr.yawOffset || 0);
}

function placeHere() {
  S.xr.placed = true;
  reticle.visible = false;
  stage.visible = true;
  setHint(null);
  toast(S.xr.domOverlay ? 'Placed. Turn on “Add note” and tap the model.' : 'Placed. Use “Add note”, then aim and pull the trigger.');
}

function updatePlacement(frame) {
  const xr = S.xr;
  const session = xr.session;
  // Prefer a hit-test ray from a tracked controller/hand (Quest), else from the screen centre (phones).
  const pointer = controllers.find((c) => c.userData.source?.targetRayMode === 'tracked-pointer' && c.userData.source.handedness !== 'left')
    || controllers.find((c) => c.userData.source?.targetRayMode === 'tracked-pointer');
  const src = pointer?.userData.source;
  if (src && xr.ctrlHitFor !== src && session.requestHitTestSource && (!session.enabledFeatures || session.enabledFeatures.includes('hit-test'))) {
    xr.ctrlHitFor = src;
    xr.ctrlHit?.cancel?.();
    xr.ctrlHit = null;
    session.requestHitTestSource({ space: src.targetRaySpace }).then((h) => { if (S.xr === xr && xr.ctrlHitFor === src) xr.ctrlHit = h; }).catch(() => {});
  }
  const ref = renderer.xr.getReferenceSpace();
  let pose = null;
  for (const h of [xr.ctrlHit, xr.viewerHit]) {
    if (!h) continue;
    const r = frame.getHitTestResults(h);
    if (r.length) { pose = r[0].getPose(ref); break; }
  }
  if (pose) {
    reticle.matrix.fromArray(pose.transform.matrix);
    reticle.visible = true;
    _v.setFromMatrixPosition(reticle.matrix);
    stage.position.copy(_v);
  } else {
    // No surface found: hover the preview in front of the user.
    reticle.visible = false;
    const cam = renderer.xr.getCamera();
    cam.getWorldPosition(_camPos);
    cam.getWorldDirection(_fwd); _fwd.y = 0; _fwd.normalize();
    stage.position.copy(_camPos).addScaledVector(_fwd, 0.6 + displaySize() * 0.5);
    stage.position.y = _camPos.y - 0.5;
  }
  stage.rotation.y = faceCamera(stage.position);
  stage.visible = true;
}

function placeVR() {
  const cam = renderer.xr.getCamera();
  cam.getWorldPosition(_camPos);
  cam.getWorldDirection(_fwd); _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
  _fwd.normalize();
  const d = displaySize();
  const floorY = S.xr.floor ? 0 : _camPos.y - 1.6;
  stage.position.copy(_camPos).addScaledVector(_fwd, S.scaleMode === 'table' ? 0.8 : Math.min(d * 0.6 + 0.8, 6));
  stage.position.y = floorY + (S.scaleMode === 'table' ? 0.8 : 0);
  stage.rotation.y = faceCamera(stage.position);
  grid.position.set(stage.position.x, floorY, stage.position.z);
}

function updateXRUI(dt) {
  const menu = xrUI.menu;
  if (menu) {
    const sig = JSON.stringify(menu.state());
    if (sig !== xrUI.lastSig) { xrUI.lastSig = sig; menu.dirty = true; }
    // Lazy "tag-along": the menu floats low and to the left, catching up when you turn away.
    const cam = renderer.xr.getCamera();
    cam.getWorldPosition(_camPos);
    cam.getWorldDirection(_fwd); _fwd.y = 0;
    if (_fwd.lengthSq() > 1e-6) {
      _fwd.normalize().applyAxisAngle(THREE.Object3D.DEFAULT_UP, 0.6);
      const desired = _camPos.clone().addScaledVector(_fwd, 0.55);
      desired.y = _camPos.y - 0.3;
      if (!menu.placed || !menu.target || desired.distanceTo(menu.target) > 0.3) { menu.target = desired; }
      if (!menu.placed) { menu.mesh.position.copy(desired); menu.placed = true; }
      menu.mesh.position.lerp(menu.target, 1 - Math.exp(-dt * 5));
      menu.mesh.lookAt(_camPos);
    }
    menu.flush();
  }
  xrUI.keyboard?.flush();

  // Pointer rays: hover highlight + ray length.
  const hovered = new Map();
  for (const c of controllers) {
    const { ray, dot, source } = c.userData;
    if (source?.targetRayMode !== 'tracked-pointer') continue;
    rayFromController(c);
    const ph = pickPanel();
    let dist = 4;
    if (ph) {
      dist = ph.distance;
      const panel = ph.object.userData.panel;
      hovered.set(panel, panel.buttonAt(ph.uv));
    } else {
      const nh = pickNote(); const mh = pickModel();
      dist = Math.min(nh?.distance ?? 4, mh?.distance ?? 4);
    }
    ray.scale.z = dist;
    dot.position.set(0, 0, -dist);
    dot.visible = dist < 4;

    // Thumbstick left/right spins the model.
    const axes = source.gamepad?.axes;
    if (axes && axes.length >= 4 && Math.abs(axes[2]) > 0.5) {
      stage.rotation.y -= axes[2] * dt * 1.6;
      S.xr.yawOffset = (S.xr.yawOffset || 0) - axes[2] * dt * 1.6;
    }
  }
  for (const p of [xrUI.menu, xrUI.keyboard]) if (p) p.setHover(hovered.get(p) || null);
}

function xrFrame(frame, dt) {
  S.xr.frames = (S.xr.frames || 0) + 1;
  // Wait a few frames so the headset pose is known before placing the model in VR.
  if (S.xr.needsVRPlace && S.xr.frames > 3) { placeVR(); S.xr.needsVRPlace = false; }
  if (!S.xr.placed && S.xr.mode === 'ar') updatePlacement(frame);
  updateXRUI(dt);
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
renderer.setAnimationLoop((t, frame) => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (S.xr && frame) xrFrame(frame, dt);
  else if (!S.xr) {
    if (S.camTween) {
      const tw = S.camTween;
      tw.t = Math.min(1, tw.t + dt / 0.6);
      const k = tw.t * tw.t * (3 - 2 * tw.t);
      controls.target.lerpVectors(tw.fromT, tw.toT, k);
      camera.position.lerpVectors(tw.fromP, tw.toP, k);
      if (tw.t >= 1) { S.camTween = null; tw.then?.(); }
    }
    controls.update();
  }
  for (const a of S.avatars.values()) a.tick(dt, S.modelScale, avatarSize());
  maybeSendPose(t);
  renderer.render(scene, camera);
});

addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- share
function roomLink() { return `${location.origin}/?room=${S.room}`; }
$('room-chip').onclick = () => {
  $('share-link').value = roomLink();
  $('share-qr').src = `/api/qr.svg?data=${encodeURIComponent(roomLink())}`;
  $('share-wrap').hidden = false;
};
$('share-close').onclick = () => { $('share-wrap').hidden = true; };
$('share-wrap').addEventListener('pointerdown', (e) => { if (e.target === $('share-wrap')) $('share-wrap').hidden = true; });
$('share-copy').onclick = async () => {
  try { await navigator.clipboard.writeText(roomLink()); toast('Link copied'); }
  catch { $('share-link').select(); document.execCommand('copy'); toast('Link copied'); }
};

// ---------------------------------------------------------------- join
const ROOM_RE = /^[A-Z0-9]{4,12}$/;
const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function newCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => A[b % A.length]).join('');
}

function start(room) {
  const name = $('join-name').value.trim() || 'Guest';
  store.set('amn-name', name);
  S.name = name;
  S.room = room;
  history.replaceState(null, '', `/?room=${room}`);
  document.title = `${room} · Model Notes AR`;
  $('room-code').textContent = room;
  $('join').hidden = true;
  $('topbar').hidden = false;
  $('toolbar').hidden = false;
  $('empty').hidden = false;
  connect();
  setupXR();
}

const urlRoom = cleanCode(new URLSearchParams(location.search).get('room'));
$('join-name').value = store.get('amn-name') || '';
if (ROOM_RE.test(urlRoom)) {
  $('join-existing').hidden = false;
  $('join-new').hidden = true;
  $('join-room-code').textContent = urlRoom;
  $('join-go').onclick = () => start(urlRoom);
}
$('join-create').onclick = () => start(newCode());
$('join-code-go').onclick = () => {
  const code = cleanCode($('join-code').value);
  if (!ROOM_RE.test(code)) return toast('Room codes are 4–12 letters or numbers', true);
  start(code);
};
$('join-code').addEventListener('keydown', (e) => e.key === 'Enter' && $('join-code-go').click());
$('join-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') (ROOM_RE.test(urlRoom) ? $('join-go') : $('join-create')).click();
});
setTimeout(() => (store.get('amn-name') && ROOM_RE.test(urlRoom) ? $('join-go') : $('join-name')).focus(), 50);

// For automated checks.
window.__amn = { S, scene, camera, raycaster, handleSelect };
