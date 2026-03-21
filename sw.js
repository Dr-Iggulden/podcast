// ── Precision Health Podcast — Service Worker ──
// VERSION: 3 — bump this number each deploy to force cache refresh
const CACHE_VERSION = 3;
const CACHE_NAME = 'php-v' + CACHE_VERSION;

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192x192.png',
  '/icon-512x512.png',
  '/icon-96x96.png'
];

// Install — pre-cache shell assets including index.html for offline
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(STATIC_ASSETS);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// Activate — clean old caches, take control immediately
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Fetch strategy:
//   index.html / root   → network first, cache fallback (always get fresh UI)
//   audio files         → pass through, never cache
//   RSS / proxy URLs    → network first, cache fallback
//   Google Analytics    → pass through, never cache
//   Firebase SDK        → pass through, never cache
//   everything else     → cache first, network fallback + cache update
self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  // Never intercept audio — always stream from network
  if (url.includes('.mp3') || url.includes('.m4a') || url.includes('.ogg')) {
    return;
  }

  // Never cache analytics / tag manager
  if (url.includes('google-analytics') || url.includes('googletagmanager')) {
    return;
  }

  // Never cache Firebase SDK calls
  if (url.includes('firebasejs') || url.includes('firebase') || url.includes('fcm')) {
    return;
  }

  // index.html — network first so the app always loads the latest version
  if (
    url.endsWith('/') ||
    url.includes('index.html') ||
    url.match(/podcast\.precisionnaturalmedicine\.com\.au\/?$/)
  ) {
    e.respondWith(
      fetch(e.request).then(function(response) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(e.request, clone);
        });
        return response;
      }).catch(function() {
        return caches.match(e.request).then(function(cached) {
          return cached || caches.match('/index.html');
        });
      })
    );
    return;
  }

  // RSS feed and CORS proxies — network first, cache fallback
  if (url.includes('rss.com') || url.includes('corsproxy') || url.includes('allorigins')) {
    e.respondWith(
      fetch(e.request).catch(function() {
        return caches.match(e.request);
      })
    );
    return;
  }

  // Everything else (fonts, icons, manifest) — cache first, network fallback + update
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) return cached;
      return fetch(e.request).then(function(response) {
        if (response && response.status === 200 && response.type !== 'opaque') {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(e.request, clone);
          });
        }
        return response;
      });
    })
  );
});

// Listen for skipWaiting message from the page
self.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── Push notification display handler ──
self.addEventListener('push', function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) {}

  var title  = data.title || 'The Precision Health Podcast';
  var body   = data.body  || 'A new episode is available.';
  var icon   = data.icon  || '/icon-192x192.png';
  var badge  = data.badge || '/icon-96x96.png';
  var url    = (data.data && data.data.url) ? data.data.url : 'https://podcast.precisionnaturalmedicine.com.au/';

  event.waitUntil(
    self.registration.showNotification(title, {
      body:    body,
      icon:    icon,
      badge:   badge,
      data:    { url: url },
      actions: [{ action: 'listen', title: 'Listen Now' }],
      tag:     'new-episode',
      renotify: true
    })
  );
});

// ── Notification click handler ──
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : 'https://podcast.precisionnaturalmedicine.com.au/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url === url && 'focus' in list[i]) return list[i].focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
