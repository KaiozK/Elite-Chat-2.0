// Push dos apps nativos (App Store / Play Store).
//
// O Web Push do painel (src/push.js) não alcança os apps das lojas. Cada
// plataforma tem seu canal e o app registra em /api/push/device o token que
// recebeu do sistema:
//
//   Android → FCM HTTP v1   (token do Firebase, via google-services.json)
//   iOS     → APNs HTTP/2   (token do próprio APNs, entregue pelo AppDelegate)
//
// Mandar o iOS por FCM exigiria embutir o SDK do Firebase no app só para
// converter o token; falar direto com o APNs evita essa dependência inteira.
//
// Sem biblioteca externa, no mesmo estilo do push.js: os dois JWTs são
// assinados com o `crypto` do Node e o APNs usa o `http2` nativo.
//
// Configuração — cada plataforma é independente, e a que não estiver
// configurada simplesmente não recebe (o resto do sistema segue normal):
//
//   Android:  FCM_SERVICE_ACCOUNT       JSON da service account do Firebase
//             FCM_SERVICE_ACCOUNT_FILE  (alternativa: caminho do .json)
//
//   iOS:      APNS_KEY / APNS_KEY_FILE  chave .p8 do APNs
//             APNS_KEY_ID               ID da chave (10 caracteres)
//             APNS_TEAM_ID              Team ID da conta Apple Developer
//             APNS_BUNDLE_ID            id do app (padrão: com.elitechat.app)
//             APNS_ENV                  production (padrão) ou sandbox
const crypto = require('crypto');
const fs = require('fs');
const http2 = require('http2');
const db = require('./db');

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let creds = null;
let credsLoaded = false;

function serviceAccount() {
  if (credsLoaded) return creds;
  credsLoaded = true;
  try {
    const raw = process.env.FCM_SERVICE_ACCOUNT
      || (process.env.FCM_SERVICE_ACCOUNT_FILE ? fs.readFileSync(process.env.FCM_SERVICE_ACCOUNT_FILE, 'utf8') : '');
    if (!raw) return (creds = null);
    const j = JSON.parse(raw);
    if (!j.project_id || !j.client_email || !j.private_key) return (creds = null);
    creds = j;
  } catch (e) {
    console.warn('[push nativo] service account inválida:', e.message);
    creds = null;
  }
  return creds;
}

// ---- Chave do APNs (iOS) ----
let apnsKey = null;
let apnsLoaded = false;

function apnsConfig() {
  if (apnsLoaded) return apnsKey;
  apnsLoaded = true;
  try {
    const pem = process.env.APNS_KEY
      || (process.env.APNS_KEY_FILE ? fs.readFileSync(process.env.APNS_KEY_FILE, 'utf8') : '');
    const keyId = process.env.APNS_KEY_ID || '';
    const teamId = process.env.APNS_TEAM_ID || '';
    if (!pem || !keyId || !teamId) return (apnsKey = null);
    apnsKey = {
      key: crypto.createPrivateKey(pem),
      keyId,
      teamId,
      bundleId: process.env.APNS_BUNDLE_ID || 'com.elitechat.app',
      host: process.env.APNS_ENV === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com'
    };
  } catch (e) {
    console.warn('[push nativo] chave APNs inválida:', e.message);
    apnsKey = null;
  }
  return apnsKey;
}

function enabled() { return !!serviceAccount() || !!apnsConfig(); }

// ---- Token OAuth2 (cache até 60s antes de expirar) ----
let tokenCache = { value: '', exp: 0 };

async function accessToken() {
  const sa = serviceAccount();
  if (!sa) return '';
  if (tokenCache.value && Date.now() < tokenCache.exp - 60000) return tokenCache.value;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: FCM_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const signingInput = header + '.' + claim;
  const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(signingInput), sa.private_key));

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signingInput + '.' + sig
    })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(j.error_description || j.error || 'falha no token FCM');
  tokenCache = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.value;
}

// ---- Registro de aparelhos por conta ----
// Um device = um token do FCM. O mesmo aparelho reinstalado gera token novo,
// por isso a lista é limpa quando o FCM avisa que o token morreu.
function registerDevice(acc, token, platform, prefs) {
  if (!acc || !token) return false;
  acc.pushDevices = acc.pushDevices || [];
  const i = acc.pushDevices.findIndex(d => d.token === token);
  const rec = {
    token: String(token),
    platform: platform === 'ios' ? 'ios' : 'android',
    prefs: prefs || {},
    updatedAt: Date.now()
  };
  if (i >= 0) acc.pushDevices[i] = Object.assign(acc.pushDevices[i], rec);
  else acc.pushDevices.push(rec);
  db.save();
  return true;
}

function unregisterDevice(acc, token) {
  if (!acc || !Array.isArray(acc.pushDevices)) return;
  acc.pushDevices = acc.pushDevices.filter(d => d.token !== token);
  db.save();
}

