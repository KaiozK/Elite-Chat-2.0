/* Koonfy — ponte com o app nativo (iOS / Android via Capacitor)
 *
 * Carregado nos dois ambientes, mas tudo aqui só liga quando roda dentro do
 * app das lojas. No navegador o módulo se auto-desativa e o painel segue
 * exatamente como sempre foi — nenhum caminho do web passa por aqui.
 *
 * O que ele resolve:
 *   · OAuth (Meta, Meta Ads, Nuvemshop) — no navegador o fluxo é popup +
 *     postMessage; no app não existe popup com opener, então a autorização
 *     abre no navegador do sistema e volta por deep link (elitechat://).
 *     Aqui o deep link é reconvertido no MESMO evento `message` que o painel
 *     já escuta, então os fluxos existentes continuam valendo sem alteração.
 *   · Push — token do device (FCM/APNs) registrado no backend.
 *   · Botão físico de voltar do Android, status bar, teclado e splash.
 */
(function () {
  'use strict';

  var EC = window.EC_CONFIG || {};
  if (!EC.native) { window.ECNative = null; return; }

  var P = (window.Capacitor && window.Capacitor.Plugins) || {};
  var SCHEME = 'elitechat';

  function plugin(name) { return P[name] || null; }

  /* ------------------------------------------------------------------
   * OAuth por deep link
   * O callback no servidor, quando não encontra window.opener, redireciona
   * para elitechat://auth/<provedor>?code=..&state=..  Traduzimos de volta
   * para o postMessage que connectNs()/esFinish()/Meta Ads já aguardam.
   * ------------------------------------------------------------------ */
  var DEEP_LINK_TYPES = {
    'meta': 'ELITECHAT_META_CALLBACK',
    'meta-ads': 'ELITECHAT_METAADS_CALLBACK',
    'nuvemshop': 'ELITECHAT_NUVEMSHOP_CALLBACK'
  };

  function handleDeepLink(url) {
    var m = /^elitechat:\/\/auth\/([a-z-]+)/i.exec(url || '');
    if (!m) return;
    var type = DEEP_LINK_TYPES[m[1].toLowerCase()];
    if (!type) return;

    var qs = {};
    var q = url.indexOf('?');
    if (q >= 0) {
      new URLSearchParams(url.slice(q + 1)).forEach(function (v, k) { qs[k] = v; });
    }
    // Fecha o navegador do sistema, que fica por cima do app após o redirect.
    var browser = plugin('Browser');
    if (browser && browser.close) { try { browser.close(); } catch (e) {} }

    // postMessage para a própria janela: o `origin` do evento é o da própria
    // página, então as checagens de origem já existentes no painel passam.
    window.postMessage({
      type: type,
      code: qs.code || '',
      state: qs.state || '',
      error: qs.error || '',
      errorDescription: qs.error_description || qs.errorDescription || ''
    }, '*');
  }

  /* ------------------------------------------------------------------
   * Push nativo (FCM no Android, APNs no iOS)
   * ------------------------------------------------------------------ */
  var pushPerm = 'default';
  var pushStarted = false;

  function authHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (localStorage.getItem('wacrm_token') || '')
    };
  }

  // Envia o token do aparelho ao backend, que o usa para entregar push mesmo
  // com o app fechado. Trocar de conta no mesmo aparelho re-registra o token.
  function sendToken(token) {
    if (!token) return;
    try { localStorage.setItem('ec_device_token', token); } catch (e) {}
    if (!localStorage.getItem('wacrm_token')) return;   // ainda não logou
    fetch(EC.api('/push/device'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ token: token, platform: EC.platform })
    }).catch(function () {});
  }

  function initPush() {
    var push = plugin('PushNotifications');
    if (!push || pushStarted) return;
    pushStarted = true;

    push.addListener('registration', function (t) { sendToken(t && t.value); });
    push.addListener('registrationError', function (e) {
      console.warn('[ECNative] push registration:', e && e.error);
    });

    // App aberto: não estoura notificação do sistema por cima da tela — o
    // painel já mostra o toast e atualiza a lista pelo SSE.
    push.addListener('pushNotificationReceived', function (n) {
      if (window.ECNotify && n) {
        try {
          ECNotify.notify({
            type: (n.data && n.data.type) || 'message',
            title: n.title || 'Koonfy',
            body: n.body || '',
            waId: n.data && n.data.waId,
            url: n.data && n.data.url
          });
        } catch (e) {}
      }
    });

    // Toque na notificação → abre a conversa correspondente.
    push.addListener('pushNotificationActionPerformed', function (a) {
      var data = (a && a.notification && a.notification.data) || {};
      if (window.ECNotify && window.__ecOnNotifOpen) {
        try { window.__ecOnNotifOpen(data); } catch (e) {}
      } else if (data.url) {
        location.hash = String(data.url).replace(/^.*#/, '#');
      }
    });

    push.checkPermissions().then(function (r) {
      pushPerm = (r && r.receive) || 'prompt';
      if (pushPerm === 'granted') push.register();
    }).catch(function () {});
  }

  function requestPush() {
    var push = plugin('PushNotifications');
    if (!push) return Promise.resolve('unsupported');
    return push.requestPermissions().then(function (r) {
      pushPerm = (r && r.receive) || 'denied';
      if (pushPerm === 'granted') { push.register(); initPush(); }
      return pushPerm === 'prompt' ? 'default' : pushPerm;
    }).catch(function () { return 'denied'; });
  }

  function pushPermission() {
    return pushPerm === 'prompt' ? 'default' : pushPerm;
  }

  // Notificação local (app em segundo plano sem push do servidor, lembretes).
  function localNotify(p) {
    var ln = plugin('LocalNotifications');
    if (!ln) return;
    ln.schedule({
      notifications: [{
        id: Math.floor(Math.random() * 2147483000) + 1,
        title: p.title || 'Koonfy',
        body: p.body || '',
        extra: p.data || {}
      }]
    }).catch(function () {});
  }

  /* ------------------------------------------------------------------
   * Ciclo de vida, botão voltar, status bar, teclado
   * ------------------------------------------------------------------ */
  function setupApp() {
    var App = plugin('App');
    if (!App) return;

    App.addListener('appUrlOpen', function (e) { handleDeepLink(e && e.url); });

    // Voltar do Android: fecha o que estiver por cima (modal, menu), depois
    // navega no histórico; na tela inicial, sai do app.
    App.addListener('backButton', function () {
      if (typeof window.__ecHandleBack === 'function' && window.__ecHandleBack()) return;
      if (location.hash && location.hash !== '#/dashboard' && history.length > 1) { history.back(); return; }
      App.exitApp();
    });

    // Voltar do segundo plano: reconecta o SSE e recarrega o que mudou.
    App.addListener('appStateChange', function (s) {
      if (s && s.isActive && window.__ecOnResume) { try { window.__ecOnResume(); } catch (e) {} }
    });
  }

  function setupChrome() {
    var sb = plugin('StatusBar');
    if (sb) {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      try {
        sb.setStyle({ style: dark ? 'DARK' : 'LIGHT' });
        if (EC.isAndroid) sb.setBackgroundColor({ color: dark ? '#0b1220' : '#ffffff' });
      } catch (e) {}
    }

    var kb = plugin('Keyboard');
    if (kb) {
      // Marca no <html> a altura do teclado para o CSS afastar a barra de
      // digitação — sem isso o campo some atrás do teclado no iOS.
      kb.addListener('keyboardWillShow', function (info) {
        document.documentElement.style.setProperty('--ec-keyboard', (info && info.keyboardHeight ? info.keyboardHeight : 0) + 'px');
        document.documentElement.classList.add('kb-open');
      });
      kb.addListener('keyboardWillHide', function () {
        document.documentElement.style.setProperty('--ec-keyboard', '0px');
        document.documentElement.classList.remove('kb-open');
      });
    }

    var splash = plugin('SplashScreen');
    if (splash) { try { splash.hide(); } catch (e) {} }
  }

  // Reaplica o estilo da status bar quando o usuário troca o tema no painel.
  function syncTheme() {
    var sb = plugin('StatusBar');
    if (!sb) return;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    try {
      sb.setStyle({ style: dark ? 'DARK' : 'LIGHT' });
      if (EC.isAndroid) sb.setBackgroundColor({ color: dark ? '#0b1220' : '#ffffff' });
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  document.documentElement.classList.add('ec-native', 'ec-' + EC.platform);
  setupApp();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupChrome);
  else setupChrome();

  window.ECNative = {
    initPush: initPush,
    requestPush: requestPush,
    pushPermission: pushPermission,
    localNotify: localNotify,
    sendToken: function () { sendToken(localStorage.getItem('ec_device_token')); },
    syncTheme: syncTheme,
    // Abre a autorização OAuth no navegador do sistema. O retorno chega por
    // deep link, tratado em handleDeepLink.
    openAuthWindow: function (url) {
      var browser = plugin('Browser');
      if (browser) { browser.open({ url: url }).catch(function () {}); return true; }
      window.open(url, '_blank');
      return true;
    }
  };
})();
