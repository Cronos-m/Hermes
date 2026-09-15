/*
 * Hermes - Service Worker
 *
 * El service worker solo puede funcionar cuando Hermes se sirve desde HTTPS
 * (o localhost). Abrir los archivos directamente con file:// no permite que
 * el navegador registre un service worker ni que la PWA sea instalable.
 */

const CACHE_NAME = "hermes-cache-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./icon.png",
  "./icon.ico"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Guardamos los recursos uno por uno para que un recurso opcional no
      // impida instalar todo el shell de la aplicación.
      await Promise.all(
        APP_SHELL.map(async (resource) => {
          try {
            await cache.add(resource);
          } catch (error) {
            console.warn("No se pudo guardar en caché", resource, error);
          }
        })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => Promise.all(
      cacheNames
        .filter((cacheName) => cacheName !== CACHE_NAME)
        .map((cacheName) => caches.delete(cacheName))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  // Para navegaciones, usamos la interfaz guardada como respaldo. Esto cubre
  // también el start_url "./" y cualquier ruta que el servidor no encuentre.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(event.request).then((networkResponse) => {
        if (
          networkResponse.ok &&
          new URL(event.request.url).origin === self.location.origin
        ) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      });
    })
  );
});
