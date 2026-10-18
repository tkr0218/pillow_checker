// 花あつめ Service Worker
// アプリを更新したら VERSION を上げる（古いキャッシュが消え、新しいファイルが入る）
const VERSION = "2026-10-18.1";
const CACHE = `kusuri-${VERSION}`;
const FONT_CACHE = "kusuri-fonts";   // フォントは版をまたいで使い回す
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE && key !== FONT_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 画面（HTML）：ネット優先。つながれば最新版、オフラインならキャッシュ
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const c = await caches.open(CACHE); c.put("./index.html", res.clone());
        return res;
      } catch (_) {
        return (await caches.match("./index.html")) || Response.error();
      }
    })());
    return;
  }

  // Google Fonts：キャッシュをすぐ返し、裏で更新
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith((async () => {
      const c = await caches.open(FONT_CACHE);
      const hit = await c.match(req);
      const net = fetch(req).then(res => { c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })());
    return;
  }

  // それ以外の自分のファイル：キャッシュ優先
  if (url.origin === self.location.origin) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
  }
});

// ---- 通知 ----
// サーバーから届いた通知を表示する。同じ予定の通知は tag で1つにまとめる（再通知は前の通知を置き換える）
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || "花あつめ", {
    body: d.body || "",
    tag: d.tag || "hana",
    renotify: true,
    icon: "icons/icon-192.png",
    data: { slotId: d.slotId || null, date: d.date || null },
    actions: d.slotId ? [{ action: "take", title: "飲んだので記録する" }] : [],
  }));
});

// 通知を押したらアプリを開く。「飲んだので記録する」なら、その予定を記録する
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const { slotId, date } = e.notification.data || {};
  const take = e.action === "take" && slotId;
  const url = new URL(take ? `./?take=${encodeURIComponent(slotId)}&date=${encodeURIComponent(date)}` : "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins.find(c => c.url.startsWith(self.registration.scope));
    if (w) {
      await w.focus();
      if (take) w.postMessage({ type: "take", slotId, date });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
