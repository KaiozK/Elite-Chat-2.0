// ============================================================================
// PIX INDIRETO (Woovi) — EXCLUSIVO para as assinaturas do EliteChat.
//
// Docs oficiais (fonte da verdade desta implementação):
//   Visão geral: https://developers.woovi.com/docs/indireto/pix-indirect-overview
//   OpenAPI:     https://developers.woovi.com/indirect
//
// Diferente da API OpenPix clássica (src/woovi.js, que segue valendo para
// recargas, Elite Pay e renovações antigas), aqui cada participante indireto
// tem uma BASE URL própria:
//   produção: https://<nome>.indireto.woovi.cloud
//   staging:  https://<nome>.indireto.dev.woovi.cloud
// e autentica com o AppID no header Authorization.
//
// Endpoints usados (todos validados na especificação OpenAPI):
//   POST   /core/charge/{txid}                       cria cobrança + location + BR Code (EMV)
//   POST   /pix-charge/v1/charge/{txid}              cria cobrança (forma detalhada)
//   GET    /pix-charge/v1/charge/{txid}              consulta cobrança
//   PUT    /pix-charge/v1/charge/{txid}              atualiza cobrança (calendar/chargeType)
//   DELETE /pix-charge/v1/charge/{txid}              remove cobrança
//   POST   /pix-charge/v1/charge/{txid}/allow        valida se a cobrança pode ser paga
//   POST   /pix-charge/v1/charge/{txid}/complete     marca a cobrança como paga
//   GET    /qr/v2/{locType}/{pixUrlAccessToken}          QR em formato JOSE
//   GET    /qr/v2/{locType}/{pixUrlAccessToken}/payload  payload do QR em JSON
//
// txid: 1–35 caracteres alfanuméricos, único por cobrança de assinatura.
// ============================================================================
const crypto = require('crypto');
const db = require('./db');
const store = require('./store');

// ---------------------------------------------------------------------------
// Configuração da plataforma (Admin SaaS → Pagamentos)
// ---------------------------------------------------------------------------
function cfg() {
  const p = db.get().platform;
  if (!p.pixIndirect || typeof p.pixIndirect !== 'object') {
    p.pixIndirect = {
      enabled: false,
      baseUrl: '',              // https://<nome>.indireto.woovi.cloud
      appId: '',                // AppID do participante indireto
      pixKey: '',               // chave Pix recebedora das assinaturas
      merchantName: 'ELITECHAT',   // 1–25 chars, sem acento (regra do EMV)
      merchantCity: 'SAO PAULO',   // 1–15 chars, sem acento
      receiver: { name: '', taxID: '', taxIDType: 'cnpj', city: '', state: '', street: '', zipcode: '' },
      webhookToken: ''
    };
  }
  const c = p.pixIndirect;
  if (!c.webhookToken) { c.webhookToken = 'pi_' + crypto.randomBytes(24).toString('hex'); db.save(); }
  if (!c.receiver || typeof c.receiver !== 'object') c.receiver = { name: '', taxID: '', taxIDType: 'cnpj' };
  return c;
}

function configured() {
  const c = cfg();
  return !!(c.enabled && c.baseUrl && c.appId && c.pixKey);
}

// EMV não aceita acento nem caractere especial em nome/cidade do lojista.
function emvText(s, max) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .-]/g, '').trim().slice(0, max) || 'ELITECHAT';
}

// txid único por assinatura: 1–35 alfanuméricos (usamos 32: "EC" + 30 hex).
function newTxid() {
  return 'EC' + crypto.randomBytes(15).toString('hex').toUpperCase();
}