// ---- Envio ----
// O FCM só aceita strings em `data`; qualquer objeto vai serializado.
function toStringMap(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

// ---- APNs (iOS) ----
// O JWT vale até 1h e a Apple recusa quem regenera com muita frequência —
// por isso o cache de ~50 min.
let apnsJwtCache = { value: '', exp: 0 };

function apnsJwt() {
  const cfg = apnsConfig();
  if (apnsJwtCache.value && Date.now() < apnsJwtCache.exp) return apnsJwtCache.value;
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }));
  const claims = b64url(JSON.stringify({ iss: cfg.teamId, iat: Math.floor(Date.now() / 1000) }));
  const input = header + '.' + claims;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: cfg.key, dsaEncoding: 'ieee-p1363' });
  apnsJwtCache = { value: input + '.' + b64url(sig), exp: Date.now() + 50 * 60 * 1000 };
  return apnsJwtCache.value;
}

// Uma conexão HTTP/2 reaproveitada entre envios: o APNs penaliza quem abre
// uma conexão por notificação.
let apnsClient = null;
function apnsConnect() {
  const cfg = apnsConfig();
  if (apnsClient && !apnsClient.closed && !apnsClient.destroyed) return apnsClient;
  apnsClient = http2.connect('https://' + cfg.host);
  apnsClient.on('error', () => { apnsClient = null; });
  apnsClient.on('close', () => { apnsClient = null; });
  return apnsClient;
}

function apnsSend(token, payload) {
  const cfg = apnsConfig();
  const urgent = !!payload.requireInteraction;
  const body = JSON.stringify({
    aps: {
      alert: { title: payload.title || 'EliteChat', body: payload.body || '' },
      sound: 'default',
      'thread-id': payload.tag || undefined,
      'interruption-level': urgent ? 'time-sensitive' : 'active'
    },
    ...toStringMap(payload.data)
  });

  return new Promise((resolve, reject) => {
    let client;
    try { client = apnsConnect(); } catch (e) { return reject(e); }
    const req = client.request({
      ':method': 'POST',
      ':path': '/3/device/' + token,
      authorization: 'bearer ' + apnsJwt(),
      'apns-topic': cfg.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    });
    let status = 0, data = '';
    req.setTimeout(10000, () => { req.close(); reject(new Error('timeout APNs')); });
    req.on('response', h => { status = h[':status']; });
    req.on('data', c => { data += c; });
    req.on('error', reject);
    req.on('end', () => {
      if (status === 200) return resolve(200);
      let reason = '';
      try { reason = JSON.parse(data).reason || ''; } catch {}
      // Aparelho desinstalou o app ou o token não vale mais para este bundle.
      if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') return resolve(410);
      reject(new Error(reason || ('HTTP ' + status)));
    });
    req.end(body);
  });
}

async function fcmSend(token, payload) {
  const at = await accessToken();
  const sa = serviceAccount();
  const urgent = !!payload.requireInteraction;

  const message = {
    token,
    notification: { title: payload.title || 'EliteChat', body: payload.body || '' },
    data: toStringMap(payload.data),
    android: {
      priority: 'HIGH',
      notification: {
        sound: 'default',
        channel_id: 'elitechat',
        tag: payload.tag || undefined,
        notification_priority: urgent ? 'PRIORITY_MAX' : 'PRIORITY_DEFAULT'
      }
    },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: {
        aps: {
          sound: 'default',
          'thread-id': payload.tag || undefined,
          'interruption-level': urgent ? 'time-sensitive' : 'active'
        }
      }
    }
  };

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
  if (res.ok) return 200;
  const err = await res.json().catch(() => ({}));
  const status = (err.error && err.error.status) || '';
  // Token morto: aparelho desinstalou o app ou o token foi rotacionado.
  if (status === 'NOT_FOUND' || status === 'UNREGISTERED' || res.status === 404) return 410;
  if (status === 'INVALID_ARGUMENT') return 400;
  throw new Error(status || ('HTTP ' + res.status));
}

// Mesma assinatura de push.sendToAccount: respeita as prefs de cada aparelho.
// Cada aparelho vai pelo canal da sua plataforma; um canal não configurado é
// pulado sem derrubar o outro.
async function sendToAccount(acc, type, payload) {
  if (!enabled()) return;
  if (!acc || !Array.isArray(acc.pushDevices) || !acc.pushDevices.length) return;
  const temFcm = !!serviceAccount();
  const temApns = !!apnsConfig();
  const dead = [];

  await Promise.all(acc.pushDevices.map(async (dev) => {
    const pf = dev.prefs || {};
    if (pf.enabled === false) return;
    if (pf.types && pf.types[type] === false) return;
    const ios = dev.platform === 'ios';
    if (ios ? !temApns : !temFcm) return;
    try {
      const st = ios ? await apnsSend(dev.token, payload) : await fcmSend(dev.token, payload);
      if (st === 410 || st === 400) dead.push(dev.token);
    } catch (e) {
      console.warn(`[push nativo/${dev.platform}] envio falhou:`, e.message);
    }
  }));

  if (dead.length) {
    acc.pushDevices = acc.pushDevices.filter(d => !dead.includes(d.token));
    db.save();
  }
}

module.exports = { enabled, registerDevice, unregisterDevice, sendToAccount };
