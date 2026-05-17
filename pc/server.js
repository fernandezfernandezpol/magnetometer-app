/* =============================================================================
   Mobile Magnetometer — PC Server  (pc/server.js)

   Role in the system
   ──────────────────
   This file is the central hub of the Mobile Magnetometer system. It has four jobs:

     1. STATIC FILE SERVING — serves the phone PWA (index.html, app.js, etc.)
        from the `mobile/` directory so the phone can install it over the LAN,
        and serves the PC dashboard (dashboard.html) from this directory.

     2. SENSOR WEBSOCKET (/sensor) — the Android phone app connects here and
        continuously pushes JSON sensor frames {type:'data', x, y, z, mag, ts}.
        The server also accepts marker and recording-control messages from the
        phone.

     3. DASHBOARD WEBSOCKET (/dashboard) — the Electron desktop window (or any
        browser) connects here to receive a live feed of sensor data, recording
        state, and the phone-connection count. The dashboard can also send
        recording-control and config-change messages back.

     4. REST API (/api/*) — lets the dashboard list, download, and delete saved
        CSV recordings, and get/set the server config (e.g. autoSave).

   Dual-mode execution
   ────────────────────
   The file is designed to run in two ways:

     • Standalone:  `node server.js` (from the pc/ directory) — starts immediately.
     • Embedded:    `require('./pc/server')` from main.js — exports
                    { start } so Electron can call start(cb) after its own
                    setup and only open the BrowserWindow once the port is
                    listening.

   The guard at the bottom (`if (require.main === module)`) selects the mode.

   Endpoints
   ─────────
   GET  /                             → phone app (index.html)
   GET  /dashboard                    → PC dashboard (dashboard.html)
   GET  /app.js, /styles.css, etc.    → static phone-app assets
   WS   /sensor                       → phone connects here to stream data
   WS   /dashboard                    → dashboard connects here to receive data

   REST API
   ────────
   GET    /api/recordings             → list saved recordings (JSON)
   DELETE /api/recordings/:file       → delete a recording
   GET    /api/recordings/:file/download → download CSV
   GET    /api/config                 → get server config
   POST   /api/config                 → update server config
   ============================================================================= */

'use strict';

const http = require('http');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const WebSocket = require('ws');

/* ── Paths & constants ────────────────────────────────────────────────────── */

/* The single TCP port used for both HTTP (static files + REST API) and the
   WebSocket upgrade. Must match the WS_PORT constant in mobile/app.js and
   the hard-coded port in dashboard.html. */
const PORT = 8443;

/* IS_PKG: legacy flag kept for historical reasons — the pkg bundler was once
   used to package the server into a self-contained .exe. The pkg build has
   since been removed in favour of Electron, but the path-branching logic is
   harmless and left in place.

   When running normally (Electron or plain Node):
     • IS_PKG is false, so...
     • DATA_DIR  = MOBILE_MAG_DATA_DIR env var (set by main.js to the
                   OS user-data folder) or __dirname (pc/) as a fallback.
     • STATIC_DIR = ../mobile relative to this file (the phone-app source).

   main.js sets MOBILE_MAG_DATA_DIR before requiring this file so that
   writable outputs (recordings, config) land in the OS user-data folder rather
   than next to the application binary, which may be read-only after install. */
const IS_PKG     = typeof process.pkg !== 'undefined';
const DATA_DIR   = IS_PKG
    ? path.dirname(process.execPath)
    : (process.env.MOBILE_MAG_DATA_DIR || __dirname);
const STATIC_DIR = IS_PKG ? path.dirname(process.execPath) : path.join(__dirname, '../mobile');

/* REC_DIR: directory where CSV recording files are written.
   CFG_FILE: JSON file where the autoSave toggle (and any future config) is
             persisted across server restarts.
   MAX_BUF:  number of data samples kept in the in-memory rolling buffer that
             is replayed to each newly connecting dashboard so it can immediately
             populate its chart without waiting for fresh sensor frames. */
