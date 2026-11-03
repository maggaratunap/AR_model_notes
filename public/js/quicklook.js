// AR on iPhone / iPad. Apple's browsers have no WebXR AR, but they open USDZ
// files in AR Quick Look. This builds a USDZ snapshot of the model plus every
// note (as upright cards on stems) at the room's current scale.
import * as THREE from 'three';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';
import * as WebGLTextureUtils from 'three/addons/utils/WebGLTextureUtils.js';
import { drawNoteCard } from './notes.js';

export function quickLookSupported() {
  const a = document.createElement('a');
  return !!(a.relList && a.relList.supports && a.relList.supports('ar'));
}

const Z = new THREE.Vector3(0, 0, 1);
const Y = new THREE.Vector3(0, 1, 0);

function toStandard(m) {
  if (!m || m.isMeshStandardMaterial) return m;
  // Unlit / Phong / Lambert etc. -> closest standard material so Quick Look keeps the color.
  return new THREE.MeshStandardMaterial({
    color: m.color ? m.color.clone() : new THREE.Color(0xcccccc),
    map: m.map || null,
    transparent: !!m.transparent,
    opacity: m.opacity ?? 1,
    side: m.side,
    roughness: 0.9,
    metalness: 0,
    emissive: m.isMeshBasicMaterial ? new THREE.Color(0x333333) : new THREE.Color(0),
  });
}

function prepareModel(root) {
  const model = root.clone(true);
  const instanced = [];
  model.traverse((o) => {
    if (!o.isMesh) return;
    if (Array.isArray(o.material)) o.material = o.material[0];
    o.material = toStandard(o.material);
    if (o.isInstancedMesh) instanced.push(o);
  });
  // The exporter writes one copy of an InstancedMesh, so expand instances into plain meshes.
  for (const im of instanced) {
    const group = new THREE.Group();
    group.position.copy(im.position); group.quaternion.copy(im.quaternion); group.scale.copy(im.scale);
    const m = new THREE.Matrix4();
    for (let i = 0; i < Math.min(im.count, 5000); i++) {
      im.getMatrixAt(i, m);
      const mesh = new THREE.Mesh(im.geometry, im.material);
      m.decompose(mesh.position, mesh.quaternion, mesh.scale);
      group.add(mesh);
    }
    im.parent.add(group);
    im.parent.remove(im);
  }
  return model;
}

function noteObject(note, worldSize, modelScale, centerXZ) {
  const g = new THREE.Group();
  g.position.fromArray(note.position);
  g.scale.setScalar(1 / modelScale); // children below are in meters

  const n = new THREE.Vector3().fromArray(note.normal);
  if (n.lengthSq() < 1e-6) n.copy(Y);
  n.normalize();
  const dir = n.clone().multiplyScalar(0.7).add(Y.clone().multiplyScalar(0.5)).normalize();
  const tip = dir.clone().multiplyScalar(worldSize * 0.6);

  // Card stands upright, facing outward horizontally so it reads like a sign.
  const face = new THREE.Vector3(n.x, 0, n.z);
  if (face.lengthSq() < 0.04) face.set(note.position[0] - centerXZ.x, 0, note.position[2] - centerXZ.y);
  if (face.lengthSq() < 1e-6) face.set(0, 0, 1);
  face.normalize();

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  drawNoteCard(canvas, note, { opaque: true });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const card = new THREE.Mesh(
    new THREE.PlaneGeometry(worldSize, worldSize),
    new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: new THREE.Color(0x666666),
      roughness: 1, metalness: 0,
    }),
  );
  card.quaternion.setFromUnitVectors(Z, face);
  card.position.copy(tip).addScaledVector(Y, worldSize / 2);

  const stemLen = tip.length();
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(worldSize * 0.012, worldSize * 0.012, stemLen, 8),
    new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.6, metalness: 0 }),
  );
  stem.quaternion.setFromUnitVectors(Y, dir);
  stem.position.copy(tip).multiplyScalar(0.5);

  const pin = new THREE.Mesh(
    new THREE.SphereGeometry(worldSize * 0.06, 16, 12),
    new THREE.MeshStandardMaterial({ color: note.color, roughness: 0.4, metalness: 0 }),
  );
  // USDZ has no double-sided materials, so add a second card facing the other way.
  const back = card.clone();
  back.quaternion.setFromUnitVectors(Z, face.clone().negate());
  back.position.addScaledVector(face, -worldSize * 0.002);
  g.add(card, back, stem, pin);
  return g;
}

/**
 * @param {object} p
 * @param {THREE.Object3D} p.modelRoot   loaded glTF scene
 * @param {THREE.Vector3}  p.contentOffset  offset that centers the model on the ground
 * @param {number} p.modelScale  display scale (model units -> meters)
 * @param {object[]} p.notes  note data
 * @param {number} p.noteSize  card width in meters
 * @returns {Promise<Blob>}
 */
export async function buildUSDZ({ modelRoot, contentOffset, modelScale, notes, noteSize }) {
  const out = new THREE.Group();
  const scaler = new THREE.Group();
  scaler.scale.setScalar(modelScale);
  const content = new THREE.Group();
  content.position.copy(contentOffset);
  out.add(scaler); scaler.add(content);

  content.add(prepareModel(modelRoot));
  const centerXZ = new THREE.Vector2(-contentOffset.x, -contentOffset.z);
  for (const note of notes) content.add(noteObject(note, noteSize, modelScale, centerXZ));
  out.updateMatrixWorld(true);

  const exporter = new USDZExporter();
  exporter.setTextureUtils(WebGLTextureUtils);
  const data = await exporter.parseAsync(out, { quickLookCompatible: true, maxTextureSize: 2048 });

  // Free the note textures/geometry created for the export (model geometry is shared, keep it).
  out.traverse((o) => {
    if (o.parent && o.parent.parent === content && o.isMesh) {
      o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose();
    }
  });
  return new Blob([data], { type: 'model/vnd.usdz+zip' });
}

/** Opens a USDZ blob in AR Quick Look. */
export function openInQuickLook(blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.rel = 'ar';
  a.href = url;
  a.style.display = 'none';
  a.appendChild(document.createElement('img')); // Quick Look requires an <img> child
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
}
