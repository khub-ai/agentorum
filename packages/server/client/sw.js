// Agentorum service worker — minimal install-only PWA shell.
// Enables "Add to Home Screen" on Android/iOS without offline caching,
// so the app always loads fresh from the local server.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Pass all fetches straight through to the network (no caching).
self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
