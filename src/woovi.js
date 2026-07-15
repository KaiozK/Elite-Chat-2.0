// Integração Woovi (OpenPix) — pagamentos Pix e Pix Automático.
// Docs: https://developers.woovi.com/docs/intro/getting-started
// Autenticação: header Authorization com o AppID gerado em app.woovi.com.
// Métodos habilitados: apenas PIX (cobrança avulsa) e PIX AUTOMÁTICO (assinatura).
const db = require('./db');
const store = require('./store');

const API = 'https://api.woovi.com';

function appId() {
  return (db.get().platform.woovi && db.get().platform.woovi.appId || '').trim();
}
function configured() { return !!appId(); }

// Chamada genérica à API da Woovi
async function call(method, path, body) {
  if (!configured()) {
    const e = new Error('Woovi não configurada — informe o AppID no painel Admin → Pagamentos');
    e.status = 400; throw e;
  }
  const r = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: appId() },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) {
    const e = new Error(data.error || data.message || `Woovi HTTP ${r.status}`);
    e.status = r.status === 401 ? 400 : 502; e.meta = data; throw e;
  }
  return data;
}

// ---- Cobrança Pix avulsa (assinatura 1º pagamento, renovação manual, saldo) ----
// POST /api/v1/charge → { charge: { brCode, qrCodeImage, paymentLinkUrl, ... } }
async function createCharge({ correlationID, value, comment, customer, expiresIn }) {
  const body = { correlationID, value, comment: comment || '', expiresIn: expiresIn || 3600 };
  if (customer && (customer.name || customer.email)) body.customer = customer;
  const d = await call('POST', '/api/v1/charge', body);
  return d.charge || d;
}

async function getCharge(correlationID) {
  const d = await call('GET', '/api/v1/charge/' + encodeURIComponent(correlationID));
  return d.charge || d;
}

async function deleteCharge(correlationID) {
  try { await call('DELETE', '/api/v1/charge/' + encodeURIComponent(correlationID)); } catch {}
}

// ---- Assinatura recorrente (Pix Automático quando habilitado na conta Woovi) ----
// POST /api/v1/subscriptions → cobranças geradas automaticamente a cada ciclo
async function createSubscription({ correlationID, value, customer, comment }) {
  const today = new Date().getDate();
  const body = {
    value,
    customer,
    correlationID,
    comment: comment || '',
    dayGenerateCharge: Math.min(28, today), // dia do mês da cobrança (Woovi aceita 1..28)
    frequency: 'MONTHLY',
    chargeType: 'DYNAMIC'
  };
  const d = await call('POST', '/api/v1/subscriptions', body);
  return d.subscription || d;
}

async function cancelSubscription(id) {
  // A Woovi cancela desativando a assinatura pelo globalID
  try { return await call('DELETE', '/api/v1/subscriptions/' + encodeURIComponent(id)); }
  catch (e) { return { error: e.message }; }
}

