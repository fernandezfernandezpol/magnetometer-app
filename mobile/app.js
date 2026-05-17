/* =============================================================================
   Mobile Magnetometer — Phone App  (mobile/app.js)
   =============================================================================

   WHAT THIS FILE IS
   -----------------
   This is the single JavaScript file that runs the phone side of the Mobile Magnetometer
   system. It is plain ("vanilla") JavaScript — no framework, no build step,
   no bundler. It is loaded directly by mobile/index.html.

   HOW IT FITS IN THE SYSTEM
   --------------------------
   The Mobile Magnetometer system has three parts:

     1. This file (+ index.html / styles.css / sw.js) — the phone UI.
        Reads the device magnetometer and renders a real-time chart.
        Installed on Android as a PWA ("Add to Home Screen") or packaged as
        a native APK via Capacitor.

     2. server/server.js — a Node.js server running on the user's PC.
        Receives sensor readings over WebSocket, fans them out to a browser
        dashboard, and optionally writes them to a CSV file.

     3. The Electron desktop app (repo root) — wraps the server + dashboard
        in a desktop window for a one-click install on Windows.

   DEPLOYMENT MODES
   ----------------
   The phone app detects its environment and selects one of three sensor paths:

     A. IS_CAPACITOR = true  →  Native Android APK (packaged with Capacitor).
        The custom MagnetometerPlugin (Kotlin) exposes TYPE_MAGNETIC_FIELD at
        SENSOR_DELAY_FASTEST via window.Capacitor.Plugins.Magnetometer.

     B. Browser, Magnetometer in window  →  PWA / Chrome on Android.
        Uses the Generic Sensor API (Magnetometer class). Requires HTTPS or
        localhost (secure context).

     C. Browser, DeviceOrientationEvent  →  iOS Safari fallback.
        No raw magnetometer access on iOS; field components are estimated
        from the fused compass heading and tilt, assuming |B| ≈ 50 μT.
        iOS 13+ additionally requires a user-gesture permission request.

     D. None of the above  →  Simulation mode (desktop / no sensor).
        Generates synthetic sinusoidal data so the UI can be tested without
        a real device.

   SENSOR LIFECYCLE
   ----------------
   The sensor does NOT start on page load. It starts only when the WebSocket
   to the PC server opens (ws.onopen → startMeasuring) and stops when the
   WebSocket closes (ws.onclose → stopMeasuring). This keeps the phone
   battery-friendly and ties data collection to an active PC session.

   CALIBRATION INVARIANT
   ---------------------
   cur.x / cur.y / cur.z hold the most-recent reading. Every sensor callback
   sets them to RAW μT values. Then record() immediately overwrites them with
   calibrated values (raw − offset). Everything downstream of record() — the
   readout display, the chart buffer, and the WebSocket sender — therefore
   always sees calibrated values. The zero() function exploits this invariant
   (see the comment there).

   NETWORKING
   ----------
   The app connects to the PC server over a plain ws:// WebSocket (not wss://)
   because the server no longer uses TLS. The port is WS_PORT (8443), which
   must match PORT in server/server.js. The user enters the server's LAN IP
   address once; it is saved to localStorage and auto-restored on the next
   page load.
   ============================================================================= */