const REC_DIR    = path.join(DATA_DIR, 'recordings');
const CFG_FILE   = path.join(DATA_DIR, 'config.json');
const MAX_BUF    = 600; // rolling in-memory buffer sent to newly connected dashboards

/* Create the recordings directory on first run if it does not exist yet. */
if (!fs.existsSync(REC_DIR)) fs.mkdirSync(REC_DIR);

/* ── Config ───────────────────────────────────────────────────────────────── */

/* ALLOWED_CONFIG_KEYS is a whitelist of the property names that are safe to
   persist in config.json. This guard exists because the dashboard sends a raw
   WebSocket message like { type: 'set_config', autoSave: false } and the
   handler calls saveConfig(msg) directly with that entire object. Without the
   whitelist, the 'type' field (and any other envelope fields) would be written
   into config.json and re-read on next startup, potentially corrupting state. */
const ALLOWED_CONFIG_KEYS = ['autoSave'];

/* In-memory config object. autoSave: true means sensor frames are written to
   the active CSV file; false means they are only forwarded to the dashboard
   (useful for monitoring without filling up disk). */
let config = { autoSave: true };

/* Attempt to load persisted config from disk. Only keys present in
   ALLOWED_CONFIG_KEYS are imported, so a corrupted or manually edited
   config.json cannot introduce unexpected properties into the live config. */
if (fs.existsSync(CFG_FILE)) {
    try {
        const loaded = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
        for (const key of ALLOWED_CONFIG_KEYS) {
            if (key in loaded) config[key] = loaded[key];
        }
    } catch {} // silently ignore missing or malformed config file
}

/* saveConfig(updates)
   ────────────────────
   Merges `updates` into the live `config` object (whitelisted keys only) and
   atomically overwrites config.json.

   Parameters:
     updates — plain object whose keys are config property names to change.
               Extra keys (e.g. WebSocket envelope fields) are silently ignored.

   Side effects:
     • Mutates the module-level `config` object.
     • Writes config.json synchronously (blocking — acceptable because config
       changes are rare user-initiated events, not high-frequency operations). */
