// ============================================================================
// RECARGA DA CARTEIRA — avulsa e automática
//
// A carteira paga assinatura, conexões extras e disparos. Ficar sem saldo no
// meio de uma campanha é o pior momento possível, então além do depósito
// avulso existe a RECARGA AUTOMÁTICA: quando o saldo cruza um piso, o sistema
// recarrega sozinho.
//
// São dois meios, e eles funcionam de formas diferentes:
//
//   • PIX  → assinatura na Woovi (Pix Automático). Quem autoriza é o cliente,
//            uma vez, no banco dele; a Woovi cobra sozinha a cada ciclo e o
//            crédito cai pelo webhook, no mesmo caminho de qualquer Pix.
//   • CARTÃO → o cartão salvo da fatura, cobrado como uma assinatura. Aqui a
//            cobrança é síncrona: aprovou, o saldo entra na hora.
//
// O disparo do cartão é feito por `checarSaldo`, chamado depois de todo gasto.
// ============================================================================

const db = require('./db');
const woovi = require('./woovi');
const elitepay = require('./elitepay');

function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

function faixa() { return db.get().platform.billing.deposit; }

// Valida o valor contra a faixa que o admin definiu no Admin SaaS.
function validarValor(cents) {
  const d = faixa();
  const v = Math.round(Number(cents) || 0);
  if (!v || v < 0) throw erro('Informe um valor');
  if (v < d.min) throw erro(`Depósito mínimo: ${elitepay.fmtBRL(d.min)}`);
  if (d.max > 0 && v > d.max) throw erro(`Depósito máximo: ${elitepay.fmtBRL(d.max)}`);
  return v;
}

// ---------------------------------------------------------------------------
// Recarga avulsa no CARTÃO.
//
// Diferente do Pix, não há espera: o adquirente responde na hora, então o
// saldo entra na mesma requisição. Reaproveita o `charge` da assinatura, que
// já sabe cobrar tanto um cartão novo quanto o cartão salvo (`useSaved`).
// ---------------------------------------------------------------------------
async function recargaCartao(acc, cents, body, broadcast) {
  const valor = validarValor(cents);
  const saas = require('./saasbilling');
  const cid = `topup-card-${acc.id}-${Date.now().toString(36)}`;

  const r = await saas.charge({
    acc, valueCents: valor, body,
    description: 'Koonfy: recarga de saldo',
    correlationID: cid
  });

  // recarregou com cartão novo? guarda, para a próxima já vir em um clique
  saas.guardarCartao(acc, r, body);
  creditar(acc, valor, 'Recarga no cartão', cid, broadcast);
  return { ok: true, amount: valor, balance: acc.wallet.balance, brand: r.brand, last4: r.last4 };
}

// Credita o saldo e registra no extrato. É o mesmo efeito que o webhook do Pix
// produz — mantido aqui em um lugar só para os dois caminhos não divergirem.
function creditar(acc, valor, label, cid, broadcast) {
  const w = acc.wallet;
  w.balance += valor;
  w.transactions.push({ id: db.genId('tx'), ts: Date.now(), amount: valor, type: 'topup', label });
  db.get().revenue.push({
    ts: Date.now(), accountId: acc.id, planId: acc.billing.planId || '',
    amount: valor, kind: 'topup', chargeId: cid
  });
  db.save();
  if (broadcast) broadcast('wallet', { accountId: acc.id });
}

