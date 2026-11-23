// Substitui o service worker antigo: limpa a cache, desliga-se e leva as janelas abertas para o endereço novo.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({type:'window'})){
    c.navigate(c.url); // recarrega: a página de reencaminhamento escolhe o endereço que estiver a funcionar
  }
})()));
