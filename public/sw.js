// B-care Service Worker — PWAオフライン対応
const CACHE = 'bcare-v2';
const ASSETS = ['/', '/index.html', '/icon-192.png', '/icon-512.png', '/manifest.json'];

// インストール時にコアファイルをキャッシュ
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// アクティベート時に古いキャッシュを削除
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  e.waitUntil(clients.claim());
});

// フェッチ: APIはネットワーク直接、それ以外はキャッシュフォールバック
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // レスポンスをキャッシュに保存
        const clone = res.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
