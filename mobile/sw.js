/*
 * sw.js — Service Worker for the Mobile Magnetometer phone app.
 *
 * Caches all static assets on first install so the web app shell loads
 * instantly and works offline. Live sensor data and WebSocket connections
 * are never cached — they must always reach the live server.
 *
 * NOTE: This service worker is only relevant when the app is accessed
 * through a browser (e.g. during UI development). When running as a
 * Capacitor Android APK the web assets are bundled inside the APK itself
 * and the service worker is not registered.
 *
 * Cache versioning: bump CACHE whenever any file in STATIC changes.
 * The old cache is deleted in the 'activate' handler so stale assets are
 * never served from a previous install.
 */

const CACHE = 'mobile-magnetometer-v18';

// These are the only files that should ever be served from cache.
// Everything else (API calls, WebSocket handshakes) must bypass the cache.
const STATIC = ['./', './index.html', './app.js', './styles.css', './manifest.json', './compass.png'];

/* ── Install: pre-cache all static assets ────────────────────────────────── */

self.addEventListener('install', e => {
    // waitUntil keeps the service worker in 'installing' state until the
    // cache is fully populated. If any file fails to cache, installation fails.
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));

    // Skip the normal 'waiting' phase and activate immediately.
    // Without this, the new service worker waits until all tabs using the old
    // version are closed before taking control.
    self.skipWaiting();
});

/* ── Activate: delete stale caches from previous versions ────────────────── */

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            // Delete every cache whose name is not the current version.
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        )
    );
    // Take control of all open pages immediately, without waiting for a reload.
    self.clients.claim();
});

/* ── Fetch: serve static assets from cache, bypass everything else ───────── */

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);

    // Never intercept WebSocket upgrade requests — they have no cache equivalent.
    // Never intercept API calls (/api/*) — they must hit the live server.
    // Never intercept requests to other origins (CDNs, analytics, etc.).
    if (e.request.url.startsWith('ws') ||
        url.pathname.startsWith('/api') ||
        url.origin !== self.location.origin) {
        return; // fall through to the network without calling e.respondWith()
    }

    // Cache-first strategy: return the cached asset if available,
    // otherwise fetch from the network (and do NOT cache the response —
    // assets are only added to cache during the install step above).
    e.respondWith(
        caches.match(e.request).then(cached => cached || fetch(e.request))
    );
});
