// Floating in-headset panel for the alignment flow (Quest has no DOM overlay).
// Draws the same view model the phone overlay uses: title, step text, optional
// reference photo, a quality line and a grid of buttons.
import * as THREE from 'three';

const W = 1024, H = 768, WORLD_W = 0.42;
const GRADE_COLOR = { good: '#2DBE8C', ok: '#F7B84F', poor: '#FF6B6B', none: '#A6A9B0' };

export class AlignPanel {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_W, (WORLD_W * H) / W),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.mesh.renderOrder = 1000;
    this.mesh.userData.panel = this;
    this.buttons = [];
    this.hover = null;
    this.view = null;
    this.sig = '';
    this.images = new Map();
    this.placed = false;
    this.target = null;
  }

  image(src) {
    if (!src) return null;
    let img = this.images.get(src);
    if (!img) {
      img = new Image();
      img.onload = () => { this.sig = ''; };
      img.src = src;
      this.images.set(src, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  buttonAt(uv) {
    const x = uv.x * W, y = (1 - uv.y) * H;
    return this.buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) || null;
  }
  setHover(b) { if (b !== this.hover) { this.hover = b; this.sig = ''; } }
  click(uv) {
    const b = this.buttonAt(uv);
    if (b && !b.disabled) b.onClick();
    return !!b;
  }

  /** Redraw only when the view model or hover changed. */
  update(view) {
    const sig = JSON.stringify(view, (k, v) => (typeof v === 'function' ? undefined : k === 'img' && v ? v.length + v.slice(-24) : v)) + (this.hover?.id || '');
    this.view = view;
    if (sig === this.sig) return;
    this.sig = sig;
    this.draw();
    this.texture.needsUpdate = true;
  }

  draw() {
    const c = this.ctx, v = this.view;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(20,22,27,0.93)';
    c.beginPath(); c.roundRect(0, 0, W, H, 36); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = 3; c.stroke();

    let y = 64;
    c.fillStyle = '#ffd447'; c.font = '700 40px system-ui, sans-serif'; c.textBaseline = 'alphabetic';
    c.fillText(v.title || '', 40, y);
    y += 20;

    const img = this.image(v.img);
    const textX = img ? 40 + 300 + 28 : 40;
    const textW = W - textX - 40;
    if (img) {
      const ih = 300 * (img.naturalHeight / img.naturalWidth);
      c.save(); c.beginPath(); c.roundRect(40, y + 10, 300, Math.min(ih, 230), 16); c.clip();
      c.drawImage(img, 40, y + 10, 300, ih); c.restore();
    }
    c.fillStyle = '#f2f1ee'; c.font = '500 32px system-ui, sans-serif';
    let ty = y + 46;
    for (const line of wrap(c, v.text || '', textW, 5)) { c.fillText(line, textX, ty); ty += 42; }
    if (v.quality) {
      c.fillStyle = GRADE_COLOR[v.quality.grade] || GRADE_COLOR.none;
      c.font = '650 30px system-ui, sans-serif';
      for (const line of wrap(c, v.quality.text, textW, 2)) { c.fillText(line, textX, ty + 6); ty += 40; }
    }
    if (v.warning) {
      c.fillStyle = '#F7B84F'; c.font = '500 26px system-ui, sans-serif';
      for (const line of wrap(c, v.warning, textW, 3)) { c.fillText(line, textX, ty + 10); ty += 34; }
    }

    // Buttons: up to 4 per row, laid out from the bottom up.
    const btns = v.buttons || [];
    const perRow = 4, gap = 16, bh = 92;
    const rows = Math.ceil(btns.length / perRow);
    const bw = (W - 80 - gap * (perRow - 1)) / perRow;
    this.buttons = [];
    btns.forEach((b, i) => {
      const r = Math.floor(i / perRow), col = i % perRow;
      const bx = 40 + col * (bw + gap);
      const by = H - 40 - (rows - r) * bh - (rows - r - 1) * gap + 0;
      const rect = { ...b, x: bx, y: by, w: bw, h: bh };
      this.buttons.push(rect);
      const hot = this.hover?.id === b.id && !b.disabled;
      c.beginPath(); c.roundRect(bx, by, bw, bh, 20);
      c.fillStyle = b.disabled ? 'rgba(255,255,255,0.04)'
        : b.kind === 'primary' ? (hot ? '#ffdd6b' : '#ffd447')
        : b.active ? 'rgba(255,212,71,0.35)'
        : hot ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.09)';
      c.fill();
      c.fillStyle = b.disabled ? 'rgba(255,255,255,0.3)' : b.kind === 'primary' ? '#2a2100' : b.kind === 'danger' ? '#ff8a8a' : '#f2f1ee';
      c.font = '600 30px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(b.label, bx + bw / 2, by + bh / 2, bw - 16);
      c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    });
  }

  dispose() {
    this.texture.dispose(); this.mesh.geometry.dispose(); this.mesh.material.dispose();
  }
}

function wrap(c, text, maxW, maxLines) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const t = line ? `${line} ${word}` : word;
      if (c.measureText(t).width > maxW && line) { out.push(line); line = word; } else line = t;
    }
    out.push(line);
  }
  if (out.length > maxLines) { out.length = maxLines; out[maxLines - 1] += '…'; }
  return out;
}
