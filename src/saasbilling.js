// ============================================================================
// COBRANÇA DOS PLANOS DO KOONFY NO CARTÃO DE CRÉDITO E NO BOLETO
//
// O Pix (Woovi) continua sendo um meio; este módulo adiciona o CARTÃO DE
// CRÉDITO e o BOLETO para o próprio SaaS. No cartão a renovação é automática
// pelo token salvo; no boleto o que se automatiza é a emissão do próximo.
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
    boleto: on && !!c.boleto,
    boletoDueDays: Math.max(1, Number(c.boletoDueDays) || 3),
    maxInstallments: Math.min(12, Math.max(1, Number(c.maxInstallments) || 1))
  };
}

function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

// Valida os dados do cartão e do titular antes de bater no adquirente.
// Valida o pagamento no cartão. São dois caminhos:
//   • cartão salvo  → só o token viaja; o número nunca passou por aqui
//   • cartão novo   → o formulário completo
// `acc` entra para reaproveitar o CPF/CNPJ e o titular já guardados, para não
// pedir de novo o que o cliente já informou na fatura.
function validate(body, acc) {
  const bill = (acc && acc.billing) || {};
  const salvo = bill.card || {};

  const c = body.useSaved
    ? { token: salvo.token || '', holderName: salvo.holderName || '' }
    : (body.card || {});

  if (body.useSaved) {
    if (!c.token) throw erro('Nenhum cartão salvo nesta conta. Informe os dados do cartão.');
  } else {
    const faltando = ['number', 'holderName', 'expMonth', 'expYear', 'cvv'].filter(k => !String(c[k] || '').trim());
    if (faltando.length) throw erro('Preencha todos os dados do cartão');
  }

  const doc = String((body.customer || {}).taxId || bill.taxId || '').replace(/\D/g, '');
  if (doc.length !== 11 && doc.length !== 14) throw erro('Informe um CPF ou CNPJ válido');
  return { c, doc };
}

// ---------------------------------------------------------------------------
// Cobra um valor no cartão em nome da PLATAFORMA.
// Só existe crédito: à vista o Pix é melhor para as duas pontas.
// ---------------------------------------------------------------------------
async function charge({ acc, valueCents, body, description, correlationID }) {
  const cfg = cardCfg();
  const m = methods();
  if (!m.credit) throw erro('Pagamento com cartão indisponível. O administrador ainda não configurou o adquirente');

  const { c, doc } = validate(body, acc);
  const parcelas = Math.max(1, Math.min(Number(body.installments) || 1, m.maxInstallments));
  // o CPF/CNPJ confirmado aqui serve para o boleto e para a próxima compra
  if (doc && acc.billing.taxId !== doc) { acc.billing.taxId = doc; db.save(); }

  const r = await cards.driver(cfg).charge({
    cfg: cards.creds(cfg),
    valueCents,
    installments: parcelas,
    card: c,
    holder: body.holder || {},
    customer: {
      name: String((body.customer || {}).name || acc.name || '').trim(),
      taxId: doc,
      email: (body.customer || {}).email || acc.email || '',
      phone: (body.customer || {}).phone || ''
    },
    description: description || 'Koonfy',
    correlationID,
    softDescriptor: cfg.softDescriptor
    // sem `split`: o valor inteiro é da plataforma
  });

  if (!r || r.status !== 'paid') {
    throw erro(r && r.message ? r.message : 'Pagamento recusado pelo emissor do cartão');
  }
  return { ...r, installments: parcelas, kind: 'credit' };
}

