// ============================================================================
// COBRANÇA DOS PLANOS DO ELITECHAT NO CARTÃO (crédito/débito)
//
// O Pix (Woovi) continua sendo um meio; este módulo adiciona o CARTÃO para o
// próprio SaaS: o cliente assina o EliteChat pagando no cartão, com renovação
// automática usando o cartão salvo.
//
// Usa o MESMO adquirente configurado pelo admin (Admin SaaS → Pagamentos), mas
// SEM split: aqui o dinheiro é da plataforma, não de um lojista.
// ============================================================================

const db = require('./db');
const store = require('./store');
const cards = require('./cardgateways');
const limits = require('./limits');

function cardCfg() { return require('./elitepay').cardConfig(); }

// O cartão só está disponível para assinar planos se o admin ligou e configurou.
function available() {
  const c = cardCfg();
  return !!(c.enabled && cards.isConfigured(c));
}

function methods() {
  const c = cardCfg();
  const on = available();
  return {
    credit: on && !!c.credit,
    debit: on && !!c.debit && c.provider === 'pagarme',
    maxInstallments: Math.min(12, Math.max(1, Number(c.maxInstallments) || 1))
  };
}

function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

// Valida os dados do cartão e do titular antes de bater no adquirente.
function validate(body) {
  const c = body.card || {};
  const faltando = ['number', 'holderName', 'expMonth', 'expYear', 'cvv'].filter(k => !String(c[k] || '').trim());
  if (faltando.length) throw erro('Preencha todos os dados do cartão');
  const doc = String((body.customer || {}).taxId || '').replace(/\D/g, '');
  if (doc.length !== 11 && doc.length !== 14) throw erro('Informe um CPF ou CNPJ válido');
  return { c, doc };
}

// ---------------------------------------------------------------------------
// Cobra um valor no cartão em nome da PLATAFORMA.
// `kind`: 'credit' | 'debit'
// ---------------------------------------------------------------------------
async function charge({ acc, valueCents, kind, body, description, correlationID }) {
  const cfg = cardCfg();
  const m = methods();
  if (!m.credit && !m.debit) throw erro('Pagamento com cartão indisponível. O administrador ainda não configurou o adquirente');
  if (kind === 'credit' && !m.credit) throw erro('Cartão de crédito indisponível');
  if (kind === 'debit' && !m.debit) throw erro('Cartão de débito indisponível');

  const { c, doc } = validate(body);
  const parcelas = kind === 'debit' ? 1 : Math.max(1, Math.min(Number(body.installments) || 1, m.maxInstallments));

  const r = await cards.driver(cfg).charge({
    cfg: cards.creds(cfg),
    valueCents,
    installments: parcelas,
    kind,
    card: c,
    holder: body.holder || {},
    customer: {
      name: String((body.customer || {}).name || acc.name || '').trim(),
      taxId: doc,
      email: (body.customer || {}).email || acc.email || '',
      phone: (body.customer || {}).phone || ''
    },
    description: description || 'EliteChat',
    correlationID,
    softDescriptor: cfg.softDescriptor
    // sem `split`: o valor inteiro é da plataforma
  });

  if (!r || r.status !== 'paid') {
    throw erro(r && r.message ? r.message : 'Pagamento recusado pelo emissor do cartão');
  }
  return { ...r, installments: parcelas, kind };
}

// ---------------------------------------------------------------------------
// Assinar um plano no cartão. Cobra plano + extras já contratados e ativa na
// hora (cartão é síncrono — diferente do Pix, que espera o webhook).
// ---------------------------------------------------------------------------
async function subscribe(acc, plan, body, broadcast) {
  const kind = body.kind === 'debit' ? 'debit' : 'credit';
  const total = plan.price + limits.extrasCost(acc);
  const cid = `card-sub-${acc.id}-${plan.id}-${Date.now().toString(36)}`;

  const r = await charge({
    acc, valueCents: total, kind, body,
    description: `EliteChat: ${plan.name}`,
    correlationID: cid
  });

  // Guarda o cartão para renovar sozinho no próximo ciclo (só o token/últimos 4).
  acc.billing.method = kind;
  acc.billing.card = {
    token: r.cardToken || r.token || '',
    brand: r.brand || '',
    last4: r.last4 || String(body.card.number || '').replace(/\D/g, '').slice(-4),
    holderName: body.card.holderName || '',
    gatewayCustomerId: r.customerId || ''
  };
  // cancela a recorrência Pix, se existia — o cliente trocou de meio
  if (acc.billing.wooviSubId) {
    try { require('./woovi').cancelSubscription(acc.billing.wooviSubId); } catch {}
    acc.billing.wooviSubId = '';
    acc.billing.subCorrelationID = '';
  }
  acc.billing.pendingCharge = null;
  db.save();

  // reaproveita a ativação/renovação + comissão de afiliado do fluxo do Pix
  require('./woovi').applyPayment({ correlationID: cid, value: total }, broadcast);
  store.logEvent({
    type: 'saas_card_paid', accountId: acc.id, planId: plan.id,
    value: total, kind, gatewayId: r.gatewayId, brand: r.brand, last4: r.last4
  });
  return { ok: true, amount: total, brand: r.brand, last4: r.last4, installments: r.installments };
}