// ---------------------------------------------------------------------------
// Cliente HTTP — AppID no Authorization, JSON puro, base URL do participante.
// ---------------------------------------------------------------------------
async function call(method, path, body) {
  const c = cfg();
  if (!configured()) {
    const e = new Error('Pix Indireto não configurado — informe base URL, AppID e chave Pix em Admin → Pagamentos');
    e.status = 400; throw e;
  }
  const base = c.baseUrl.replace(/\/+$/, '');
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: c.appId },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    const msg = (data.error && (data.error.message || data.error)) || data.message ||
      (Array.isArray(data.issues) && data.issues.map(i => i.message).join(' · ')) ||
      `Pix Indireto HTTP ${r.status}`;
    const e = new Error(String(msg).slice(0, 300));
    e.status = r.status === 401 ? 400 : (r.status === 404 ? 404 : 502);
    e.meta = data; throw e;
  }
  return data;
}

// ---------------------------------------------------------------------------
// OPERAÇÕES DA API (espelham 1:1 os endpoints da especificação)
// ---------------------------------------------------------------------------

// POST /core/charge/{txid} — caminho recomendado: cria a cobrança, a location
// e o BR Code EMV numa chamada só. `extra` aceita os objetos do modelo
// detalhado (calendar, debtor, receiver, additionalInfo, comment…), que a
// especificação permite ("Additional properties allowed").
function createCoreCharge(txid, { valueCents, comment, debtor, calendar, additionalInfo }) {
  const c = cfg();
  const body = {
    pixCharge: {
      chargeType: 'cob',
      pixKey: c.pixKey,
      value: valueCents,
      ...(comment ? { comment: String(comment).slice(0, 140) } : {}),
      ...(calendar ? { calendar } : {}),
      ...(debtor && debtor.name ? { debtor } : {}),
      ...(Array.isArray(additionalInfo) && additionalInfo.length
        ? { additionalInfo: additionalInfo.slice(0, 50) } : {}),
      ...(c.receiver && c.receiver.name && c.receiver.taxID ? { receiver: c.receiver } : {})
    },
    pixLocation: { type: 'cob' },
    brCodeInfo: {
      merchantName: emvText(c.merchantName, 25),
      merchantCity: emvText(c.merchantCity, 15)
    }
  };
  return call('POST', `/core/charge/${encodeURIComponent(txid)}`, body);
}

// POST /pix-charge/v1/charge/{txid} — criação detalhada (todos os objetos do
// modelo). Mantida para quem já tem uma location; o fluxo de assinatura usa o
// /core acima, que resolve location + EMV junto.
function createCharge(txid, payload) {
  return call('POST', `/pix-charge/v1/charge/${encodeURIComponent(txid)}`, payload);
}

// GET /pix-charge/v1/charge/{txid} — consulta.
function getCharge(txid) {
  return call('GET', `/pix-charge/v1/charge/${encodeURIComponent(txid)}`);
}

// PUT /pix-charge/v1/charge/{txid} — atualização (calendar / chargeType).
function updateCharge(txid, { chargeType, calendar }) {
  const body = {};
  if (chargeType) body.chargeType = chargeType;
  if (calendar) body.calendar = calendar;
  return call('PUT', `/pix-charge/v1/charge/${encodeURIComponent(txid)}`, body);
}

// DELETE /pix-charge/v1/charge/{txid} — remoção (cancelamento da cobrança).
async function deleteCharge(txid) {
  try { return await call('DELETE', `/pix-charge/v1/charge/${encodeURIComponent(txid)}`); }
  catch (e) { if (e.status === 404) return { ok: true, missing: true }; throw e; }
}

// POST /pix-charge/v1/charge/{txid}/allow — o PSP pagador valida a cobrança.
function allowCharge(txid, { paymentValue, taxID, DPP, codMun }) {
  return call('POST', `/pix-charge/v1/charge/${encodeURIComponent(txid)}/allow`, {
    paymentValue,
    ...(taxID ? { taxID } : {}),
    ...(DPP ? { DPP } : {}),
    ...(codMun ? { codMun } : {})
  });
}