(function () {
'use strict';

/* ── Constants ────────────────────────────────────────────────────────────────
   These values are fixed at build-time. Changing WS_PORT here requires the
   matching change in server/server.js.
   ─────────────────────────────────────────────────────────────────────────── */

const MAX_POINTS  = 300;   // Number of samples kept in the rolling chart buffer.
                            // Older samples are discarded (FIFO shift) once full.
const BAR_SCALE   = 100;   // μT value that maps to 100% bar width in the readout panel.
const WS_PORT     = 8443;  // WebSocket port. MUST match PORT in server/server.js.

// IS_CAPACITOR: true when this code is running inside a native Android APK
// packaged with Capacitor. window.Capacitor is injected by the Capacitor
// runtime; isNativePlatform() distinguishes the APK from a browser running
// the same page via a web server. When IS_CAPACITOR is true, we use the
// custom MagnetometerPlugin instead of the browser Sensor API.
const IS_CAPACITOR = !!(window.Capacitor && window.Capacitor.isNativePlatform());

/* localStorage keys — centralised here so they never drift between read and write sites */
const VIS_KEY = 'mm_visible';  // JSON object {x,y,z,mag} axis visibility flags
const IP_KEY  = 'mm_server_ip'; // last successfully used server IP string
const HZ_KEY  = 'mm_hz';       // integer sample rate (1, 5, or 20)
const OFF_KEY = 'mm_offset';   // JSON object {x,y,z} calibration offsets in μT

/* Chart trace colours — kept in JS (not CSS) so the canvas 2D renderer can
   use them directly when drawing strokes and fills. */
const COLORS = {
    x:    { stroke: '#ce9178', fill: 'rgba(206, 145, 120, 0.08)' },
    y:    { stroke: '#4ec9b0', fill: 'rgba(78,  201, 176, 0.08)' },
    z:    { stroke: '#9cdcfe', fill: 'rgba(156, 220, 254, 0.08)' },
    mag:  { stroke: '#c586c0', fill: 'rgba(197, 134, 192, 0.10)' },
    grid:  '#2d2d2d',   // subtle grid line colour
    label: '#858585',   // Y-axis tick label colour
    zero:  '#3e3e42',   // horizontal line at y=0 (visible only when data crosses zero)
};

/* ── Persisted state ──────────────────────────────────────────────────────────
   These values survive page reloads. They are read from localStorage on startup
   and written back whenever the user changes them.
   ─────────────────────────────────────────────────────────────────────────── */

// Per-axis visibility toggles. The user can hide/show each trace by tapping
// the axis badge. State is saved to localStorage so it survives reload.
// Defaults to all-visible if no saved value exists.
const visible = JSON.parse(localStorage.getItem(VIS_KEY) || 'null') ||
    { x: true, y: true, z: true, mag: true };

// Sample rate in Hz. Valid choices are 1, 5, or 20 only. Any other stored
// value (including NaN from an empty/corrupt key) falls back to 20 Hz.
const _savedHz = parseInt(localStorage.getItem(HZ_KEY), 10);
let currentHz  = [1, 5, 20].includes(_savedHz) ? _savedHz : 20;

// Calibration offset in μT. Every raw sensor reading has this subtracted
// before the value is displayed, buffered, or sent. Starts at {0,0,0}
// (no correction) if the user has never pressed ZERO.
const _savedOff = JSON.parse(localStorage.getItem(OFF_KEY) || 'null');
const offset    = _savedOff || { x: 0, y: 0, z: 0 };
// zeroed = true means a non-zero offset is currently active, which determines
// whether the ZERO button's label should say "UNZERO" on page load.
let zeroed      = !!_savedOff;

/* ── Runtime state ────────────────────────────────────────────────────────────
   Everything below is ephemeral — it resets each time the page loads.
   ─────────────────────────────────────────────────────────────────────────── */

let sensorType          = 'none';  // 'native' | 'generic' | 'orientation' | 'sim'
let magnetometer        = null;    // Generic Sensor API Magnetometer instance (mode B)
let orientHandler       = null;    // Bound DeviceOrientation event listener (mode C);
                                   // stored so we can removeEventListener it on stop
let simTimer            = null;    // setInterval handle for simulation mode (mode D)
let animFrame           = null;    // requestAnimationFrame handle for the render loop
let nativeListenerHandle = null;   // The object returned by Mag.addListener() (mode A).
                                   // Stored so we can call .remove() to unsubscribe
                                   // the native event before stopping the sensor.

let paused      = false;  // When true the chart buffer freezes (no new samples added),
                          // but the sensor keeps running and data keeps flowing to the PC.
let pendingMark = false;  // When true the NEXT call to record() will stamp that sample
                          // with mark=1 in the local buffer (mirrors the server marker).

// Counters used to compute the displayed "actual Hz" measurement in the status bar.
let rateCounter  = 0;
let lastRateTime = performance.now();

// Timestamp (ms, from Date.now()) of the last sample accepted by the
// DeviceOrientation handler. Used to throttle iOS events to currentHz.
let lastOrientMs = 0;

// Rolling data buffers — parallel arrays, all the same length (≤ MAX_POINTS).
// When a new sample arrives and the buffer is full, the oldest entry is
// shifted off the front of each array simultaneously so they stay in sync.
const buf = { x: [], y: [], z: [], mag: [], ts: [], mark: [] };

// Most-recent calibrated sample values. Updated by record() after every sensor
// reading. The render loop and sendData() both read from cur, so they always
// see calibrated (not raw) values. See the CALIBRATION INVARIANT note above.
const cur = { x: 0, y: 0, z: 0, mag: 0 };

/* ── DOM references ───────────────────────────────────────────────────────────
   All DOM nodes the app needs to read or mutate are looked up once at startup
   and stored in `el`. Querying the DOM on every frame would be slow and noisy.
   ─────────────────────────────────────────────────────────────────────────── */

const $ = s => document.querySelector(s); // shorthand for querySelector

const el = {
    mode:      $('#sensor-mode'),      // text badge showing current sensor type
    indicator: $('#status-indicator'), // coloured dot (green=ok, red=error, grey=off)
    rate:      $('#sample-rate'),      // live "Hz" readout in the status bar
    vx: $('#val-x'), vy: $('#val-y'), vz: $('#val-z'), vt: $('#val-total'), // numeric readouts
    bx: $('#bar-x'), by: $('#bar-y'), bz: $('#bar-z'),                      // percentage bars
    canvas:    $('#chart'),            // <canvas> element for the time-series chart
    chartWrap: $('#chart-wrap'),       // wrapper div used to measure available pixel size
    btnClear:  $('#btn-clear'),        // clears the rolling buffer
    info:      $('#info-text'),        // descriptive status text below the mode badge
    /* PC link controls */
    pcBtn:    $('#btn-pc-connect'),    // opens the connection modal
    pcStatus: $('#pc-status'),         // LINKED / ... / OFFLINE badge
    recDot:   $('#rec-dot'),           // red flashing dot shown while server is recording
    /* Connection modal — shown when the user taps the PC connect button */
    serverIpInput: $('#server-ip'),    // text input for the server's LAN IP address
    connectModal:  $('#connect-modal'), // the modal overlay element
    btnConnect:    $('#btn-modal-connect'), // "CONNECT" button inside the modal
    btnCancel:     $('#btn-modal-cancel'), // "CANCEL" button inside the modal
    linkTrust:     $('#link-trust'),   // <a> that opens the server URL so the user can
                                       // accept the self-signed TLS cert in the browser
    /* Controls strip — bottom action bar */
    btnZero:  $('#btn-zero'),  // ZERO / UNZERO calibration toggle
    btnPause: $('#btn-pause'), // PAUSE / RESUME chart freeze toggle
    btnRec:   $('#btn-rec'),   // REC / STOP (connected) or EXPORT (standalone)
    btnMark:  $('#btn-mark'),  // stamps the next sample as a marker event
    /* Per-axis statistics spans — 4 axes × 4 stats = 16 DOM nodes */
    stats: {
        x:   { min: $('#stat-x-min'), max: $('#stat-x-max'), mean: $('#stat-x-mean'), sd: $('#stat-x-sd') },
        y:   { min: $('#stat-y-min'), max: $('#stat-y-max'), mean: $('#stat-y-mean'), sd: $('#stat-y-sd') },
        z:   { min: $('#stat-z-min'), max: $('#stat-z-max'), mean: $('#stat-z-mean'), sd: $('#stat-z-sd') },
        mag: { min: $('#stat-m-min'), max: $('#stat-m-max'), mean: $('#stat-m-mean'), sd: $('#stat-m-sd') },
    },
};

/* ── Utility ──────────────────────────────────────────────────────────────────
   Small helper functions with no side-effects on app state.
   ─────────────────────────────────────────────────────────────────────────── */

// Returns true when the app appears to be running on a mobile device.
// Used to decide whether DeviceOrientationEvent is a viable fallback
// (it exists on desktop too, but carries no useful compass data there).
function isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
           (navigator.maxTouchPoints > 0 && window.innerWidth <= 1024);
}

// Returns true when `host` looks like a private LAN address or localhost.
// Previously used to decide whether to auto-connect; now kept as a utility.
function isLocalIP(host) {
    return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|localhost|127\.)/.test(host);
}

// Updates the small mode badge text (e.g. "MAG-API", "OFFLINE").
function setMode(text)       { el.mode.textContent = text; }

// Updates the longer descriptive status line below the mode badge.
function setInfo(text)       { el.info.textContent = text; }

// Sets the coloured status dot in the corner.
// state: 'ok' (green) | 'err' (red) | anything else (grey / off)
function setIndicator(state) {
    el.indicator.className = 'indicator-dot' +
        (state === 'ok'  ? ' active' :
         state === 'err' ? ' error'  : '');
}

/* ── Axis visibility ──────────────────────────────────────────────────────────
   The user can show or hide each axis trace by tapping its label badge on the
   chart or in the readout panels. The state is persisted in localStorage.
   ─────────────────────────────────────────────────────────────────────────── */

// Flips the visible flag for one axis and persists the change.
// The chart re-draws on the next animation frame automatically because render()
// checks visible[] before drawing each trace.
function toggleAxis(axis) {
    visible[axis] = !visible[axis];
    localStorage.setItem(VIS_KEY, JSON.stringify(visible));
    applyVisibility();
}

// Walks every [data-toggle] element and every readout panel and adds or removes
// the CSS class 'axis-off' according to the current visible[] state.
// Called on startup (to restore saved state) and after every toggleAxis() call.
function applyVisibility() {
    for (const axis of ['x', 'y', 'z', 'mag']) {
        const on      = visible[axis];
        const panelId = axis === 'mag' ? 'panel-mag' : `panel-${axis}`;
        document.getElementById(panelId)?.classList.toggle('axis-off', !on);
        document.querySelectorAll(`[data-toggle="${axis}"]`).forEach(e => {
            e.classList.toggle('axis-off', !on);
        });
    }
}