// ---------------------------------------------------------------------------
// Assinar / renovar usando o SALDO DA CARTEIRA.
// É o principal destino do dinheiro das vendas no cartão: em vez de sacar, o
// cliente abate o próprio plano.
// ---------------------------------------------------------------------------
function subscribeWallet(acc, plan, broadcast) {
  const ep = require('./elitepay');
  const total = plan.price + limits.extrasCost(acc);
  const cid = `wallet-sub-${acc.id}-${plan.id}-${Date.now().toString(36)}`;

  ep.spendWallet(acc, total, `Assinatura ${plan.name}`, broadcast);   // 402 se faltar saldo
  acc.billing.method = 'wallet';
  acc.billing.pendingCharge = null;
  // trocou de meio: desliga a recorrência do Pix para não cobrar duas vezes
  // (a renovação passa a sair do saldo, na varredura diária)
  if (acc.billing.wooviSubId) {
    try { require('./woovi').cancelSubscription(acc.billing.wooviSubId); } catch {}
    acc.billing.wooviSubId = '';
    acc.billing.subCorrelationID = '';
    acc.billing.subValue = 0;
  }
  db.save();

  require('./woovi').applyPayment({ correlationID: cid, value: total }, broadcast);
  store.logEvent({ type: 'saas_wallet_paid', accountId: acc.id, planId: plan.id, value: total });
  return { ok: true, amount: total, balance: acc.wallet.balance };
}

// ---------------------------------------------------------------------------
// Compra de unidades EXTRAS (WhatsApp adicional / link rastreável adicional).
// Cobra proporcional? Não: cobra 1 ciclo cheio e soma ao saldo de extras — o
// valor recorrente passa a entrar em toda renovação.
// ---------------------------------------------------------------------------
async function buyExtra(acc, key, qty, body, broadcast) {
  if (!limits.PAID_EXTRAS.includes(key)) throw erro('Recurso não vendido avulso');
  const n = Math.max(1, Math.min(100, Math.floor(Number(qty) || 0)));
  const unit = limits.extraPrices()[key];
  if (!unit) throw erro('O administrador ainda não definiu o preço deste extra');
  const total = unit * n;

  // ---- Pix: assíncrono. Devolve o QR e só libera quando o pagamento cai. ----
  if (body.pay === 'pix') {
    const woovi = require('./woovi');
    if (!woovi.configured()) throw erro('Pix indisponível no momento');
    const cid = `xtr-${acc.id}-${key}-${n}-${Date.now().toString(36)}`;
    const charge = await woovi.createCharge({
      correlationID: cid, value: total,
      customer: { name: acc.name, email: acc.email },
      comment: `EliteChat: ${n}x ${limits.LABEL[key]}`
    });
    acc.billing.pendingCharge = {
      correlationID: cid, kind: 'extra', planId: acc.billing.planId, amount: total,
      extraKey: key, extraQty: n,
      brCode: charge.brCode || '', qrCodeImage: charge.qrCodeImage || '',
      paymentLinkUrl: charge.paymentLinkUrl || '', ts: Date.now()
    };
    db.save();
    return { ok: true, pix: true, charge: acc.billing.pendingCharge };
  }

  const cid = `${body.pay === 'wallet' ? 'wallet' : 'card'}-extra-${acc.id}-${key}-${Date.now().toString(36)}`;

  // Pode pagar com o SALDO da carteira (dinheiro das vendas no cartão) ou
  // lançar direto num cartão novo.
  let r = { gatewayId: '' };
  if (body.pay === 'wallet') {
    require('./elitepay').spendWallet(acc, total, `${n}x ${limits.LABEL[key]}`, broadcast);
  } else {
    const kind = body.kind === 'debit' ? 'debit' : 'credit';
    r = await charge({
      acc, valueCents: total, kind, body,
      description: `EliteChat: ${n}x ${limits.LABEL[key]}`,
      correlationID: cid
    });
  }

  acc.billing.extras[key] = (Number(acc.billing.extras[key]) || 0) + n;
  db.get().revenue.push({
    ts: Date.now(), accountId: acc.id, planId: acc.billing.planId,
    amount: total, kind: 'extra', chargeId: cid
  });
  db.save();
  // O extra é RECORRENTE: entra no valor de toda renovação. No cartão isso é
  // automático (chargeTotal), mas a assinatura do Pix Automático guarda um
  // valor fixo e precisa ser refeita com o total novo.
  require('./woovi').syncSubscription(acc, `compra de ${n}x ${key}`).catch(() => {});
  store.logEvent({ type: 'saas_extra_paid', accountId: acc.id, key, qty: n, value: total, gatewayId: r.gatewayId });
  if (broadcast) { broadcast('billing', { accountId: acc.id }); broadcast('channels', { accountId: acc.id }); }
  return { ok: true, key, qty: acc.billing.extras[key], amount: total };
}

