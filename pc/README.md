# Mobile Magnetometer — PC App

**Version:** 1.0.0  
**Platform:** Windows 10/11 (x64)  
**Runtime:** Electron (Node.js embedded — no separate installation required)

The PC app is a Windows desktop application that runs a local HTTP + WebSocket server and opens a dashboard window. It receives live magnetometer data from the Android phone, displays a scrolling chart, and records data to CSV files.

---

## Install (end users)

Download `Mobile-Magnetometer-Setup.exe` from the [latest release](https://github.com/polfd/magnetometer-app/releases/latest), run the installer, and launch **Mobile Magnetometer** from the Start Menu or desktop shortcut.

The installer bundles the Node.js server — no external tools required.

---

## Run without installing (development)

Requires [Node.js](https://nodejs.org) v18 or later.

```bash
# from the repo root
npm install        # install Electron and server dependencies
npm run electron   # launch the app in development mode
```

Or run the embedded server standalone (no Electron window, open the dashboard in any browser):

```bash
cd pc
npm install        # first time only — installs ws
node server.js
# then open http://localhost:8443/dashboard in a browser
```

Windows shortcut: double-click `pc/start.bat`.

---

## Build the Windows installer

```bash
# from the repo root
npm install
npm run build
# output: dist-app/Mobile-Magnetometer-Setup.exe
```

Requires electron-builder (installed by `npm install` as a dev dependency). The resulting installer is self-contained and does not require Node.js on the end-user machine.

---

## Configuration

| Setting | Where | Default |
|---------|-------|---------|
| Server port | `pc/server.js` → `PORT` | `8443` |
| Auto-save recordings | Dashboard UI toggle | on |
| Recordings folder | `%APPDATA%\Mobile Magnetometer\recordings\` (Electron) or `pc/recordings/` (standalone) | — |

---

## Dashboard

Open `http://localhost:8443/dashboard` in any browser, or let the Electron window load it automatically.

| Control | Description |
|---------|-------------|
| **▶ REC** | Start a CSV recording |
| **■ STOP** | Stop the current recording |
| **◆ MARK** | Insert a marker row in the active recording |
| **ZERO / UNZERO** | Set / clear the ambient baseline offset |
| Recordings panel | List, download, and delete saved CSV files |

---

## CSV output format

```
timestamp_ms,x_uT,y_uT,z_uT,magnitude_uT,marker
```

`marker` is `1` for rows flagged with **◆ MARK**, `0` otherwise.

---

## Files in this directory

| File | Purpose |
|------|---------|
| `server.js` | Node.js HTTP + WebSocket + REST server |
| `dashboard.html` | Self-contained PC dashboard UI |
| `package.json` | Standalone server dependencies (`ws`) |
| `start.bat` | Windows one-click standalone server launch |
