// Fluxo oficial do Embedded Signup — Meta Graph API v26.0 (Tech Provider)
// Docs: https://developers.facebook.com/docs/whatsapp/embedded-signup
// Todas as chamadas usam as credenciais da PLATAFORMA (App ID/Secret do dono do SaaS);
// o token de cada cliente é obtido trocando o authorization_code devolvido pelo popup.
const db = require('./db');

function p() { return db.get().platform; }
function base() { return `https://graph.facebook.com/${p().graphVersion || 'v26.0'}`; }

const CFG_LABELS = {
  appId: 'App ID',
  appSecret: 'App Secret',
  configId: 'Config ID do Embedded Signup'
};

function requirePlatform(...keys) {
  for (const k of keys) {
    if (!p()[k]) {
      const e = new Error(`Configuração da plataforma ausente: ${CFG_LABELS[k] || k}. O administrador precisa preenchê-la em Configurações.`);
      e.status = 400;
      throw e;
    }
  }
}

async function graph(path, { method = 'GET', token, body, formParams } = {}) {
  const opts = { method, headers: {} };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (formParams) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(formParams).toString();
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base() + path, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `Graph API retornou ${res.status}`);
    err.status = res.status;
    err.meta = data.error || data;
    throw err;
  }
  return data;
}

// Passo 3 — troca o authorization_code pelo access token do cliente
// POST /oauth/access_token  (client_id, client_secret, redirect_uri, code)
// redirect_uri só entra quando o code veio do diálogo OAuth com redirect (não do SDK).
function exchangeCode(code, redirectUri) {
  requirePlatform('appId', 'appSecret');
  const params = { client_id: p().appId, client_secret: p().appSecret, code };
  if (redirectUri) params.redirect_uri = redirectUri;
  return graph('/oauth/access_token', { method: 'POST', formParams: params });
}

// Passo 4 — GET /me/businesses
const getBusinesses = (token) =>
  graph('/me/businesses?fields=id,name', { token });

// O DONO DA WABA, perguntado à própria WABA.
//
// `/me/businesses` responde pelo USUÁRIO, e no Embedded Signup o token quase
// nunca enxerga business nenhum por ali: ele nasce com escopo da WABA que
// acabou de ser compartilhada, não da carteira de negócios da pessoa. A lista
// volta vazia mesmo quando existe um business — e ele está bem aqui, no campo
// `owner_business_info` da WABA que já sabemos qual é.
const getWabaOwner = (token, wabaId) =>
  graph(`/${encodeURIComponent(wabaId)}?fields=id,name,owner_business_info`, { token });

// Passo 5 — GET /{business_id}/owned_whatsapp_business_accounts
const getOwnedWabas = (token, businessId) =>
  graph(`/${encodeURIComponent(businessId)}/owned_whatsapp_business_accounts?fields=id,name`, { token });

// Passo 6 — GET /{waba_id}/phone_numbers
const getPhoneNumbers = (token, wabaId) =>
  graph(`/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status`, { token });

// Passo 7 — POST /{waba_id}/subscribed_apps (assina o app da plataforma na WABA do cliente)
const subscribeApp = (token, wabaId) =>
  graph(`/${encodeURIComponent(wabaId)}/subscribed_apps`, { method: 'POST', token, body: {} });

// REGISTRAR O NÚMERO NA CLOUD API — sem isto ele não envia nem recebe.
//
// Era o passo que faltava, e o sintoma é exatamente o que o WhatsApp Manager
// mostra: status "Pendente". O Embedded Signup COMPARTILHA o número com o app;
// registrá-lo na Cloud API é outra coisa, e é um POST que ninguém fazia. A
// conexão terminava "conectada" do nosso lado e morta do lado da Meta.
//
// O PIN é a verificação em duas etapas do número. A Meta exige seis dígitos
// aqui; guardamos o nosso para poder registrar de novo depois (troca de
// servidor, reconexão) sem depender de alguém lembrar.
const registerPhone = (token, phoneNumberId, pin) =>
  graph(`/${encodeURIComponent(phoneNumberId)}/register`, {
    method: 'POST', token,
    body: { messaging_product: 'whatsapp', pin: String(pin) }
  });

