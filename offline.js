"use strict";

const scope = new URL(self.registration.scope);
const prefix = scope.pathname === "/" ? "arcanblade-shell-" : `arcanblade-shell:${scope.pathname}:`;
const CACHE = prefix + "a4e450ef5dc4302a8fed01f72bd047f37807d84dad8cc6ebb2c8a80a98260d85";
const SHELL = ["./", "player.css", "player.js", "mark.png", "manifest.webmanifest", "icon-192.png", "icon-512.png",
  "offline-store.js", "offline-download.js", "offline-zip.js"].map(path => new URL(path, scope).href);

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE && key.startsWith(prefix)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate" && url.pathname === scope.pathname) url.search = "";
  if (!SHELL.includes(url.href)) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.href)) || fetch(event.request)));
});
