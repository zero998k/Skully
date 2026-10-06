// Scout for iPad · service worker for notifications only. It caches nothing, so updates always arrive.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL('./#alerts', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    for (const client of list) if ('focus' in client) return client.focus();
    return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
  }));
});