// POST /pix-charge/v1/charge/{txid}/complete — marca como paga (liquidação).
function completeCharge(txid, { paymentValue, paymentDate }) {
  return call('POST', `/pix-charge/v1/charge/${encodeURIComponent(txid)}/complete`, {
    paymentValue,
    paymentDate: paymentDate || new Date().toISOString()
  });
}

// GET /qr/v2/{locType}/{pixUrlAccessToken} — QR assinado (JOSE).
function getQr(locType, pixUrlAccessToken) {
  return call('GET', `/qr/v2/${encodeURIComponent(locType)}/${encodeURIComponent(pixUrlAccessToken)}`);
}

// GET /qr/v2/{locType}/{pixUrlAccessToken}/payload — payload do QR em JSON.
function getQrPayload(locType, pixUrlAccessToken) {
  return call('GET', `/qr/v2/${encodeURIComponent(locType)}/${encodeURIComponent(pixUrlAccessToken)}/payload`);
}

// ---------------------------------------------------------------------------
// Normalização da resposta — a spec permite propriedades adicionais, então a
// leitura é defensiva: procura cada campo nos nomes usados pela API.
// ---------------------------------------------------------------------------
function pick(obj, ...keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o && o[p] !== undefined ? o[p] : undefined), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}

function normalizeCharge(d, txid) {
  const ch = d.pixCharge || d.charge || d;
  const loc = d.pixLocation || d.location || ch.location || {};
  return {
    txid: pick(ch, 'txid') || txid,
    chargeId: String(pick(d, 'id', '_id', 'chargeId') || pick(ch, 'id', '_id') || ''),
    locationId: String(pick(loc, 'id', '_id', 'locId', 'locationId') || pick(ch, 'locId') || ''),
    pixUrlAccessToken: String(pick(loc, 'pixUrlAccessToken', 'accessToken') || pick(d, 'pixUrlAccessToken') || ''),
    // qrCode = conteúdo/URL da location que o QR codifica; brCode = EMV completo
    qrCode: String(pick(loc, 'url', 'location', 'pixUrl') || pick(d, 'qrCode', 'pixUrl') || ''),
    brCode: String(pick(d, 'brCode', 'emv', 'brCodeInfo.emv', 'pixCopiaECola') || pick(ch, 'brCode', 'pixCopiaECola') || ''),
    status: String(pick(ch, 'status') || pick(d, 'status') || 'ATIVA').toUpperCase(),
    expiresAt: (() => {
      const cal = ch.calendar || {};
      if (cal.dueDate) return new Date(cal.dueDate).getTime() || 0;
      const created = pick(cal, 'creation', 'createdAt') || pick(ch, 'createdAt');
      const exp = Number(cal.expiration) || 0;
      if (exp) return (created ? new Date(created).getTime() : Date.now()) + exp * 1000;
      return 0;
    })(),
    paidAt: (() => {
      const v = pick(ch, 'paymentDate', 'paidAt') || pick(d, 'paymentDate', 'paidAt');
      return v ? (new Date(v).getTime() || 0) : 0;
    })()
  };
}

// Status BACEN de uma cob: ATIVA | CONCLUIDA | REMOVIDA_PELO_USUARIO_RECEBEDOR
// | REMOVIDA_PELO_PSP. Pago = CONCLUIDA (aceitamos sinônimos por segurança).
function isPaid(status) { return /CONCLUIDA|COMPLETED|CONFIRMED|PAID/i.test(String(status || '')); }
function isRemoved(status) { return /REMOVIDA/i.test(String(status || '')); }

// ---------------------------------------------------------------------------
// FLUXO DE ASSINATURA — a única coisa que o Pix Indireto atende no EliteChat.
// ---------------------------------------------------------------------------

