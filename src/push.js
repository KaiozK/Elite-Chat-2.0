// Web Push (VAPID + aes128gcm) — implementado só com o módulo `crypto` do Node,
// sem dependências externas. Entrega notificações ao WebApp instalado mesmo
// com o app fechado (requer HTTPS em produção; funciona em localhost p/ teste).
//
// Referências: RFC 8291 (encryption) e RFC 8292 (VAPID).
const crypto = require('crypto');
const db = require('./db');

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// ---- Chaves VAPID (geradas uma vez e persistidas em platform.vapid) ----
function ensureKeys() {
  const p = db.get().platform;
  if (p.vapid && p.vapid.publicKey && p.vapid.jwk) return p.vapid;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const rawPublic = Buffer.concat([Buffer.from([4]), fromB64url(pub.x), fromB64url(pub.y)]); // ponto não comprimido (65 bytes)
  p.vapid = { publicKey: b64url(rawPublic), jwk: priv };
  db.save();
  return p.vapid;
}
function publicKey() { return ensureKeys().publicKey; }

// ---- Assinatura VAPID (JWT ES256) ----
function vapidAuth(endpoint) {
  const v = ensureKeys();
  const aud = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64url(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: 'mailto:no-reply@koonfy.app'
  }));
  const signingInput = header + '.' + body;
  const key = crypto.createPrivateKey({ key: v.jwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  const jwt = signingInput + '.' + b64url(sig);
  return { Authorization: 'vapid t=' + jwt + ', k=' + v.publicKey };
}

// ---- Criptografia do payload (aes128gcm, RFC 8291) ----
function encrypt(sub, payloadStr) {
  const clientPub = fromB64url(sub.keys.p256dh);   // 65 bytes
  const authSecret = fromB64url(sub.keys.auth);    // 16 bytes

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();            // 65 bytes
  const sharedSecret = ecdh.computeSecret(clientPub);

  const salt = crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), clientPub, asPublic]);
  const IKM = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const CEK = Buffer.from(crypto.hkdfSync('sha256', IKM, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const NONCE = Buffer.from(crypto.hkdfSync('sha256', IKM, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const plaintext = Buffer.concat([Buffer.from(payloadStr), Buffer.from([2])]); // 0x02 = delimitador do último registro
  const cipher = crypto.createCipheriv('aes-128-gcm', CEK, NONCE);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096, 0);
  const idlen = Buffer.from([asPublic.length]);
  return Buffer.concat([salt, rs, idlen, asPublic, ct]); // cabeçalho aes128gcm + corpo cifrado
}

// ---- Envio a UMA assinatura ----
async function sendOne(sub, payloadObj) {
  const body = encrypt(sub, JSON.stringify(payloadObj));
  const headers = Object.assign({
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'TTL': '2419200'
  }, vapidAuth(sub.endpoint));
  const res = await fetch(sub.endpoint, { method: 'POST', headers, body });
  return res.status;
}

// ---- Assinaturas por conta ----
function subscribe(acc, subscription, prefs) {
  if (!subscription || !subscription.endpoint || !subscription.keys) return false;
  acc.pushSubs = acc.pushSubs || [];
  const i = acc.pushSubs.findIndex(s => s.endpoint === subscription.endpoint);
  const rec = {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    prefs: prefs || {}, updatedAt: Date.now()
  };
  if (i >= 0) acc.pushSubs[i] = Object.assign(acc.pushSubs[i], rec);
  else acc.pushSubs.push(rec);
  db.save();
  return true;
}
function unsubscribe(acc, endpoint) {
  if (!acc.pushSubs) return;
  acc.pushSubs = acc.pushSubs.filter(s => s.endpoint !== endpoint);
  db.save();
}

// ---- Envio à conta inteira (respeita as prefs de cada dispositivo) ----
// type ∈ message|call|attendance|reminder — filtra por prefs.types[type] e prefs.enabled.
async function sendToAccount(acc, type, payloadObj) {
  if (!acc || !Array.isArray(acc.pushSubs) || !acc.pushSubs.length) return;
  try { ensureKeys(); } catch { return; }
  const dead = [];
  await Promise.all(acc.pushSubs.map(async (sub) => {
    const pf = sub.prefs || {};
    if (pf.enabled === false) return;
    if (pf.types && pf.types[type] === false) return;
    try {
      const st = await sendOne(sub, payloadObj);
      if (st === 404 || st === 410) dead.push(sub.endpoint);
    } catch (e) { /* rede/endpoint indisponível, ignora */ }
  }));
  if (dead.length) { acc.pushSubs = acc.pushSubs.filter(s => !dead.includes(s.endpoint)); db.save(); }
}

module.exports = { ensureKeys, publicKey, subscribe, unsubscribe, sendToAccount };
