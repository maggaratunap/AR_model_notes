# Model Notes AR

A shared WebXR viewer for GLB models. Everyone in a room sees the same model and the same sticky notes, live.
Upload a `.glb`, place it on a real table or floor in AR, and pin colored notes to any spot on the model.

Works on:

| Device | How it runs |
|---|---|
| **Meta Quest 3 / 3S** (Meta Quest Browser) | Passthrough AR. Aim a controller or your hand at a surface and pull the trigger (or pinch) to place the model. A floating menu and a virtual keyboard handle notes. |
| **Android phones and tablets** (Chrome) | Camera AR. Move the phone to find a surface, tap to place, then tap the model to pin notes. The normal on-screen keyboard is used for typing. |
| **Desktop** (any modern browser) | 3D view with orbit controls. Click the model to pin notes. Drag-and-drop a `.glb` to upload. |
| **iPhone / iPad** (Safari) | Live 3D view, fully synced. **View in AR** opens Apple's AR Quick Look with the model and all current notes placed on a real surface. Quick Look is a snapshot: tap View in AR again to pick up newer notes, and add or edit notes in the 3D view. (Apple's browsers don't support WebXR AR, so live shared AR isn't possible there.) |
| Other headsets with WebXR (e.g. Pico) | AR if the browser supports `immersive-ar`, otherwise VR. |

## Features

- **Rooms.** Create a room, share the link or QR code (click the room code). No accounts.
- **GLB upload** up to 150 MB (configurable). Draco, Meshopt and KTX2 compressed files are supported.
- **Sticky notes** in six colors, with live typing, author name, move, recolor, delete. Empty notes clean themselves up.
- **Shared scale**: Tabletop (longest side 0.5 m), Large (2 m), or Real size 1:1. Changing it changes it for everyone.
- **Presence**: each person appears as a small colored head with a name tag, positioned where they are looking from relative to the model.
- **Notes list** (desktop): click a note to fly the camera to it.
- **iPhone/iPad AR** via Apple Quick Look: the app builds a USDZ of the model and notes on the device, kept ready in the background so it opens instantly.
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
For a real-size model of a real building, **Site align** (below) places it from surveyed control points, so
every device lands it in the same spot. It is a separate page for now and does not show notes yet.
To line everyone up, agree on a spot (for example the corner of a table), have each person place the model there and
use the rotate buttons (or the Quest thumbstick) to match orientation. Notes are pinned to the model, not to the room,
so they always line up with the geometry.

Remote participants (desktop, or AR in a different room) see the same model, notes and each other's heads.

## Site alignment: put the model exactly where the real building is

Open **Site align** from a room (or go to `/align?room=CODE`). It lines a 1:1 model up with the real
building, so walls, columns and MEP runs in the model sit on top of the real ones.

**How it works.** You mark 3 or 4 control points on the model once (sharp corners at floor level). On site you
aim at the same real corners and tap. The phone's or headset's own surface detection gives each tap a 3D
position (about 0.3 s of samples are median-filtered). A least-squares fit solves the rotation about the
vertical and the position. Tilt and scale are not estimated: the device already knows which way is down and
the model is 1:1, so two points are enough and a bad tap can't tilt the building. Then **Lock** anchors the
model to the room.

| | Android phone/tablet (Chrome) | Meta Quest 3 / 3S |
|---|---|---|
| First alignment | Crosshair in the middle of the screen, tap each point | Aim the controller ray (or hand), pull the trigger or pinch |
| Every visit after that | **Point the camera at any printed marker.** No taps. Works for every phone and every person. | **Saved anchor.** The model snaps back by itself in the same room, no taps. |
| iPhone/iPad | Not possible: Apple's browsers have no WebXR. Control points can still be set up there. | |

### Printed markers (Android)

Chrome on Android lets a page read the AR camera image, so the phone can find printed square markers
(ArUco) by itself. The markers do **not** need to be placed or measured precisely:

1. In the side panel open **Printed markers → Print markers**. Print at 100% / Actual size and check the black
   square with a tape (default 150 mm; enter the measured size if it differs).
2. Tape them flat on columns or walls around the building at chest height, one ID per spot. 4 to 8 markers
   spread around a high bay is plenty.
3. Do one normal point alignment on an Android phone and **Lock**. Then walk past each marker and look at it from
   1 to 2 m for about 2 seconds. The card shows “learning, hold steady” and then “learned ✓”. The phone works out
   where each marker is in model coordinates and saves it to the room. Learning is refused if the fit is poor.
4. From then on, anyone opening the room on an Android phone just points the camera at any marker. The model
   aligns from it and gets better as more markers come into view (one marker fixes the position well; a second
   one far away fixes the rotation).

