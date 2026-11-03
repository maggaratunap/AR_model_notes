# Model Notes AR

A shared WebXR viewer for GLB models. Everyone in a room sees the same model and the same sticky notes, live.
Upload a `.glb`, place it on a real table or floor in AR, and pin colored notes to any spot on the model.

Works on:

| Device | How it runs |
|---|---|
| **Meta Quest 3 / 3S** (Meta Quest Browser) | Passthrough AR. Aim a controller or your hand at a surface and pull the trigger (or pinch) to place the model. A floating menu and a virtual keyboard handle notes. |
| **Android phones and tablets** (Chrome) | Camera AR. Move the phone to find a surface, tap to place, then tap the model to pin notes. The normal on-screen keyboard is used for typing. |
| **Desktop** (any modern browser) | 3D view with orbit controls. Click the model to pin notes. Drag-and-drop a `.glb` to upload. |
| **iPhone / iPad** (Safari) | 3D view only, fully synced. Apple does not support WebXR AR in Safari yet. |
| Other headsets with WebXR (e.g. Pico) | AR if the browser supports `immersive-ar`, otherwise VR. |

## Features

- **Rooms.** Create a room, share the link or QR code (click the room code). No accounts.
- **GLB upload** up to 150 MB (configurable). Draco, Meshopt and KTX2 compressed files are supported.
- **Sticky notes** in six colors, with live typing, author name, move, recolor, delete. Empty notes clean themselves up.
- **Shared scale**: Tabletop (longest side 0.5 m), Large (2 m), or Real size 1:1. Changing it changes it for everyone.
- **Presence**: each person appears as a small colored head with a name tag, positioned where they are looking from relative to the model.
- **Notes list** (desktop): click a note to fly the camera to it.
- Rooms, models and notes are saved on the server and reload when you come back.

## Run it locally

```bash
npm install
npm start          # http://localhost:3000
```

WebXR needs HTTPS on anything other than `localhost`, so to test AR on a phone or Quest you need either the deployed site
or an HTTPS tunnel (for example `npx cloudflared tunnel --url http://localhost:3000`).

## Deploy on Render

1. Push this folder to a new GitHub repository.
2. In Render choose **New > Blueprint** and select the repo (it reads `render.yaml`), or create a **Web Service**
   with build command `npm install` and start command `npm start`.
3. Open the `.onrender.com` URL on each device.

**Persistence:** on Render's free plan the filesystem is wiped when the service restarts or spins down,
so uploaded models and notes disappear. To keep them, switch the service to a paid plan, attach a disk
(see the commented block in `render.yaml`) and set `DATA_DIR` to the disk's mount path.

### Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port (Render sets this) |
| `DATA_DIR` | `./data` | Where models (`models/`) and room state (`rooms/*.json`) are stored |
| `MAX_UPLOAD_MB` | `150` | Largest GLB accepted |

## Using it together in the same physical room

WebXR has no shared spatial anchors across devices, so each person places the model themselves.
To line everyone up, agree on a spot (for example the corner of a table), have each person place the model there and
use the rotate buttons (or the Quest thumbstick) to match orientation. Notes are pinned to the model, not to the room,
so they always line up with the geometry.

Remote participants (desktop, or AR in a different room) see the same model, notes and each other's heads.

## Tips for large BIM models

- Quest 3 stays smooth up to roughly 1 to 2 million triangles. Larger exports should be simplified or compressed,
  for example `npx gltfpack -i model.glb -o model-small.glb -cc -tc` or with Blender's Decimate modifier.
- Exporters that mark everything as metallic make models look dark. Set metallic to 0 in the exporter if possible.
- glTF units are meters. If a model appears 1000 times too large in "Real size", it was exported in millimeters.

## Controls

**Desktop:** drag to orbit, scroll to zoom, right-drag to pan. `N` toggles Add note, `Esc` cancels.
**Phone AR:** tap to place, then use the bottom bar (Add note, colors, rotate, Move model, Exit).
**Quest AR/VR:** trigger or pinch to select. The menu floats to your lower left and follows when you turn.
Thumbstick left/right spins the model.

Replacing the model in a room clears that room's notes (they were pinned to the old geometry); the app asks first.

## Project layout

```
server.js            Express + WebSocket server, uploads, room persistence
public/index.html    UI shell (also the AR DOM overlay on phones)
public/styles.css
public/js/app.js     Scene, sync, picking, WebXR session handling
public/js/notes.js   Sticky note and avatar rendering
public/js/xr-ui.js   In-headset menu and virtual keyboard
render.yaml          Render Blueprint
```
