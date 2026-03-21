// ── Precision Health Podcast — Service Worker ──
// VERSION: 5
const CACHE_VERSION = 5;
const CACHE_NAME    = 'php-v' + CACHE_VERSION;
const OFFLINE_URL   = '/index.html';

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

// ── Install — pre-cache everything needed for offline ──────────────────────
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        return cache.addAll(STATIC_ASSETS).then(function() {
          // Explicitly cache root as /index.html too so offline fallback
          // hits regardless of how the browser requests the page
          return fetch('/index.html').then(function(res) {
            if (!res || !res.ok) return;
            var clone = res.clone();
            return Promise.all([
              cache.put('/', clone),
              cache.put('/index.html', res)
            ]);
          }).catch(function(){});
        });
      })
      .then(function() { return self.skipWaiting(); })
  );
});

// ── Activate — purge old caches, claim clients ─────────────────────────────
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys()
      .then(function(keys) {
        return Promise.all(
          keys.filter(function(k) { return k !== CACHE_NAME; })
              .map(function(k)   { return caches.delete(k); })
        );
      })
      .then(function() { return self.clients.claim(); })
  );
});

// ── Fetch ──────────────────────────────────────────────────────────────────
self.addEventListener('fetch', function(e) {
  var req = e.request;
  var url = req.url;

  // Never intercept non-GET requests (POST to Apps Script, etc.)
  if (req.method !== 'GET') return;

  // Never intercept audio — always stream
  if (url.includes('.mp3') || url.includes('.m4a') || url.includes('.ogg')) return;

  // Never intercept analytics, Firebase, or FCM
  if (url.includes('google-analytics') || url.includes('googletagmanager')) return;
  if (url.includes('firebasejs') || url.includes('fcm.googleapis') || url.includes('firebase')) return;

  // RSS feed + CORS proxies — network first, cache fallback
  if (url.includes('rss.com') || url.includes('corsproxy') || url.includes('allorigins')) {
    e.respondWith(
      fetch(req)
        .then(function(res) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(req, clone); });
          return res;
        })
        .catch(function() { return caches.match(req); })
    );
    return;
  }

  // App shell (root + index.html) — network first, guaranteed offline fallback
  if (
    url.endsWith('/') ||
    url.endsWith('/index.html') ||
    url.endsWith('/widget.html') ||
    url.endsWith('/notes.html') ||
    url.match(/podcast\.precisionnaturalmedicine\.com\.au\/?$/)
  ) {
    e.respondWith(
      fetch(req)
        .then(function(res) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(req, clone); });
          return res;
        })
        .catch(function() {
          // Offline — try the exact request, then /index.html, then /
          return caches.match(req)
            .then(function(cached) {
              if (cached) return cached;
              return caches.match('/index.html')
                .then(function(c) { return c || caches.match('/'); });
            });
        })
    );
    return;
  }

  // Everything else — cache first, network fallback + update cache
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

// ── Background Sync ────────────────────────────────────────────────────────
// Queues failed API requests (likes, downloads, signups) and retries
// automatically when the device comes back online.
var SYNC_QUEUE_KEY = 'php-sync-queue';

self.addEventListener('sync', function(e) {
  if (e.tag === 'retry-api-requests') {
    e.waitUntil(flushSyncQueue());
  }
});

function flushSyncQueue() {
  return self.registration.sync && getQueuedRequests().then(function(queue) {
    if (!queue || !queue.length) return;
    return Promise.all(queue.map(function(item) {
      return fetch(item.url, {
        method:  item.method  || 'POST',
        headers: item.headers || { 'Content-Type': 'text/plain' },
        body:    item.body
      }).then(function(res) {
        if (res.ok) return removeFromQueue(item.id);
      }).catch(function() {
        // Still offline — leave in queue for next sync
      });
    }));
  });
}

