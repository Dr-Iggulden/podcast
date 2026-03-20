// ── Firebase Cloud Messaging Service Worker ──
// This file MUST be named firebase-messaging-sw.js and served from the root
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            'AIzaSyCs0aFTyPrCYUojYQBMdK35OQmlMgoMV3E',
  projectId:         'the-precision-health-podcast',
  messagingSenderId: '457399711361',
  appId:             '1:457399711361:web:ef5d6374f18b73c307bf80'
});

var messaging = firebase.messaging();

// Handle background messages (when browser tab is not open)
messaging.onBackgroundMessage(function(payload) {
  console.log('Background message received:', payload);
  var notification = payload.notification || {};
  var data         = payload.data         || {};
  var url          = (data.url || notification.click_action || 'https://podcast.precisionnaturalmedicine.com.au/');

  return self.registration.showNotification(
    notification.title || 'The Precision Health Podcast',
    {
      body:    notification.body  || '',
      icon:    notification.icon  || '/icon-192x192.png',
      badge:   '/icon-96x96.png',
      data:    { url: url },
      actions: [{ action: 'listen', title: 'Listen Now' }]
    }
  );
});

// Open podcast page when notification is clicked
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : 'https://podcast.precisionnaturalmedicine.com.au/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url === url && 'focus' in clientList[i]) {
          return clientList[i].focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
