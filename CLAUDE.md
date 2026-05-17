# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Mobile Magnetometer — a real-time magnetometer telemetry system. Three deployment targets share the same server and wire format:

- **Android APK** (`mobile/` + `android/`): Vanilla JS/HTML/CSS wrapped by Capacitor. The `mobile/` folder is the web source; `android/` is the generated native Android project. A custom Capacitor plugin (`MagnetometerPlugin.java`) reads `TYPE_MAGNETIC_FIELD` via `SensorManager` and emits raw μT values to JS.
- **PC server** (`pc/`): Node.js HTTP + WebSocket + REST. Serves the dashboard and static files, ingests sensor data, fans out live data to the Electron dashboard, and writes CSV recordings.
- **Electron desktop app** (repo root `package.json` + `main.js`): Wraps the PC server + dashboard in an Electron window. The root `package.json` is the Electron/Capacitor project; `pc/package.json` is the bare Node.js server project for standalone use.

There is no test suite, no linter, and no bundler.

## Running

**Node.js server (recommended for development):**
```bash
cd pc
npm install        # first time only
node server.js     # or: npm start
# Windows: double-click pc/start.bat (handles install + run)
```

**Electron desktop app (development):**
```bash
npm install        # from repo root — installs electron + capacitor + server deps
npm run electron   # launches Electron window pointing at http://localhost:8443/dashboard
```

**Build Electron installer (Windows .exe):**
```bash
npm run build      # from repo root — outputs to dist-app/
```

**Build Android APK:**
```bash
npm install               # from repo root (installs Capacitor)
npx cap sync android      # copy web assets into android/ after any mobile/ change
# Then open android/ in Android Studio → Build → Generate Signed/Unsigned APK
```

The server listens on `http://0.0.0.0:8443`. Open `http://localhost:8443/dashboard` for the PC UI. The Android app connects via `ws://<lan-ip>:8443/sensor` — the PC IP is entered manually in the app's connect modal and persisted in localStorage for auto-reconnect.

## Architecture

### Wire endpoints (must stay aligned across all files)

- `WS /sensor` — phone → server. Messages: `{type:'data', x, y, z, mag, ts}`, `{type:'marker'}`, `{type:'start_rec'}`, `{type:'stop_rec'}`. Server → phone: `{type:'rec', recording}`.
- `WS /dashboard` — server ↔ dashboard. Server → dashboard: `data`, `history` (replay buffer on connect), `rec`, `phones`, `marker`, `config`. Dashboard → server: `start_rec`, `stop_rec`, `marker`, `set_config`.
- `WS_PORT` in `mobile/app.js` (8443) **must** match `PORT` in `pc/server.js`.
- CSV columns are defined in *two* places (`pc/server.js` `startRecording`, and `mobile/app.js` `exportCSV`). Keep them in sync if the schema changes.

### Server-side state (all in-process, lost on restart)

`pc/server.js` holds the single source of truth for recording state (`recording`, `recStream`, `recCount`, `pendingMarker`) and a 600-sample rolling `dataBuf` that is replayed to each newly connected dashboard. The phone's REC button is just a remote-control message — it does not track recording state locally; it mirrors what the server broadcasts back.

Auto-save toggle (`config.autoSave`, persisted to `pc/config.json` when running standalone, or `%APPDATA%\Mobile Magnetometer\config.json` when running in Electron) gates only the *file write*; live forwarding to the dashboard happens regardless.

### Phone app calibration model

In `mobile/app.js`, `cur.x/y/z` is overwritten inside `record()` from raw → calibrated (raw − offset). Anything that reads `cur` (the WebSocket sender, the readouts, the chart) sees calibrated values. The `zero` function increments `offset` by the current calibrated value, exploiting this invariant — see the comment in `zero()` before changing it.

### Sensor cascade in `mobile/app.js`

`detect()` picks one of four modes in order:
1. `native` — running as Capacitor Android APK; uses `MagnetometerPlugin` for raw μT via `SensorManager.TYPE_MAGNETIC_FIELD`.
2. `generic` — `new Magnetometer()` Generic Sensor API (browser, requires HTTPS).
3. `orientation` — `DeviceOrientationEvent` (iOS fallback, derived compass values, ~50 μT assumed).
4. `sim` — simulation (desktop / no sensor).

`IS_CAPACITOR = !!(window.Capacitor && window.Capacitor.isNativePlatform())` gates the native path. Capacitor injects `window.Capacitor` into the WebView automatically — do not add `<script src="capacitor.js">` to `index.html`.

The native sensor runs at `SENSOR_DELAY_FASTEST`; JS-side throttling in `startNative()` enforces `currentHz`.

### Electron desktop app

`main.js` starts the embedded server by `require('./pc/server')` and calling `start(cb)`, then creates a `BrowserWindow` loading `http://localhost:8443/dashboard` inside the callback. It sets `MOBILE_MAG_DATA_DIR` to `app.getPath('userData')` before loading the server so writable files (config, recordings) land in the OS user-data folder, not next to the binary. The server exports `{ start }` only when `require.main !== module`; when run directly via `node server.js` it boots itself.

The root `package.json` includes Electron dev dependencies, Capacitor dependencies, and the server's runtime dependency (`ws`) so `npm install` at the repo root covers all three without a separate `cd pc && npm install`.

### Android project (`android/`)

Generated by `npx cap add android` — do not hand-edit except for the files in `com/mobilemagnetometer/app/`:
- `MagnetometerPlugin.java` — custom Capacitor plugin; registers on `registerPlugin()` call in `MainActivity.java`.
- `MainActivity.java` — registers `MagnetometerPlugin` before `super.onCreate`.
- `res/xml/network_security_config.xml` — allows cleartext HTTP/WebSocket (needed for `ws://` on the LAN).
- `AndroidManifest.xml` — references the network security config via `android:networkSecurityConfig`.

Run `npx cap sync android` after any change to `mobile/` to copy updated web assets into `android/app/src/main/assets/public/`.

### Static file serving

`pc/server.js` sets `STATIC_DIR = path.join(__dirname, '../mobile')` and serves the phone-app files (`index.html`, `app.js`, `styles.css`, `sw.js`, `compass.png`, `manifest.json`) from `mobile/`. URL paths stay at root level (`/index.html`, `/app.js`, etc.) — `mobile/` is a filesystem detail, not a URL prefix.

### Service worker cache

`mobile/sw.js` uses a versioned cache name (`mobile-magnetometer-vN`). **Bump the version constant whenever any cached static asset changes** (`index.html`, `app.js`, `styles.css`, `manifest.json`, `compass.png`). The service worker is unused in the Capacitor APK (assets are bundled in the APK), but kept for any browser-based testing.