// ============ Processamento de pagamento confirmado ============
// Chamado pelo webhook (após verificação server-side) e pelo polling do painel.
// correlationID: sub-<accId>-<planId>-<rand> | topup-<accId>-<rand>
// (separador "-" porque os IDs internos contêm "_")
function applyPayment(charge, broadcast) {
  const data = db.get();
  const cid = charge.correlationID || '';
  const paid = Number(charge.value) || 0;
  if (data.revenue.some(r => r.chargeId === cid && r.chargeId)) return { ok: true, duplicate: true };

  let acc = null, kind = '', planId = '';
  if (cid.startsWith('sub-') || cid.startsWith('topup-')) {
    const parts = cid.split('-');
    acc = db.findAccount(parts[1]);
    kind = parts[0] === 'sub' ? 'first' : 'topup';
    planId = parts[0] === 'sub' ? parts[2] : '';
  } else {
    // renovação gerada pela assinatura Woovi — casa pelo correlationID da assinatura
    const subCid = (charge.subscription && (charge.subscription.correlationID || charge.subscription)) || charge.subscriptionCorrelationID || '';
    acc = data.accounts.find(a => a.billing && a.billing.subCorrelationID &&
      (a.billing.subCorrelationID === subCid || cid.startsWith(a.billing.subCorrelationID)));
    if (acc) { kind = 'renewal'; planId = acc.billing.planId; }
  }
  if (!acc) {
    store.logEvent({ type: 'woovi_unmatched', correlationID: cid, value: paid });
    return { ok: false, reason: 'unmatched' };
  }

  const plan = data.plans.find(p => p.id === planId) || null;

  if (kind === 'topup') {
    acc.wallet.balance += paid;
    acc.wallet.transactions.push({ id: db.genId('tx'), ts: Date.now(), amount: paid, type: 'topup', label: 'Recarga via Pix' });
  } else {
    // ativa/renova a assinatura
    const period = (plan && plan.periodDays ? plan.periodDays : 30) * 86400000;
    const base = Math.max(Date.now(), acc.billing.periodEnd || 0);
    acc.billing.status = 'active';
    acc.billing.planId = planId || acc.billing.planId;
    acc.billing.periodEnd = base + period;
    if (!acc.billing.startedAt) acc.billing.startedAt = Date.now();
    acc.billing.pendingCharge = null;
    if (kind === 'first' && acc.billing.subCorrelationID) kind = 'first'; // 1ª cobrança da recorrência

    // ---- comissão de afiliado (assinatura E renovação) ----
    const refCode = acc.affiliate && acc.affiliate.refBy;
    if (refCode) {
      const aff = db.findAccountByRefCode(refCode);
      if (aff && aff.id !== acc.id) {
        const cfg = data.platform.affiliate || {};
        const pct = kind === 'first' ? (cfg.percentFirst || 0) : (cfg.percentRenewal || 0);
        const cut = Math.floor(paid * pct / 100);
        if (cut > 0) {
          aff.wallet.balance += cut;
          aff.affiliate.earned += cut;
          aff.wallet.transactions.push({
            id: db.genId('tx'), ts: Date.now(), amount: cut, type: 'commission',
            label: `Comissão ${pct}% — ${kind === 'first' ? 'nova assinatura' : 'renovação'} (${acc.name})`
          });
          if (broadcast) broadcast('wallet', { accountId: aff.id });
        }
      }
    }
  }

  data.revenue.push({ ts: Date.now(), accountId: acc.id, planId, amount: paid, kind, chargeId: cid });
  db.save();
  store.logEvent({ type: 'woovi_paid', accountId: acc.id, kind, value: paid, correlationID: cid });
  if (broadcast) broadcast('billing', { accountId: acc.id });
  return { ok: true, kind, accountId: acc.id };
}

// ============ Webhook público (configurar na Woovi: <URL>/woovi-webhook) ============
// Segurança: nunca confia no payload — reconsulta a cobrança na API antes de aplicar.
function webhookHandler(broadcast) {
  return async (req, res) => {
    res.json({ ok: true }); // responde já; Woovi reenvia em caso de erro
    try {
      const b = req.body || {};
      const ev = b.event || b.evento || '';
      const charge = b.charge || (b.data && b.data.charge) || null;
      store.logEvent({ type: 'woovi_webhook', event: ev, correlationID: charge && charge.correlationID });
      if (!/CHARGE_COMPLETED|TRANSACTION_RECEIVED/i.test(ev) || !charge || !charge.correlationID) return;
      if (!configured()) return;
      const fresh = await getCharge(charge.correlationID); // verificação server-side
      if (fresh && /COMPLETED|CONFIRMED|PAID/i.test(fresh.status || '')) {
        applyPayment(fresh, broadcast);
      }
    } catch (e) {
      store.logEvent({ type: 'woovi_webhook_error', error: e.message });
    }
  };
}

module.exports = { configured, call, createCharge, getCharge, deleteCharge, createSubscription, cancelSubscription, applyPayment, webhookHandler };
