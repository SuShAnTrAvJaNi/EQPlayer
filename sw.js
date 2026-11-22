const C='eqp-v5';
const FILES=['./','./index.html','./config.js','./manifest.json','./icon-180.png','./icon-192.png','./icon-512.png','./lyrics/engine.js','./lyrics/worker.js','./streaming/providers.js'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  if(new URL(e.request.url).origin!==self.location.origin)return; // never cache third-party API/auth traffic
  e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r;}).catch(()=>caches.match(e.request).then(m=>m||caches.match('./index.html'))));
});
