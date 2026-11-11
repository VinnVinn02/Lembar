// Service worker Lembar: membuat app jalan offline setelah dibuka sekali.
// Naikkan angka versi ini setiap kali mengganti daftar file di bawah.
const CACHE = 'lembar-v4';

const LOCAL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

// Harus sama persis dengan URL di index.html
const CDN = [
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
  'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(LOCAL);
    // Library CDN: usahakan, tapi jangan gagalkan instalasi kalau salah satu gagal.
    await Promise.all(CDN.map((url) =>
      cache.add(new Request(url, { mode: 'cors' })).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // File app sendiri: jaringan dulu (supaya update cepat sampai), cache kalau offline.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      } catch (e) {
        const hit = await caches.match(req, { ignoreSearch: true });
        return hit || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Library CDN: cache dulu (versinya terkunci di URL), jaringan kalau belum ada.
  if (CDN.includes(req.url)) {
    event.respondWith((async () => {
      const hit = await caches.match(req.url);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req.url, copy)).catch(() => {});
      }
      return res;
    })());
  }
});
