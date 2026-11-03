// 3D sticky notes and user avatars. Both live inside the model's coordinate
// frame (so everyone sees them in the same spot on the model) but are sized in
// real-world meters, so they stay readable at any model scale.
import * as THREE from 'three';

export const PALETTE = ['#FFE873', '#FFB36B', '#FF9EC7', '#C9A8FF', '#8FD3FF', '#A8E6A1'];
const INK = '#262318';
const NOTE_FONT = '"Segoe Print", "Bradley Hand", "Comic Sans MS", system-ui, sans-serif';

export function wrapLines(ctx, text, maxWidth, maxLines) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const test = line + word;
      if (ctx.measureText(test).width <= maxWidth || !line.trim()) {
        // Break very long words by character.
        if (ctx.measureText(test).width > maxWidth) {
          for (const ch of word) {
            if (ctx.measureText(line + ch).width > maxWidth && line) { out.push(line); line = ''; }
            line += ch;
          }
        } else line = test;
      } else {
        out.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  if (out.length > maxLines) {
    const cut = out.slice(0, maxLines);
    cut[maxLines - 1] = cut[maxLines - 1].replace(/.{0,2}$/, '') + '…';
    return cut;
  }
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  const [tl, tr, br, bl] = Array.isArray(r) ? r : [r, r, r, r];
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y); ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
  ctx.lineTo(x + w, y + h - br); ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
  ctx.lineTo(x + bl, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
  ctx.lineTo(x, y + tl); ctx.quadraticCurveTo(x, y, x + tl, y);
  ctx.closePath();
}

