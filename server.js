// AR Model Notes — shared WebXR model viewer with sticky notes.
// One Node process: serves the client, stores uploaded GLB files, and keeps
// every room in sync over a WebSocket.
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 150);
const MODELS_DIR = path.join(DATA_DIR, 'models');
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
fs.mkdirSync(MODELS_DIR, { recursive: true });
fs.mkdirSync(ROOMS_DIR, { recursive: true });

const ROOM_RE = /^[A-Z0-9]{4,12}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const SCALE_MODES = new Set(['table', 'large', 'real']);
const MAX_NOTES = 500;
const MAX_TEXT = 600;

// ---------- room state ----------
/** @type {Map<string, {id:string, model:any, scaleMode:string, notes:Record<string, any>, clients:Set<any>, saveTimer:any}>} */
const rooms = new Map();

function roomFile(id) { return path.join(ROOMS_DIR, `${id}.json`); }

function getRoom(id) {
  let room = rooms.get(id);
  if (room) return room;
  room = { id, model: null, scaleMode: 'table', notes: {}, clients: new Set(), saveTimer: null };
  try {
    const saved = JSON.parse(fs.readFileSync(roomFile(id), 'utf8'));
    room.model = saved.model || null;
    room.scaleMode = SCALE_MODES.has(saved.scaleMode) ? saved.scaleMode : 'table';
    room.notes = saved.notes || {};
    if (room.model && !fs.existsSync(path.join(MODELS_DIR, room.model.file))) room.model = null;
  } catch { /* new room */ }
  rooms.set(id, room);
  return room;
}

function saveRoom(room) {
  clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => {
    const data = { model: room.model, scaleMode: room.scaleMode, notes: room.notes };
    const tmp = roomFile(room.id) + '.tmp';
    fsp.writeFile(tmp, JSON.stringify(data))
      .then(() => fsp.rename(tmp, roomFile(room.id)))
      .catch((e) => console.error('save failed', room.id, e.message));
  }, 400);
}

function publicModel(m) {
  return m ? { url: `/models/${m.file}`, name: m.name, size: m.size, version: m.version, uploadedBy: m.uploadedBy } : null;
}

function snapshot(room) {
  return {
    type: 'state',
    model: publicModel(room.model),
    scaleMode: room.scaleMode,
    notes: Object.values(room.notes),
    users: [...room.clients].map((c) => c.user),
  };
}

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const c of room.clients) if (c !== except && c.readyState === 1) c.send(data);
}

// ---------- validation helpers ----------
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const vec3 = (v) => (Array.isArray(v) && v.length === 3 ? v.map(num) : [0, 0, 0]);
const quat = (v) => (Array.isArray(v) && v.length === 4 ? v.map(num) : [0, 0, 0, 1]);
const cleanText = (t) => String(t ?? '').slice(0, MAX_TEXT);
const cleanName = (t) => String(t ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32) || 'Guest';
const safeDecode = (v) => { try { return decodeURIComponent(v || ''); } catch { return ''; } };
const cleanColor = (c, fallback = '#FFE873') => (COLOR_RE.test(c) ? c : fallback);

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  // Lets Quest Browser / Chrome open WebXR sessions from this origin.
  res.setHeader('Permissions-Policy', 'xr-spatial-tracking=(self)');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// Three.js and the BVH library are served from node_modules so the app has no CDN dependency.
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three'), { maxAge: '7d' }));
app.use('/vendor/three-mesh-bvh', express.static(path.join(__dirname, 'node_modules/three-mesh-bvh/build'), { maxAge: '7d' }));
app.use('/models', express.static(MODELS_DIR, {
  maxAge: '365d', immutable: true,
  setHeaders: (res) => res.setHeader('Content-Type', 'model/gltf-binary'),
}));