// ---------------------------------------------------------------------------
// Guarda o cartão da conta depois de uma cobrança aprovada.
//
// O que fica aqui é só o que dá para reusar sem risco: o identificador que o
// adquirente devolve (nunca o número), a bandeira, os 4 últimos dígitos e o
// titular. É isso que permite oferecer "pagar no cartão salvo" na próxima
// compra e preencher o formulário sozinho.
//
// Pagando COM o cartão salvo não existe formulário: nesse caso preservamos o
// que já estava gravado, em vez de sobrescrever com campos vazios.
// ---------------------------------------------------------------------------
function guardarCartao(acc, r, body) {
  const antigo = acc.billing.card || {};
  const digitado = (!body.useSaved && body.card) || {};
  acc.billing.card = {
    token: r.cardToken || r.token || antigo.token || '',
    brand: r.brand || antigo.brand || '',
    last4: r.last4 || String(digitado.number || '').replace(/\D/g, '').slice(-4) || antigo.last4 || '',
    holderName: digitado.holderName || r.holderName || antigo.holderName || '',
    gatewayCustomerId: r.customerId || antigo.gatewayCustomerId || ''
  };
  db.save();
}

// ---------------------------------------------------------------------------
// Assinar um plano no cartão. Cobra plano + extras já contratados e ativa na
// hora (cartão é síncrono — diferente do Pix, que espera o webhook).
// ---------------------------------------------------------------------------
async function subscribe(acc, plan, body, broadcast) {
  const total = plan.price + limits.extrasCost(acc);
  const cid = `card-sub-${acc.id}-${plan.id}-${Date.now().toString(36)}`;

  const r = await charge({
    acc, valueCents: total, body,
    description: `Koonfy: ${plan.name}`,
    correlationID: cid
  });

  // Guarda o cartão para renovar sozinho no próximo ciclo (só o token/últimos 4).
  acc.billing.method = 'credit';
  guardarCartao(acc, r, body);
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
    value: total, kind: 'credit', gatewayId: r.gatewayId, brand: r.brand, last4: r.last4
  });
  return { ok: true, amount: total, brand: r.brand, last4: r.last4, installments: r.installments };
}

// ---------------------------------------------------------------------------
// BOLETO — para a plataforma. Como o Pix, é assíncrono: gera a cobrança, mostra
// a linha digitável e o PDF, e a liberação sai quando o banco compensa.
// ---------------------------------------------------------------------------
async function gerarBoleto({ acc, valueCents, description, correlationID }) {
  const cfg = cardCfg();
  if (!methods().boleto) throw erro('Boleto indisponível. O administrador ainda não habilitou esse meio');
  const doc = String((acc.billing && acc.billing.taxId) || '').replace(/\D/g, '');
  const r = await cards.driver(cfg).boleto({
    cfg: cards.creds(cfg),
    valueCents,
    customer: { name: acc.name, email: acc.email, taxId: doc },
    description, correlationID,
    dueDays: methods().boletoDueDays
  });
  return {
    correlationID, amount: valueCents,
    gatewayId: r.gatewayId || '',
    boletoUrl: r.url || '', boletoLine: r.line || '', boletoBarcode: r.barcode || '',
    dueDate: r.dueDate || 0, ts: Date.now()
  };
}

// Assinar o plano no boleto: fica pendente até compensar.
async function subscribeBoleto(acc, plan, body, broadcast) {
  const total = limits.chargeTotal(acc, plan);
  const cid = `bol-sub-${acc.id}-${plan.id}-${Date.now().toString(36)}`;
  if (body && body.taxId) acc.billing.taxId = String(body.taxId).replace(/\D/g, '');

  const b = await gerarBoleto({
    acc, valueCents: total, correlationID: cid,
    description: `Koonfy: assinatura ${plan.name}`
  });
  acc.billing.method = 'boleto';
  acc.billing.pendingCharge = { ...b, kind: 'sub', via: 'boleto', planId: plan.id };
  // boleto não debita sozinho: a recorrência Pix sairia por cima
  if (acc.billing.wooviSubId) {
    try { require('./woovi').cancelSubscription(acc.billing.wooviSubId); } catch {}
    acc.billing.wooviSubId = ''; acc.billing.subCorrelationID = ''; acc.billing.subValue = 0;
  }
  db.save();
  store.logEvent({ type: 'saas_boleto_issued', accountId: acc.id, planId: plan.id, value: total });
  if (broadcast) broadcast('billing', { accountId: acc.id });
  return { ok: true, boleto: true, charge: acc.billing.pendingCharge };
}

