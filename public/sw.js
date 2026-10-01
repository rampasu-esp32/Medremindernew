// Service worker for the Smart Medicine Reminder PWA.
//
// Only the app shell (the page itself, icons, manifest) is cached, so the app
// opens instantly and still opens with no signal at all. /api/* is never
// cached - it's the live state of the pill box, and showing stale data there
// would be actively misleading, so those requests always go to the network
// and are simply left unhandled here on failure (the page's own "offline"
// banner in index.html already covers that case).

const CACHE = 'medrem-shell-v1';   // bump this string whenever the shell files change materially
const SHELL = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET' || url.origin !== self.location.origin) return;   // let everything else pass through untouched
  if (url.pathname.startsWith('/api/')) return;                             // always live, never cached

  // App shell: try the network first so a schedule/UI update shows up as soon
  // as it's deployed, but fall back to the cached copy when there's no signal.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('/')))
  );
});