app.get('/api/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

app.get('/api/qr.svg', async (req, res) => {
  const text = String(req.query.data || '').slice(0, 500);
  if (!text) return res.status(400).end();
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').send(svg);
});

app.post('/api/rooms/:room/model',
  express.raw({ type: () => true, limit: `${MAX_UPLOAD_MB}mb` }),
  async (req, res) => {
    const id = String(req.params.room).toUpperCase();
    if (!ROOM_RE.test(id)) return res.status(400).json({ error: 'Bad room code' });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 20) return res.status(400).json({ error: 'Empty file' });
    // Binary glTF starts with the ASCII magic "glTF" followed by version 2.
    if (buf.toString('ascii', 0, 4) !== 'glTF' || buf.readUInt32LE(4) !== 2) {
      return res.status(415).json({ error: 'That file is not a binary glTF 2.0 (.glb) file.' });
    }
    const room = getRoom(id);
    const version = Date.now();
    const file = `${id}-${version}-${crypto.randomBytes(4).toString('hex')}.glb`;
    await fsp.writeFile(path.join(MODELS_DIR, file), buf);
    const old = room.model;
    room.model = {
      file, version, size: buf.length,
      name: cleanText(safeDecode(req.get('x-file-name')) || 'model.glb').slice(0, 120),
      uploadedBy: cleanName(safeDecode(req.get('x-user-name'))),
    };
    room.notes = {}; // notes were pinned to the old geometry
    saveRoom(room);
    if (old) fsp.unlink(path.join(MODELS_DIR, old.file)).catch(() => {});
    broadcast(room, { type: 'model', model: publicModel(room.model), notes: [] });
    res.json({ ok: true, model: publicModel(room.model) });
  });

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: `File is larger than ${MAX_UPLOAD_MB} MB.` });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.room = null;
  ws.user = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') {
      const id = String(msg.room || '').toUpperCase();
      if (!ROOM_RE.test(id) || ws.room) return;
      const room = getRoom(id);
      ws.room = room;
      ws.user = {
        id: crypto.randomUUID().slice(0, 8),
        name: cleanName(msg.name),
        color: cleanColor(msg.color, '#4F8EF7'),
        device: String(msg.device || 'desktop').slice(0, 16),
      };
      room.clients.add(ws);
      ws.send(JSON.stringify({ ...snapshot(room), you: ws.user }));
      broadcast(room, { type: 'user-joined', user: ws.user }, ws);
      return;
    }

    const room = ws.room;
    if (!room) return;

    switch (msg.type) {
      case 'note-add': {
        if (Object.keys(room.notes).length >= MAX_NOTES) return;
        const n = msg.note || {};
        const id = /^[a-zA-Z0-9-]{6,40}$/.test(n.id) ? n.id : crypto.randomUUID();
        const note = {
          id,
          position: vec3(n.position),
          normal: vec3(n.normal),
          color: cleanColor(n.color),
          text: cleanText(n.text),
          author: ws.user.name,
          authorId: ws.user.id,
          created: Date.now(),
          updated: Date.now(),
        };
        room.notes[id] = note;
        saveRoom(room);
        broadcast(room, { type: 'note', note });
        break;
      }
      case 'note-update': {
        const n = msg.note || {};
        const note = room.notes[n.id];
        if (!note) return;
        if ('text' in n) note.text = cleanText(n.text);
        if ('color' in n) note.color = cleanColor(n.color, note.color);
        if ('position' in n) note.position = vec3(n.position);
        if ('normal' in n) note.normal = vec3(n.normal);
        note.updated = Date.now();
        note.editedBy = ws.user.name;
        saveRoom(room);
        broadcast(room, { type: 'note', note, from: ws.user.id });
        break;
      }
      case 'note-delete': {
        if (!room.notes[msg.id]) return;
        delete room.notes[msg.id];
        saveRoom(room);
        broadcast(room, { type: 'note-delete', id: msg.id });
        break;
      }
      case 'scale': {
        if (!SCALE_MODES.has(msg.scaleMode)) return;
        room.scaleMode = msg.scaleMode;
        saveRoom(room);
        broadcast(room, { type: 'scale', scaleMode: room.scaleMode, by: ws.user.name });
        break;
      }
      case 'pose': {
        // Head pose in model coordinates; relayed, never stored.
        broadcast(room, { type: 'pose', id: ws.user.id, p: vec3(msg.p), q: quat(msg.q), mode: String(msg.mode || '').slice(0, 8) }, ws);
        break;
      }
      case 'rename': {
        ws.user.name = cleanName(msg.name);
        broadcast(room, { type: 'user-joined', user: ws.user });
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    room.clients.delete(ws);
    broadcast(room, { type: 'user-left', id: ws.user.id });
  });
});

// Keep sockets alive behind proxies (Render closes idle connections).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log(`AR Model Notes on http://localhost:${PORT}  (data: ${DATA_DIR})`));