function getQueuedRequests() {
  return self.clients.matchAll().then(function() {
    // Read queue from IndexedDB
    return openSyncDB().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx  = db.transaction('queue', 'readonly');
        var req = tx.objectStore('queue').getAll();
        req.onsuccess = function() { resolve(req.result || []); };
        req.onerror   = function() { resolve([]); };
      });
    });
  });
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
// Pre-fetches the RSS feed in the background (max once per hour) so that
// when the user opens the app, the episode list loads instantly even on
// a slow connection. Also checks for new episodes to badge the app icon.
self.addEventListener('periodicsync', function(e) {
  if (e.tag === 'refresh-feed') {
    e.waitUntil(refreshFeedCache());
  }
  if (e.tag === 'check-new-episodes') {
    e.waitUntil(checkAndBadgeNewEpisode());
  }
});

var RSS_FEED = 'https://media.rss.com/sacredherbology/feed.xml';
var LAST_GUID_KEY = 'php-last-guid';

function refreshFeedCache() {
  return fetch(RSS_FEED)
    .then(function(res) {
      if (!res.ok) return;
      var clone = res.clone();
      return caches.open(CACHE_NAME).then(function(cache) {
        return cache.put(RSS_FEED, clone);
      });
    })
    .catch(function() { /* offline — skip */ });
}

function checkAndBadgeNewEpisode() {
  return fetch(RSS_FEED)
    .then(function(res) { return res.text(); })
    .then(function(text) {
      // Extract first <guid> from RSS
      var match = text.match(/<guid[^>]*>([^<]+)<\/guid>/);
      if (!match) return;
      var latestGuid = match[1].trim();
      // Compare with stored last-seen guid
      return getStoredValue(LAST_GUID_KEY).then(function(stored) {
        if (stored && stored !== latestGuid) {
          // New episode — badge the app icon
          if ('setAppBadge' in navigator) {
            return navigator.setAppBadge(1);
          }
        }
        // Update stored guid
        return setStoredValue(LAST_GUID_KEY, latestGuid);
      });
    })
    .catch(function() {});
}

// Simple key-value store using Cache API (avoids needing another IDB store)
function getStoredValue(key) {
  return caches.open('php-kv').then(function(c) {
    return c.match('/__kv__/' + key).then(function(r) {
      return r ? r.text() : null;
    });
  });
}
function setStoredValue(key, val) {
  return caches.open('php-kv').then(function(c) {
    return c.put('/__kv__/' + key, new Response(val));
  });
}

