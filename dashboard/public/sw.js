// Bumped to v8 for the confirmDialog/Client-Secret/tooltip-portal fixes —
// the new name makes the activate handler purge the v7 cache on next load.
// Bump this string on any deploy that changes cached shell assets
// (index.html/style.css/js) and needs to reach already-open clients
// immediately.
const CACHE_NAME = 'velync-cache-v8';

// The app shell: everything needed to render the page and its icons/fonts
// offline (minus the Firebase SDK, which is imported cross-origin from
// gstatic and can't be self-hosted without a bundler). Vendored libraries
// (TomSelect, Feather, the Google button icon) live under /vendor/ so a
// third-party CDN outage can't break the UI.
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/responsive.css',
  '/app.js',
  '/manifest.json',
  '/vendor/tom-select.css',
  '/vendor/tom-select.complete.min.js',
  '/vendor/feather.min.js',
  '/vendor/google.svg',
  '/velync-logo.png',
  '/velync-icon.png',
];

// Install: precache the shell. Individual adds (not addAll) so one missing
// asset can't abort the whole install and leave the SW uninstalled.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(
        ASSETS_TO_CACHE.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[sw] precache skip', url, err && err.message);
          })
        )
      ))
      .then(() => self.skipWaiting())
  );
});

// Activate: drop old-version caches.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.map((name) => (name !== CACHE_NAME ? caches.delete(name) : null)))
    ).then(() => self.clients.claim())
  );
});

// Silently ack service-worker-bound messages (kept from prior versions).
self.addEventListener('message', (event) => {
  if (!event.ports || event.ports.length === 0) return;
  try { event.ports[0].postMessage({ type: 'ack' }); } catch (_) { /* port closed */ }
});

// Fetch: network-first, populate the cache on success, fall back to cache on
// failure. `ignoreSearch` on the cache lookup is the key fix — the page
// requests versioned URLs like `app.js?v=7` / `responsive.css?v=2`, which
// would never match the query-less precached entries otherwise, so an
// offline reload used to fail to find app.js at all.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Never cache/intercept Firebase realtime, Google APIs, or hosting-internal
  // reserved paths — stale auth tokens / API responses would be dangerous.
  if (url.hostname.includes('firebaseio.com') ||
      url.hostname.includes('googleapis.com') ||
      url.pathname.startsWith('/__/')) {
    return;
  }

  const isSameOrigin = url.origin === self.location.origin;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful same-origin GETs so a later offline/flaky load can
        // still serve them (progressive caching beyond the precached shell).
        if (isSameOrigin && response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        // Offline / network failure. Try the cache (ignoring the ?v= query).
        const cached = await caches.match(event.request, { ignoreSearch: true });
        if (cached) return cached;

        // For a navigation with nothing cached, serve the app shell so the
        // user sees the app's own offline UI rather than a browser error page.
        if (event.request.mode === 'navigate') {
          const shell = await caches.match('/index.html', { ignoreSearch: true });
          if (shell) return shell;
        }

        // Genuinely unavailable and uncacheable — return a clear error
        // response instead of letting the fetch reject unhandled.
        return new Response('', { status: 504, statusText: 'Offline' });
      })
  );
});
