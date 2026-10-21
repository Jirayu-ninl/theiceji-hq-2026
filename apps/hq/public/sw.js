/* HQ service worker — Web Push for the devices registered here.
 *
 * Intentionally tiny: it exists only to receive push messages and route a
 * notification click to wherever the message points. No offline caching, no
 * asset interception — this is an admin tool, not an offline app.
 *
 * `url` is normally a path on this origin (`/inbox`, where a request is
 * waiting for the owner). An absolute URL on another origin is still
 * honoured, but a tab can only be navigated within its own origin, so such a
 * target opens a window instead of reusing one.
 */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim()),
)

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (_) {
    data = {}
  }

  const title = data.title || 'Something needs you'
  const options = {
    body: data.body || '',
    tag: data.tag || 'hq',
    icon: '/icon.svg',
    badge: '/icon.svg',
    data: { url: data.url || '/' },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const raw = (event.notification.data && event.notification.data.url) || '/'
  const target = new URL(raw, self.location.origin)
  const sameOrigin = target.origin === self.location.origin

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        // Focus an existing tab of this app if one is open; a target on
        // another origin can only be opened, never navigated to.
        if (sameOrigin) {
          for (const client of clients) {
            if ('focus' in client) {
              client.navigate(target.href)
              return client.focus()
            }
          }
        }
        return self.clients.openWindow(target.href)
      }),
  )
})