// ---------------------------------------------------------------------------
// RENOVAÇÃO AUTOMÁTICA no cartão salvo.
// Roda uma vez por dia: quem assinou no cartão e está chegando no fim do ciclo
// é cobrado de novo (plano + extras) usando o token guardado pelo adquirente.
// Falhou? A conta vai para `past_due` — o gate de envio já trata isso.
// ---------------------------------------------------------------------------
async function renew(acc, broadcast) {
  const b = acc.billing;
  const plan = limits.planOf(acc);
  if (!plan) return { ok: false, reason: 'sem plano' };
  if (!b.card || !b.card.token) return { ok: false, reason: 'sem cartão salvo' };

  const total = limits.chargeTotal(acc, plan);
  const cid = `card-ren-${acc.id}-${plan.id}-${Date.now().toString(36)}`;
  const cfg = cardCfg();
  const kind = b.method === 'debit' ? 'debit' : 'credit';

  try {
    const r = await cards.driver(cfg).charge({
      cfg: cards.creds(cfg),
      valueCents: total,
      installments: 1,
      kind,
      card: { token: b.card.token },        // sem PAN: o adquirente resolve pelo token
      holder: {},
      customer: { name: acc.name, email: acc.email },
      description: `EliteChat: renovação ${plan.name}`,
      correlationID: cid,
      softDescriptor: cfg.softDescriptor
    });
    if (!r || r.status !== 'paid') throw new Error(r && r.message ? r.message : 'recusado');
    require('./woovi').applyPayment({ correlationID: cid, value: total }, broadcast);
    store.logEvent({ type: 'saas_card_renewed', accountId: acc.id, value: total });
    return { ok: true, amount: total };
  } catch (e) {
    acc.billing.status = 'past_due';
    db.save();
    store.logEvent({ type: 'saas_card_renew_failed', accountId: acc.id, error: e.message });
    if (broadcast) broadcast('billing', { accountId: acc.id });
    return { ok: false, reason: e.message };
  }
}

// ---------------------------------------------------------------------------
// RENOVAÇÃO AUTOMÁTICA pelo SALDO da carteira.
// Quem assinou com o saldo também tem assinatura mensal: no fim do ciclo o
// valor (plano + extras) é debitado sozinho. Sem saldo, vai para `past_due`.
// ---------------------------------------------------------------------------
function renewWallet(acc, broadcast) {
  const plan = limits.planOf(acc);
  if (!plan) return { ok: false, reason: 'sem plano' };
  const total = limits.chargeTotal(acc, plan);
  const cid = `wallet-ren-${acc.id}-${plan.id}-${Date.now().toString(36)}`;
  try {
    require('./elitepay').spendWallet(acc, total, `Renovação ${plan.name}`, broadcast);
    require('./woovi').applyPayment({ correlationID: cid, value: total }, broadcast);
    store.logEvent({ type: 'saas_wallet_renewed', accountId: acc.id, value: total });
    return { ok: true, amount: total };
  } catch (e) {
    acc.billing.status = 'past_due';
    db.save();
    store.logEvent({ type: 'saas_wallet_renew_failed', accountId: acc.id, error: e.message });
    if (broadcast) broadcast('billing', { accountId: acc.id });
    return { ok: false, reason: e.message };
  }
}

// Varre as contas e renova as que vencem nas próximas 24h.
// Cartão e saldo são renovados aqui; o Pix Automático é renovado pela própria
// Woovi (a assinatura recorrente gera a cobrança e o webhook confirma).
async function runRenewals(broadcast) {
  const limite = Date.now() + 86400000;
  const vencendo = a => a.billing && a.billing.status === 'active' &&
    a.billing.periodEnd && a.billing.periodEnd <= limite;

  const noCartao = available()
    ? db.get().accounts.filter(a => vencendo(a) &&
        ['credit', 'debit'].includes(a.billing.method) &&
        a.billing.card && a.billing.card.token)
    : [];
  const naCarteira = db.get().accounts.filter(a => vencendo(a) && a.billing.method === 'wallet');

  let ok = 0, fail = 0;
  for (const acc of noCartao) { (await renew(acc, broadcast)).ok ? ok++ : fail++; }
  for (const acc of naCarteira) { renewWallet(acc, broadcast).ok ? ok++ : fail++; }

  const total = noCartao.length + naCarteira.length;
  if (total) store.logEvent({ type: 'saas_renew_batch', total, cartao: noCartao.length, carteira: naCarteira.length, ok, fail });
  return { total, ok, fail };
}

// Tick diário (com uma primeira passada 1min após subir o servidor).
function startRenewalJob(broadcast) {
  const tick = () => runRenewals(broadcast).catch(e => store.logEvent({ type: 'saas_renew_error', error: e.message }));
  setTimeout(tick, 60000);
  setInterval(tick, 24 * 3600 * 1000);
}

module.exports = {
  available, methods, charge, subscribe, subscribeWallet, buyExtra,
  renew, renewWallet, runRenewals, startRenewalJob
};