// O ESTADO do número, para saber se ele já está de pé.
// `status` é o que aparece como "Pendente"/"Conectado" no WhatsApp Manager.
const phoneStatus = (token, phoneNumberId) =>
  graph(`/${encodeURIComponent(phoneNumberId)}?fields=id,display_phone_number,verified_name,status,code_verification_status,platform_type,quality_rating,messaging_limit_tier`, { token });

const unsubscribeApp = (token, wabaId) =>
  graph(`/${encodeURIComponent(wabaId)}/subscribed_apps`, { method: 'DELETE', token });

// Validação do token — GET /debug_token (usa app access token APP_ID|APP_SECRET)
function debugToken(inputToken) {
  requirePlatform('appId', 'appSecret');
  const appToken = `${p().appId}|${p().appSecret}`;
  return graph(`/debug_token?input_token=${encodeURIComponent(inputToken)}`, { token: appToken });
}

// Passo 11 — health check: GET /{phone_number_id}
const phoneHealth = (token, phoneNumberId) =>
  graph(`/${encodeURIComponent(phoneNumberId)}?fields=verified_name,display_phone_number,quality_rating,code_verification_status,platform_type`, { token });

// ---------------------------------------------------------------------------
// META ADS (permissão ads_read) — usado pelo módulo de Tracking.
//
// Reaproveita o MESMO app da plataforma já configurado para o WhatsApp: o
// cliente clica em "Conectar Meta Ads", autoriza no popup e o token vem por
// aqui. Ninguém precisa gerar token no Graph API Explorer.
// ---------------------------------------------------------------------------

// App usado pelo OAuth de Meta Ads: o dedicado (platform.metaAds), se
// preenchido; senão o mesmo app do WhatsApp. Assim quem tem um app só não
// configura nada, e quem tem um app separado para anúncios aponta para ele.
function adsApp() {
  const m = p().metaAds || {};
  const usarProprio = m.appId && m.appSecret;
  const id = usarProprio ? m.appId : p().appId;
  const secret = usarProprio ? m.appSecret : p().appSecret;
  if (!id) {
    const e = new Error('Configuração da plataforma ausente: App ID da Meta. O administrador precisa preenchê-la em Configurações.');
    e.status = 400; throw e;
  }
  return { id, secret, dedicated: usarProprio };
}

// Diz se o OAuth de Meta Ads está pronto para uso (o admin já pôs as credenciais).
function adsConfigured() {
  const m = p().metaAds || {};
  return !!((m.appId && m.appSecret) || (p().appId && p().appSecret));
}

// URL do diálogo de autorização. `state` protege contra CSRF.
function adsAuthUrl(redirectUri, state) {
  const app = adsApp();
  const ver = p().graphVersion || 'v26.0';
  const q = new URLSearchParams({
    client_id: app.id,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    scope: 'ads_read'
  });
  return `https://www.facebook.com/${ver}/dialog/oauth?${q}`;
}

// Troca o authorization_code do diálogo de Meta Ads pelo access token.
// Usa o app de anúncios (dedicado ou o do WhatsApp), não o exchangeCode do
// Embedded Signup, que é sempre o app do WhatsApp.
function exchangeAdsCode(code, redirectUri) {
  const app = adsApp();
  return graph('/oauth/access_token', {
    method: 'POST',
    formParams: { client_id: app.id, client_secret: app.secret, redirect_uri: redirectUri, code }
  });
}

// O token que volta do diálogo dura ~1h. Trocamos por um de LONGA duração
// (60 dias), senão a sincronização quebraria no mesmo dia.
function longLivedToken(shortToken) {
  const app = adsApp();
  return graph('/oauth/access_token', {
    method: 'POST',
    formParams: {
      grant_type: 'fb_exchange_token',
      client_id: app.id,
      client_secret: app.secret,
      fb_exchange_token: shortToken
    }
  });
}

// Contas de anúncio que o usuário autorizou, para ele escolher numa lista em
// vez de digitar o "act_..." de cabeça.
const getAdAccounts = (token) =>
  graph('/me/adaccounts?fields=account_id,name,currency,account_status&limit=100', { token });

module.exports = {
  exchangeCode,
  getBusinesses,
  registerPhone,
  phoneStatus,
  getWabaOwner,
  getOwnedWabas,
  getPhoneNumbers,
  subscribeApp,
  unsubscribeApp,
  debugToken,
  phoneHealth,
  adsAuthUrl,
  adsConfigured,
  exchangeAdsCode,
  longLivedToken,
  getAdAccounts
};
