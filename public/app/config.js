/* Koonfy — configuração de runtime (web + apps nativos)
 *
 * O mesmo código do painel roda em três lugares:
 *   1. Navegador  → servido pelo próprio Express, API no mesmo host (caminho relativo).
 *   2. Android    → WebView em https://localhost, API num host remoto.
 *   3. iOS        → WebView em capacitor://localhost, API num host remoto.
 *
 * Nos apps nativos o HTML vem do bundle, então "/api/..." apontaria para dentro
 * do próprio pacote e nada funcionaria. Este módulo resolve a base certa uma
 * vez e todo o resto do app passa a usá-la.
 *
 * A URL do backend é gravada em www/app/native-config.js pelo script de build
 * do pacote mobile/ (a partir de KOONFY_API_URL) — este arquivo só a lê.
 */
(function () {
  var native = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  // Injetado no build nativo; ausente no web.
  var injected = (window.__KOONFY_NATIVE__ || {});

  // Web: base vazia = tudo relativo ao host que serviu a página (comportamento atual).
  // Nativo: precisa ser absoluta. Sem barra no fim para concatenar sem duplicar.
  var apiBase = '';
  if (native) {
    apiBase = String(injected.apiUrl || '').replace(/\/+$/, '');
  }

  // Origem "web" do produto — usada onde a URL precisa ser a pública de verdade
  // e não o localhost do WebView: redirect_uri de OAuth, links de indicação,
  // snippet de tracking, endereços mostrados ao usuário.
  var webOrigin = native ? (apiBase || '') : window.location.origin;

  window.EC_CONFIG = {
    native: native,
    platform: native && window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : 'web',
    isIOS: native && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === 'ios',
    isAndroid: native && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === 'android',

    apiBase: apiBase,
    webOrigin: webOrigin,

    // Monta a URL de um endpoint da API. Caminho sempre começando com "/".
    api: function (path) { return apiBase + '/api' + path; },
    // Monta a URL de uma rota não-API do backend (callbacks, webhooks, landing).
    url: function (path) { return webOrigin + path; }
  };
})();
