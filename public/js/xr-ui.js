// In-headset UI for devices without a DOM overlay (Quest 3, other headsets):
// a floating tool menu and a virtual keyboard for writing notes. Both are
// canvas textures on planes; controller/hand rays hit them and the hit UV is
// mapped back to a button.
import * as THREE from 'three';
import { PALETTE, wrapLines } from './notes.js';

class CanvasPanel {
  constructor(pxW, pxH, worldW) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = pxW; this.canvas.height = pxH;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(worldW, (worldW * pxH) / pxW),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.mesh.renderOrder = 1000;
    this.mesh.userData.panel = this;
    this.buttons = [];
    this.hover = null;
    this.pressed = null;
    this.dirty = true;
  }
  buttonAt(uv) {
    const x = uv.x * this.canvas.width;
    const y = (1 - uv.y) * this.canvas.height;
    return this.buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) || null;
  }
  setHover(b) { if (b !== this.hover) { this.hover = b; this.dirty = true; } }
  click(uv) {
    const b = this.buttonAt(uv);
    if (b?.onClick) {
      b.onClick();
      this.pressed = b; this.dirty = true;
      setTimeout(() => { this.pressed = null; this.dirty = true; }, 120);
    }
    return !!b;
  }
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
    this.texture.needsUpdate = true;
  }
  rr(x, y, w, h, r) {
    const c = this.ctx; c.beginPath(); c.roundRect(x, y, w, h, r);
  }
  drawButton(b) {
    const c = this.ctx;
    const hot = this.hover === b, down = this.pressed === b;
    if (b.swatch) {
      this.rr(b.x, b.y, b.w, b.h, [10, 10, 10, 24]);
      c.fillStyle = b.swatch; c.fill();
      if (b.active) { c.lineWidth = 8; c.strokeStyle = '#fff'; c.stroke(); }
      else if (hot) { c.lineWidth = 5; c.strokeStyle = 'rgba(255,255,255,0.7)'; c.stroke(); }
      return;
    }
    this.rr(b.x, b.y, b.w, b.h, 18);
    c.fillStyle = down ? '#fff6c8' : b.active ? '#ffd447' : hot ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.1)';
    c.fill();
    c.fillStyle = b.active || down ? '#2a2100' : b.danger ? '#ff8a8a' : '#f2f1ee';
    c.font = `600 ${b.fontSize || 34}px system-ui, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1, b.w - 16);
  }
  background() {
    const c = this.ctx;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.rr(4, 4, this.canvas.width - 8, this.canvas.height - 8, 36);
    c.fillStyle = 'rgba(20,22,27,0.92)'; c.fill();
    c.lineWidth = 3; c.strokeStyle = 'rgba(255,255,255,0.15)'; c.stroke();
  }
}

/** Floating tool menu. `actions` supplies callbacks; `state()` returns current UI state. */
export class XRMenu extends CanvasPanel {
  constructor(actions, state) {
    super(1024, 470, 0.42);
    this.actions = actions; this.state = state;
    this.status = '';
  }
  setStatus(s) { if (s !== this.status) { this.status = s; this.dirty = true; } }
  layoutButtons() {
    const st = this.state();
    const B = [];
    const pad = 36, gap = 18, rowH = 92;
    let y = 110;
    const row = (items) => {
      const total = items.reduce((a, i) => a + i.w, 0) + gap * (items.length - 1);
      let x = pad + (1024 - pad * 2 - total) / 2;
      for (const i of items) { B.push({ ...i, x, y, h: i.h || rowH }); x += i.w + gap; }
      y += rowH + gap;
    };
    row([
      { id: 'add', label: st.addMode ? 'Adding notes: ON' : 'Add note', w: 380, active: st.addMode, onClick: this.actions.toggleAdd },
      { id: 'rotl', label: '⟲', w: 110, fontSize: 48, onClick: () => this.actions.rotate(-1) },
      { id: 'rotr', label: '⟳', w: 110, fontSize: 48, onClick: () => this.actions.rotate(1) },
      { id: 'place', label: st.placing ? 'Placing…' : 'Move model', w: 300, active: st.placing, onClick: this.actions.replace },
    ]);
    row(PALETTE.map((c) => ({ id: c, swatch: c, w: 120, active: st.color === c, onClick: () => this.actions.setColor(c) })));
    row([
      { id: 'table', label: 'Tabletop', w: 230, active: st.scaleMode === 'table', onClick: () => this.actions.setScale('table') },
      { id: 'large', label: 'Large', w: 180, active: st.scaleMode === 'large', onClick: () => this.actions.setScale('large') },
      { id: 'real', label: '1:1', w: 160, active: st.scaleMode === 'real', onClick: () => this.actions.setScale('real') },
      { id: 'exit', label: 'Exit', w: 240, danger: true, onClick: this.actions.exit },
    ]);
    this.buttons = B;
  }
  draw() {
    this.layoutButtons();
    const c = this.ctx;
    this.background();
    const st = this.state();
    c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillStyle = '#ffd447'; c.font = '700 36px system-ui, sans-serif';
    c.fillText(`Room ${st.room}`, 44, 58);
    c.fillStyle = '#a6a9b0'; c.font = '500 28px system-ui, sans-serif';
    c.textAlign = 'right';
    c.fillText(this.status || `${st.users} here · ${st.notes} notes`, 1024 - 44, 58, 600);
    for (const b of this.buttons) this.drawButton(b);
  }
}

const KEY_ROWS = [
  '1234567890'.split(''),
  'qwertyuiop'.split(''),
  'asdfghjkl'.split(''),
  ['⇧', ...'zxcvbnm'.split(''), '⌫'],
];

/** Virtual keyboard + preview for editing one note in the headset. */
export class XRKeyboard extends CanvasPanel {
  constructor(actions) {
    super(1024, 860, 0.62);
    this.actions = actions; // { change(text), setColor(c), done(), del(), move() }
    this.text = ''; this.color = PALETTE[0]; this.shift = false;
    this.blink = 0;
  }
  open(note) {
    this.text = note.text || ''; this.color = note.color; this.shift = !this.text;
    this.dirty = true;
  }
  setColor(c) { this.color = c; this.dirty = true; }
  type(ch) {
    if (this.text.length >= 600) return;
    this.text += this.shift ? ch.toUpperCase() : ch;
    this.shift = false;
    this.actions.change(this.text); this.dirty = true;
  }
  layoutButtons() {
    const B = [];
    const pad = 30, gap = 10;
    // colors + actions row
    let x = pad, y = 250;
    for (const c of PALETTE) { B.push({ swatch: c, x, y, w: 70, h: 70, active: c === this.color, onClick: () => { this.setColor(c); this.actions.setColor(c); } }); x += 80; }
    x += 10;
    B.push({ label: 'Delete', danger: true, x, y, w: 150, h: 70, fontSize: 30, onClick: this.actions.del }); x += 160;
    B.push({ label: 'Move', x, y, w: 120, h: 70, fontSize: 30, onClick: this.actions.move }); x += 130;
    B.push({ label: 'Done', active: true, x, y, w: 1024 - pad - x, h: 70, fontSize: 32, onClick: this.actions.done });
    // keys
    const keyW = 86, keyH = 84;
    y = 345;
    KEY_ROWS.forEach((row, r) => {
      const widths = row.map((k) => (k === '⇧' || k === '⌫' ? keyW * 1.45 : keyW));
      const total = widths.reduce((a, w) => a + w, 0) + gap * (row.length - 1);
      x = (1024 - total) / 2;
      row.forEach((k, i) => {
        const w = widths[i];
        let onClick, active = false, label = k;
        if (k === '⇧') { onClick = () => { this.shift = !this.shift; this.dirty = true; }; active = this.shift; }
        else if (k === '⌫') onClick = () => { this.text = this.text.slice(0, -1); this.actions.change(this.text); this.dirty = true; };
        else { onClick = () => this.type(k); label = this.shift ? k.toUpperCase() : k; }
        B.push({ label, x, y, w, h: keyH, fontSize: 38, active, onClick });
        x += w + gap;
      });
      y += keyH + gap;
    });
    const last = [
      { label: ',', w: keyW, ch: ',' }, { label: '.', w: keyW, ch: '.' }, { label: '?', w: keyW, ch: '?' },
      { label: 'space', w: 380, ch: ' ' }, { label: '!', w: keyW, ch: '!' }, { label: '-', w: keyW, ch: '-' },
      { label: '↵', w: keyW * 1.3, ch: '\n' },
    ];
    const total = last.reduce((a, k) => a + k.w, 0) + gap * (last.length - 1);
    x = (1024 - total) / 2;
    for (const k of last) {
      B.push({ label: k.label, x, y, w: k.w, h: keyH, fontSize: 34, onClick: () => this.type(k.ch) });
      x += k.w + gap;
    }
    this.buttons = B;
  }
  draw() {
    this.layoutButtons();
    this.background();
    const c = this.ctx;
    // preview
    this.rr(30, 30, 964, 200, [10, 10, 10, 36]);
    c.fillStyle = this.color; c.fill();
    c.font = '38px "Segoe Print", "Comic Sans MS", system-ui, sans-serif';
    c.textAlign = 'left'; c.textBaseline = 'top';
    const lines = wrapLines(c, this.text + '|', 900, 99);
    const shown = lines.slice(-4);
    c.fillStyle = '#262318';
    shown.forEach((l, i) => c.fillText(l, 60, 50 + i * 44));
    if (!this.text) { c.fillStyle = 'rgba(38,35,24,0.45)'; c.fillText('Type your note…', 76, 50); }
    for (const b of this.buttons) this.drawButton(b);
  }
}