/* ── Sample rate ──────────────────────────────────────────────────────────────
   The active sampling frequency. Only 1, 5, and 20 Hz are exposed in the UI.
   Changing the rate restarts the active sensor because the Generic Sensor API
   (Magnetometer) and the native Capacitor plugin must be restarted to pick up
   the new frequency; the orientation and simulation modes use their own timers.
   ─────────────────────────────────────────────────────────────────────────── */

// Sets the new sample rate, persists it, updates the UI, then restarts the
// sensor pipeline with the new value. Reads: currentHz. Modifies: currentHz,
// localStorage[HZ_KEY], the sensor and its timer/interval.
function setSampleRate(hz) {
    currentHz = hz;
    localStorage.setItem(HZ_KEY, hz);
    updateHzUI();
    stopSensor();       // tear down whatever sensor is currently running
    startSensorOnly();  // restart with the updated currentHz
}

// Highlights the Hz button that matches the current rate; clears the others.
function updateHzUI() {
    document.querySelectorAll('.hz-btn').forEach(btn => {
        btn.classList.toggle('active', +btn.dataset.hz === currentHz);
    });
}

/* ── Zero / calibration ───────────────────────────────────────────────────────
   The ZERO button captures the current ambient field and stores it as `offset`.
   All subsequent readings subtract offset so the displayed value shows only the
   deviation from the baseline. Pressing ZERO again clears the offset.

   INVARIANT: When zero() is called, cur.x/y/z already hold calibrated values
   (i.e. raw − offset), because record() always overwrites them before anything
   else reads them. Therefore the actual raw reading is (cur + offset), and to
   make the NEW offset equal to the current raw reading we write:
       new_offset = (cur + old_offset) = cur + offset   → offset += cur
   This is the reason the code does offset.x += cur.x rather than offset.x = cur.x.
   ─────────────────────────────────────────────────────────────────────────── */

// Toggles calibration. First call: sets offset to the current calibrated value
// plus the existing offset, which is mathematically equal to the raw reading.
// Second call: resets offset to {0,0,0} (raw values shown again).
// Side effects: persists offset to localStorage, clears the rolling buffer
// (because old data was collected on a different scale and would look like a
// discontinuity), updates the button label.
function zero() {
    if (!zeroed) {
        /* cur.x/y/z are calibrated (= raw − offset). To set the new offset to
           the current raw value: new_offset = cur + old_offset. */
        offset.x += cur.x;
        offset.y += cur.y;
        offset.z += cur.z;
        zeroed = true;
        localStorage.setItem(OFF_KEY, JSON.stringify(offset));
        el.btnZero.textContent = 'UNZERO';
    } else {
        offset.x = offset.y = offset.z = 0;
        zeroed = false;
        localStorage.removeItem(OFF_KEY);
        el.btnZero.textContent = 'ZERO';
    }
    clearBuffers(); // old data is no longer on the same scale
}

/* ── Pause / resume ───────────────────────────────────────────────────────────
   Pause freezes the LOCAL chart buffer and statistics display. The sensor
   continues running and record() still calls sendData(), so the PC server keeps
   receiving and recording data without any gap. The buffer simply stops growing.
   ─────────────────────────────────────────────────────────────────────────── */

// Toggles the paused flag and updates the button label and style.
// Reads: paused. Modifies: paused, btnPause appearance.
function togglePause() {
    paused = !paused;
    el.btnPause.textContent = paused ? '▶ RESUME' : '⏸ PAUSE';
    el.btnPause.classList.toggle('ctrl-btn--active', paused);
}

/* ── Marker ───────────────────────────────────────────────────────────────────
   A marker flags a specific moment in the data — e.g. "I moved the object now".
   It appears as a vertical red dashed line on the chart and as marker=1 in the CSV.
   The server is notified in parallel so the same event is stamped in the server CSV.
   ─────────────────────────────────────────────────────────────────────────── */

// Sets pendingMark so the NEXT sample pushed into the buffer gets mark=1.
// Simultaneously sends a 'marker' WebSocket message to the server.
// The button briefly shows a star to confirm the tap.
// No-ops if paused (the chart buffer is frozen, so there is nowhere to mark).
function addMarker() {
    if (paused) return;
    pendingMark = true;
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'marker' }));
    }
    const orig = el.btnMark.textContent;
    el.btnMark.textContent = '★';
    setTimeout(() => { el.btnMark.textContent = orig; }, 500);
}

/* ── Export CSV ───────────────────────────────────────────────────────────────
   Downloads the current rolling buffer as a CSV file. This is the STANDALONE
   (no server) workflow. When connected to a server the REC button should be
   used instead — the server writes a continuous file with no 300-sample limit.
   The column names must stay in sync with the server-side CSV schema defined
   in server/server.js startRecording().
   ─────────────────────────────────────────────────────────────────────────── */

// Serialises buf to CSV and triggers a browser download. Reports an error if
// the buffer is empty. All values are calibrated (offset already applied).
function exportCSV() {
    if (!buf.ts.length) { setInfo('Buffer empty — nothing to export'); return; }

    const rows = ['timestamp_ms,x_uT,y_uT,z_uT,magnitude_uT,marker'];
    for (let i = 0; i < buf.ts.length; i++) {
        rows.push(
            `${buf.ts[i]},${buf.x[i].toFixed(4)},${buf.y[i].toFixed(4)},` +
            `${buf.z[i].toFixed(4)},${buf.mag[i].toFixed(4)},${buf.mark[i] || 0}`
        );
    }

    // Build a temporary object URL, click a hidden anchor to trigger the
    // download, then release the URL after 1 s (enough time for the browser
    // to start the download).
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `magnetometer_${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── WebSocket / PC connection ────────────────────────────────────────────────
   The phone connects to the PC server over a plain ws:// WebSocket (not wss://)
   because the server no longer uses TLS. The endpoint is /sensor. The server
   uses a separate /dashboard endpoint for the browser UI.

   Connection lifecycle:
     connectWS(ip) → ws.onopen → startMeasuring() → sensor starts
     ws.onclose    → stopMeasuring() → sensor stops, auto-retry in 4 s
     disconnectWS() → manual disconnect, no retry

   The REC button is server-driven: the phone only sends start_rec / stop_rec
   messages. The server echoes back {type:'rec', recording: bool} which the
   phone uses to update the REC dot and button label. The phone has no local
   recording state of its own.
   ─────────────────────────────────────────────────────────────────────────── */

let ws               = null;   // Active WebSocket instance, or null when disconnected
let wsServerIP       = null;   // IP of the server we are (or were last) connected to;
                                // kept so the auto-retry knows where to reconnect
let wsReconnectTimer = null;   // setTimeout handle for the 4-second reconnect delay
let isRecording      = false;  // Mirror of the server's recording state; updated via
                                // the 'rec' WebSocket message from the server
let sensorRunning    = false;  // True while the sensor pipeline is active
let iosPermGranted   = false;  // True after the user accepts the iOS 13+ permission prompt

// Updates the pc-status badge (LINKED / ... / OFFLINE).
// state: 'linked' | 'linking' | anything else (maps to OFFLINE)
function setPCStatus(state) {
    el.pcStatus.className   = 'pc-status ' + state;
    el.pcStatus.textContent =
        state === 'linked'  ? 'LINKED'  :
        state === 'linking' ? '...'     : 'OFFLINE';
}

// Opens a ws:// (plain, non-TLS) WebSocket to the given IP on WS_PORT/sensor.
// If a previous connection exists, it is torn down cleanly first.
// On a successful open: saves the IP and starts the sensor pipeline.
// On close: marks offline, queues a 4-second reconnect attempt, stops the sensor.
// On error: marks offline (the close event will fire and handle the retry).
function connectWS(ip) {
    clearTimeout(wsReconnectTimer);
    // Detach the onclose handler before closing to prevent triggering the
    // auto-retry logic for a deliberate replacement connection.
    if (ws) { ws.onclose = null; ws.close(); ws = null; }

    wsServerIP = ip;
    setPCStatus('linking');

    // Plain ws:// — no TLS. The server switched away from HTTPS/WSS, so we
    // do not need a wss:// URI or any certificate handling here.
    ws = new WebSocket(`ws://${ip}:${WS_PORT}/sensor`);

    ws.onopen = () => {
        setPCStatus('linked');
        setInfo(`Linked to PC (${ip})`);
        localStorage.setItem(IP_KEY, ip); // persist for next-session auto-connect
        updateRecPhoneBtn();
        // Start the sensor only if it isn't already running AND we either have
        // a sensor that doesn't need a special permission (anything except iOS
        // DeviceOrientation) OR the iOS permission was already granted.
        if (!sensorRunning && (sensorType !== 'orientation' || iosPermGranted)) {
            startMeasuring();
        }
    };

    ws.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            // The server sends {type:'rec', recording: bool} whenever the
            // recording state changes. The phone mirrors this state to drive
            // the REC dot and button label. The phone itself never decides
            // whether recording is active — only the server does.
            if (msg.type === 'rec') {
                isRecording = msg.recording;
                el.recDot.className = 'rec-dot' + (isRecording ? '' : ' hidden');
                updateRecPhoneBtn();
            }
        } catch {}
    };

    ws.onclose = () => {
        ws = null;
        setPCStatus('offline');
        el.recDot.className = 'rec-dot hidden'; // server gone → recording must have stopped
        isRecording = false;
        updateRecPhoneBtn();
        // Retry automatically after 4 s, but only if we have a target IP.
        // wsServerIP is cleared by disconnectWS() to suppress the retry.
        if (wsServerIP) wsReconnectTimer = setTimeout(() => connectWS(wsServerIP), 4000);
        stopMeasuring(); // no point running the sensor with nowhere to send data
    };

    ws.onerror = () => { ws = null; setPCStatus('offline'); updateRecPhoneBtn(); };
}

