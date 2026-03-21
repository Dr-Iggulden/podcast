// ── Precision Health Podcast — Service Worker ──
// VERSION: 6
const CACHE_VERSION = 6;
const CACHE_NAME    = 'php-v' + CACHE_VERSION;

// Pages to pre-cache at install — ensures offline works from first visit
var ORIGIN = 'https://podcast.precisionnaturalmedicine.com.au';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/notes.html',
  '/widget.html',
  '/manifest.json',
  '/icon-96x96.png',
  '/icon-192x192.png',
  '/icon-512x512.png'
];

// ── Install ────────────────────────────────────────────────────────────────
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      // Fetch and cache each asset individually using absolute URLs
      // so cache keys exactly match navigation request URLs
      var fetches = STATIC_ASSETS.map(function(path) {
        var absUrl = ORIGIN + path;
        return fetch(absUrl, { cache: 'no-cache' })
          .then(function(res) {
            if (!res || !res.ok) return;
            var clone = res.clone();
            // Store under BOTH relative path and absolute URL
            // so caches.match() hits regardless of how it's requested
            return Promise.all([
              cache.put(path, clone),
              cache.put(absUrl, res)
            ]);
          }).catch(function() {});
      });
      return Promise.all(fetches);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// ── Activate — purge old caches ────────────────────────────────────────────
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k)   { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ── Fetch ──────────────────────────────────────────────────────────────────
self.addEventListener('fetch', function(e) {
  var req = e.request;
  var url = req.url;

  // Only handle GET
  if (req.method !== 'GET') return;

  // Never cache audio — always stream
  if (url.includes('.mp3') || url.includes('.m4a') || url.includes('.ogg')) return;

  // Never cache analytics or Firebase
  if (url.includes('google-analytics') || url.includes('googletagmanager')) return;
  if (url.includes('firebasejs') || url.includes('fcm.googleapis') || url.includes('firebase')) return;

  // RSS feed + CORS proxies — network first, cache fallback
  if (url.includes('rss.com') || url.includes('corsproxy') || url.includes('allorigins')) {
    e.respondWith(
      fetch(req).then(function(res) {
        var clone = res.clone();
        caches.open(CACHE_NAME).then(function(c) { c.put(req, clone); });
        return res;
      }).catch(function() { return caches.match(req); })
    );
    return;
  }

  // App shell pages — network first, multi-key offline fallback
  var isAppShell = (
    url.endsWith('/') ||
    url.endsWith('/index.html') ||
    url.endsWith('/notes.html') ||
    url.endsWith('/notes') ||
    url.endsWith('/widget.html') ||
    url.endsWith('/widget') ||
    url.match(/podcast\.precisionnaturalmedicine\.com\.au\/?$/)
  );

  if (isAppShell) {
    e.respondWith(
      fetch(req).then(function(res) {
        // Cache fresh copy
        var clone = res.clone();
        caches.open(CACHE_NAME).then(function(c) { c.put(req, clone); });
        return res;
      }).catch(function() {
        // Offline — try multiple cache key forms
        return caches.match(req, { ignoreSearch: true }).then(function(cached) {
          if (cached) return cached;
          // Try absolute URL form
          return caches.match(ORIGIN + new URL(req.url).pathname, { ignoreSearch: true })
            .then(function(cached2) {
              if (cached2) return cached2;
              // Map extensionless paths to .html versions
              if (url.endsWith('/notes'))  {
                return caches.match(ORIGIN + '/notes.html').then(function(c) { return c || caches.match('/notes.html'); });
              }
              if (url.endsWith('/widget')) {
                return caches.match(ORIGIN + '/widget.html').then(function(c) { return c || caches.match('/widget.html'); });
              }
              // Final fallback — serve index
              return caches.match(ORIGIN + '/index.html').then(function(c) {
                return c || caches.match(ORIGIN + '/') || caches.match('/index.html') || caches.match('/');
              });
            });
        });
      })
    );
    return;
  }

  // Everything else — cache first, background update
  e.respondWith(
    caches.match(req).then(function(cached) {
      var networkFetch = fetch(req).then(function(res) {
        if (res && res.status === 200 && res.type !== 'opaque') {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(req, clone); });
        }
        return res;
      });
      return cached || networkFetch;
    })
  );
});

