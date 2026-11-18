// Push notifications only. No fetch handler and no caching: page loads and updates are never touched.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data.json(); } catch { /* not JSON: show the defaults */ }
  const icon = new URL('icon-192.png', self.registration.scope).href;
  e.waitUntil(self.registration.showNotification(String(d.title || 'SPEEDBIKE').slice(0, 60), { body: String(d.body || '').slice(0, 200), icon, badge: icon, data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const w = list.find((c) => c.url.startsWith(self.registration.scope));
    return w ? w.focus() : self.clients.openWindow(url);
  }));
});
