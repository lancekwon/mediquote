// mediquote PWA service worker (minimal)
// 역할: Chrome이 'installable PWA'로 인식하도록 fetch 핸들러만 등록.
// 적극적인 캐싱은 하지 않음 (최신 app.js 보장 위해 network-first pass-through).

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // 모든 요청은 네트워크로 그대로 통과 — 오프라인 캐싱 없음.
  // 추후 캐싱 전략 넣을 때 여기 확장.
});
