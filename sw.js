const C='eqp-v14';
const FILES=['./','./index.html','./config.js','./manifest.json','./icon-180.png','./icon-192.png','./icon-512.png','./lyrics/engine.js','./lyrics/worker.js','./streaming/providers.js'];
// No skipWaiting on install: a new version waits until the page asks for it (the "Update available" button).
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(FILES)));});
self.addEventListener('message',e=>{if(e.data==='skip')self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const q=e.request;
  if(q.method!=='GET')return;
  if(new URL(q.url).origin!==self.location.origin)return; // never cache third-party API/auth traffic
  e.respondWith(fetch(q).then(r=>{
    if(r&&r.ok){const cp=r.clone();caches.open(C).then(c=>c.put(q,cp));} // only cache good responses
    return r;
  }).catch(()=>caches.match(q).then(m=>m||(q.mode==='navigate'?caches.match('./index.html'):Response.error()))));
});