// Cria a cobrança da assinatura e grava TODOS os campos exigidos no billing:
// txid, chargeId, locationId, pixUrlAccessToken, brCode, qrCode, status,
// expiresAt, paidAt.
async function createSubscriptionCharge(acc, plan, { expiresInSec } = {}) {
  const txid = newTxid();
  // correlationID interno espelha o formato do fluxo clássico, para reaproveitar
  // a ativação/renovação + comissão de afiliado de woovi.applyPayment.
  const correlationID = `sub-${acc.id}-${plan.id}-${Date.now().toString(36)}`;

  const raw = await createCoreCharge(txid, {
    valueCents: plan.price,
    comment: `EliteChat: assinatura ${plan.name}`,
    calendar: { expiration: Math.max(300, Number(expiresInSec) || 3600) },
    debtor: acc.name ? { name: String(acc.name).slice(0, 200) } : null,
    additionalInfo: [
      { name: 'Plano', value: String(plan.name).slice(0, 200) },
      { name: 'Conta', value: String(acc.email || acc.id).slice(0, 200) }
    ]
  });

  const n = normalizeCharge(raw, txid);
  acc.billing.pendingCharge = {
    provider: 'pixIndirect',
    kind: 'sub', planId: plan.id, amount: plan.price,
    correlationID,
    txid: n.txid,
    chargeId: n.chargeId,
    locationId: n.locationId,
    pixUrlAccessToken: n.pixUrlAccessToken,
    brCode: n.brCode,
    qrCode: n.qrCode,
    qrCodeImage: '',                       // imagem é renderizada no painel a partir do brCode
    status: n.status,
    expiresAt: n.expiresAt || (Date.now() + (Number(expiresInSec) || 3600) * 1000),
    paidAt: n.paidAt || 0,
    ts: Date.now()
  };
  db.save();
  store.logEvent({ type: 'pixindirect_charge', accountId: acc.id, txid: n.txid, value: plan.price });
  return acc.billing.pendingCharge;
}

// Reconsulta a cobrança e sincroniza o status salvo. Se pagou, ativa a
// assinatura reutilizando o ledger do fluxo clássico (receita + afiliado).
async function refreshSubscriptionCharge(acc, broadcast) {
  const pc = acc.billing.pendingCharge;
  if (!pc || pc.provider !== 'pixIndirect' || !pc.txid) return { ok: false, none: true };

  const raw = await getCharge(pc.txid);
  const n = normalizeCharge(raw, pc.txid);
  pc.status = n.status;
  if (n.brCode) pc.brCode = n.brCode;
  if (n.pixUrlAccessToken) pc.pixUrlAccessToken = n.pixUrlAccessToken;
  if (n.expiresAt) pc.expiresAt = n.expiresAt;
  if (n.paidAt) pc.paidAt = n.paidAt;
  db.save();

  if (isPaid(n.status)) {
    const woovi = require('./woovi');
    pc.paidAt = pc.paidAt || Date.now();
    const cid = pc.correlationID;
    const valor = pc.amount;
    store.logEvent({ type: 'pixindirect_paid', accountId: acc.id, txid: pc.txid, value: valor });
    woovi.applyPayment({ correlationID: cid, value: valor }, broadcast);   // limpa o pendingCharge
    return { ok: true, paid: true, status: n.status };
  }
  if (isRemoved(n.status)) {
    acc.billing.pendingCharge = null;
    db.save();
    return { ok: true, paid: false, removed: true, status: n.status };
  }
  return { ok: true, paid: false, status: n.status };
}

// Cancela a cobrança pendente da assinatura (DELETE na API + limpa o billing).
async function cancelSubscriptionCharge(acc) {
  const pc = acc.billing.pendingCharge;
  if (!pc || pc.provider !== 'pixIndirect') return { ok: false, none: true };
  try { await deleteCharge(pc.txid); } catch (e) { store.logEvent({ type: 'pixindirect_cancel_error', txid: pc.txid, error: e.message }); }
  acc.billing.pendingCharge = null;
  db.save();
  return { ok: true };
}