function saveConfig(updates) {
    for (const key of ALLOWED_CONFIG_KEYS) {
        if (key in updates) config[key] = updates[key];
    }
    fs.writeFileSync(CFG_FILE, JSON.stringify(config, null, 2));
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/* getLocalIPs()
   ─────────────
   Returns a sorted array of all IPv4 addresses on this machine, always
   including 127.0.0.1. Used at startup to print the URLs the phone should
   connect to.

   The phone and PC must be on the same local network; the relevant address is
   the one in the 192.168.x.x / 10.x.x.x range that both devices share. */
function getLocalIPs() {
    const ips = ['127.0.0.1'];
    for (const iface of Object.values(os.networkInterfaces())) {
        for (const i of iface) {
            if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
        }
    }
    return ips.sort();
}

/* ── Recording state ──────────────────────────────────────────────────────── */

/* All recording state is kept at module scope (single source of truth).
   The phone app does NOT track recording state independently — it mirrors
   whatever the server broadcasts back via the 'rec' message type. This means
   the dashboard and phone buttons both reflect the true server state and can
   toggle recording remotely without getting out of sync. */

let recording     = false;    // true while a recording session is active
let recStream     = null;     // writable file stream, open while recording
let recFile       = '';       // filename of the active (or most recent) recording
let recCount      = 0;        // number of data rows written to the current file
let pendingMarker = false;    // set to true for one sample after a 'marker' event;
                              // causes that CSV row to get a 1 in the marker column
const dataBuf     = [];       // rolling in-memory buffer for new dashboard connections

/* startRecording()
   ─────────────────
   Opens a new timestamped CSV file and transitions the server into recording
   state. If already recording, this is a no-op.

   File naming: recording_YYYY-MM-DDTHH-MM-SS.csv (colons and dots replaced
   with hyphens so the name is valid on Windows).

   After opening the file, it broadcasts the new state to:
     • All dashboards — so their REC indicator and file name update.
     • All phone clients — so the phone's REC button lights up (via broadcastSensors).

   Side effects:
     • Sets module-level `recording`, `recStream`, `recFile`, `recCount`.
     • Creates a new file in REC_DIR.
     • Broadcasts 'rec' messages to both client sets. */
function startRecording() {
    if (recording) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    recFile   = `recording_${ts}.csv`;
    recStream = fs.createWriteStream(path.join(REC_DIR, recFile));
    recStream.write('timestamp_ms,x_uT,y_uT,z_uT,magnitude_uT,marker\n');
    recCount  = 0;
    recording = true;
    console.log(`▶  Recording started: ${recFile}`);
    broadcastDashboard({ type: 'rec', recording: true,  file: recFile, count: 0 });
    broadcastSensors(  { type: 'rec', recording: true });
}

/* stopRecording()
   ────────────────
   Closes the active CSV file stream and transitions the server out of recording
   state. If not currently recording, this is a no-op.

   After closing the file, it broadcasts the final state (including the total
   sample count) to both dashboards and phone clients so their UIs can update.

   Side effects:
     • Clears module-level `recording` and `recStream`.
     • Closes and flushes the CSV file.
     • Broadcasts 'rec' messages to both client sets. */
function stopRecording() {
    if (!recording) return;
    recording = false;
    recStream.end(); // flushes the write buffer and closes the file descriptor
    recStream = null;
    console.log(`■  Recording stopped: ${recFile} (${recCount} samples)`);
    broadcastDashboard({ type: 'rec', recording: false, file: recFile, count: recCount });
    broadcastSensors(  { type: 'rec', recording: false });
}

/* ── WebSocket client sets ────────────────────────────────────────────────── */

/* Two independent Sets track open WebSocket connections by role.
   Using a Set (rather than an array) makes O(1) add/delete on disconnect and
   avoids stale-reference bugs from splicing arrays. */
const sensorClients    = new Set(); // phone connections  → /sensor
const dashboardClients = new Set(); // browser connections → /dashboard

/* broadcastDashboard(obj)
   ────────────────────────
   Serialises `obj` to JSON and sends it to every currently open dashboard
   connection. Connections that are not yet OPEN (e.g. in CLOSING state) are
   skipped silently; the ws library does not queue messages for closing sockets.

   Parameters:
     obj — any JSON-serialisable object. The 'type' field identifies the
           message kind on the receiving end. */
function broadcastDashboard(obj) {
    const msg = JSON.stringify(obj);
    for (const c of dashboardClients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

/* broadcastSensors(obj)
   ──────────────────────
   Serialises `obj` to JSON and sends it to every currently open phone/sensor
   connection. Primarily used to push recording state back to the phone so the
   REC button indicator stays in sync regardless of which client (phone or
   dashboard) triggered the recording toggle.

   Parameters:
     obj — any JSON-serialisable object. In practice, always { type: 'rec', recording: bool }. */
function broadcastSensors(obj) {
    const msg = JSON.stringify(obj);
    for (const c of sensorClients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

/* ── HTTP helpers ─────────────────────────────────────────────────────────── */

/* MIME type map for static files. The server uses the file extension to set
   the Content-Type header. Files with an unrecognised extension fall back to
   'text/plain', which browsers accept for most text-based assets. */
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.svg':  'image/svg+xml',
    '.json': 'application/json',
    '.png':  'image/png',
    '.ico':  'image/x-icon',
};

/* sendJSON(res, data, status)
   ────────────────────────────
   Convenience wrapper that serialises `data` to JSON, sets the correct
   Content-Type header, and ends the response.

   Parameters:
     res    — Node.js http.ServerResponse
     data   — any JSON-serialisable value
     status — HTTP status code (default 200) */
function sendJSON(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/* serveFile(filePath, res)
   ─────────────────────────
   Reads a file from disk asynchronously and writes it to the response with
   the appropriate Content-Type header. Responds with 404 if the file does
   not exist or cannot be read.

   Parameters:
     filePath — absolute filesystem path to the file to serve
     res      — Node.js http.ServerResponse */
function serveFile(filePath, res) {
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'text/plain' });
        res.end(data);
    });
}

/* recordingMeta(filename)
   ────────────────────────
   Reads a CSV file from REC_DIR and returns a metadata object describing it.
   Used by the GET /api/recordings endpoint to populate the dashboard's
   recordings list without sending the file contents.

   Parameters:
     filename — basename of a CSV file inside REC_DIR (e.g. "recording_2024-01-01T12-00-00.csv")

   Returns:
     { name, bytes, date (ISO string from mtime), samples (data row count) }

   Note: sample counting reads the entire file synchronously. This is acceptable
   because recordings are only listed on demand (user opens the recordings panel),
   not on every request. For very large files the mtime-based approach would be
   faster, but an exact row count is more useful in the UI. */
function recordingMeta(filename) {
    const fullPath = path.join(REC_DIR, filename);
    const stat     = fs.statSync(fullPath);
    let samples    = 0;
    try {
        /* Count data rows (skip header line) */
        const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
        samples = lines.filter((l, i) => i > 0 && l.trim()).length;
    } catch {}
    return { name: filename, bytes: stat.size, date: stat.mtime.toISOString(), samples };
}

/* ── REST API ─────────────────────────────────────────────────────────────── */

/* handleAPI(req, res)
   ─────────────────────
   Handles all requests whose URL begins with /api/. Each branch matches a
   specific method + pathname combination and responds, then returns. Unmatched
   combinations fall through to the generic 404 at the bottom.

   Parameters:
     req — Node.js http.IncomingMessage (URL, method, body stream)
     res — Node.js http.ServerResponse */
function handleAPI(req, res) {
    const pathname = req.url.split('?')[0]; // strip query string for matching

    /* GET /api/recordings — list all CSV files, newest first */
    if (pathname === '/api/recordings' && req.method === 'GET') {
        const files = fs.readdirSync(REC_DIR)
            .filter(f => f.endsWith('.csv'))
            .map(recordingMeta)
            .sort((a, b) => new Date(b.date) - new Date(a.date)); // newest first
        return sendJSON(res, files);
    }

    /* DELETE /api/recordings/:file
       path.basename() is used to strip any directory components from the
       decoded filename, preventing path-traversal attacks (e.g. ../../etc/passwd).
       The .csv extension check is an additional safety guard. */
    if (pathname.startsWith('/api/recordings/') && req.method === 'DELETE') {
        const name     = path.basename(decodeURIComponent(pathname.replace('/api/recordings/', '')));
        const fullPath = path.join(REC_DIR, name);
        if (!name.endsWith('.csv') || !fs.existsSync(fullPath)) return sendJSON(res, { ok: false }, 404);
        fs.unlinkSync(fullPath);
        console.log(`🗑  Deleted: ${name}`);
        return sendJSON(res, { ok: true });
    }

    /* GET /api/recordings/:file/download
       Streams the CSV directly into the response using a readable pipe, so the
       entire file does not need to be buffered in memory. The Content-Disposition
       header tells the browser to save it as a file rather than display it. */
    if (pathname.startsWith('/api/recordings/') && pathname.endsWith('/download') && req.method === 'GET') {
        const name     = path.basename(decodeURIComponent(
            pathname.replace('/api/recordings/', '').replace('/download', '')
        ));
        const fullPath = path.join(REC_DIR, name);
        if (!fs.existsSync(fullPath)) { res.writeHead(404); return res.end(); }
        res.writeHead(200, {
            'Content-Type': 'text/csv',
            'Content-Disposition': `attachment; filename="${name}"`,
        });
        return fs.createReadStream(fullPath).pipe(res);
    }

    /* GET /api/config — returns the live config object as JSON so the dashboard
       can read initial state (e.g. on page load) without waiting for a WebSocket
       'config' broadcast. */
    if (pathname === '/api/config' && req.method === 'GET') {
        return sendJSON(res, config);
    }

    /* POST /api/config — allows HTTP clients (or curl) to update config in
       addition to the WebSocket set_config mechanism. After saving, the new
       config is broadcast to all dashboards over WebSocket so their UIs
       reflect the change immediately. */
    if (pathname === '/api/config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                saveConfig(JSON.parse(body));
                broadcastDashboard({ type: 'config', ...config });
                sendJSON(res, { ok: true });
            } catch { sendJSON(res, { ok: false }, 400); }
        });
        return;
    }

    /* No route matched — return a JSON 404 (consistent with the rest of the API). */
    sendJSON(res, { error: 'Not found' }, 404);
}

