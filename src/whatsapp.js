// Cliente da Meta WhatsApp Cloud API (Graph API v26.0) — escopado por conta (tenant)
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
// Cada função recebe a conta (acc) e usa o token/os IDs salvos pelo Embedded Signup.
const db = require('./db');

function ver() { return db.get().platform.graphVersion || 'v26.0'; }
function base() { return `https://graph.facebook.com/${ver()}`; }

// Token da conta (Embedded Signup); fallback: System User Token da plataforma
function tokenOf(acc) {
  return (acc && acc.wa && acc.wa.accessToken) || db.get().platform.systemToken || '';
}

const CFG_LABELS = {
  accessToken: 'Access Token',
  phoneNumberId: 'Phone Number ID',
  wabaId: 'WABA ID'
};

function requireWa(acc, ...keys) {
  for (const k of keys) {
    const val = k === 'accessToken' ? tokenOf(acc) : acc && acc.wa && acc.wa[k];
    if (!val) {
      const e = new Error(`WhatsApp não conectado (${CFG_LABELS[k] || k} ausente). Clique em "Conectar WhatsApp" em Configurações.`);
      e.status = 400;
      throw e;
    }
  }
}

async function graph(acc, path, { method = 'GET', body, form, raw = false, token } = {}) {
  requireWa(acc, 'accessToken');
  const opts = { method, headers: { Authorization: `Bearer ${token || tokenOf(acc)}` } };
  if (form) {
    opts.body = form;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base() + path, opts);
  if (raw) return res;
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

// ============ MENSAGENS — POST /{phone_number_id}/messages ============

function sendPayload(acc, payload) {
  requireWa(acc, 'phoneNumberId');
  return graph(acc, `/${acc.wa.phoneNumberId}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }
  });
}

const sendText = (acc, to, bodyText, previewUrl = false) =>
  sendPayload(acc, { to, type: 'text', text: { body: bodyText, preview_url: !!previewUrl } });

const sendTemplate = (acc, to, name, language, components) =>
  sendPayload(acc, {
    to,
    type: 'template',
    template: { name, language: { code: language || 'pt_BR' }, ...(components && components.length ? { components } : {}) }
  });

// type: image | video | audio | document | sticker; media: { id } ou { link }, + caption/filename
const sendMedia = (acc, to, type, media) => sendPayload(acc, { to, type, [type]: media });

const sendLocation = (acc, to, location) => sendPayload(acc, { to, type: 'location', location });

const sendReaction = (acc, to, messageId, emoji) =>
  sendPayload(acc, { to, type: 'reaction', reaction: { message_id: messageId, emoji } });

const sendInteractive = (acc, to, interactive) => sendPayload(acc, { to, type: 'interactive', interactive });

const sendContactCard = (acc, to, contacts) => sendPayload(acc, { to, type: 'contacts', contacts });

// Confirmação de leitura (e indicador de digitação opcional)
function markRead(acc, messageId, typing = false) {
  requireWa(acc, 'phoneNumberId');
  const body = { messaging_product: 'whatsapp', status: 'read', message_id: messageId };
  if (typing) body.typing_indicator = { type: 'text' };
  return graph(acc, `/${acc.wa.phoneNumberId}/messages`, { method: 'POST', body });
}

// ============ MÍDIA ============

// POST /{phone_number_id}/media (multipart)
async function uploadMedia(acc, filename, mime, buffer) {
  requireWa(acc, 'phoneNumberId');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mime }), filename || 'arquivo');
  return graph(acc, `/${acc.wa.phoneNumberId}/media`, { method: 'POST', form });
}

// GET /{media_id} -> { url, mime_type, sha256, file_size }
const getMediaInfo = (acc, id) => graph(acc, `/${encodeURIComponent(id)}`);

// Baixa o binário da mídia (a URL retornada exige o Bearer token)
async function downloadMedia(acc, id) {
  const info = await getMediaInfo(acc, id);
  const res = await fetch(info.url, { headers: { Authorization: `Bearer ${tokenOf(acc)}` } });
  if (!res.ok) {
    const e = new Error('Falha ao baixar mídia: HTTP ' + res.status);
    e.status = res.status;
    throw e;
  }
  return { res, info };
}

const deleteMedia = (acc, id) => graph(acc, `/${encodeURIComponent(id)}`, { method: 'DELETE' });

// Upload resumável (Resumable Upload API) — gera o "handle" de exemplo exigido
// pela Meta em cabeçalhos de mídia (IMAGE/VIDEO/DOCUMENT) de templates.
// 1) POST /{app_id}/uploads → sessão  2) POST /{session_id} com o binário → { h }
async function uploadTemplateExample(acc, filename, mime, buffer) {
  const appId = db.get().platform.appId;
  if (!appId) {
    const e = new Error('App ID da plataforma não configurado (Configurações → Plataforma)');
    e.status = 400; throw e;
  }
  requireWa(acc, 'accessToken');
  const sess = await graph(acc,
    `/${appId}/uploads?file_name=${encodeURIComponent(filename || 'exemplo')}&file_length=${buffer.length}&file_type=${encodeURIComponent(mime)}`,
    { method: 'POST', body: {} });
  const res = await fetch(`${base()}/${sess.id}`, {
    method: 'POST',
    headers: { Authorization: `OAuth ${tokenOf(acc)}`, file_offset: '0' },
    body: buffer
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || !data.h) {
    const e = new Error((data.error && data.error.message) || 'Falha no upload do exemplo de mídia');
    e.status = res.status || 500; e.meta = data; throw e;
  }
  return data.h; // handle p/ example.header_handle
}

// ============ TEMPLATES — /{waba_id}/message_templates ============

function listTemplates(acc) {
  requireWa(acc, 'wabaId');
  return graph(acc, `/${acc.wa.wabaId}/message_templates?limit=200&fields=name,status,category,language,components,quality_score,rejected_reason`);
}

function createTemplate(acc, tpl) {
  requireWa(acc, 'wabaId');
  return graph(acc, `/${acc.wa.wabaId}/message_templates`, { method: 'POST', body: tpl });
}

function deleteTemplate(acc, name) {
  requireWa(acc, 'wabaId');
  return graph(acc, `/${acc.wa.wabaId}/message_templates?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
}

// ============ NÚMERO DE TELEFONE — /{phone_number_id} ============

function getPhoneInfo(acc) {
  requireWa(acc, 'phoneNumberId');
  // `messaging_limit_tier` é o teto de conversas novas por 24h — o número que
  // decide o tamanho de um disparo. `throughput` é a velocidade de envio.
  return graph(acc, `/${acc.wa.phoneNumberId}?fields=verified_name,display_phone_number,quality_rating,code_verification_status,platform_type,messaging_limit_tier,throughput`);
}

// Verificação do número (quando ainda não verificado)
function requestCode(acc, code_method = 'SMS', language = 'pt_BR') {
  requireWa(acc, 'phoneNumberId');
  return graph(acc, `/${acc.wa.phoneNumberId}/request_code`, { method: 'POST', body: { code_method, language } });
}

function verifyCode(acc, code) {
  requireWa(acc, 'phoneNumberId');
  return graph(acc, `/${acc.wa.phoneNumberId}/verify_code`, { method: 'POST', body: { code } });
}

// Registro do número na Cloud API (PIN de verificação em duas etapas, 6 dígitos)
function registerPhone(acc, pin) {
  requireWa(acc, 'phoneNumberId');
  return graph(acc, `/${acc.wa.phoneNumberId}/register`, { method: 'POST', body: { messaging_product: 'whatsapp', pin: String(pin) } });
}

function deregisterPhone(acc) {
  requireWa(acc, 'phoneNumberId');
  return graph(acc, `/${acc.wa.phoneNumberId}/deregister`, { method: 'POST', body: {} });
}

// ============ WABA — /{waba_id} ============

function getWaba(acc) {
  requireWa(acc, 'wabaId');
  return graph(acc, `/${acc.wa.wabaId}?fields=id,name,timezone_id,message_template_namespace`);
}

function getWabaPhones(acc) {
  requireWa(acc, 'wabaId');
  return graph(acc, `/${acc.wa.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type`);
}

// Inscreve o App nos webhooks desta WABA (necessário para receber mensagens)
function subscribeApp(acc) {
  requireWa(acc, 'wabaId');
  return graph(acc, `/${acc.wa.wabaId}/subscribed_apps`, { method: 'POST', body: {} });
}

function getSubscriptions(acc) {
  requireWa(acc, 'wabaId');
  return graph(acc, `/${acc.wa.wabaId}/subscribed_apps`);
}

function unsubscribeApp(acc) {
  requireWa(acc, 'wabaId');
  return graph(acc, `/${acc.wa.wabaId}/subscribed_apps`, { method: 'DELETE' });
}

// ============ PERFIL COMERCIAL — /{phone_number_id}/whatsapp_business_profile ============

function getProfile(acc) {
  requireWa(acc, 'phoneNumberId');
  return graph(acc, `/${acc.wa.phoneNumberId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`);
}

function updateProfile(acc, fields) {
  requireWa(acc, 'phoneNumberId');
  return graph(acc, `/${acc.wa.phoneNumberId}/whatsapp_business_profile`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', ...fields }
  });
}

// ============ CHAMADAS — WhatsApp Business Calling API ============
// Docs: chamadas VoIP no número da Cloud API. Habilita/desabilita o recurso e
// a visibilidade do ícone de ligação via /{phone_number_id}/settings.

function getCallingSettings(acc) {
  requireWa(acc, 'phoneNumberId');
  return graph(acc, `/${acc.wa.phoneNumberId}/settings?include_fields=calling`);
}

function setCallingSettings(acc, enabled) {
  requireWa(acc, 'phoneNumberId');
  return graph(acc, `/${acc.wa.phoneNumberId}/settings`, {
    method: 'POST',
    body: {
      calling: enabled
        ? { status: 'ENABLED', call_icon_visibility: 'DEFAULT' }
        : { status: 'DISABLED' }
    }
  });
}

// Ações de chamada — POST /{phone_number_id}/calls (Calling API oficial)
//   accept/pre_accept: atender (exige session SDP answer do WebRTC)
//   reject: recusar · terminate: encerrar · connect: ligar para o cliente
function callAction(acc, body) {
  requireWa(acc, 'phoneNumberId');
  return graph(acc, `/${acc.wa.phoneNumberId}/calls`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', ...body }
  });
}

