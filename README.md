# Mobile Magnetometer

[![Release](https://img.shields.io/github/v/release/fernandezfernandezpol/magnetometer-app?label=latest)](https://github.com/fernandezfernandezpol/magnetometer-app/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Android%20%7C%20Windows-lightgrey)](#installation)

Real-time magnetic field telemetry system. Reads raw X / Y / Z values from the phone's hardware magnetometer in µT, streams them over WebSocket to a PC dashboard, and records them to CSV — designed for precision measurements with Helmholtz coils and similar lab equipment.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│  Android APK  (Capacitor)                    │
│                                              │
│  MagnetometerPlugin.java                     │
│  └─ SensorManager.TYPE_MAGNETIC_FIELD        │
│  └─ Throttled to 1 / 5 / 20 Hz               │
│                                              │
│  app.js  ·  Live chart  ·  Calibration       │
└──────────────────────────────────────────────┘
                         │
                ws://<lan-ip>:8443
                         │
                         ▼
┌──────────────────────────────────────────────┐
│  PC Server  (Node.js / Electron)             │
│                                              │
│  ws  /sensor     ←  phone data ingestion     │
│  ws  /dashboard  →  live fan-out             │
│  http REST       →  recording management     │
│  http static     →  serves the phone app     │
└──────────────────────────────────────────────┘
                         │
             http://localhost:8443/dashboard
                         │
                         ▼
  ┌────────────────────────────────────────────┐
  │  Electron window  ·  auto-opens on launch  │
  │  Dashboard UI  ·  Live chart  ·  REC panel │
  └────────────────────────────────────────────┘
```

The phone app is a native **Android APK** built with [Capacitor](https://capacitorjs.com/). A custom Java plugin reads the hardware magnetometer at full hardware speed, throttled to the user-selected sample rate in JavaScript. Data streams over a plain WebSocket to the PC server on the same Wi-Fi network.

The PC side ships as a **Windows installer** built with Electron. The app embeds the Node.js server and opens the dashboard automatically — no browser required.

---

## Features

- Raw X / Y / Z magnetic field readings in µT at up to 20 Hz
- Live scrolling chart with auto-scaling Y axis, per-axis colour coding, and pause/resume
- Zero / un-zero calibration — subtracts the current reading as an ambient baseline
- CSV recording with start / stop control and event markers
- Auto-save toggle — live data still streams to the dashboard even when auto-save is off
- Recording management: view, download, and delete recordings from the dashboard
- Saved PC IP — the phone reconnects automatically on next launch without re-entering the address

---

## Requirements

| Component              | Requirement                                          |
|------------------------|------------------------------------------------------|
| Android app            | Android 5.1+ (API 22+)                               |
| PC server / dashboard  | Windows 10/11 (x64), [Node.js](https://nodejs.org) v18+ |
| Both together          | Same Wi-Fi network                                   |

---

## Installation

### End users

Download the latest release from the [releases page](https://github.com/fernandezfernandezpol/magnetometer-app/releases/latest) or from the [download page](https://fernandezfernandezpol.github.io/magnetometer-app/):

- **Windows** — run `Mobile-Magnetometer-Setup.exe` and complete the installer wizard.
- **Android** — transfer `Mobile-Magnetometer.apk` to the phone, enable *Install unknown apps* in Settings, then open the file to install.

### Building from source

#### PC server (development / no installer)

```bash
cd pc
npm install       # first time only
node server.js    # or: npm start
```

Windows shortcut: double-click `pc/start.bat` (handles install + run automatically).

The server starts on `http://0.0.0.0:8443`. Open `http://localhost:8443/dashboard` in any browser.

#### PC desktop app (Electron)

```bash
npm install          # installs Electron, Capacitor CLI, and server deps
npm run electron     # launch in development mode
npm run build        # build the Windows installer → dist-app/
```

#### Android APK

```bash
npm install             # installs Capacitor CLI
npx cap sync android    # copies web assets from mobile/ into android/
```

Then open the `android/` folder in **Android Studio** and build:

`Build → Build Bundle(s) / APK(s) → Build APK(s)`

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

> First time in Android Studio: allow Gradle sync to complete before building (~1–2 min).

---

## Usage

### Connecting the phone to the PC

1. Start the PC app — the console prints the server's local IP addresses.
2. Open Mobile Magnetometer on the phone → tap **PC** in the header → enter the PC's IP (e.g. `192.168.1.45`).
3. Tap **CONNECT**. The status badge changes to **LINKED** and data starts streaming.
4. The IP is saved automatically for reconnection on next launch.

### Recording

1. Click **▶ REC** in the dashboard (or on the phone) once linked.
2. The **REC** indicator pulses on both screens while recording.
3. Click **■ STOP** to end the recording. The file appears in the Saved Recordings panel.
4. Use **◆ MARK** at any point to insert a marker row in the active recording.

### CSV format

```
timestamp_ms, x_uT, y_uT, z_uT, magnitude_uT, marker
```

`marker` is `1` for rows flagged with **◆ MARK**, `0` otherwise.

### Calibration

Tap **ZERO** to capture the current reading as the ambient baseline. All subsequent readings subtract this offset, showing the delta from zero. Tap **UNZERO** to restore raw values.

---

## Project structure

```
magnetometer-app/
├── main.js                    # Electron entry point — starts server, opens window
├── package.json               # Root package: Electron + Capacitor CLI + server deps
├── capacitor.config.json      # Capacitor: app ID, webDir, cleartext traffic
│
├── pc/                        # PC application
│   ├── server.js              # Node.js HTTP + WebSocket + REST server
│   ├── dashboard.html         # Dashboard UI (self-contained HTML / JS / CSS)
│   ├── package.json           # Server-only deps (ws) — for standalone use
│   └── start.bat              # Windows one-click standalone server launcher
│
├── mobile/                    # Mobile application (web source for the APK)
│   ├── index.html             # App shell and UI layout
│   ├── app.js                 # Sensor reading, chart rendering, WebSocket client
│   ├── styles.css             # VS Code–inspired dark theme
│   ├── manifest.json          # PWA manifest (icon, theme colour, orientation)
│   ├── sw.js                  # Service worker (offline cache — unused in APK)
│   └── compass.png            # App icon
│
├── android/                   # Generated Android / Capacitor project
│   └── app/src/main/java/com/mobilemagnetometer/app/
│       ├── MainActivity.java          # Registers the sensor plugin
│       └── MagnetometerPlugin.java    # Custom plugin: SensorManager → JS events
│
├── build/
│   └── icon.png               # Electron installer icon (256 × 256)
│
├── docs/                      # GitHub Pages download page
│   ├── index.html
│   └── compass.png
│
└── compass.png                # Master icon (source for all generated icon sizes)
```

---

## Wire protocol

All WebSocket messages are JSON objects with a `type` field.

### Phone → Server &nbsp;(`ws /sensor`)

| `type`      | Fields             | Description                                       |
|-------------|--------------------|----------------------------------------------------|
| `data`      | `x, y, z, mag, ts` | One calibrated sensor sample (µT + ms timestamp)  |
| `marker`    | —                  | Flag the next CSV row as a marked event            |
| `start_rec` | —                  | Remote-control: start a recording                  |
| `stop_rec`  | —                  | Remote-control: stop the current recording         |

### Server → Phone

| `type` | Fields      | Description                                            |
|--------|-------------|--------------------------------------------------------|
| `rec`  | `recording` | Mirrors recording state back to the phone              |

### Dashboard ↔ Server &nbsp;(`ws /dashboard`)

| Direction | `type`                    | Description                                               |
|-----------|---------------------------|-----------------------------------------------------------|
| S → D     | `data`                    | Live sensor sample forwarded to all connected dashboards  |
| S → D     | `history`                 | Last 600 samples replayed to a newly connected dashboard  |
| S → D     | `rec`                     | Recording state change (`recording`, `file`, `count`)     |
| S → D     | `phones`                  | Number of connected phone clients                         |
| S → D     | `marker`                  | Marker event forwarded to the dashboard                   |
| S → D     | `config`                  | Current server configuration (e.g. `autoSave`)           |
| D → S     | `start_rec` / `stop_rec`  | Start or stop a recording                                 |
| D → S     | `marker`                  | Insert a marker from the dashboard side                   |
| D → S     | `set_config`              | Update server configuration                               |

---

## Technical notes

**No TLS.** The server uses plain HTTP and WebSocket (`ws://`). Both the Android APK and the Electron window are native apps that do not require HTTPS for sensor access or WebSocket connections. `network_security_config.xml` explicitly permits cleartext traffic on the LAN. This is intentional; do not expose the server to the internet.

**Native magnetometer plugin.** The Android WebView's Generic Sensor API (`new Magnetometer()`) requires HTTPS, which this project does not use. `MagnetometerPlugin.java` reads `Sensor.TYPE_MAGNETIC_FIELD` directly via `SensorManager` at `SENSOR_DELAY_FASTEST`. JavaScript-side throttling enforces the user-selected Hz.

**Sensor lifecycle.** The magnetometer only runs while the phone is connected to the PC server — it starts on `ws.onopen` and stops on `ws.onclose`. This conserves battery and keeps the reading state unambiguous.

**Calibration invariant.** `record()` in `app.js` overwrites `cur.x/y/z` from raw to calibrated (raw − offset) on every call. Every consumer of `cur` — the WebSocket sender, the chart, the readouts — sees calibrated values. `zero()` exploits this by adding the current calibrated value to the offset, making the current position the new zero without a separate raw-value read.

**Electron embedding.** `main.js` `require()`s `pc/server.js` and calls `start(cb)` before creating the `BrowserWindow`. `MOBILE_MAG_DATA_DIR` is set to `app.getPath('userData')` before the server loads, so recordings and config land in `%APPDATA%\Mobile Magnetometer` rather than next to the binary.

**Privacy.** The app collects no user data. Sensor readings are transmitted only over the local Wi-Fi network to the PC server you control — nothing is sent to any external server, API, or cloud service. The GitHub Pages download page makes no network requests (enforced by `connect-src 'none'` in its Content Security Policy).

---

## License

Released under the [MIT License](LICENSE).  
Copyright © 2026 Pol Fernández Fernández