How it works: a few times a second the camera image is downscaled and copied into a background worker, which
finds markers and refines their corners to sub-pixel accuracy. The marker's printed size gives its 3D position,
and about 10 sightings are median-filtered. Sightings that are too far (over 2.5 m), too small or too oblique are
ignored. The card shows the error near the markers and at the far end of the building, including how well
each marker was learned. Camera images stay on the phone; only marker IDs and corner positions are stored.
Quest Browser does not give pages camera access, so Quest uses its saved anchors instead.

**Setting up points (desktop, once):**

1. Open the room's **Site align** page. Turn on **Add point** (or press `A`) and click corners. *Snap to corners*
   pulls the click onto the nearest mesh corner, which is where columns and walls really meet.
2. Good points: column base corners, wall corners, door jambs, floor drains, slab joints at the floor.
   Bad points: anything that moves, anything on furniture, anything you can't put a crosshair exactly on.
3. Spread them out. Points 10 m+ apart in an L or triangle beat points clustered together.
4. Rename each point so you can find it ("NE column C4, north face"). Each point keeps a close-up photo of
   the model that is shown on site. Points are saved to the room, so the Quest sees them too.
   **Export points** saves a `.json` you can keep with the model.

**On site:** open the same page on the phone or Quest and tap **Align in AR**. For each point, aim at the real
corner and tap. After 2 points the model appears; add the rest, then **Review** and **Lock**.

**How much to trust it.** The card shows the expected error:

* With 3+ points it fits without each point in turn and measures how far that point lands (leave-one-out).
  That is an honest error, not a best case. Green is within 3 cm, amber within 8 cm.
* It also estimates the error at the far end of the building (rotation error grows with distance).
* It flags a point that disagrees with the others, distances that don't match the model (wrong units or wrong
  corner), height mismatches, and points that are too close together.
* **Check** (after locking) lets you tap any control point and shows how far off the model is there.
  Do this every time, including after a saved alignment is restored.
* **Nudge** shifts by 1 cm / 5 cm or rotates by 0.2° / 1°, relative to the way you face.

Expect about 2 to 5 cm with good points on a Quest 3 or a recent ARCore phone. Tracking drifts over long
walks; anchors correct most of it, and **Check** tells you when to re-align.

**Safety and privacy.** The model stays hidden until it is placed and is see-through by default (**Model %**
cycles 85 / 55 / 30 % / hidden). It hides itself if tracking is lost. The first run asks you to confirm
you will watch where you walk and won't use the overlay alone for layout or anything safety-critical.
No camera images are read or uploaded; only the control points you save go to the server.

**Survey coordinates.** Models exported far from the origin (kilometres) are recentred internally so float
precision stays sub-millimetre. Point coordinates are still stored in the model's own coordinates.

Tested in code: `npm test` runs the fitting math (exact recovery, noise, outlier detection, unit errors) and an
end-to-end marker test: a synthetic camera image of a printed marker is detected with the same detector the phone
uses, and the recovered 3D corners are checked against the truth.

## Tips for large BIM models

- Quest 3 stays smooth up to roughly 1 to 2 million triangles. Larger exports should be simplified or compressed,
  for example `npx gltfpack -i model.glb -o model-small.glb -cc -tc` or with Blender's Decimate modifier.
- Exporters that mark everything as metallic make models look dark. Set metallic to 0 in the exporter if possible.
- glTF units are meters. If a model appears 1000 times too large in "Real size", it was exported in millimeters.

## Troubleshooting AR on Android

"Could not start AR" or "The specified session configuration is not supported" means the phone's browser
reported AR support but the phone could not start a session. The app automatically retries with simpler settings,
then shows a help panel with a **Try basic AR mode** button. If that also fails, check:

1. The page is open in **Google Chrome** (not Samsung Internet, Firefox, or a link opened inside another app).
2. **Google Play Services for AR** is installed and up to date (Play Store).
3. The phone is on Google's [ARCore supported devices list](https://developers.google.com/ar/devices).
   Phones that aren't on it can't run web AR, but the 3D view still works and stays synced.

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
public/js/quicklook.js  USDZ export for AR Quick Look on iPhone/iPad
public/align.html    Site alignment page (control points + on-site AR alignment)
public/align-markers.html  Printable ArUco markers (exact size, one per page)
public/js/align/     app.js (page), solver.js (fit + error checks), panel.js (in-headset UI),
                     scanner.js + marker-worker.js + refine.js + markerpose.js (Android marker detection)
test/                npm test: solver and marker tests
render.yaml          Render Blueprint
```