// Deliberately disconnects the WebSocket and suppresses any auto-retry.
// Called when the user cancels the connection or switches server IP.
function disconnectWS() {
    clearTimeout(wsReconnectTimer);
    wsServerIP = null;  // tells the onclose handler not to retry
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    setPCStatus('offline');
    el.recDot.className = 'rec-dot hidden';
    isRecording = false;
    updateRecPhoneBtn();
    stopMeasuring();
}

// Updates the REC/STOP/EXPORT button label to reflect the current context:
//   • Connected + recording   → "■ STOP"
//   • Connected + not recording → "▶ REC"
//   • Not connected           → "↓ EXPORT" (saves local buffer to CSV)
function updateRecPhoneBtn() {
    const connected = ws && ws.readyState === WebSocket.OPEN;
    if (connected) {
        el.btnRec.textContent = isRecording ? '■ STOP' : '▶ REC';
    } else {
        el.btnRec.textContent = '↓ EXPORT';
    }
}

// Sends one calibrated sample to the PC server over the open WebSocket.
// No-ops silently when not connected. Called by record() after every sensor
// reading regardless of the paused state (the server should never have gaps
// even when the local chart is frozen).
function sendData() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'data',
            x: cur.x, y: cur.y, z: cur.z, mag: cur.mag,
            ts: Date.now(),
        }));
    }
}

// Called at startup. Reads the last-used server IP from localStorage and
// immediately attempts a WebSocket connection. There is no hostname-based
// auto-detect — the user always provides the IP explicitly via the modal the
// first time; after that the saved IP is used automatically.
function tryAutoConnect() {
    const saved = localStorage.getItem(IP_KEY);
    if (saved) connectWS(saved);
}

/* ── Connection modal ─────────────────────────────────────────────────────────
   A modal overlay that lets the user type the PC server's LAN IP address.
   It also shows a "trust" link that opens the server URL in the browser so the
   user can accept the self-signed certificate (required once per device for
   the Electron app's embedded server).
   ─────────────────────────────────────────────────────────────────────────── */

// Show the modal and pre-fill the input with the last saved IP (if any).
el.pcBtn.addEventListener('click', () => {
    el.serverIpInput.value = localStorage.getItem(IP_KEY) || '';
    updateTrustLink(el.serverIpInput.value || '192.168.1.100');
    el.connectModal.classList.add('open');
});

// Live-update the trust link as the user types a new IP.
el.serverIpInput.addEventListener('input', () => {
    updateTrustLink(el.serverIpInput.value || '192.168.1.100');
});

// Builds the href for the "trust this server" link shown in the modal.
// The link opens the server's HTTP root so the browser's cert-accept UI appears.
function updateTrustLink(ip) {
    el.linkTrust.href = `http://${ip}:${WS_PORT}`;
}

// "CONNECT" button inside the modal: validate, close modal, open WebSocket.
el.btnConnect.addEventListener('click', () => {
    const ip = el.serverIpInput.value.trim();
    if (!ip) return;
    el.connectModal.classList.remove('open');
    connectWS(ip);
});

// "CANCEL" button: close the modal without doing anything.
el.btnCancel.addEventListener('click', () => {
    el.connectModal.classList.remove('open');
});

// Clicking the backdrop (the dimmed area outside the modal card) also closes it.
el.connectModal.addEventListener('click', (e) => {
    if (e.target === el.connectModal) el.connectModal.classList.remove('open');
});

/* ── Controls strip event listeners ──────────────────────────────────────────
   The controls strip is the bottom action bar. Event delegation is used for the
   Hz buttons to avoid attaching multiple identical listeners.
   ─────────────────────────────────────────────────────────────────────────── */

// Hz buttons — single delegated listener on the parent strip element.
// Reads the desired Hz from the button's data-hz attribute.
document.getElementById('controls-strip').addEventListener('click', (e) => {
    if (e.target.classList.contains('hz-btn')) setSampleRate(+e.target.dataset.hz);
});

el.btnZero.addEventListener('click', zero);
el.btnPause.addEventListener('click', togglePause);

// REC button — dual purpose:
//   Connected to server → send start_rec or stop_rec (server decides recording state)
//   Not connected       → trigger a local CSV export of the rolling buffer
el.btnRec.addEventListener('click', () => {
    const connected = ws && ws.readyState === WebSocket.OPEN;
    if (connected) {
        ws.send(JSON.stringify({ type: isRecording ? 'stop_rec' : 'start_rec' }));
    } else {
        exportCSV();
    }
});

el.btnMark.addEventListener('click', addMarker);

