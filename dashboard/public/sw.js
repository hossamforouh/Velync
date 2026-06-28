const CACHE_NAME = 'velync-cache-v5';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/velync-logo.png',
  '/velync-icon.png'
];

// Install event: cache essential assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate event: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Message event: silently handle service-worker-bound messages
self.addEventListener('message', (event) => {
  // Only respond if the port is still open and this is our own message
  if (!event.ports || event.ports.length === 0) return;
  try {
    event.ports[0].postMessage({ type: 'ack' });
  } catch (_) {
    // Port may have closed — ignore
  }
});

// Fetch event: network first, fallback to cache
self.addEventListener('fetch', (event) => {
  // Only cache GET requests
  if (event.request.method !== 'GET') return;
  
  // Exclude Firebase API and Auth requests from caching to prevent stale auth tokens
  const url = new URL(event.request.url);
  if (url.hostname.includes('firebaseio.com') || 
      url.hostname.includes('googleapis.com') || 
      url.pathname.startsWith('/__/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .catch(async () => {
        const cachedResponse = await caches.match(event.request);
        if (cachedResponse) {
          return cachedResponse;
        }
        return new Response('', { status: 404, statusText: 'Not found' });
      })
  );
});