/* ── HTTP request handler ─────────────────────────────────────────────────── */

/* onRequest(req, res)
   ─────────────────────
   Top-level HTTP request dispatcher. All HTTP traffic (static files, REST API,
   and the WebSocket upgrade handshake for ws://) passes through this function.

   CORS headers are set on every response so the dashboard can make fetch()
   calls from a browser origin that differs from the server origin (e.g. when
   the dashboard is opened from a file:// URL during development).

   Parameters:
     req — Node.js http.IncomingMessage
     res — Node.js http.ServerResponse */
function onRequest(req, res) {
    /* Allow cross-origin requests from any origin (phone app, dashboard during
       development, etc.). The OPTIONS pre-flight check is answered with 204 so
       browsers do not block subsequent requests. */
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const pathname = req.url.split('?')[0];

    /* Route to the REST API handler for all /api/* paths. */
    if (pathname.startsWith('/api/'))                          return handleAPI(req, res);

    /* Serve the PC dashboard HTML. dashboard.html lives next to server.js (in
       pc/), not in STATIC_DIR (mobile/), because it is the desktop UI, not
       a phone-app asset. */
    if (pathname === '/dashboard' || pathname === '/dashboard/') return serveFile(path.join(IS_PKG ? path.dirname(process.execPath) : __dirname, 'dashboard.html'), res);

    /* Serve the phone app entry point. */
    if (pathname === '/')                                       return serveFile(path.join(STATIC_DIR, 'index.html'), res);

    /* Serve other static phone-app assets (app.js, styles.css, sw.js, etc.)
       from STATIC_DIR (mobile/).

       Security note: STATIC_DIR is the parent of pc/, so a path like
       /../../etc/passwd would reach outside the mobile directory. The checks
       below harden against directory traversal:
         • No forward- or back-slashes in the decoded filename (prevents
           subdirectory access).
         • No '..' segments (blocks explicit traversal).
         • No leading dot (prevents serving hidden files like .env). */
    let requested;
    try { requested = decodeURIComponent(pathname.slice(1)); }
    catch { res.writeHead(400); return res.end('Bad request'); }

    if (requested.includes('/') || requested.includes('\\') ||
        requested.includes('..') || requested.startsWith('.')) {
        res.writeHead(404); return res.end('Not found');
    }
    serveFile(path.join(STATIC_DIR, requested), res);
}

