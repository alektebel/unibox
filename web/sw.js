/* unibox service worker — app shell cache, Android share-target, and Web Push. */
const VERSION = "unibox-v10";
const SHELL = [
  "/",
  "/app.js",
  "/styles.css",
  "/mobile.js",
  "/mobile.css",
  "/fonts/geist-latin.woff2",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Android share sheet: the OS POSTs the shared link/photos/voice here.
async function handleShare(request) {
  let added = 0;
  try {
    const form = await request.formData();
    const text = [form.get("title"), form.get("text"), form.get("url")]
      .filter((v) => typeof v === "string" && v.trim())
      .join("\n");
    if (text.trim()) {
      const res = await fetch("/api/capture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const json = await res.json().catch(() => ({}));
      added += json.added || 0;
    }
    const files = form.getAll("files").filter((f) => typeof f !== "string");
    for (const file of files) {
      const name = encodeURIComponent(file.name || "shared");
      await fetch(`/api/capture/file?name=${name}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      });
      added++;
    }
  } catch (e) {
    // fall through to the redirect; the user can retry from the composer
  }
  const dest = new URL(`/?shared=${added}`, self.location.origin).href;
  return Response.redirect(dest, 303);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(handleShare(request));
    return;
  }
  if (request.method !== "GET" || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put("/", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }

  // Network first, so a deploy shows up on the next open; the cache is only for offline.
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request))
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "unibox", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "unibox", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag || "unibox",
      renotify: true,
      data: { url: data.url || "/?screen=dump" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          if ("navigate" in client) client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
    })
  );
});