/* ── Sensor detection ─────────────────────────────────────────────────────────
   detect() inspects the runtime environment and sets sensorType to one of:
     'native'      — Capacitor APK with MagnetometerPlugin
     'generic'     — Browser with Generic Sensor API (Magnetometer class)
     'orientation' — Browser with DeviceOrientationEvent (iOS)
     'sim'         — No sensor available; use synthetic data
   It does NOT start the sensor — that happens in startSensorOnly().
   ─────────────────────────────────────────────────────────────────────────── */

// Probes the environment and sets sensorType and the mode badge.
// Must be called before any startXxx() function.
function detect() {
    if (IS_CAPACITOR) {
        // Running as a native APK: the Capacitor bridge provides the plugin.
        sensorType = 'native';
        setMode('NATIVE');
        setInfo('Native Android sensor — raw μT');
        return;
    }
    if ('Magnetometer' in window) {
        // Chrome on Android (or other browsers) with the Generic Sensor API.
        sensorType = 'generic';
        setMode('MAG-API');
        setInfo('Native Magnetometer API — raw X Y Z data');
    } else if ('DeviceOrientationEvent' in window && isMobile()) {
        // iOS Safari: no raw magnetometer, but compass heading is available.
        sensorType = 'orientation';
        setMode('DEV-ORI');
        setInfo('DeviceOrientation — estimated field from compass');
    } else {
        // Desktop browser or unsupported device: use simulation.
        sensorType = 'sim';
        setMode('SIM');
        setInfo('Simulation — open on Android for real data');
    }
}

// Runs at startup. Detects the sensor type, handles the iOS 13+ permission
// gating, then either shows the start overlay (iOS) or waits for the PC
// connection to open before starting the sensor pipeline.
async function autoStart() {
    detect();

    // iOS 13+ requires DeviceOrientationEvent.requestPermission() to be called
    // from a direct user-gesture handler (a click event). We cannot call it
    // here at startup, so we show an overlay with a button and defer.
    if (sensorType === 'orientation' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
        showStartOverlay();
        return;
    }

    // For all other sensor types (including sim), we do not start the sensor
    // yet. The sensor starts when the WebSocket opens (ws.onopen → startMeasuring).
    setMode('OFFLINE');
    setInfo('Connect to PC server to start measuring');
}

// Shows a full-screen overlay with a single "START" button. Tapping it calls
// DeviceOrientationEvent.requestPermission() — the required user gesture —
// then either starts the sensor or reports the denial.
function showStartOverlay() {
    const overlay = document.getElementById('start-overlay');
    overlay.style.display = 'flex';

    // { once: true } removes the listener after the first click, preventing
    // the permission dialog from being triggered again on a second tap.
    document.getElementById('btn-start-sensor').addEventListener('click', async () => {
        overlay.style.display = 'none';
        try {
            const result = await DeviceOrientationEvent.requestPermission();
            if (result !== 'granted') {
                setMode('OFFLINE');
                setInfo('Sensor permission denied — connect to PC to retry');
                return;
            }
        } catch {
            setMode('OFFLINE');
            setInfo('Sensor permission error');
            return;
        }

        iosPermGranted = true;
        // If the PC connection was already established while we were waiting
        // for the permission (the user connected first, then accepted the
        // overlay), start immediately. Otherwise wait for the WS to open.
        if (ws && ws.readyState === WebSocket.OPEN) {
            startMeasuring();
        } else {
            setMode('OFFLINE');
            setInfo('Connect to PC server to start measuring');
        }
    }, { once: true });
}

// Starts the sensor pipeline and the render loop.
// Guard: no-ops if the sensor is already running (prevents double-starts).
// Side effects: sets sensorRunning = true, launches the rAF render loop.
function startMeasuring() {
    if (sensorRunning) return;
    sensorRunning = true;
    startSensorOnly();                         // launches the right sensor for sensorType
    setIndicator('ok');
    if (!animFrame) animFrame = requestAnimationFrame(render); // kick off the UI loop
}

// Stops the sensor pipeline, the render loop, and resets the UI to its
// disconnected state (blank readouts, "connect to PC" chart message).
// Side effects: sets sensorRunning = false, cancels rAF, clears buffers.
function stopMeasuring() {
    if (!sensorRunning) return;
    stopSensor();
    cancelAnimationFrame(animFrame);
    animFrame = null;
    sensorRunning = false;
    setIndicator('');
    clearBuffers();
    /* Reset numeric readouts to placeholder dashes */
    el.vx.textContent = '—';
    el.vy.textContent = '—';
    el.vz.textContent = '—';
    el.vt.textContent = '—';
    el.bx.style.width = '0%';
    el.by.style.width = '0%';
    el.bz.style.width = '0%';
    updateStats();   // clears stats to "—"
    drawChart();     // draws the "connect to PC" message on canvas
    setMode('OFFLINE');
    setInfo('Connect to PC server to start measuring');
}

/* ── Sensor lifecycle ─────────────────────────────────────────────────────────
   stopSensor() tears down ALL possible sensor sources in a single call, so the
   caller does not need to know which one was active.
   startSensorOnly() dispatches to the correct start function for the detected
   sensorType without touching the render loop or sensorRunning flag.
   ─────────────────────────────────────────────────────────────────────────── */

// Tears down whichever sensor is currently active. Safe to call when no sensor
// is running (all branches are guarded by null-checks).
function stopSensor() {
    // Mode A: native Capacitor plugin.
    // nativeListenerHandle.remove() unsubscribes the JS 'reading' event
    // listener from the Capacitor bridge. Mag.stop() tells the Kotlin plugin
    // to call sensorManager.unregisterListener(), releasing the hardware.
    if (nativeListenerHandle) {
        nativeListenerHandle.remove();
        nativeListenerHandle = null;
    }
    if (IS_CAPACITOR && window.Capacitor?.Plugins?.Magnetometer) {
        window.Capacitor.Plugins.Magnetometer.stop?.();
    }
    // Mode B: Generic Sensor API.
    if (magnetometer) {
        try { magnetometer.stop(); } catch {}
        magnetometer = null;
    }
    // Mode C: DeviceOrientation.
    if (orientHandler) {
        window.removeEventListener('deviceorientation', orientHandler, true);
        orientHandler = null;
    }
    // Mode D: simulation timer.
    if (simTimer) {
        clearInterval(simTimer);
        simTimer = null;
    }
}

// Dispatches to the correct sensor start function. Does NOT touch sensorRunning
// or the render loop — those are managed by startMeasuring() / stopMeasuring().
function startSensorOnly() {
    switch (sensorType) {
        case 'native':      startNative();      break;
        case 'generic':     startGeneric();     break;
        case 'orientation': startOrientation(); break;
        default:            startSim();         break;
    }
}

/* ── Native Capacitor sensor — Android APK ────────────────────────────────────
   The custom MagnetometerPlugin (Kotlin) registers Android's TYPE_MAGNETIC_FIELD
   sensor at SENSOR_DELAY_FASTEST, which can deliver hundreds of readings per
   second. JS cannot keep up with that rate and the user only wants 1/5/20 Hz,
   so we throttle in JS using lastMs / currentHz instead of configuring the
   native delay (which would require a plugin restart for every rate change).
   ─────────────────────────────────────────────────────────────────────────── */