export function drawNoteCard(canvas, note, { selected = false, opaque = false } = {}) {
  const ctx = canvas.getContext('2d');
  const S = canvas.width;
  ctx.clearRect(0, 0, S, S);
  // `opaque` fills the whole square (no transparent corners), used for the iOS AR export.
  const pad = opaque ? 0 : 18;
  if (opaque) { ctx.fillStyle = note.color; ctx.fillRect(0, 0, S, S); }
  // shadow
  ctx.save();
  if (!opaque) { ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 6; }
  ctx.fillStyle = note.color;
  roundRect(ctx, pad, pad, S - pad * 2, S - pad * 2, [8, 8, 8, 48]);
  ctx.fill();
  ctx.restore();
  // adhesive strip
  ctx.save();
  roundRect(ctx, pad, pad, S - pad * 2, S - pad * 2, [8, 8, 8, 48]);
  ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,0.06)';
  ctx.fillRect(pad, pad, S, 60);
  // curled corner
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  ctx.beginPath(); ctx.moveTo(pad, S - pad - 70); ctx.lineTo(pad + 70, S - pad); ctx.lineTo(pad, S - pad); ctx.fill();
  ctx.restore();
  if (selected) {
    ctx.lineWidth = 10; ctx.strokeStyle = '#ffffff';
    roundRect(ctx, pad + 5, pad + 5, S - pad * 2 - 10, S - pad * 2 - 10, [6, 6, 6, 44]);
    ctx.stroke();
  }
  // text
  const text = note.text?.trim();
  const fontSize = !text ? 52 : text.length < 30 ? 76 : text.length < 80 ? 58 : text.length < 160 ? 46 : 36;
  ctx.font = `${fontSize}px ${NOTE_FONT}`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = text ? INK : 'rgba(38,35,24,0.45)';
  const maxLines = Math.floor((S - pad * 2 - 150) / (fontSize * 1.2));
  const lines = wrapLines(ctx, text || 'Empty note', S - pad * 2 - 60, maxLines);
  lines.forEach((l, i) => ctx.fillText(l, pad + 30, pad + 78 + i * fontSize * 1.2));
  // author
  ctx.font = `600 26px system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(38,35,24,0.55)';
  ctx.textAlign = 'right';
  ctx.fillText(note.author || '', S - pad - 26, S - pad - 46);
  ctx.textAlign = 'left';
}

export function makeLabelSprite(text, color = '#ffffff') {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = '600 30px system-ui, sans-serif';
  const w = Math.min(248, ctx.measureText(text).width + 32);
  ctx.fillStyle = 'rgba(20,22,26,0.85)';
  roundRect(ctx, (256 - w) / 2, 6, w, 52, 26); ctx.fill();
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 33, 230);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  s.scale.set(0.2, 0.05, 1);
  return s;
}

const UP = new THREE.Vector3(0, 1, 0);
const pinGeo = new THREE.SphereGeometry(1, 16, 12);

/** A note pinned to the model. `group` is placed in model (content) space. */
export class NoteObject {
  constructor(data) {
    this.data = { ...data };
    this.group = new THREE.Group();
    this.group.userData.noteId = data.id;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = 512;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.card = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthWrite: false }));
    this.card.center.set(0.5, 0.02);
    this.card.renderOrder = 10;

    this.pin = new THREE.Mesh(pinGeo, new THREE.MeshBasicMaterial({ color: data.color }));
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]);
    this.stem = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.6 }));

    for (const o of [this.card, this.pin]) o.userData.noteId = data.id;
    this.group.add(this.stem, this.pin, this.card);
    this.selected = false;
    this.update(data);
  }

  update(data) {
    Object.assign(this.data, data);
    this.group.position.fromArray(this.data.position);
    this.pin.material.color.set(this.data.color);
    this.redraw();
  }

  setSelected(v) {
    if (this.selected === v) return;
    this.selected = v;
    this.redraw();
  }

  redraw() {
    drawNoteCard(this.canvas, this.data, { selected: this.selected });
    this.texture.needsUpdate = true;
  }

  /** worldSize: card width in meters; modelScale: world scale of the content group. */
  layout(worldSize, modelScale) {
    this.group.scale.setScalar(1 / modelScale);
    const n = new THREE.Vector3().fromArray(this.data.normal);
    if (n.lengthSq() < 1e-6) n.copy(UP);
    n.normalize();
    // Lean the stem toward "up" so cards on walls still float upward a little.
    const dir = n.clone().multiplyScalar(0.7).add(UP.clone().multiplyScalar(0.5)).normalize();
    const stemLen = worldSize * 0.6;
    const tip = dir.multiplyScalar(stemLen);
    const pos = this.stem.geometry.attributes.position;
    pos.setXYZ(1, tip.x, tip.y, tip.z); pos.needsUpdate = true;
    this.stem.geometry.computeBoundingSphere();
    this.card.position.copy(tip);
    this.card.scale.set(worldSize, worldSize, 1);
    this.pin.scale.setScalar(worldSize * 0.06);
  }

  dispose() {
    this.texture.dispose();
    this.card.material.dispose();
    this.pin.material.dispose();
    this.stem.geometry.dispose();
    this.stem.material.dispose();
  }
}

/** Another participant's head, shown where they are looking from. */
export class Avatar {
  constructor(user) {
    this.user = user;
    this.group = new THREE.Group();
    this.body = new THREE.Group();
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.09, 24, 16),
      new THREE.MeshStandardMaterial({ color: user.color, roughness: 0.5 }));
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.05, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.2, metalness: 0.3 }));
    visor.position.set(0, 0.01, -0.07);
    this.body.add(head, visor);
    this.label = makeLabelSprite(user.name, user.color);
    this.label.position.set(0, 0.17, 0);
    this.group.add(this.body, this.label);
    this.lastSeen = 0;
    this.target = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
    this.group.visible = false;
  }
  setPose(p, q) {
    this.target.p.fromArray(p);
    this.target.q.fromArray(q);
    if (!this.group.visible) {
      this.group.position.copy(this.target.p);
      this.body.quaternion.copy(this.target.q);
    }
    this.lastSeen = performance.now();
    this.group.visible = true;
  }
  tick(dt, modelScale, sizeScale) {
    if (performance.now() - this.lastSeen > 15000) this.group.visible = false;
    const k = 1 - Math.exp(-dt * 12);
    this.group.position.lerp(this.target.p, k);
    this.body.quaternion.slerp(this.target.q, k);
    this.group.scale.setScalar(sizeScale / modelScale);
  }
  dispose() {
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); });
  }
}
