/*
 * Hermes - Service Worker
 *
 * Este archivo implementa una estrategia de caché mínima y predecible:
 * 1. Durante la instalación, guarda los recursos esenciales de la aplicación.
 * 2. Durante la activación, elimina cachés de versiones anteriores.
 * 3. Para las peticiones GET, sirve primero desde caché y consulta la red
 *    como respaldo. Las respuestas nuevas se añaden a la caché dinámica.
 */

const CACHE_NAME = "hermes-cache-v2";
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
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Solo interceptamos solicitudes GET. Las solicitudes de micrófono no pasan
  // por aquí porque getUserMedia es una API del navegador, no una petición HTTP.
  if (event.request.method !== "GET") {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        // Guardamos únicamente respuestas válidas y del mismo origen.
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