// Async because Mag.addListener() returns a Promise that resolves to a handle
// object with a .remove() method. The handle is stored in nativeListenerHandle
// so stopSensor() can unsubscribe the listener later.
async function startNative() {
    const Mag = window.Capacitor?.Plugins?.Magnetometer;
    if (!Mag) { fallbackSim(); return; } // plugin not present → fall back to simulation
    try {
        let lastMs = 0; // timestamp of the last sample we actually processed
        nativeListenerHandle = await Mag.addListener('reading', (data) => {
            const now = Date.now();
            // RATE THROTTLE: The native sensor fires at SENSOR_DELAY_FASTEST
            // (potentially 200+ Hz). We discard any reading that arrives less
            // than (1000 / currentHz) ms after the last accepted one.
            // This gives us the user-selected rate without restarting the plugin.
            if (now - lastMs < 1000 / currentHz) return;
            lastMs  = now;
            // Set cur to RAW values from the plugin. record() will subtract
            // offset and overwrite cur with calibrated values.
            cur.x   = data.x;
            cur.y   = data.y;
            cur.z   = data.z;
            cur.mag = Math.hypot(cur.x, cur.y, cur.z);
            record();
        });
        await Mag.start(); // tell the Kotlin plugin to register the hardware listener
    } catch { fallbackSim(); } // any error (plugin crash, security) → simulation
}

/* ── Generic Sensor API — Android Chrome ─────────────────────────────────────
   The W3C Generic Sensor API (Magnetometer class) is supported in Chrome on
   Android. It requires a secure context (HTTPS or localhost); on plain HTTP
   the constructor throws a SecurityError immediately.
   ─────────────────────────────────────────────────────────────────────────── */

// Switches sensorType to 'sim' and starts the simulation. Called when the
// preferred sensor (native plugin or Generic Sensor API) fails to initialise.
function fallbackSim() {
    sensorType = 'sim';
    setMode('SIM');
    startSim();
}

// Creates and starts a Magnetometer instance at the requested frequency.
// The 'reading' event fires whenever a new sample is ready; we copy the raw
// x/y/z values into cur and call record(). On any error, fall back to sim.
function startGeneric() {
    try {
        // Requires a secure context (HTTPS / localhost). On plain HTTP the
        // constructor throws a SecurityError before reaching addEventListener.
        magnetometer = new Magnetometer({ frequency: currentHz });
        magnetometer.addEventListener('reading', () => {
            cur.x   = magnetometer.x;
            cur.y   = magnetometer.y;
            cur.z   = magnetometer.z;
            cur.mag = Math.hypot(cur.x, cur.y, cur.z);
            record();
        });
        magnetometer.addEventListener('error', () => fallbackSim());
        magnetometer.start();
    } catch { fallbackSim(); }
}

/* ── DeviceOrientation — iOS fallback ────────────────────────────────────────
   iOS Safari does not expose the raw magnetometer through any web API. We
   synthesise approximate field components from the compass heading and device
   tilt, assuming a total Earth field magnitude of B = 50 μT (a reasonable
   global average). The result is far less precise than raw μT values but it
   gives a live signal that responds to device rotation and nearby iron objects.

   Math:
     beta  = front-back tilt (degrees). Positive = top tilted forward.
     gamma = left-right tilt (degrees). Positive = right side down.
     h     = compass heading (radians). 0 = North, π/2 = East.

   With webkitCompassHeading (true compass — available on iOS):
     Bx = B · sin(h) · cos(beta)   (East component, horizontal)
     Bz = B · cos(h) · cos(beta)   (North component, horizontal)
     By = B · sin(beta)            (vertical component)

   Without webkitCompassHeading (standard alpha/beta/gamma only):
     Bx = B · cos(beta) · sin(gamma)
     Bz = B · cos(beta) · cos(gamma)
     By = B · sin(beta)

   The handler is throttled to currentHz via the lastOrientMs timestamp because
   deviceorientation can fire at 60 Hz on some iOS devices.
   ─────────────────────────────────────────────────────────────────────────── */

function startOrientation() {
    orientHandler = (e) => {
        const now = Date.now();
        // Throttle: accept at most one reading per (1000/currentHz) ms.
        if (now - lastOrientMs < 1000 / currentHz) return;
        lastOrientMs = now;

        const B     = 50;  // assumed Earth field magnitude in μT
        const beta  = (e.beta  || 0) * Math.PI / 180; // front-back tilt in radians
        const gamma = (e.gamma || 0) * Math.PI / 180; // left-right tilt in radians

        if (e.webkitCompassHeading !== undefined) {
            // iOS-specific: true compass heading referenced to magnetic North.
            const h = e.webkitCompassHeading * Math.PI / 180;
            cur.x = B * Math.sin(h) * Math.cos(beta);
            cur.z = B * Math.cos(h) * Math.cos(beta);
        } else {
            // Standard orientation angles — no heading reference.
            cur.x = B * Math.cos(beta) * Math.sin(gamma);
            cur.z = B * Math.cos(beta) * Math.cos(gamma);
        }
        cur.y   = B * Math.sin(beta);
        cur.mag = Math.hypot(cur.x, cur.y, cur.z);
        record();
    };
    // useCapture = true: receive the event before any child element handlers.
    window.addEventListener('deviceorientation', orientHandler, true);
}

/* ── Simulation ───────────────────────────────────────────────────────────────
   Generates realistic-looking synthetic magnetometer data using overlapping
   sine waves at different frequencies plus a small random noise term.
   The Z component has a large DC offset (~38 μT) to simulate the vertical
   Earth field component typically dominant at mid-latitudes.
   The interval period is 1000/currentHz ms, matching the selected sample rate.
   ─────────────────────────────────────────────────────────────────────────── */

function startSim() {
    let t = 0;
    simTimer = setInterval(() => {
        t += 0.05; // time accumulator; not wall-clock time, just an animation phase
        cur.x   = 18 * Math.sin(t * 0.7) + 4 * Math.sin(t * 3.1) + (Math.random() - 0.5) * 2;
        cur.y   = 12 * Math.cos(t * 0.5) + 6 * Math.cos(t * 2.3) + (Math.random() - 0.5) * 2;
        cur.z   = 38 +  8 * Math.sin(t * 0.3) + 3 * Math.sin(t * 4.7) + (Math.random() - 0.5) * 1.5;
        cur.mag = Math.hypot(cur.x, cur.y, cur.z);
        record();
    }, 1000 / currentHz);
}

/* ── Data pipeline ────────────────────────────────────────────────────────────
   record() is the single funnel through which every sensor reading passes.
   It is called by all four sensor modes after they have written raw values
   into cur. Its responsibilities:
     1. Apply calibration (subtract offset), overwriting cur with calibrated values.
     2. Push the calibrated sample into the rolling buffer (unless paused).
     3. Stamp the pending marker if one is waiting.
     4. Trim the buffer if it exceeds MAX_POINTS.
     5. Increment the rate counter (for the Hz display).
     6. Send the sample to the PC server.
   ─────────────────────────────────────────────────────────────────────────── */