// ---------------------------------------------------------------------------
// LIGAR/DESLIGAR a recarga automática.
//
// No Pix, ligar significa criar a assinatura na Woovi e devolver ao cliente o
// QR/link em que ele autoriza o débito automático no banco. No cartão não há
// nada a autorizar: o cartão já está salvo, então basta guardar a regra.
// ---------------------------------------------------------------------------
async function configurarAuto(acc, cfg, broadcast) {
  const a = acc.wallet.autoTopup;
  const ligar = !!cfg.enabled;

  if (!ligar) {
    // desligou: derruba a assinatura da Woovi, se existir
    if (a.wooviSubId) { try { await woovi.cancelSubscription(a.wooviSubId); } catch {} }
    Object.assign(a, { enabled: false, wooviSubId: '', lastError: '' });
    db.save();
    if (broadcast) broadcast('wallet', { accountId: acc.id });
    return { autoTopup: publico(acc) };
  }

  const metodo = cfg.method === 'card' ? 'card' : 'pix';
  const valor = validarValor(cfg.amount);
  const piso = Math.max(0, Math.round(Number(cfg.threshold) || 0));
  if (piso >= valor) throw erro('O piso precisa ser menor que o valor da recarga, senão ela se repetiria sem parar');

  if (metodo === 'card' && !(acc.billing.card && acc.billing.card.token)) {
    throw erro('Nenhum cartão salvo. Pague uma vez no cartão para guardá-lo e depois ligue a recarga automática.');
  }

  let sub = null;
  if (metodo === 'pix') {
    if (!woovi.configured()) throw erro('Pix indisponível no momento');
    // Trocar de valor/meio significa outra assinatura: a Woovi guarda o valor
    // fixo, então a antiga é cancelada antes de nascer a nova.
    if (a.wooviSubId) { try { await woovi.cancelSubscription(a.wooviSubId); } catch {} }
    const cid = `topup-${acc.id}-auto-${Date.now().toString(36)}`;
    sub = await woovi.createSubscription({
      correlationID: cid, value: valor,
      customer: { name: acc.name, email: acc.email },
      comment: 'Koonfy: recarga automática de saldo'
    });
  } else if (a.wooviSubId) {
    // saiu do Pix para o cartão: a recorrência antiga não deve continuar
    try { await woovi.cancelSubscription(a.wooviSubId); } catch {}
  }

  Object.assign(a, {
    enabled: true, method: metodo, amount: valor, threshold: piso,
    wooviSubId: metodo === 'pix' ? ((sub && (sub.globalID || sub.id)) || '') : '',
    lastError: ''
  });
  db.save();
  if (broadcast) broadcast('wallet', { accountId: acc.id });
  return { autoTopup: publico(acc), subscription: sub || null };
}

// O que a tela precisa saber. O id da assinatura fica no servidor.
function publico(acc) {
  const a = acc.wallet.autoTopup;
  return {
    enabled: !!a.enabled, method: a.method, threshold: a.threshold, amount: a.amount,
    ativa: !!(a.enabled && (a.method === 'card' || a.wooviSubId)),
    lastRunAt: a.lastRunAt || 0, lastError: a.lastError || ''
  };
}

// ---------------------------------------------------------------------------
// GATILHO: chamado depois de todo gasto na carteira.
//
// Só o CARTÃO recarrega por aqui — é ele que cobramos por conta própria. No
// Pix quem cobra é a Woovi, no ciclo dela; nada a fazer neste ponto.
//
// A trava de 5 minutos evita que uma sequência de gastos (uma campanha, por
// exemplo) dispare várias cobranças antes da primeira cair no saldo.
// ---------------------------------------------------------------------------
const TRAVA_MS = 5 * 60 * 1000;

async function checarSaldo(acc, broadcast) {
  const a = acc && acc.wallet && acc.wallet.autoTopup;
  if (!a || !a.enabled || a.method !== 'card') return false;
  if (acc.wallet.balance >= a.threshold) return false;
  if (Date.now() - (a.lastRunAt || 0) < TRAVA_MS) return false;
  if (!(acc.billing.card && acc.billing.card.token)) {
    a.lastError = 'O cartão salvo saiu do cadastro. Pague uma vez no cartão para religar.';
    a.enabled = false; db.save();
    return false;
  }

  a.lastRunAt = Date.now(); db.save();   // marca ANTES: uma falha não pode virar laço
  try {
    await recargaCartao(acc, a.amount, { useSaved: true, installments: 1 }, broadcast);
    a.lastError = ''; db.save();
    if (broadcast) broadcast('billing', { accountId: acc.id, kind: 'autotopup', amount: a.amount });
    return true;
  } catch (e) {
    a.lastError = String(e.message || e).slice(0, 180);
    db.save();
    return false;
  }
}

module.exports = { validarValor, recargaCartao, creditar, configurarAuto, publico, checarSaldo };