// Pedido de permissão para ligar (mensagem interativa oficial da Meta —
// ligações business-initiated exigem aprovação prévia do cliente)
const sendCallPermission = (acc, to, text) => sendPayload(acc, {
  to,
  type: 'interactive',
  interactive: {
    type: 'call_permission_request',
    body: { text: text || 'Podemos te ligar pelo WhatsApp para agilizar seu atendimento?' },
    action: { name: 'call_permission_request' }
  }
});

// ============ TOKEN — GET /debug_token ============

function debugToken(acc) {
  const p = db.get().platform;
  const appToken = p.appId && p.appSecret ? `${p.appId}|${p.appSecret}` : tokenOf(acc);
  return graph(acc, `/debug_token?input_token=${encodeURIComponent(tokenOf(acc))}`, { token: appToken });
}

module.exports = {
  graph,
  tokenOf,
  sendPayload,
  sendText,
  sendTemplate,
  sendMedia,
  sendLocation,
  sendReaction,
  sendInteractive,
  sendContactCard,
  markRead,
  uploadMedia,
  uploadTemplateExample,
  getMediaInfo,
  downloadMedia,
  deleteMedia,
  listTemplates,
  createTemplate,
  deleteTemplate,
  getPhoneInfo,
  requestCode,
  verifyCode,
  registerPhone,
  deregisterPhone,
  getWaba,
  getWabaPhones,
  subscribeApp,
  getSubscriptions,
  unsubscribeApp,
  getProfile,
  updateProfile,
  getCallingSettings,
  setCallingSettings,
  callAction,
  sendCallPermission,
  debugToken
};
