/* Koonfy — Engine de Notificações do WebApp (PWA)
 * Reutiliza o token (localStorage.wacrm_token) e o toast() do app.
 * Expõe window.ECNotify. Sem dependências externas.
 *
 * Recursos: permissão, registro do Service Worker, Web Push (VAPID),
 * notificações nativas (nome do contato = título, mensagem = descrição),
 * clique abre a conversa, sons por tipo, vibração, badge no ícone do app,
 * Centro de Notificações (histórico) e sincronização ao voltar do offline.
 */
(function () {
  'use strict';

  // No app nativo a API mora em outro host e o push não é Web Push: quem
  // entrega é o FCM/APNs, via ECNative. O resto da engine (sons, vibração,
  // centro de notificações, prefs) é idêntico nos dois ambientes.
  var EC = window.EC_CONFIG || { api: function (p) { return '/api' + p; }, native: false };

  var LS_PREFS = 'ec_notif_prefs';
  var LS_CENTER = 'ec_notif_center';
  var CENTER_MAX = 60;

  var DEFAULT_PREFS = {
    enabled: true,     // notificações do sistema
    sounds: true,      // sons
    vibrate: true,     // vibração
    badge: true,       // badge no ícone do app
    // Mostrar a notificação do SISTEMA mesmo com o app aberto e visível.
    // Sem isto, quem fica o dia com o painel na tela só via o aviso interno,
    // e nada aparecia na barra do celular ou do computador.
    systemWhenOpen: true,
    types: { message: true, call: true, attendance: true, reminder: true, commission: true, sale: true }
  };

  var state = {
    reg: null,
    prefs: loadPrefs(),
    center: loadCenter(),
    onOpen: null,      // callback(data), app registra p/ abrir a conversa
    onCallEnd: null,   // callback(data), chamada encerrada em outro aparelho
    onResync: null,    // callback(), app registra p/ recarregar dados
    onChange: null,    // callback(), center mudou (repinta o sino/painel)
    audioCtx: null
  };

  /* ---------------- Prefs ---------------- */
  function loadPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem(LS_PREFS) || '{}');
      return Object.assign({}, DEFAULT_PREFS, p, { types: Object.assign({}, DEFAULT_PREFS.types, p.types || {}) });
    } catch (e) { return JSON.parse(JSON.stringify(DEFAULT_PREFS)); }
  }
  function savePrefs() { try { localStorage.setItem(LS_PREFS, JSON.stringify(state.prefs)); } catch (e) {} syncSubPrefs(); }
  function getPrefs() { return state.prefs; }
  function setPref(path, val) {
    if (path.indexOf('types.') === 0) state.prefs.types[path.slice(6)] = !!val;
    else state.prefs[path] = !!val;
    savePrefs();
    if (path === 'enabled' && val) requestPermission();
    if (path === 'badge' && !val) clearBadge();
  }

  /* ---------------- Centro de Notificações ---------------- */
  function loadCenter() { try { return JSON.parse(localStorage.getItem(LS_CENTER) || '[]'); } catch (e) { return []; } }
  function saveCenter() { try { localStorage.setItem(LS_CENTER, JSON.stringify(state.center.slice(0, CENTER_MAX))); } catch (e) {} }
  function pushCenter(item) {
    state.center.unshift(item);
    if (state.center.length > CENTER_MAX) state.center = state.center.slice(0, CENTER_MAX);
    saveCenter();
    refreshBadgeCount();
    if (state.onChange) try { state.onChange(); } catch (e) {}
  }
  function unreadCount() { return state.center.filter(function (n) { return !n.read; }).length; }
  function markAllRead() { state.center.forEach(function (n) { n.read = true; }); saveCenter(); refreshBadgeCount(); if (state.onChange) state.onChange(); }
  function markRead(id) { var n = state.center.find(function (x) { return x.id === id; }); if (n) { n.read = true; saveCenter(); refreshBadgeCount(); if (state.onChange) state.onChange(); } }
  function clearCenter() { state.center = []; saveCenter(); refreshBadgeCount(); if (state.onChange) state.onChange(); }
  function getCenter() { return state.center; }

  /* ---------------- Badge no ícone do app ---------------- */
  function refreshBadgeCount() {
    var n = unreadCount();
    if (!state.prefs.badge) return;
    try {
      if (n > 0 && navigator.setAppBadge) navigator.setAppBadge(n);
      else if (navigator.clearAppBadge) navigator.clearAppBadge();
    } catch (e) {}
  }
  function clearBadge() { try { if (navigator.clearAppBadge) navigator.clearAppBadge(); } catch (e) {} }

  /* ---------------- Sons (sintetizados, sem arquivos) ---------------- */
  function ac() {
    if (!state.audioCtx) { try { state.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
    if (state.audioCtx.state === 'suspended') { try { state.audioCtx.resume(); } catch (e) {} }
    return state.audioCtx;
  }
  function tone(freq, start, dur, type, gain) {
    var c = ac(); if (!c) return;
    var o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    var t0 = c.currentTime + start;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain || 0.14, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  var SOUNDS = {
    message:    function () { tone(880, 0, 0.12, 'sine', 0.12); tone(1180, 0.10, 0.16, 'sine', 0.12); },
    call:       function () { for (var i = 0; i < 3; i++) { tone(680, i * 0.34, 0.18, 'triangle', 0.16); tone(540, i * 0.34 + 0.16, 0.18, 'triangle', 0.14); } },
    attendance: function () { tone(620, 0, 0.14, 'sine', 0.12); tone(820, 0.12, 0.18, 'sine', 0.12); },
    reminder:   function () { tone(990, 0, 0.16, 'sine', 0.13); tone(760, 0.15, 0.2, 'sine', 0.12); tone(990, 0.32, 0.22, 'sine', 0.12); },
    // venda aprovada: acorde ascendente, distinto de mensagem para o afiliado
    // reconhecer sem olhar a tela
    sale:       function () { tone(700, 0, 0.14, 'sine', 0.13); tone(940, 0.12, 0.16, 'sine', 0.13); tone(1250, 0.26, 0.28, 'sine', 0.12); },
    commission: function () { tone(660, 0, 0.14, 'sine', 0.13); tone(880, 0.12, 0.16, 'sine', 0.13); tone(1180, 0.26, 0.26, 'sine', 0.12); }
  };
  /* ---------------- Sons em arquivo ----------------
     Dois avisos são gravados, e não sintetizados: a mensagem e a venda. O som
     de caixa registradora dá para reconhecer uma venda sem olhar a tela, que é
     o ponto. Os demais tipos seguem com os tons sintetizados acima.

     O <audio> fica pronto desde o começo, mas o navegador só deixa tocar
     depois que a pessoa interage com a página; enquanto isso o play() é
     recusado e cai no tom sintetizado, que nunca falha. */
  var ARQUIVOS = { message: '/assets/sons/mensagem.mp3', sale: '/assets/sons/venda.mp3',
                   commission: '/assets/sons/venda.mp3',
                   // O mesmo toque da confirmação de pagamento no checkout. Ele
                   // marca "deu certo, acabou" — e é isso que o disparo de uma
                   // campanha e um agendamento também são.
                   confirm: '/assets/sons/confirmado.mp3',
                   call: '/assets/sons/chamada.mp3' };
  // O toque da ligação fica FORA do pré-carregamento: é o maior arquivo dos
  // três e a maioria das sessões nunca recebe uma chamada. Baixá-lo na abertura
  // seria banda de celular gasta por um som que talvez não toque.
  var NAO_PRECARREGAR = { call: true };
  var tocadores = {};
  function tocador(tipo) {
    if (!ARQUIVOS[tipo]) return null;
    if (!tocadores[tipo]) {
      try {
        var a = new Audio(ARQUIVOS[tipo]);
        a.preload = 'auto'; a.volume = 0.7;
        tocadores[tipo] = a;
      } catch (e) { return null; }
    }
    return tocadores[tipo];
  }
  // Deixa os arquivos em cache antes do primeiro aviso, para o som não chegar
  // atrasado na mensagem que importa.
  function prepararSons() { for (var k in ARQUIVOS) if (!NAO_PRECARREGAR[k]) tocador(k); }

  function playSound(type) {
    if (!state.prefs.sounds) return;
    var a = tocador(type);
    if (a) {
      try {
        a.currentTime = 0;
        var p = a.play();
        // play() devolve promessa: se o navegador recusar (sem interação
        // ainda, arquivo faltando), o tom sintetizado entra no lugar.
        if (p && p.catch) { p.catch(function () { try { (SOUNDS[type] || SOUNDS.message)(); } catch (e) {} }); }
        return;
      } catch (e) { /* cai no sintetizado */ }
    }
    try { (SOUNDS[type] || SOUNDS.message)(); } catch (e) {}
  }

  /* ---------------- Toque contínuo da ligação ----------------
     Um bipe único não serve para chamada: quem está de costas para a tela
     perde a ligação inteira. O toque repete até alguém atender, recusar ou o
     cliente desistir — como qualquer telefone. Fica em teto de 60 repetições
     (~2 min) para que uma falha em parar o toque não vire um alarme eterno. */
  var toque = { iv: null, n: 0, audio: null };

  /* O ARQUIVO TOCA EM LAÇO, e não repetido por temporizador.
     Um toque de telefone tem começo, meio e fim pensados para emendar: cortá-lo
     a cada 2,2s pelo relógio produz silêncios e sobreposições que não existem
     no som original. `loop` deixa o próprio navegador emendar, no ponto certo.

     O TEMPORIZADOR CONTINUA EXISTINDO, mas com outra função: contar os ciclos
     para o toque não virar alarme eterno se algo falhar ao pará-lo. */
  var CICLO_MS = 2200;      // ritmo do padrão sintetizado e da vibração
  var MAX_CICLOS = 60;      // ~2 min, como qualquer telefone desiste

  function startRing() {
    if (toque.iv) return;             // já tocando: não empilha
    toque.n = 0;

    if (state.prefs.sounds) {
      var a = tocador('call');
      if (a) {
        try {
          a.loop = true;
          a.currentTime = 0;
          var pr = a.play();
          toque.audio = a;
          // play() é recusado enquanto a pessoa não tiver interagido com a
          // página — e numa ligação que chega com o app recém-aberto isso é o
          // caso comum. Aí o tom sintetizado assume, que nunca é bloqueado
          // porque não é reprodução de mídia.
          if (pr && pr.catch) {
            pr.catch(function () {
              toque.audio = null;
            });
          }
        } catch (e) { toque.audio = null; }
      }
    }

    var bater = function () {
      if (++toque.n > MAX_CICLOS) return stopRing();
      // O sintetizado só entra quando o arquivo NÃO está tocando — os dois
      // juntos viram barulho, não toque.
      if (state.prefs.sounds && !toque.audio) { try { SOUNDS.call(); } catch (e) {} }
      if (state.prefs.vibrate && navigator.vibrate) {
        try { navigator.vibrate([400, 200, 400]); } catch (e) {}
      }
    };
    bater();
    toque.iv = setInterval(bater, CICLO_MS);
  }

  function stopRing() {
    if (toque.iv) { clearInterval(toque.iv); toque.iv = null; }
    toque.n = 0;
    // PARAR É PAUSAR E VOLTAR AO ZERO. Só pausar deixaria o próximo toque
    // começando no meio do som, de onde o anterior parou.
    if (toque.audio) {
      try { toque.audio.pause(); toque.audio.currentTime = 0; toque.audio.loop = false; } catch (e) {}
      toque.audio = null;
    }
    if (navigator.vibrate) { try { navigator.vibrate(0); } catch (e) {} }
  }

  function vibrate(type) {
    if (!state.prefs.vibrate || !navigator.vibrate) return;
    var pat = type === 'call' ? [200, 100, 200, 100, 200] : type === 'reminder' ? [120, 60, 120] : [90];
    try { navigator.vibrate(pat); } catch (e) {}
  }

  /* ---------------- Permissão + Service Worker + Push ---------------- */
  function supported() { return EC.native ? true : ('serviceWorker' in navigator); }
  function permission() {
    if (EC.native) return window.ECNative ? ECNative.pushPermission() : 'default';
    return ('Notification' in window) ? Notification.permission : 'unsupported';
  }

  function requestPermission() {
    // Nativo: quem pede é o sistema operacional (APNs/FCM), não a API web.
    if (EC.native) return window.ECNative ? ECNative.requestPush() : Promise.resolve('unsupported');
    if (!('Notification' in window)) return Promise.resolve('unsupported');
    if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
    return Notification.requestPermission().then(function (p) { if (p === 'granted') subscribePush(); return p; }).catch(function () { return 'denied'; });
  }

  function register() {
    prepararSons();   // busca os MP3 agora, para o aviso não chegar mudo
    // Service Worker não se aplica ao WebView nativo: os arquivos já vêm no
    // bundle (não há o que cachear) e o push chega pelo canal do sistema.
    if (EC.native) { if (window.ECNative) ECNative.initPush(); return Promise.resolve(null); }
    if (!supported()) return Promise.resolve(null);
    // Cada painel registra no PRÓPRIO caminho: um service worker só controla
    // o diretório de onde foi servido, e o painel da plataforma vive em /adm/.
    var raiz = /^\/adm(\/|$)/.test(location.pathname) ? '/adm/' : '/app/';
    return navigator.serviceWorker.register(raiz + 'sw.js', { scope: raiz })
      .then(function (reg) {
        state.reg = reg;
        navigator.serviceWorker.addEventListener('message', onSwMessage);
        if (Notification && Notification.permission === 'granted') subscribePush();
        return reg;
      }).catch(function (e) { console.warn('[ECNotify] SW falhou:', e && e.message); return null; });
  }

  function onSwMessage(e) {
    var d = e.data || {};
    if (d.type === 'NOTIFICATION_CLICK' && state.onOpen) { try { state.onOpen(d.data || {}); } catch (x) {} }
    if (d.type === 'RESYNC' && state.onResync) { try { state.onResync(); } catch (x) {} }
    // A CHAMADA ACABOU em outro aparelho: o Service Worker ja apagou o aviso
    // da tela de bloqueio e avisa aqui para a tela de chamada fechar junto.
    if (d.type === 'CALL_END' && state.onCallEnd) { try { state.onCallEnd(d.data || {}); } catch (x) {} }
  }

  function urlB64ToUint8(base64) {
    var pad = '='.repeat((4 - base64.length % 4) % 4);
    var b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(b64), arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }
  function authHeaders() {
    var t = localStorage.getItem('wacrm_token') || '';
    return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t };
  }
  // A chave da assinatura vem como ArrayBuffer; a do servidor, em base64url.
  // Sem poder conferir (navegador antigo que não expõe `options`), devolve
  // false: refazer a inscrição é barato, ficar com uma morta não é.
  function mesmaChave(sub, publicKey) {
    var atual = sub.options && sub.options.applicationServerKey;
    if (!atual) return false;
    var a = new Uint8Array(atual), b = urlB64ToUint8(publicKey);
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Devolve a promessa: quem chama (o teste de notificação, por exemplo)
  // precisa esperar a inscrição terminar antes de pedir o envio.
  function subscribePush() {
    if (!state.reg || !state.reg.pushManager) return Promise.resolve(null);
    return fetch(EC.api('/push/vapid'), { headers: authHeaders() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (!cfg || !cfg.publicKey) return;
        return state.reg.pushManager.getSubscription().then(function (sub) {
          // Uma assinatura existente NÃO serve por existir: ela é amarrada à
          // chave VAPID com que foi criada. Se a do servidor mudou, o serviço
          // de push recusa todo envio com 403 e nada se recupera sozinho —
          // era o caso aqui, porque a chave é regerada quando o banco volta
          // ao estado inicial. Conferindo, o app se conserta na próxima carga.
          if (sub && mesmaChave(sub, cfg.publicKey)) return sub;
          var descarta = sub ? sub.unsubscribe().catch(function () {}) : Promise.resolve();
          return descarta.then(function () {
            return state.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(cfg.publicKey) });
          });
        });
      })
      .then(function (sub) {
        if (!sub) return;
        state._sub = sub;
        return fetch(EC.api('/push/subscribe'), { method: 'POST', headers: authHeaders(), body: JSON.stringify({ subscription: sub, prefs: state.prefs }) });
      })
      .catch(function (e) { console.warn('[ECNotify] push subscribe:', e && e.message); return null; });
  }
  function syncSubPrefs() {
    if (!state._sub) return;
    fetch(EC.api('/push/subscribe'), { method: 'POST', headers: authHeaders(), body: JSON.stringify({ subscription: state._sub, prefs: state.prefs }) }).catch(function () {});
  }

  /* ---------------- Notificar ---------------- */
  // opts: { type, title, body, waId, url, tag, requireInteraction, silent }
  function notify(opts) {
    opts = opts || {};
    var type = opts.type || 'message';
    if (state.prefs.types[type] === false) return;         // tipo desativado

    // histórico (Centro) sempre registra
    var item = {
      id: 'ntf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: type, title: opts.title || 'Koonfy', body: opts.body || '',
      waId: opts.waId || null, url: opts.url || null, ts: Date.now(), read: false
    };
    pushCenter(item);

    if (!opts.silent) { playSound(type); vibrate(type); }

    var focusedHere = !document.hidden;
    // `callId` viaja com a notificação de ligação: é por ele que o toque na
    // notificação sabe QUAL chamada atender depois de o app voltar do segundo
    // plano — sem isso o toque só abria o app e a pessoa perdia a ligação.
    var data = { type: type, waId: opts.waId || null, url: opts.url || ('/app/#/inbox'), callId: opts.callId || null };

    // App em foco: o aviso interno aparece sempre; a notificação do sistema
    // depende da preferência. Antes o toast encerrava aqui, então quem ficava
    // com o painel aberto nunca via nada na barra do sistema.
    if (focusedHere && typeof window.toast === 'function' && type !== 'call') {
      try { window.toast((type === 'reminder' ? '⏰ ' : '') + item.title + (item.body ? ' - ' + item.body : '')); } catch (e) {}
      if (!state.prefs.systemWhenOpen) return item;
    }
    // App em segundo plano (ou ligação) → notificação nativa do sistema
    if (state.prefs.enabled && permission() === 'granted') {
      var payload = {
        title: item.title, body: item.body,
        tag: opts.tag || (type + ':' + (opts.waId || '')),
        data: data, icon: '/assets/koonfy-192.png', badge: '/assets/koonfy-192.png',
        requireInteraction: type === 'call' || !!opts.requireInteraction,
        vibrate: state.prefs.vibrate ? (type === 'call' ? [200, 100, 200] : [90]) : undefined
      };
      // Botões na própria notificação: no celular a ligação chega com o app
      // fechado, e obrigar a abrir o app, achar a tela e só então atender custa
      // os poucos segundos que a chamada dura. Só o Service Worker desenha
      // ações — o `new Notification()` do fallback as ignora.
      if (type === 'call') {
        payload.actions = [
          { action: 'answer', title: 'Atender' },
          { action: 'reject', title: 'Recusar' }
        ];
      }
      if (EC.native) {
        // WebView não tem Notification API: quem desenha na bandeja é o plugin nativo.
        if (window.ECNative) ECNative.localNotify(payload);
      } else if (state.reg && state.reg.showNotification) {
        try { state.reg.showNotification(payload.title, payload); } catch (e) { fallbackNotif(payload); }
      } else fallbackNotif(payload);
    }
    return item;
  }
  function fallbackNotif(p) {
    try {
      var n = new Notification(p.title, p);
      n.onclick = function () { window.focus(); if (state.onOpen) state.onOpen(p.data || {}); n.close(); };
    } catch (e) {}
  }

  /* ---------------- Online / Offline ---------------- */
  function setupConnectivity() {
    window.addEventListener('online', function () {
      if (typeof window.toast === 'function') window.toast('Conexão restaurada, sincronizando…');
      if (state.reg && state.reg.sync) { try { state.reg.sync.register('ec-resync'); } catch (e) {} }
      if (state.onResync) try { state.onResync(); } catch (e) {}
    });
    window.addEventListener('offline', function () {
      if (typeof window.toast === 'function') window.toast('Você está offline, as ações voltam ao reconectar', 'error');
    });
    // resume o áudio no primeiro gesto do usuário (política de autoplay)
    var resume = function () { ac(); window.removeEventListener('pointerdown', resume); };
    window.addEventListener('pointerdown', resume);
  }

  /* ---------------- API pública ---------------- */
  var api = {
    init: function (hooks) {
      hooks = hooks || {};
      state.onOpen = hooks.onOpen || null;
      state.onResync = hooks.onResync || null;
      state.onChange = hooks.onChange || null;
      setupConnectivity();
      register();
      refreshBadgeCount();
      return this;
    },
    notify: notify,
    requestPermission: requestPermission,
    subscribePush: subscribePush,
    // prefs
    getPrefs: getPrefs, setPref: setPref,
    // centro
    getCenter: getCenter, unreadCount: unreadCount, markAllRead: markAllRead, markRead: markRead, clearCenter: clearCenter,
    // estados
    permission: permission, supported: supported,
    playSound: playSound,
    startRing: startRing, stopRing: stopRing,
    setHooks: function (h) { if (h.onOpen) state.onOpen = h.onOpen; if (h.onResync) state.onResync = h.onResync; if (h.onChange) state.onChange = h.onChange; if (h.onCallEnd) state.onCallEnd = h.onCallEnd; }
  };
  window.ECNotify = api;
})();
