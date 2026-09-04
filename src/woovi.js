// Integração Woovi (OpenPix) — pagamentos Pix e Pix Automático.
// Docs: https://developers.woovi.com/docs/intro/getting-started
// Autenticação: header Authorization com o AppID gerado em app.woovi.com.
// Métodos habilitados: apenas PIX (cobrança avulsa) e PIX AUTOMÁTICO (assinatura).
const db = require('./db');
const store = require('./store');

// Produção e testes são contas SEPARADAS na Woovi, cada uma com o seu AppID:
// app.woovi.com e app.woovi-sandbox.com. Um AppID de testes enviado para a API
// de produção só devolve 401, sem dizer o motivo — daí o ambiente ser uma
// escolha explícita aqui, e não algo deduzido do formato do AppID.
const BASES = { producao: 'https://api.woovi.com', testes: 'https://api.woovi-sandbox.com' };

function cfg() { return db.get().platform.woovi || {}; }
function ambiente() { return cfg().sandbox ? 'testes' : 'produção'; }
function base() { return cfg().sandbox ? BASES.testes : BASES.producao; }

function appId() { return (cfg().appId || '').trim(); }
function configured() { return !!appId(); }

// Chamada genérica à API da Woovi
async function call(method, path, body) {
  if (!configured()) {
    const e = new Error('Woovi não configurada, informe o AppID no painel Admin → Pagamentos');
    e.status = 400; throw e;
  }
  const r = await fetch(base() + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: appId() },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) {
    // 401 aqui quase sempre é AppID do ambiente errado, não AppID inválido: a
    // mensagem antiga ("Woovi HTTP 401") mandava o admin procurar no lugar
    // errado. Diz em qual ambiente a chamada saiu e onde gerar o par certo.
    let msg = data.error || data.message || `Woovi HTTP ${r.status}`;
    if (r.status === 401) {
      msg = 'A Woovi recusou o AppID no ambiente de ' + ambiente() + '. ' +
        (cfg().sandbox
          ? 'Gere o AppID em app.woovi-sandbox.com (a conta de testes é separada da de produção).'
          : 'Se o AppID veio de app.woovi-sandbox.com, marque "ambiente de testes" aqui; ' +
            'o AppID de produção é gerado em app.woovi.com.');
    }
    const e = new Error(msg);
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
// PARA QUEM É O DINHEIRO — os dois casos que passam por aqui:
//
//   • O KOONFY COBRANDO O CLIENTE (plano, recarga automática). O dinheiro é da
//     plataforma inteiro: sem subconta, sem split.
//   • O CLIENTE COBRANDO OS CLIENTES DELE (produto de assinatura no checkout).
//     O dinheiro é dele e vai para a subconta dele; a taxa da plataforma sai
//     por split — exatamente como já acontece na cobrança avulsa.
//
// São os mesmos dois campos que `createCharge` já usa, e é por isso que têm os
// mesmos nomes aqui.
//
// SUPOSIÇÃO NÃO CONFIRMADA, e vale ler antes de ligar isto para clientes de
// verdade: a documentação da Woovi descreve `subaccount`/`splits` na rota de
// COBRANÇA. Que a rota de ASSINATURA aceite os mesmos campos é o esperado e é
// o que este código faz — mas não foi verificado contra a API. Se a Woovi
// ignorar os campos em silêncio, o dinheiro da recorrência cai na conta da
// PLATAFORMA em vez da subconta do cliente, e nada levanta erro. Conferir uma
// recorrência de ponta a ponta na sandbox e olhar ONDE o dinheiro caiu.
// `assinaturas.js` guarda a `subPixKey` de cada assinatura para essa
// conferência ser possível depois.
async function createSubscription({ correlationID, value, customer, comment, subPixKey, splits, diaDoCiclo }) {
  const today = new Date().getDate();
  const body = {
    value,
    customer,
    correlationID,
    comment: comment || '',
    // A Woovi só aceita 1..28, e com razão: fevereiro não tem 29 todo ano, e
    // uma recorrência marcada no 31 ficaria sem data em metade dos meses.
    dayGenerateCharge: Math.min(28, Math.max(1, Number(diaDoCiclo) || today)),
    frequency: 'MONTHLY',
    chargeType: 'DYNAMIC'
  };
  if (subPixKey) body.subaccount = subPixKey;
  if (splits && splits.length) body.splits = splits;
  const d = await call('POST', '/api/v1/subscriptions', body);
  return d.subscription || d;
}

async function cancelSubscription(id) {
  // A Woovi cancela desativando a assinatura pelo globalID
  try { return await call('DELETE', '/api/v1/subscriptions/' + encodeURIComponent(id)); }
  catch (e) { return { error: e.message }; }
}

// ---- Manter a recorrência valendo o que a conta realmente custa hoje ----
// Comprar (ou perder) uma conexão extra muda o valor mensal. A assinatura da
// Woovi guarda um valor fixo, então quem já paga por Pix Automático precisa ter
// a assinatura refeita — senão o extra é cobrado uma vez e nunca mais.
// A API não expõe edição de valor: cancelamos e recriamos com o total novo.
async function syncSubscription(acc, motivo) {
  const b = acc.billing || {};
  if (!b.wooviSubId || !configured()) return { skipped: true };
  const limits = require('./limits');
  const plan = limits.planOf(acc);
  if (!plan) return { skipped: true };

  const total = limits.chargeTotal(acc, plan);
  if (total === b.subValue) return { skipped: true, reason: 'valor igual' };

  const cid = `sub-${acc.id}-${plan.id}-${Date.now().toString(36)}`;
  try {
    await cancelSubscription(b.wooviSubId);
    const sub = await createSubscription({
      correlationID: cid, value: total,
      customer: { name: acc.name, email: acc.email },
      comment: `Koonfy: ${plan.name} (mensal)`
    });
    b.wooviSubId = sub.globalID || sub.id || '';
    b.subCorrelationID = cid;
    b.subValue = total;
    db.save();
    store.logEvent({ type: 'woovi_sub_synced', accountId: acc.id, value: total, motivo: motivo || '' });
    return { ok: true, value: total };
  } catch (e) {
    // A recorrência antiga já foi cancelada: sem valor gravado, a próxima
    // varredura tenta de novo em vez de deixar a conta cobrando o valor errado.
    b.wooviSubId = ''; b.subCorrelationID = ''; b.subValue = 0;
    db.save();
    store.logEvent({ type: 'woovi_sub_sync_failed', accountId: acc.id, error: e.message });
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// COMISSÃO DE AFILIADO — a regra, num lugar só
//
// Ela morava DENTRO do ramo que ativa assinatura, dentro de `applyPayment`. E
// isso escondeu um defeito caro: o pagamento de um cadastro NOVO chega com
// correlationID `nov-`, que `applyPayment` desvia para
// `preassinatura.confirmar` na primeira linha e retorna ali mesmo — sem nunca
// alcançar este trecho.
//
// O efeito era parcial, que é o pior tipo: a conta nascia certa, o `refBy` era
// gravado, a receita entrava no relatório. Só a comissão da PRIMEIRA venda — a
// maior, 30% — sumia. As renovações pagavam normal, porque passam por
// `applyPayment` inteiro. Quem indicou via o indicado aparecer e o dinheiro
// não.
//
// Como função, os dois caminhos chamam a mesma coisa, e o próximo caminho de
// pagamento que aparecer também chama em vez de esquecer de copiar.
function pagarComissao(acc, valorPago, kind, broadcast) {
  const data = db.get();
  const refCode = acc.affiliate && acc.affiliate.refBy;
  if (!refCode) return { ok: false, motivo: 'sem indicação' };

  const aff = db.findAccountByRefCode(refCode);
  // Indicar a si mesmo não paga. O antiabuso já retém o caso disfarçado (mesmo
  // IP, mesmo documento); esta linha cobre o descarado.
  if (!aff || aff.id === acc.id) return { ok: false, motivo: 'afiliado inválido' };

  const cfg = data.platform.affiliate || {};
  const pct = kind === 'first' ? (cfg.percentFirst || 0) : (cfg.percentRenewal || 0);
  const cut = Math.floor(valorPago * pct / 100);
  if (cut <= 0) return { ok: false, motivo: 'percentual zero' };

  // COMISSÃO RETIDA não é paga. Quando quem indicou e quem foi indicado
  // dividem IP, CPF/CNPJ ou WhatsApp, o dinheiro espera alguém olhar — ver
  // src/antiabuso.js.
  //
  // Reter e conferir custa uma espera; pagar e descobrir depois custa pedir
  // dinheiro de volta, que quase nunca volta. O evento fica no log para o valor
  // não sumir da história.
  if (!require('./antiabuso').comissaoLiberada(acc)) {
    // GUARDA O VALOR, não só o fato. Antes ficava só o registro no log: o
    // admin liberava a conta e a comissão da PRIMEIRA venda — a maior, 30% —
    // nunca era paga, porque este `return` já tinha acontecido e ninguém
    // voltava para ele. Só as renovações seguintes entravam. Numa operação
    // que vive de afiliado isso é o pior defeito possível: silencioso, e
    // sempre contra quem trouxe a venda.
    //
    // Com o valor guardado aqui, `pagarPendentes` paga tudo no momento em que
    // alguém libera. A retenção passa a ser uma ESPERA, não uma perda.
    const r = acc.affiliate.comissaoRetida;
    if (!Array.isArray(r.pendentes)) r.pendentes = [];
    r.pendentes.push({ valor: cut, kind, pct, ts: Date.now() });
    db.save();
    store.logEvent({ type: 'comissao_retida', accountId: acc.id, afiliado: aff.id, valor: cut, kind });
    return { ok: false, motivo: 'retida', valor: cut };
  }

  aff.wallet.balance += cut;
  aff.affiliate.earned += cut;
  aff.wallet.transactions.push({
    id: db.genId('tx'), ts: Date.now(), amount: cut, type: 'commission',
    label: `Comissão ${pct}%, ${kind === 'first' ? 'nova assinatura' : 'renovação'} (${acc.name})`
  });
  // Notificação nos aparelhos do afiliado. O SSE abaixo só chega em quem está
  // com o app aberto naquele instante; a comissão cai a qualquer hora do dia.
  try { require('./avisos').avisarComissao(aff, { amount: cut, percent: pct, kind, indicado: acc.name }); } catch {}
  if (broadcast) {
    broadcast('wallet', { accountId: aff.id });
    // Venda do indicado aprovada: o afiliado é avisado na hora, com o valor que
    // entrou. Vale para assinatura nova e para renovação.
    broadcast('commission', { accountId: aff.id, amount: cut, percent: pct, kind, indicado: acc.name });
  }
  store.logEvent({ type: 'comissao_paga', accountId: acc.id, afiliado: aff.id, valor: cut, kind });
  return { ok: true, valor: cut, afiliado: aff.id };
}

// PAGA O QUE FICOU ESPERANDO. Chamada quando o admin libera uma conta retida
// (ver src/antiabuso.js → liberar). Paga cada comissão que ficou na espera, com
// o percentual que valia NA ÉPOCA — se a plataforma mudou de 30% para 20% no
// meio da revisão, quem trouxe a venda não pode perder por causa da demora de
// quem revisa.
//
// A lista é esvaziada ao pagar: liberar duas vezes não paga duas vezes.
function pagarPendentes(acc, broadcast) {
  const r = acc && acc.affiliate && acc.affiliate.comissaoRetida;
  if (!r || !Array.isArray(r.pendentes) || !r.pendentes.length) return { ok: true, pagas: 0, total: 0 };

  const aff = db.findAccountByRefCode(acc.affiliate.refBy || '');
  if (!aff || aff.id === acc.id) { r.pendentes = []; db.save(); return { ok: false, motivo: 'afiliado inválido' }; }

  const fila = r.pendentes;
  r.pendentes = [];                     // esvazia ANTES de creditar: nada é pago duas vezes
  let total = 0;
  for (const item of fila) {
    const cut = Number(item.valor) || 0;
    if (cut <= 0) continue;
    aff.wallet.balance += cut;
    aff.affiliate.earned += cut;
    aff.wallet.transactions.push({
      id: db.genId('tx'), ts: Date.now(), amount: cut, type: 'commission',
      label: `Comissão ${item.pct}%, ${item.kind === 'first' ? 'nova assinatura' : 'renovação'} (${acc.name}) · liberada na revisão`
    });
    total += cut;
    store.logEvent({ type: 'comissao_liberada_paga', accountId: acc.id, afiliado: aff.id, valor: cut, kind: item.kind });
  }
  db.save();
  if (total) {
    try { require('./avisos').avisarComissao(aff, { amount: total, percent: 0, kind: 'first', indicado: acc.name }); } catch {}
    if (broadcast) {
      broadcast('wallet', { accountId: aff.id });
      broadcast('commission', { accountId: aff.id, amount: total, kind: 'first', indicado: acc.name });
    }
  }
  return { ok: true, pagas: fila.length, total, afiliado: aff.id };
}

// ============ Processamento de pagamento confirmado ============
// Chamado pelo webhook (após verificação server-side) e pelo polling do painel.
// Formatos de correlationID que chegam aqui (separador "-" porque os IDs
// internos usam "_"):
//
//   sub-<conta>-<plano>-<r>            assinatura paga no Pix
//   topup-<conta>-<r>                  recarga da carteira
//   xtr-<conta>-<recurso>-<qtd>-<r>    unidade extra paga no Pix
//   card-sub-<conta>-<plano>-<r>       assinatura no cartão de crédito
//   card-ren-<conta>-<plano>-<r>       renovação no cartão de crédito
//   wallet-sub-<conta>-<plano>-<r>     assinatura pelo saldo
//   wallet-ren-<conta>-<plano>-<r>     renovação pelo saldo
//   bol-sub-<conta>-<plano>-<r>        assinatura no boleto
//   bol-ren-<conta>-<plano>-<r>        renovação no boleto
//   (qualquer outro)                   renovação gerada pela recorrência Woovi
function applyPayment(charge, broadcast) {
  const data = db.get();
  const cid = charge.correlationID || '';
  const paid = Number(charge.value) || 0;
  if (data.revenue.some(r => r.chargeId === cid && r.chargeId)) return { ok: true, duplicate: true };

  // COMPRA SEM CONTA: quem paga antes de se cadastrar não tem conta para
  // achar aqui — a conta nasce da confirmação, no módulo da pré-assinatura.
  if (cid.startsWith('nov-')) return require('./preassinatura').confirmar(cid, paid, broadcast);

  let acc = null, kind = '', planId = '', extraKey = '', extraQty = 0;
  // Cartão, saldo e boleto pagam com prefixo próprio. Sem tratar esses
  // prefixos, a cobrança era aprovada mas a assinatura nunca ativava.
  const meio = /^(card|wallet|bol)-(sub|ren)-(.+)$/.exec(cid);
  if (meio) {
    const parts = meio[3].split('-');
    acc = db.findAccount(parts[0]);
    kind = meio[2] === 'sub' ? 'first' : 'renewal';
    planId = parts[1] || '';
  } else if (cid.startsWith('xtr-')) {
    // unidade extra paga no Pix: xtr-<contaId>-<recurso>-<qtd>-<aleatório>
    const parts = cid.split('-');
    acc = db.findAccount(parts[1]);
    kind = 'extra';
    extraKey = parts[2] || '';
    extraQty = Math.max(0, Number(parts[3]) || 0);
  } else if (cid.startsWith('sub-') || cid.startsWith('topup-')) {
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
  } else if (kind === 'extra') {
    // Libera as unidades na hora e coloca o valor dentro da recorrência: a
    // partir daqui o extra é cobrado todo mês junto com o plano.
    const limits = require('./limits');
    acc.billing.extras[extraKey] = (Number(acc.billing.extras[extraKey]) || 0) + extraQty;
    acc.billing.pendingCharge = null;
    db.save();
    syncSubscription(acc, 'extra pago no Pix').catch(() => {});
    store.logEvent({ type: 'saas_extra_paid', accountId: acc.id, key: extraKey, qty: extraQty, value: paid, via: 'pix' });
    data.revenue.push({ ts: Date.now(), accountId: acc.id, planId: acc.billing.planId, amount: paid, kind: 'extra', chargeId: cid,
      metodo: require('./saaspix').metodoDeCid(cid, acc) });
    db.save();
    if (broadcast) { broadcast('billing', { accountId: acc.id }); broadcast('channels', { accountId: acc.id }); }
    return { ok: true, kind, accountId: acc.id, key: extraKey, qty: limits.limitOf(acc, extraKey) };
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

    // Assinou: a conta de Pagamentos é criada com os dados do cadastro, sem
    // formulário nenhum. Não trava a ativação se o gateway estiver fora.
    try { require('./pagamentos').garantirPagamentos(acc).catch(() => {}); } catch {}

    pagarComissao(acc, paid, kind, broadcast);
  }

  // O MÉTODO É GRAVADO NA HORA. Deduzir depois pelo prefixo continua
  // funcionando (é o mesmo cálculo), mas o registro histórico não muda quando a
  // conta troca de forma de pagamento — e é o histórico que o painel soma.
  data.revenue.push({ ts: Date.now(), accountId: acc.id, planId, amount: paid, kind, chargeId: cid,
    metodo: require('./saaspix').metodoDeCid(cid, acc) });
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

      // KYC/BaaS: conta do cliente aprovada pela compliance → ativa o Pagamentos.
      if (/ACCOUNT_REGISTER_APPROVED/i.test(ev)) {
        const acct = b.account || (b.data && b.data.account) || b.data || b;
        require('./pagamentos').applyAccountApproved(acct, broadcast);
        return;
      }

      if (!/CHARGE_COMPLETED|TRANSACTION_RECEIVED/i.test(ev) || !charge || !charge.correlationID) return;
      if (!configured()) return;
      const fresh = await getCharge(charge.correlationID); // verificação server-side
      if (fresh && /COMPLETED|CONFIRMED|PAID/i.test(fresh.status || '')) {
        // Cobranças do PAGAMENTOS (correlationID "ep-...") são de subcontas dos
        // clientes — vão para o módulo próprio; as demais são do billing SaaS.
        const pagamentos = require('./pagamentos');
        // O CICLO DE UMA ASSINATURA DE CLIENTE não é reconhecível pelo
        // correlationID: quem o gerou foi a Woovi, com um id que o Koonfy
        // nunca viu. Ele é casado pela ASSINATURA que o produziu, e por isso
        // esta pergunta vem ANTES das outras duas — sem ela o ciclo cairia no
        // ramo do billing SaaS, que procuraria uma conta pelo prefixo, não
        // acharia, e registraria "unmatched". A venda mensal do cliente
        // sumiria em silêncio, mês após mês.
        //
        // `fresh` vem do GET da cobrança e pode não trazer o vínculo com a
        // assinatura; o corpo do webhook traz. Os dois são consultados.
        const assinaturas = require('./assinaturas');
        const comVinculo = assinaturas.correlacaoDaAssinatura(fresh)
          ? fresh
          : { ...fresh, subscription: charge.subscription, subscriptionCorrelationID: charge.subscriptionCorrelationID };
        if (assinaturas.ehCicloDeAssinatura(comVinculo)) assinaturas.aoPagarCiclo(comVinculo, broadcast);
        else if (pagamentos.isPagamentosCharge(fresh.correlationID)) pagamentos.applyPaid(fresh, broadcast);
        else applyPayment(fresh, broadcast);
      }
    } catch (e) {
      store.logEvent({ type: 'woovi_webhook_error', error: e.message });
    }
  };
}

module.exports = {
  configured, ambiente, base, call, createCharge, getCharge, deleteCharge,
  createSubscription, cancelSubscription, syncSubscription, applyPayment, pagarComissao, pagarPendentes, webhookHandler
};