// Reads: cur (raw from sensor), offset, paused, pendingMark.
// Modifies: cur (overwritten with calibrated values), buf (appended + trimmed),
//           pendingMark (consumed), rateCounter, ws (via sendData).
function record() {
    /* CALIBRATION: cur.x/y/z are raw from the sensor callback at this point.
       Subtract the stored offset to obtain calibrated values. Then overwrite
       cur so that every downstream consumer (readouts, chart, WS sender)
       receives calibrated data. This is the invariant that zero() relies on. */
    const cx = cur.x - offset.x;
    const cy = cur.y - offset.y;
    const cz = cur.z - offset.z;
    const cm = Math.hypot(cx, cy, cz);
    cur.x = cx; cur.y = cy; cur.z = cz; cur.mag = cm;

    if (!paused) {
        buf.x.push(cx);
        buf.y.push(cy);
        buf.z.push(cz);
        buf.mag.push(cm);
        buf.ts.push(Date.now());
        // Consume the pending marker flag: mark=1 for this sample, then reset.
        buf.mark.push(pendingMark ? 1 : 0);
        pendingMark = false;

        // Trim: keep only the most-recent MAX_POINTS samples by dropping
        // the oldest element from every parallel array simultaneously.
        if (buf.x.length > MAX_POINTS) {
            buf.x.shift(); buf.y.shift(); buf.z.shift(); buf.mag.shift();
            buf.ts.shift(); buf.mark.shift();
        }
        rateCounter++; // tallied by updateRate() every second
    }

    sendData(); // transmit to server; no-ops when not connected
}

// Empties all rolling buffer arrays simultaneously. Called after zero()
// (scale has changed) and after stopMeasuring() (stale data should not
// linger when a new session starts).
function clearBuffers() {
    buf.x.length = buf.y.length = buf.z.length = buf.mag.length = 0;
    buf.ts.length = buf.mark.length = 0;
}

/* ── Statistics ───────────────────────────────────────────────────────────────
   Computes min, max, mean, and population standard deviation over a numeric
   array in a single forward pass (except for the variance, which needs the
   mean first). All values are in μT.
   ─────────────────────────────────────────────────────────────────────────── */

// Returns {min, max, mean, sd} for arr, or null if arr has fewer than 2 items.
// Uses a two-pass algorithm: one pass to get min/max/sum, a second for variance.
function calcStats(arr) {
    if (arr.length < 2) return null;
    const n = arr.length;
    let min = arr[0], max = arr[0], sum = 0;
    for (let i = 0; i < n; i++) {
        if (arr[i] < min) min = arr[i];
        if (arr[i] > max) max = arr[i];
        sum += arr[i];
    }
    const mean = sum / n;
    let variance = 0;
    for (let i = 0; i < n; i++) variance += (arr[i] - mean) ** 2;
    return { min, max, mean, sd: Math.sqrt(variance / n) };
}

// Recalculates statistics for all four axes and writes the results to the DOM.
// Writes "—" for all fields when the buffer is too short to be meaningful.
function updateStats() {
    const axes = [
        ['x',   el.stats.x],
        ['y',   el.stats.y],
        ['z',   el.stats.z],
        ['mag', el.stats.mag],
    ];
    for (const [axis, dom] of axes) {
        const s = calcStats(buf[axis]);
        if (!s) {
            dom.min.textContent = dom.max.textContent =
            dom.mean.textContent = dom.sd.textContent = '—';
        } else {
            dom.min.textContent  = s.min.toFixed(1);
            dom.max.textContent  = s.max.toFixed(1);
            dom.mean.textContent = s.mean.toFixed(1);
            dom.sd.textContent   = s.sd.toFixed(2);
        }
    }
}

/* ── Display update ───────────────────────────────────────────────────────────
   updateReadouts() and updateRate() are called every animation frame from
   render(). They write to the DOM outside the canvas.
   ─────────────────────────────────────────────────────────────────────────── */

// Updates the four numeric readouts (X, Y, Z, |B|) and the three bar-graph
// widths. All values are calibrated (cur was already overwritten by record()).
// The bar width is clamped to [0, 100]% using BAR_SCALE as the full-scale value.
function updateReadouts() {
    el.vx.textContent = cur.x.toFixed(2);
    el.vy.textContent = cur.y.toFixed(2);
    el.vz.textContent = cur.z.toFixed(2);
    el.vt.textContent = cur.mag.toFixed(2);

    el.bx.style.width = Math.min(Math.abs(cur.x)   / BAR_SCALE * 100, 100) + '%';
    el.by.style.width = Math.min(Math.abs(cur.y)   / BAR_SCALE * 100, 100) + '%';
    el.bz.style.width = Math.min(Math.abs(cur.z)   / BAR_SCALE * 100, 100) + '%';
}

// Measures the actual sample rate by counting how many calls to record()
// occurred in the last ≥ 1000 ms window. Updates the Hz badge once per second.
function updateRate() {
    const now = performance.now();
    const dt  = now - lastRateTime;
    if (dt >= 1000) {
        el.rate.textContent = (rateCounter / dt * 1000).toFixed(0);
        rateCounter  = 0;
        lastRateTime = now;
    }
}

/* ── Canvas chart ─────────────────────────────────────────────────────────────
   The chart is a 2D canvas that re-renders every animation frame. The Y axis
   auto-scales to the visible data range. The X axis represents the rolling
   buffer index (most-recent sample on the right).

   setupCanvas() must be called every frame because the device pixel ratio or
   container size can change (e.g. device rotation). Assigning canvas.width /
   canvas.height clears the canvas AND resets the transform, so ctx.scale()
   must immediately follow to re-apply HiDPI scaling.
   ─────────────────────────────────────────────────────────────────────────── */

// Sizes the canvas backing store to the container's layout size × devicePixelRatio
// (HiDPI / Retina support) and returns {ctx, w, h} in CSS pixels.
// Returns null if the container has no layout yet (deferred until next frame).
function setupCanvas() {
    const wrap = el.chartWrap;
    const dpr  = window.devicePixelRatio || 1;
    const w    = wrap.clientWidth;
    const h    = wrap.clientHeight;
    if (!w || !h) return null; // layout not ready — skip this frame

    // Setting width/height resets the canvas content and transform.
    el.canvas.width         = w * dpr;
    el.canvas.height        = h * dpr;
    el.canvas.style.width   = w + 'px';
    el.canvas.style.height  = h + 'px';

    const ctx = el.canvas.getContext('2d');
    // Re-apply the HiDPI scale so all subsequent draw calls use CSS pixels.
    ctx.scale(dpr, dpr);
    return { ctx, w, h };
}

// The requestAnimationFrame callback. Runs at the display refresh rate
// (typically 60 Hz) when sensorRunning is true. Updates all display elements
// and schedules the next frame.
function render() {
    updateReadouts();
    updateStats();
    updateRate();
    drawChart();
    animFrame = requestAnimationFrame(render);
}