// Consulta o boleto pendente no adquirente e aplica o pagamento se compensou.
async function checkBoleto(acc, broadcast) {
  const pc = acc.billing.pendingCharge;
  if (!pc || !pc.gatewayId) return { paid: false, none: !pc };
  const cfg = cardCfg();
  const r = await cards.driver(cfg).getCharge({ cfg: cards.creds(cfg), gatewayId: pc.gatewayId });
  if (r && r.status === 'paid') {
    require('./woovi').applyPayment({ correlationID: pc.correlationID, value: pc.amount }, broadcast);
    return { paid: true };
  }
  return { paid: false, status: r && r.status };
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
    // Conexão extra e link rastreável são cobrança do KOONFY, e passam pelo
    // adquirente escolhido em Admin → Gateways — não mais fixo na Woovi.
    const cid = `xtr-${acc.id}-${key}-${n}-${Date.now().toString(36)}`;
    const charge = await require('./saaspix').criarCobranca(acc, {
      correlationID: cid, valueCents: total,
      comment: `Koonfy: ${n}x ${limits.LABEL[key]}`
    });
    acc.billing.pendingCharge = {
      correlationID: cid, kind: 'extra', via: 'pix', planId: acc.billing.planId, amount: total,
      extraKey: key, extraQty: n,
      brCode: charge.brCode || '', qrCodeImage: charge.qrCodeImage || '',
      paymentLinkUrl: charge.paymentLinkUrl || '', ts: Date.now()
    };
    db.save();
    return { ok: true, pix: true, charge: acc.billing.pendingCharge };
  }

  // ---- Boleto: também assíncrono, libera quando o banco compensa. ----
  if (body.pay === 'boleto') {
    const cid = `xtr-${acc.id}-${key}-${n}-${Date.now().toString(36)}`;
    if (body.taxId) acc.billing.taxId = String(body.taxId).replace(/\D/g, '');
    const b = await gerarBoleto({
      acc, valueCents: total, correlationID: cid,
      description: `Koonfy: ${n}x ${limits.LABEL[key]}`
    });
    acc.billing.pendingCharge = {
      ...b, kind: 'extra', via: 'boleto', planId: acc.billing.planId,
      extraKey: key, extraQty: n
    };
    db.save();
    return { ok: true, boleto: true, charge: acc.billing.pendingCharge };
  }

  const cid = `${body.pay === 'wallet' ? 'wallet' : 'card'}-extra-${acc.id}-${key}-${Date.now().toString(36)}`;

  // Pode pagar com o SALDO da carteira (dinheiro das vendas no cartão) ou
  // lançar direto num cartão novo.
  let r = { gatewayId: '' };
  if (body.pay === 'wallet') {
    require('./elitepay').spendWallet(acc, total, `${n}x ${limits.LABEL[key]}`, broadcast);
  } else {
    r = await charge({
      acc, valueCents: total, body,
      description: `Koonfy: ${n}x ${limits.LABEL[key]}`,
      correlationID: cid
    });
    // comprou um extra no cartão: guarda para a próxima compra já vir pronta
    guardarCartao(acc, r, body);
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

  try {
    const r = await cards.driver(cfg).charge({
      cfg: cards.creds(cfg),
      valueCents: total,
      installments: 1,
      card: { token: b.card.token },        // sem PAN: o adquirente resolve pelo token
      holder: {},
      customer: { name: acc.name, email: acc.email },
      description: `Koonfy: renovação ${plan.name}`,
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
    // Quem está no Pix sem recorrência ativa vê de onde saiu o dinheiro: o
    // extrato precisa explicar um débito que a pessoa não agendou.
    const socorro = acc.billing.method === 'pix' && !acc.billing.wooviSubId;
    const rotulo = socorro
      ? `Renovação ${plan.name} pelo saldo (Pix Automático não ativado)`
      : `Renovação ${plan.name}`;
    require('./elitepay').spendWallet(acc, total, rotulo, broadcast);
    require('./woovi').applyPayment({ correlationID: cid, value: total }, broadcast);
    store.logEvent({ type: 'saas_wallet_renewed', accountId: acc.id, value: total, fallbackPix: socorro });
    return { ok: true, amount: total };
  } catch (e) {
    acc.billing.status = 'past_due';
    db.save();
    store.logEvent({ type: 'saas_wallet_renew_failed', accountId: acc.id, error: e.message });
    if (broadcast) broadcast('billing', { accountId: acc.id });
    return { ok: false, reason: e.message };
  }
}

// ---------------------------------------------------------------------------
// RENOVAÇÃO por BOLETO. Boleto não debita sozinho, então o que dá para
// automatizar é a emissão: alguns dias antes do vencimento o próximo boleto é
// gerado e fica pendente para o cliente pagar. Se não pagar, o gate de envio
// trata o vencimento normalmente.
// ---------------------------------------------------------------------------
async function renewBoleto(acc, broadcast) {
  const plan = limits.planOf(acc);
  if (!plan) return { ok: false, reason: 'sem plano' };
  if (acc.billing.pendingCharge) return { ok: true, reason: 'boleto já emitido' };

  const total = limits.chargeTotal(acc, plan);
  const cid = `bol-ren-${acc.id}-${plan.id}-${Date.now().toString(36)}`;
  try {
    const b = await gerarBoleto({
      acc, valueCents: total, correlationID: cid,
      description: `Koonfy: renovação ${plan.name}`
    });
    acc.billing.pendingCharge = { ...b, kind: 'sub', planId: plan.id, via: 'boleto' };
    db.save();
    store.logEvent({ type: 'saas_boleto_renewal_issued', accountId: acc.id, value: total });
    if (broadcast) broadcast('billing', { accountId: acc.id });
    return { ok: true, amount: total };
  } catch (e) {
    store.logEvent({ type: 'saas_boleto_renewal_failed', accountId: acc.id, error: e.message });
    return { ok: false, reason: e.message };
  }
}

// Varre as contas e renova as que vencem em breve.
// Cartão e saldo são cobrados aqui; o boleto da renovação é emitido com
// antecedência (o prazo de vencimento + 2 dias de folga); o Pix Automático é
// renovado pela própria Woovi (a recorrência gera a cobrança e o webhook confirma).
async function runRenewals(broadcast) {
  const agora = Date.now();
  const limite = agora + 86400000;
  const ativa = a => a.billing && a.billing.status === 'active' && a.billing.periodEnd;
  const vencendo = a => ativa(a) && a.billing.periodEnd <= limite;

  const noCartao = available()
    ? db.get().accounts.filter(a => vencendo(a) &&
        a.billing.method === 'credit' && a.billing.card && a.billing.card.token)
    : [];
  // Carteira: quem escolheu pagar pelo saldo, MAIS quem está no Pix e nunca
  // ativou o Pix Automático. Este segundo grupo não renovava por nada: não
  // entra em cartão, nem em boleto, e a recorrência da Woovi que renovaria não
  // existe sem `wooviSubId`. A assinatura simplesmente vencia com o dinheiro
  // parado na carteira. Só entra quem TEM saldo suficiente — sem isso o débito
  // falharia e a conta cairia em `past_due` antes da hora, tirando o acesso de
  // quem ainda podia pagar de outro jeito.
  const semPixAutomatico = a => a.billing.method === 'pix' && !a.billing.wooviSubId;
  const temSaldo = a => {
    const plan = limits.planOf(a);
    return plan && a.wallet && a.wallet.balance >= limits.chargeTotal(a, plan);
  };
  const naCarteira = db.get().accounts.filter(a => vencendo(a) &&
    (a.billing.method === 'wallet' || (semPixAutomatico(a) && temSaldo(a))));

  // boleto precisa de tempo para o cliente pagar e o banco compensar
  const folga = (methods().boletoDueDays + 2) * 86400000;
  const noBoleto = methods().boleto
    ? db.get().accounts.filter(a => ativa(a) && a.billing.method === 'boleto' &&
        a.billing.periodEnd <= agora + folga && !a.billing.pendingCharge)
    : [];

  let ok = 0, fail = 0;
  for (const acc of noCartao) { (await renew(acc, broadcast)).ok ? ok++ : fail++; }
  for (const acc of naCarteira) { renewWallet(acc, broadcast).ok ? ok++ : fail++; }
  for (const acc of noBoleto) { (await renewBoleto(acc, broadcast)).ok ? ok++ : fail++; }

  const total = noCartao.length + naCarteira.length + noBoleto.length;
  if (total) {
    store.logEvent({
      type: 'saas_renew_batch', total, ok, fail,
      cartao: noCartao.length, carteira: naCarteira.length, boleto: noBoleto.length
    });
  }
  return { total, ok, fail };
}

// ---------------------------------------------------------------------------
// CANCELAMENTO DE CONEXÃO EXTRA.
//
// Cancelar não desliga na hora: o cliente já pagou o ciclo, então a conexão
// continua funcionando até o vencimento. Quando a data chega, o canal é apagado
// junto com tudo que é dele e a unidade extra sai da cobrança — é o que o
// cliente confirmou ao cancelar, e está escrito no aviso.
// ---------------------------------------------------------------------------
function agendarCancelamento(acc, ch) {
  const fim = Math.max(Date.now(), Number(acc.billing.periodEnd) || 0);
  ch.canceledAt = Date.now();
  ch.cancelAt = fim;
  db.save();
  store.logEvent({ type: 'channel_cancel_scheduled', accountId: acc.id, channelId: ch.id, at: fim });
  return ch;
}

function desfazerCancelamento(acc, ch) {
  ch.canceledAt = 0;
  ch.cancelAt = 0;
  db.save();
  store.logEvent({ type: 'channel_cancel_undone', accountId: acc.id, channelId: ch.id });
  return ch;
}

// Varre os cancelamentos vencidos e executa a exclusão.
async function runChannelCancellations(broadcast) {
  const agora = Date.now();
  let apagados = 0;
  for (const acc of db.get().accounts) {
    const vencidos = (acc.channels || []).filter((c, i) => i > 0 && c.cancelAt && c.cancelAt <= agora);
    for (const ch of vencidos) {
      // solta o número na Meta antes de sumir com o canal
      try {
        const w = ch.wa || {};
        if (w.wabaId && w.accessToken) await require('./meta').unsubscribeApp(w.accessToken, w.wabaId);
      } catch {}
      const removido = store.purgeChannel(acc, ch.id);
      // a unidade deixa de ser cobrada a partir da próxima renovação
      const atual = Number(acc.billing.extras.whatsapps) || 0;
      if (atual > 0) acc.billing.extras.whatsapps = atual - 1;
      db.save();
      require('./woovi').syncSubscription(acc, 'cancelamento de conexão').catch(() => {});
      store.logEvent({
        type: 'channel_purged', accountId: acc.id, channelId: ch.id,
        label: ch.label, ...removido
      });
      if (broadcast) {
        broadcast('channels', { accountId: acc.id });
        broadcast('billing', { accountId: acc.id });
      }
      apagados++;
    }
  }
  if (apagados) store.logEvent({ type: 'channel_purge_batch', total: apagados });
  return { apagados };
}

// Tick diário (com uma primeira passada 1min após subir o servidor).
function startRenewalJob(broadcast) {
  const tick = async () => {
    try { await runRenewals(broadcast); }
    catch (e) { store.logEvent({ type: 'saas_renew_error', error: e.message }); }
    try { await runChannelCancellations(broadcast); }
    catch (e) { store.logEvent({ type: 'channel_purge_error', error: e.message }); }
  };
  setTimeout(tick, 60000);
  setInterval(tick, 24 * 3600 * 1000);
}

module.exports = {
  available, methods, charge, guardarCartao, subscribe, subscribeWallet, subscribeBoleto,
  gerarBoleto, checkBoleto, buyExtra,
  renew, renewWallet, renewBoleto, runRenewals, startRenewalJob,
  agendarCancelamento, desfazerCancelamento, runChannelCancellations
};