// ── Messages ───────────────────────────────────────────────────────────────
self.addEventListener('message', function(e) {
  if (!e.data) return;
  if (e.data.type === 'SKIP_WAITING') { self.skipWaiting(); return; }

  // Queue failed API request for Background Sync retry
  if (e.data.type === 'QUEUE_REQUEST') {
    openSyncDB().then(function(db) {
      var tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').add({
        url: e.data.url, method: e.data.method || 'POST',
        headers: e.data.headers || { 'Content-Type': 'text/plain' },
        body: e.data.body, queued: Date.now()
      });
    });
    return;
  }
});

// ── Background Sync — retry failed API calls ───────────────────────────────
self.addEventListener('sync', function(e) {
  if (e.tag === 'retry-api-requests') {
    e.waitUntil(flushSyncQueue());
  }
});

function flushSyncQueue() {
  return openSyncDB().then(function(db) {
    return new Promise(function(resolve) {
      var tx  = db.transaction('queue', 'readonly');
      var req = tx.objectStore('queue').getAll();
      req.onsuccess = function() {
        var queue = req.result || [];
        if (!queue.length) { resolve(); return; }
        Promise.all(queue.map(function(item) {
          return fetch(item.url, {
            method: item.method, headers: item.headers, body: item.body
          }).then(function(res) {
            if (res.ok) return removeFromQueue(item.id);
          }).catch(function() {});
        })).then(resolve);
      };
      req.onerror = function() { resolve(); };
    });
  }).catch(function() {});
}

function removeFromQueue(id) {
  return openSyncDB().then(function(db) {
    return new Promise(function(resolve) {
      var tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').delete(id);
      tx.oncomplete = resolve;
    });
  });
}

function openSyncDB() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open('php-sync', 1);
    req.onupgradeneeded = function(e) {
      e.target.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror   = function()  { reject(req.error); };
  });
}

// ── Periodic Background Sync ───────────────────────────────────────────────
var RSS_FEED     = 'https://media.rss.com/sacredherbology/feed.xml';
var LAST_GUID_KEY = 'php-last-guid';

self.addEventListener('periodicsync', function(e) {
  if (e.tag === 'refresh-feed')       e.waitUntil(refreshFeedCache());
  if (e.tag === 'check-new-episodes') e.waitUntil(checkAndBadgeNewEpisode());
});

function refreshFeedCache() {
  return fetch(RSS_FEED).then(function(res) {
    if (!res.ok) return;
    var clone = res.clone();
    return caches.open(CACHE_NAME).then(function(c) { return c.put(RSS_FEED, clone); });
  }).catch(function() {});
}

function checkAndBadgeNewEpisode() {
  return fetch(RSS_FEED).then(function(r) { return r.text(); }).then(function(text) {
    var match = text.match(/<guid[^>]*>([^<]+)<\/guid>/);
    if (!match) return;
    var latestGuid = match[1].trim();
    return getStoredValue(LAST_GUID_KEY).then(function(stored) {
      if (stored && stored !== latestGuid && 'setAppBadge' in navigator) {
        navigator.setAppBadge(1).catch(function() {});
      }
      return setStoredValue(LAST_GUID_KEY, latestGuid);
    });
  }).catch(function() {});
}

function getStoredValue(key) {
  return caches.open('php-kv').then(function(c) {
    return c.match('/__kv__/' + key).then(function(r) { return r ? r.text() : null; });
  });
}
function setStoredValue(key, val) {
  return caches.open('php-kv').then(function(c) {
    return c.put('/__kv__/' + key, new Response(val));
  });
}