// ── Messages from page ─────────────────────────────────────────────────────
self.addEventListener('message', function(e) {
  if (!e.data) return;

  // Force update
  if (e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // Page asks SW to queue a failed API request for Background Sync retry
  if (e.data.type === 'QUEUE_REQUEST') {
    openSyncDB().then(function(db) {
      var tx    = db.transaction('queue', 'readwrite');
      var store = tx.objectStore('queue');
      store.add({
        url:     e.data.url,
        method:  e.data.method  || 'POST',
        headers: e.data.headers || { 'Content-Type': 'text/plain' },
        body:    e.data.body,
        queued:  Date.now()
      });
    });
    return;
  }

  // Page registers periodic sync tags
  if (e.data.type === 'REGISTER_PERIODIC_SYNC') {
    if ('periodicSync' in self.registration) {
      self.registration.periodicSync.register('refresh-feed',          { minInterval: 60 * 60 * 1000 }).catch(function(){});
      self.registration.periodicSync.register('check-new-episodes',    { minInterval: 60 * 60 * 1000 }).catch(function(){});
    }
    return;
  }
});

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
    // Clear badge when notification arrives
    ('clearAppBadge' in navigator ? navigator.clearAppBadge() : Promise.resolve())
      .then(function() {
        return self.registration.showNotification(title, {
          body, icon, badge,
          data:     { url },
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

// ── Widget handlers (Windows 11 Widget Board) ─────────────────────────────
// Handles widget install/uninstall, button actions, and periodic data updates

var RSS_FEED_WIDGET = 'https://media.rss.com/sacredherbology/feed.xml';
var widgetState = {}; // tracks installed widget instances

self.addEventListener('widgetinstall', function(e) {
  e.waitUntil(handleWidgetInstall(e.widget));
});

self.addEventListener('widgetuninstall', function(e) {
  e.waitUntil(handleWidgetUninstall(e.widget));
});

self.addEventListener('widgetresume', function(e) {
  e.waitUntil(updateAllWidgets());
});

self.addEventListener('widgetclick', function(e) {
  e.waitUntil(handleWidgetClick(e.action, e.instanceId, e.data));
});

function handleWidgetInstall(widget) {
  if (!widget) return Promise.resolve();
  return updateWidget(widget);
}

function handleWidgetUninstall(widget) {
  if (!widget || !widget.tag) return Promise.resolve();
  delete widgetState[widget.instanceId];
  return Promise.resolve();
}

function handleWidgetClick(action, instanceId, data) {
  if (!action) return Promise.resolve();
  // Open the app for any play/navigate action
  if (action === 'play-episode' || action === 'toggle-play' || action === 'next-episode') {
    var url = 'https://podcast.precisionnaturalmedicine.com.au/';
    if (data && data.slug) url += '#ep-' + data.slug;
    return clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        if ('focus' in list[i]) return list[i].focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    });
  }
  return Promise.resolve();
}

function updateAllWidgets() {
  if (!('widgets' in self)) return Promise.resolve();
  return self.widgets.getAll().then(function(widgets) {
    return Promise.all(widgets.map(updateWidget));
  }).catch(function() {});
}

function updateWidget(widget) {
  if (!widget || !widget.definition) return Promise.resolve();
  var tag = widget.definition.tag;
  if (tag === 'latest-episode' || tag === 'episode-list') {
    return fetchLatestEpisodeData().then(function(data) {
      return self.widgets.updateByTag(tag, { data: JSON.stringify(data) });
    }).catch(function() {});
  }
  if (tag === 'now-playing') {
    var npData = {
      title: 'No episode playing',
      image: 'https://podcast.precisionnaturalmedicine.com.au/icon-512x512.png',
      currentTime: '0:00', duration: '--:--', isPlaying: false, slug: ''
    };
    return self.widgets ? self.widgets.updateByTag('now-playing', { data: JSON.stringify(npData) }) : Promise.resolve();
  }
  return Promise.resolve();
}

function fetchLatestEpisodeData() {
  return fetch(RSS_FEED_WIDGET)
    .then(function(r) { return r.text(); })
    .then(function(text) {
      var parser = new DOMParser ? new DOMParser() : null;
      if (!parser) return {};
      var doc = parser.parseFromString(text, 'text/xml');
      var NS  = 'http://www.itunes.com/dtds/podcast-1.0.dtd';
      var items = Array.from(doc.querySelectorAll('item')).slice(0, 5);
      var episodes = items.map(function(item) {
        var title   = (item.querySelector('title') || {}).textContent || '';
        var enc     = item.querySelector('enclosure');
        var imgEl   = item.getElementsByTagNameNS(NS, 'image')[0];
        var imgUrl  = imgEl ? imgEl.getAttribute('href') : 'https://podcast.precisionnaturalmedicine.com.au/icon-512x512.png';
        var dur     = (item.getElementsByTagNameNS(NS, 'duration')[0] || {}).textContent || '';
        var slug    = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);
        var rawDesc = (item.querySelector('description') || {}).textContent || '';
        var desc    = rawDesc.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').substring(0, 120) + '...';
        var pubDate = (item.querySelector('pubDate') || {}).textContent || '';
        return { title: title, image: imgUrl, duration: dur, slug: slug, description: desc, pubDate: pubDate };
      });
      return {
        // Latest episode data
        title:       episodes[0] ? episodes[0].title : 'No episodes',
        image:       episodes[0] ? episodes[0].image : 'https://podcast.precisionnaturalmedicine.com.au/icon-512x512.png',
        description: episodes[0] ? episodes[0].description : '',
        pubDate:     episodes[0] ? episodes[0].pubDate : '',
        duration:    episodes[0] ? episodes[0].duration : '',
        slug:        episodes[0] ? episodes[0].slug : '',
        // Episode list data
        episodes:    episodes
      };
    });
}

// Update widgets on periodic sync too
var _origPeriodicSync = self.onperiodicsync;
self.addEventListener('periodicsync', function(e) {
  if (e.tag === 'refresh-feed') {
    e.waitUntil(
      Promise.all([refreshFeedCache(), updateAllWidgets()])
    );
  }
});
