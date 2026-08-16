/* Koonfy — Service Worker (PWA)
 * Cache do app shell + offline + Push Notifications + clique abre a conversa.
 * Escopo: /app/  (registrado por notifications.js)
 */
const VERSION = 'koonfy-v7';   // v7: ícone maskable próprio + /marca/logo na rede
const SHELL = 'ec-shell-' + VERSION;
const RUNTIME = 'ec-runtime-' + VERSION;

// App shell — precache para funcionar offline e abrir instantâneo.
const SHELL_ASSETS = [
  '/app/',
  '/app/index.html',
  '/app/app.js',
  '/app/style.css',
  '/app/notifications.js',
  '/app/voz.js',
  '/app/manifest.webmanifest',
  '/assets/koonfy-192.png',
  '/assets/koonfy-maskable-192.png',
  // Os avisos sonoros precisam estar prontos ANTES do evento que os dispara:
  // buscar o arquivo na hora faria o som chegar depois da notificação.
  '/assets/sons/mensagem.mp3',
  '/assets/sons/venda.mp3'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then(c => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()).catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL && k !== RUNTIME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Permite ao app forçar atualização do SW e disparar notificações locais.
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
  if (d.type === 'SHOW_NOTIFICATION' && d.payload) {
    const p = d.payload;
    self.registration.showNotification(p.title || 'Koonfy', notifOptions(p));
  }
});

function notifOptions(p) {
  return {
    body: p.body || '',
    icon: p.icon || '/assets/koonfy-192.png',
    badge: p.badge || '/assets/koonfy-192.png',
    tag: p.tag || undefined,
    renotify: !!p.tag,
    data: p.data || {},
    vibrate: p.vibrate || undefined,
    requireInteraction: !!p.requireInteraction,
    silent: !!p.silent,
    // Atender/Recusar direto na notificação da ligação.
    actions: p.actions || undefined
  };
}

/* ---------------- Push (background, app fechado) ---------------- */
self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { title: 'Koonfy', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(p.title || 'Koonfy', notifOptions(p)));
});

// Clique na notificação → foca o app já aberto (e abre a conversa) ou abre o app.
//
// LIGAÇÃO: o toque (no corpo ou no botão "Atender") precisa ATENDER, não só
// abrir o app. Como o app pode nem estar rodando, a intenção vai grudada na
// URL — `?atender=<id>` — e o app a executa assim que sobe. Com o app já
// aberto, a mensagem resolve na hora.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const acao = e.action || '';
  let url = data.url || '/app/#/inbox';
  if (data.type === 'call' && data.callId && acao !== 'reject') {
    const [caminho, hash] = url.split('#');
    const base = (caminho || '/app/').split('?')[0];
    url = base + '?atender=' + encodeURIComponent(data.callId) + (hash ? '#' + hash : '');
  }
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('/app')) {
        c.postMessage({ type: 'NOTIFICATION_CLICK', data: { ...data, action: acao } });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});

/* ---------------- Sincronização ao voltar do offline ---------------- */
self.addEventListener('sync', (e) => {
  if (e.tag === 'ec-resync') {
    e.waitUntil((async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      all.forEach(c => c.postMessage({ type: 'RESYNC' }));
    })());
  }
});

/* ---------------- Estratégias de fetch ---------------- */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // nunca cacheia POST/PUT/DELETE
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // deixa terceiros passarem
  if (url.pathname.startsWith('/api/')) return;           // API sempre na rede (SSE inclusive)

  // Navegações: rede primeiro, cai para o shell em cache (offline).
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(r => { caches.open(RUNTIME).then(c => c.put(req, r.clone())); return r; })
        .catch(() => caches.match(req).then(m => m || caches.match('/app/index.html')))
    );
    return;
  }

  // Código do app (app.js/css/notifications): rede primeiro p/ receber updates,
  // cache como fallback offline.
  // `/marca/logo` entra aqui porque a marca PODE mudar pelo painel do admin.
  // Na regra genérica lá embaixo ela era servida do cache para sempre: quem
  // instalasse o app ficaria com a logo antiga, sem jeito de atualizar. O
  // `voz.js` estava na mesma situação — código do app servido de cache eterno.
  if (/\/app\/(app\.js|style\.css|notifications\.js|voz\.js)$/.test(url.pathname) ||
      url.pathname === '/marca/logo') {
    e.respondWith(
      fetch(req).then(r => { const cp = r.clone(); caches.open(SHELL).then(c => c.put(req, cp)); return r; })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Demais GET same-origin (assets, ícones): cache primeiro + revalida em 2º plano.
  e.respondWith(
    caches.match(req).then(cached => {
      const net = fetch(req).then(r => { const cp = r.clone(); caches.open(RUNTIME).then(c => c.put(req, cp)); return r; }).catch(() => cached);
      return cached || net;
    })
  );
});