// ── Push notifications ─────────────────────────────────────────────────────
self.addEventListener('push', function(e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch(ex) {}
  var title = data.title || 'The Precision Health Podcast';
  var body  = data.body  || 'A new episode is available.';
  var icon  = data.icon  || '/icon-192x192.png';
  var badge = data.badge || '/icon-96x96.png';
  var url   = (data.data && data.data.url) ? data.data.url : 'https://podcast.precisionnaturalmedicine.com.au/';
  e.waitUntil(
    (('clearAppBadge' in navigator) ? navigator.clearAppBadge() : Promise.resolve())
      .then(function() {
        return self.registration.showNotification(title, {
          body, icon, badge, data: { url },
          actions:  [{ action: 'listen', title: 'Listen Now' }],
          tag:      'new-episode',
          renotify: true
        });
      })
  );
});

// ── Notification click ─────────────────────────────────────────────────────
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url)
    ? e.notification.data.url
    : 'https://podcast.precisionnaturalmedicine.com.au/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url === url && 'focus' in list[i]) return list[i].focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ── Widget handlers ────────────────────────────────────────────────────────
self.addEventListener('widgetinstall',  function(e) { e.waitUntil(updateWidget(e.widget)); });
self.addEventListener('widgetuninstall',function(e) { /* nothing to clean up */ });
self.addEventListener('widgetresume',   function(e) { e.waitUntil(updateAllWidgets()); });
self.addEventListener('widgetclick',    function(e) { e.waitUntil(handleWidgetClick(e.action, e.instanceId, e.data)); });

function handleWidgetClick(action, instanceId, data) {
  var url = 'https://podcast.precisionnaturalmedicine.com.au/';
  if (data && data.slug) url += '#ep-' + data.slug;
  return clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
    for (var i = 0; i < list.length; i++) {
      if ('focus' in list[i]) return list[i].focus();
    }
    if (clients.openWindow) return clients.openWindow(url);
  });
}

function updateAllWidgets() {
  if (!('widgets' in self)) return Promise.resolve();
  return self.widgets.getAll().then(function(ws) {
    return Promise.all(ws.map(updateWidget));
  }).catch(function() {});
}

function updateWidget(widget) {
  if (!widget || !widget.definition) return Promise.resolve();
  var tag = widget.definition.tag;
  if (tag === 'now-playing') {
    var data = JSON.stringify({ title: 'No episode playing', image: '/icon-512x512.png', currentTime: '0:00', duration: '--:--', isPlaying: false, slug: '' });
    return self.widgets ? self.widgets.updateByTag(tag, { data }) : Promise.resolve();
  }
  return fetchLatestEpisodeData().then(function(data) {
    return self.widgets ? self.widgets.updateByTag(tag, { data: JSON.stringify(data) }) : Promise.resolve();
  }).catch(function() {});
}

function fetchLatestEpisodeData() {
  return fetch(RSS_FEED).then(function(r) { return r.text(); }).then(function(text) {
    var NS   = 'http://www.itunes.com/dtds/podcast-1.0.dtd';
    var doc  = new DOMParser().parseFromString(text, 'text/xml');
    var items = Array.from(doc.querySelectorAll('item')).slice(0, 5);
    var eps = items.map(function(item, i) {
      var title  = (item.querySelector('title') || {}).textContent || '';
      var imgEl  = item.getElementsByTagNameNS(NS, 'image')[0];
      var imgUrl = imgEl ? imgEl.getAttribute('href') : '/icon-512x512.png';
      var dur    = (item.getElementsByTagNameNS(NS, 'duration')[0] || {}).textContent || '';
      var rawDesc= (item.querySelector('description') || {}).textContent || '';
      var desc   = rawDesc.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').substring(0, 120);
      var pub    = (item.querySelector('pubDate') || {}).textContent || '';
      var slug   = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);
      return { num: items.length - i, title, image: imgUrl, duration: dur, description: desc, pubDate: pub, slug };
    });
    return { title: eps[0] ? eps[0].title : '', image: eps[0] ? eps[0].image : '/icon-512x512.png', description: eps[0] ? eps[0].description : '', pubDate: eps[0] ? eps[0].pubDate : '', duration: eps[0] ? eps[0].duration : '', slug: eps[0] ? eps[0].slug : '', episodes: eps };
  });
}