// Prorroga a validade da cobrança pendente (PUT calendar.expiration).
async function extendSubscriptionCharge(acc, extraSec) {
  const pc = acc.billing.pendingCharge;
  if (!pc || pc.provider !== 'pixIndirect') return { ok: false, none: true };
  const novo = Math.max(300, Number(extraSec) || 3600);
  await updateCharge(pc.txid, { calendar: { expiration: novo } });
  pc.expiresAt = Date.now() + novo * 1000;
  db.save();
  return { ok: true, expiresAt: pc.expiresAt };
}

// ---------------------------------------------------------------------------
// WEBHOOK — a confirmação de liquidação do participante indireto.
//
// A especificação pública do Indireto não fixa um schema de webhook (os
// eventos de liquidação trafegam nas filas SPI: PACS008 inicia, PACS002
// confirma). Por isso o receptor é tolerante ao formato: extrai o txid de
// qualquer envelope conhecido e NUNCA confia no payload — reconsulta a
// cobrança via GET /pix-charge/v1/charge/{txid} antes de ativar (mesma
// blindagem anti-fraude do webhook OpenPix). URL protegida por token.
// ---------------------------------------------------------------------------
function extractTxid(b) {
  if (!b || typeof b !== 'object') return '';
  return String(
    b.txid || b.txId ||
    (b.charge && (b.charge.txid || b.charge.txId)) ||
    (b.pixCharge && b.pixCharge.txid) ||
    (b.pix && b.pix[0] && b.pix[0].txid) ||               // formato BACEN de callback de pix recebido
    (b.data && (b.data.txid || (b.data.charge && b.data.charge.txid))) || ''
  ).replace(/[^A-Za-z0-9]/g, '').slice(0, 35);
}

function webhookHandler(broadcast) {
  return async (req, res) => {
    const c = cfg();
    const token = req.get('x-webhook-token') || req.query.token || '';
    if (!c.webhookToken || token !== c.webhookToken) return res.status(401).json({ error: 'unauthorized' });
    res.json({ ok: true });   // responde já; reentrega em caso de erro fica por conta do emissor

    try {
      const txid = extractTxid(req.body);
      store.logEvent({ type: 'pixindirect_webhook', txid, event: (req.body && (req.body.event || req.body.evento)) || '' });
      if (!txid || !configured()) return;

      // acha a conta dona deste txid (a cobrança pendente de assinatura)
      const acc = db.get().accounts.find(a =>
        a.billing && a.billing.pendingCharge &&
        a.billing.pendingCharge.provider === 'pixIndirect' &&
        a.billing.pendingCharge.txid === txid);
      if (!acc) { store.logEvent({ type: 'pixindirect_unmatched', txid }); return; }

      // verificação server-side: só o status vindo da API vale
      await refreshSubscriptionCharge(acc, broadcast);
    } catch (e) {
      store.logEvent({ type: 'pixindirect_webhook_error', error: e.message });
    }
  };
}

// Visão do admin (nunca expõe o AppID inteiro).
function adminView(baseUrlHost) {
  const c = cfg();
  return {
    enabled: !!c.enabled,
    configured: configured(),
    baseUrl: c.baseUrl || '',
    appId: c.appId ? '••••' + String(c.appId).slice(-6) : '',
    hasAppId: !!c.appId,
    pixKey: c.pixKey || '',
    merchantName: c.merchantName || 'ELITECHAT',
    merchantCity: c.merchantCity || 'SAO PAULO',
    receiver: c.receiver || {},
    webhookUrl: baseUrlHost ? `${baseUrlHost}/pix-indireto-webhook?token=${c.webhookToken}` : '',
    webhookToken: c.webhookToken
  };
}

module.exports = {
  cfg, configured, newTxid, emvText, normalizeCharge, isPaid, isRemoved, extractTxid,
  createCoreCharge, createCharge, getCharge, updateCharge, deleteCharge,
  allowCharge, completeCharge, getQr, getQrPayload,
  createSubscriptionCharge, refreshSubscriptionCharge, cancelSubscriptionCharge, extendSubscriptionCharge,
  webhookHandler, adminView
};