/* ── WebSocket handler ────────────────────────────────────────────────────── */

/* onConnection(ws, req)
   ──────────────────────
   Called by the ws library whenever a new WebSocket connection is established.
   The connection is routed to one of two roles based on the URL path:

     /sensor    — phone sensor client (Android app)
     /dashboard — PC dashboard client (Electron or browser)

   Any connection to an unrecognised path is simply ignored (the socket is left
   open but receives no messages and is added to no set).

   Parameters:
     ws  — ws.WebSocket instance for the new connection
     req — Node.js http.IncomingMessage (used to read req.url) */
function onConnection(ws, req) {
    const url = req.url || '';

    /* ── Phone sensor client ── */
    if (url.startsWith('/sensor')) {
        sensorClients.add(ws);
        console.log(`📱 Sensor connected   (${sensorClients.size} active)`);

        /* Notify all dashboards that the phone count has changed so they can
           update a "N phones connected" indicator. */
        broadcastDashboard({ type: 'phones', count: sensorClients.size });

        /* Send the current recording state to the newly connected phone.
           Without this, a phone that connects while a recording is already in
           progress would not light up its REC dot until the next broadcastSensors
           call. The server is the authoritative source of recording state —
           the phone does not track it locally. */
        ws.send(JSON.stringify({ type: 'rec', recording }));

        ws.on('message', raw => {
            try {
                const msg = JSON.parse(raw);

                if (msg.type === 'data') {
                    /* Coerce all numeric fields to Number so downstream code
                       does not have to deal with string values from JSON. */
                    const point = {
                        x: +msg.x, y: +msg.y, z: +msg.z, mag: +msg.mag,
                        ts: msg.ts || Date.now(), // fall back to server timestamp if missing
                    };

                    /* Add to the rolling in-memory buffer. When the buffer is
                       full, the oldest sample is removed (shift) to keep the
                       size bounded at MAX_BUF. New dashboards that connect
                       receive this buffer as a 'history' message so they can
                       immediately display recent data on their chart. */
                    dataBuf.push(point);
                    if (dataBuf.length > MAX_BUF) dataBuf.shift();

                    /* Write to CSV only if a recording is active AND the
                       autoSave config is enabled. The autoSave toggle lets the
                       user monitor data live without committing anything to disk. */
                    if (recording && config.autoSave) {
                        /* pendingMarker is set by a preceding 'marker' message.
                           Writing it into the CSV row and then clearing the flag
                           means exactly one row gets a 1 in the marker column —
                           the first data frame received after the marker event. */
                        const mark = pendingMarker ? 1 : 0;
                        pendingMarker = false;
                        recStream.write(
                            `${point.ts},${point.x.toFixed(4)},${point.y.toFixed(4)},` +
                            `${point.z.toFixed(4)},${point.mag.toFixed(4)},${mark}\n`
                        );
                        recCount++;

                        /* Broadcast updated sample count periodically (every 200
                           samples) rather than on every frame. The dashboard
                           already receives live data on every frame via the 'data'
                           message below, so sending a full 'rec' update every
                           sample would be redundant and wasteful. */
                        if (recCount % 200 === 0) {
                            broadcastDashboard({ type: 'rec', recording: true, file: recFile, count: recCount });
                        }
                    }

                    /* Forward every sample to all connected dashboards, including
                       the current recording state and count so the dashboard UI
                       can reflect them without a separate 'rec' message. */
                    broadcastDashboard({ type: 'data', ...point, recording, recCount });

                } else if (msg.type === 'marker') {
                    /* A marker event does not create its own CSV row; instead it
                       sets a flag that is consumed by the next 'data' frame.
                       The dashboard receives a 'marker' message immediately so
                       it can draw a visual marker line on the chart at the
                       correct timestamp. */
                    pendingMarker = true;
                    broadcastDashboard({ type: 'marker' });

                } else if (msg.type === 'start_rec') {
                    startRecording();
                } else if (msg.type === 'stop_rec') {
                    stopRecording();
                }
            } catch {} // silently drop malformed JSON messages
        });

        ws.on('close', () => {
            sensorClients.delete(ws);
            console.log(`📱 Sensor disconnected (${sensorClients.size} active)`);
            /* Update dashboards with the new phone count after disconnection. */
            broadcastDashboard({ type: 'phones', count: sensorClients.size });
        });

    /* ── PC dashboard client ── */
    } else if (url.startsWith('/dashboard')) {
        dashboardClients.add(ws);
        console.log('🖥  Dashboard connected');

        /* Immediately bring the new dashboard up to speed with current server
           state. Without these messages the dashboard would show stale or empty
           data until the next incoming sensor frame. */

        /* 1. Replay the rolling data buffer so the chart is not blank.
              Sending as a single 'history' array is more efficient than
              replaying 600 individual 'data' messages. */
        ws.send(JSON.stringify({ type: 'history', data: dataBuf }));

        /* 2. Send current recording state (is it recording? which file? how many
              samples?) so the REC indicator and file name are correct. */
        ws.send(JSON.stringify({ type: 'rec',     recording, file: recFile, count: recCount }));

        /* 3. Send the number of currently connected phone clients. */
        ws.send(JSON.stringify({ type: 'phones',  count: sensorClients.size }));

        /* 4. Send the current config (e.g. autoSave) so the dashboard's toggle
              switches reflect the live server state without an HTTP round-trip. */
        ws.send(JSON.stringify({ type: 'config',  ...config }));

        ws.on('message', raw => {
            try {
                const msg = JSON.parse(raw);
                if      (msg.type === 'start_rec')  startRecording();
                else if (msg.type === 'stop_rec')   stopRecording();
                else if (msg.type === 'marker')     { pendingMarker = true; }
                else if (msg.type === 'set_config') {
                    /* Save the new config and immediately broadcast it to all
                       dashboards (including the sender) so every open window
                       reflects the change, not just the one that sent it. */
                    saveConfig(msg);
                    broadcastDashboard({ type: 'config', ...config });
                }
            } catch {} // silently drop malformed JSON messages
        });

        ws.on('close', () => {
            dashboardClients.delete(ws);
            console.log('🖥  Dashboard disconnected');
        });
    }
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */

/* Create a plain HTTP server (no TLS). When running inside Electron, the
   BrowserWindow communicates with localhost so TLS is unnecessary — Electron
   handles its own security context. When running standalone for development,
   plain HTTP is also sufficient for localhost access.

   The single http.Server instance handles both ordinary HTTP requests (via
   onRequest) and WebSocket upgrade handshakes (the ws library intercepts
   'upgrade' events on the same server). */
const server = http.createServer(onRequest);
const wss    = new WebSocket.Server({ server });
wss.on('connection', onConnection);

/* startServer(cb)
   ────────────────
   Binds the HTTP+WebSocket server to PORT on all interfaces (0.0.0.0) and
   prints a startup banner listing the accessible URLs. Calls `cb` once the
   server is listening.

   Binding to 0.0.0.0 (rather than 127.0.0.1) is required so that the phone,
   which connects over the LAN, can reach the server by the machine's LAN IP.

   Parameters:
     cb — optional callback invoked after the server is listening. Used by
          main.js to open the BrowserWindow only once the port is
          ready, avoiding a race condition where the window loads before the
          server is accepting connections. */
function startServer(cb) {
    server.listen(PORT, '0.0.0.0', () => {
        /* Build the startup banner. LAN IPs (excluding loopback) are listed
           so the user knows exactly which WebSocket URL to type into the phone
           app or browser when connecting from another device on the same local network. */
        const ips  = getLocalIPs().filter(ip => ip !== '127.0.0.1');
        const line = s => `║  ${s.padEnd(44)}║`; // pads a line to fit the banner width

        console.log('\n╔══════════════════════════════════════════════╗');
        console.log('║   MOBILE MAGNETOMETER — RUNNING                 ║');
        console.log('╠══════════════════════════════════════════════╣');
        console.log(line('PC Dashboard:'));
        console.log(line(`  http://localhost:${PORT}/dashboard`));
        console.log('║                                              ║');
        console.log(line('Android app WebSocket (same local network):'));
        for (const ip of ips) console.log(line(`  ws://${ip}:${PORT}/sensor`));
        console.log('╚══════════════════════════════════════════════╝\n');
        if (typeof cb === 'function') cb();
    });
}

/* Dual-mode execution guard.
   ───────────────────────────
   • `node server.js` (standalone): require.main === module is true, so the
     server starts immediately with no callback needed.
   • `require('./pc/server')` (from main.js): require.main !== module, so
     the server does NOT start on its own. Instead, the module exports a
     { start } object. electron-main.js calls start(cb) after setting up the
     Electron app and environment variables, ensuring the server only boots
     when the Electron lifecycle is ready. */
if (require.main === module) {
    startServer();
} else {
    module.exports = { start: startServer };
}
