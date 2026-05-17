/*
 * main.js — Electron entry point for the Mobile Magnetometer desktop app.
 *
 * Responsibilities:
 *   1. Start the embedded Node.js server (pc/server.js) in-process.
 *   2. Once the server is listening, open a BrowserWindow that loads the
 *      dashboard at http://localhost:8443/dashboard.
 *   3. Route any external navigation (links that open new windows) to the OS
 *      browser instead of opening a second Electron window.
 *
 * The server module detects whether it is being run standalone (`node server.js`)
 * or embedded here by checking `require.main !== module`. When embedded it
 * exports { start } and waits to be called; when standalone it boots itself.
 *
 * MOBILE_MAG_DATA_DIR is set before requiring the server so writable files
 * (config.json, recordings/) land in the OS user-data folder (e.g.
 * %APPDATA%\Mobile Magnetometer on Windows) rather than next to the installed binary,
 * which may be in a read-only location after installation.
 */

'use strict';

const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

/* ── Main window ─────────────────────────────────────────────────────────── */

let mainWindow = null;

/**
 * Creates the single application window and loads the dashboard.
 * Called inside the server's start() callback so the window only
 * opens once the server is confirmed to be listening on port 8443.
 */
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 960,
        minHeight: 640,
        backgroundColor: '#1e1e1e',
        show: false,
        center: true,
        autoHideMenuBar: true,
        title: 'Mobile Magnetometer',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    // Remove the native application menu entirely (File / Edit / View / …)
    Menu.setApplicationMenu(null);

    // The dashboard is served by the embedded Node.js server on localhost.
    // Plain HTTP is used because both the server and Electron run on the same
    // machine — there is no need for TLS on loopback traffic.
    mainWindow.loadURL('http://localhost:8443/dashboard');

    // Show the window only after the page is fully rendered to avoid a blank frame.
    mainWindow.once('ready-to-show', () => {
        mainWindow.maximize();
        mainWindow.show();
        mainWindow.focus();
    });

    // Any link that tries to open a new window (target="_blank", window.open, etc.)
    // is redirected to the default OS browser instead of spawning a second
    // Electron window, which would have no server-awareness.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' }; // tell Electron not to open the window itself
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

/* ── Boot sequence ───────────────────────────────────────────────────────── */

app.whenReady().then(() => {
    // Set the data directory BEFORE requiring the server module so the server
    // reads this env var at module load time when resolving DATA_DIR.
    process.env.MOBILE_MAG_DATA_DIR = app.getPath('userData');

    // Start the server and open the window in the callback, guaranteeing that
    // the HTTP server is accepting connections before the WebView navigates to it.
    const { start } = require('./pc/server');
    start(() => {
        createWindow();
    });
});

// Quit the entire app when all windows are closed (standard Windows/Linux behaviour).
// On macOS apps conventionally stay open until the user explicitly quits.
app.on('window-all-closed', () => { app.quit(); });

// Re-create the window if the app is activated with no windows open (macOS dock click).
app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