// Draws one complete frame of the time-series chart onto the canvas.
// Called by render() every frame and also by stopMeasuring() (once, to paint
// the "connect to PC" idle message after the loop is cancelled).
function drawChart() {
    const dims = setupCanvas();
    if (!dims) return; // container not laid out yet
    const { ctx, w, h } = dims;

    ctx.clearRect(0, 0, w, h);

    // Padding: l=left (room for Y axis labels), r/t/b=small margins.
    const pad = { l: 42, r: 6, t: 6, b: 6 };
    const cw  = w - pad.l - pad.r;  // usable chart width in CSS pixels
    const ch  = h - pad.t - pad.b;  // usable chart height in CSS pixels

    // Show a placeholder message when there is not enough data to draw.
    if (buf.mag.length < 2) {
        ctx.fillStyle  = COLORS.label;
        ctx.font       = '11px Consolas, monospace';
        ctx.textAlign  = 'center';
        const msg = paused          ? 'PAUSED' :
                    !sensorRunning  ? 'Connect to PC server to start measuring' :
                                      'Acquiring data...';
        ctx.fillText(msg, w / 2, h / 2);
        return;
    }

    /* AUTO-SCALE: compute the Y range from all visible-axis values in the
       buffer, then add 10% headroom so traces don't touch the top/bottom edges. */
    const all  = [...buf.x, ...buf.y, ...buf.z, ...buf.mag];
    let yMin   = Math.min(...all);
    let yMax   = Math.max(...all);
    const span = yMax - yMin || 1; // guard against zero-span (flat line)
    yMin -= span * 0.1;
    yMax += span * 0.1;

    // Mapping helpers: buffer index → canvas X, μT value → canvas Y.
    // The oldest sample (index 0 of a full buffer) maps to the LEFT edge;
    // the newest (MAX_POINTS-1) maps to the RIGHT edge.
    const toX = i => pad.l + (i / (MAX_POINTS - 1)) * cw;
    const toY = v => pad.t + ((yMax - v) / (yMax - yMin)) * ch;

    /* Grid lines and Y axis labels — 5 evenly-spaced horizontal rules */
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth   = 1;
    ctx.setLineDash([1, 3]); // fine dotted line
    ctx.font        = '9px Consolas, monospace';
    ctx.fillStyle   = COLORS.label;
    ctx.textAlign   = 'right';

    for (let i = 0; i <= 4; i++) {
        const y = pad.t + (i / 4) * ch;
        const v = yMax - (i / 4) * (yMax - yMin);
        ctx.beginPath();
        ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y);
        ctx.stroke();
        ctx.fillText(v.toFixed(0), pad.l - 4, y + 3); // label left of the chart area
    }
    ctx.setLineDash([]); // reset to solid

    /* Zero reference line — only drawn when data crosses y=0, so it is
       visible only when calibrated values include negative components. */
    if (yMin < 0 && yMax > 0) {
        const zy = toY(0);
        ctx.strokeStyle = COLORS.zero;
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(pad.l, zy); ctx.lineTo(w - pad.r, zy);
        ctx.stroke();
    }

    /* Marker lines — one vertical red dashed line per marked sample.
       markOff aligns the marker's buffer index with the X coordinate system,
       which is always anchored to MAX_POINTS positions (the right edge is
       always position MAX_POINTS-1, even when the buffer is not yet full). */
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.55)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([2, 3]);
    const markOff = MAX_POINTS - buf.mark.length; // offset from the left edge
    for (let i = 0; i < buf.mark.length; i++) {
        if (buf.mark[i]) {
            const x = toX(markOff + i);
            ctx.beginPath();
            ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ch);
            ctx.stroke();
        }
    }
    ctx.setLineDash([]);

    /* Draws a filled area trace for one data series (one axis).
       The fill is a semi-transparent area between the line and the bottom
       of the chart, giving depth to overlapping traces. */
    function trace(arr, col) {
        if (arr.length < 2) return;
        // off: same index-alignment trick as markOff above — the newest point
        // is always at the right edge (toX(MAX_POINTS-1)) regardless of how
        // many points are in the buffer.
        const off = MAX_POINTS - arr.length;

        ctx.beginPath();
        ctx.moveTo(toX(off), toY(arr[0]));
        for (let i = 1; i < arr.length; i++) ctx.lineTo(toX(off + i), toY(arr[i]));

        // Stroke the line first, then close the path downward and fill.
        ctx.strokeStyle = col.stroke;
        ctx.lineWidth   = 1.5;
        ctx.stroke();

        // Close the polygon: drop to the bottom-left corner to create a filled area.
        ctx.lineTo(toX(off + arr.length - 1), pad.t + ch);
        ctx.lineTo(toX(off), pad.t + ch);
        ctx.closePath();
        ctx.fillStyle = col.fill;
        ctx.fill();
    }

    /* Draw back-to-front so the X trace (rendered last) appears on top.
       Skip any axis the user has toggled off to avoid cluttering the chart. */
    if (visible.mag) trace(buf.mag, COLORS.mag);
    if (visible.z)   trace(buf.z,   COLORS.z);
    if (visible.y)   trace(buf.y,   COLORS.y);
    if (visible.x)   trace(buf.x,   COLORS.x);

    /* Endpoint dots — a small filled circle at the right edge of each visible
       trace, marking the most-recent sample value. */
    function dot(v, color) {
        ctx.beginPath();
        ctx.arc(toX(MAX_POINTS - 1), toY(v), 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
    }

    if (buf.x.length) {
        if (visible.x)   dot(buf.x.at(-1),   COLORS.x.stroke);
        if (visible.y)   dot(buf.y.at(-1),   COLORS.y.stroke);
        if (visible.z)   dot(buf.z.at(-1),   COLORS.z.stroke);
        if (visible.mag) dot(buf.mag.at(-1), COLORS.mag.stroke);
    }

    /* PAUSED watermark — semi-transparent text centred on the chart to remind
       the user that the buffer is frozen even though data may still be flowing. */
    if (paused) {
        ctx.fillStyle = 'rgba(234, 179, 8, 0.15)';
        ctx.font      = 'bold 18px Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('PAUSED', w / 2, h / 2);
    }
}

/* ── Event listeners ──────────────────────────────────────────────────────────
   Miscellaneous DOM event listeners not already attached above.
   ─────────────────────────────────────────────────────────────────────────── */

// Clear button empties the buffer but does not stop the sensor.
el.btnClear.addEventListener('click', clearBuffers);

// Wire up all axis toggle elements. Any element with a data-toggle attribute
// is a click target that hides or shows the matching axis.
document.querySelectorAll('[data-toggle]').forEach(node => {
    node.addEventListener('click', () => toggleAxis(node.dataset.toggle));
});

// Debounced resize handler — drawChart() reads clientWidth/clientHeight, which
// are only accurate after the browser has completed the layout reflow triggered
// by the resize. 100 ms is enough for the reflow to settle on all tested devices.
let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawChart, 100);
});

/* ── Boot ─────────────────────────────────────────────────────────────────────
   Executed once when the page loads. Restores persisted UI state, runs sensor
   detection, and attempts to reconnect to the last-known server.
   ─────────────────────────────────────────────────────────────────────────── */

applyVisibility();                           // restore saved axis toggle state to DOM
updateHzUI();                                // highlight the persisted Hz button
if (zeroed) el.btnZero.textContent = 'UNZERO'; // reflect active calibration in button label
updateRecPhoneBtn();                         // set initial REC/EXPORT label (starts offline)
autoStart();    // detect sensor, handle iOS permission gate, wait for PC connection
tryAutoConnect(); // if a server IP is saved, open the WebSocket immediately

})();
