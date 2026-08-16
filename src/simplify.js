// ============================================================================
// SIMPLIFY — adquirente Pix (alternativa à Woovi)
//
// Documentação: https://simplifybr.gitbook.io/documentacao-simplify
//
// O MODELO É DIFERENTE DO DA WOOVI, e isso muda o desenho:
//
//   Woovi   → cada cliente tem uma SUBCONTA; o dinheiro cai direto nela e o
//             cliente saca de lá.
//   Simplify→ não há subconta. O depósito cai na conta da PLATAFORMA
//             (a das credenciais) e o `split` manda uma porcentagem para
//             OUTROS usuários da Simplify, identificados por `username`.
//
// O split não serve para repassar a venda ao cliente: o teto é 90% do total, e
// a parte do cliente é ~97%. Então, com a Simplify, o dinheiro fica na conta da
// plataforma e quem faz as contas é a CARTEIRA do Koonfy — que já existe: a
// venda credita o saldo do cliente e ele saca em Pagamentos. O `split` fica
// para quando a plataforma quiser mandar um pedaço para outra conta.
//
// LIMITAÇÃO REAL: a Simplify EXIGE nome, e-mail, CPF/CNPJ e telefone do
// pagador para criar o depósito. A Woovi não exige. Isso significa que uma
// cobrança sem esses dados não pode ser criada — ver `dadosDoPagador()`.
// ============================================================================
const db = require('./db');
const store = require('./store');

const BASE = 'https://simplifybr.com/api/v1';

function cfg() {
  const p = db.get().platform;
  if (!p.simplify) p.simplify = { clientId: '', clientSecret: '', splitUsername: '', splitPercent: 0 };
  return p.simplify;
}

function configured() {
  const c = cfg();
  return !!(c.clientId && c.clientSecret);
}

async function call(metodo, rota, corpo) {
  const c = cfg();
  if (!configured()) {
    const e = new Error('Simplify não configurada. Informe Client ID e Client Secret em Admin, Gateways.');
    e.status = 400; throw e;
  }
  const r = await fetch(BASE + rota, {
    method: metodo,
    headers: {
      'client-id': c.clientId,
      'client-secret': c.clientSecret,
      'Content-Type': 'application/json'
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const txt = await r.text();
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch { /* resposta não-JSON */ }
  if (!r.ok) {
    // A mensagem do gateway vale mais que "erro 400": é ela que diz se faltou
    // CPF, se a credencial está errada ou se o split não fecha.
    const msg = (j && (j.message || j.error || j.detail)) || txt.slice(0, 200) || ('HTTP ' + r.status);
    const e = new Error('Simplify: ' + msg);
    e.status = r.status === 401 || r.status === 403 ? 400 : (r.status || 502);
    throw e;
  }
  return j || {};
}

// ---------------------------------------------------------------------------
// DADOS DO PAGADOR
//
// Os quatro campos são obrigatórios na Simplify. O Koonfy nem sempre os tem: a
// cobrança gerada do chat sabe o nome e o telefone, mas não o CPF.
//
// Aqui NADA é inventado. Um CPF falso passaria pela validação de formato e
// quebraria a conciliação do cliente depois — e o dinheiro é real. Quando falta
// dado, o erro diz exatamente o que falta e onde resolver.
// ---------------------------------------------------------------------------
function dadosDoPagador({ contactName, waId, payer }) {
  const p = payer || {};
  const doc = String(p.document || '').replace(/\D/g, '');
  const faltando = [];
  if (!String(p.name || contactName || '').trim()) faltando.push('nome');
  if (!doc) faltando.push('CPF/CNPJ');
  if (!String(p.email || '').trim()) faltando.push('e-mail');

  if (faltando.length) {
    const e = new Error(
      `A Simplify exige ${faltando.join(', ')} do pagador para gerar o Pix. ` +
      'Envie a cobrança pelo checkout (o cliente preenche na hora) ou complete a ficha do contato.'
    );
    e.status = 400; e.code = 'payer_required';
    throw e;
  }
  return {
    name: String(p.name || contactName).trim().slice(0, 120),
    email: String(p.email).trim().toLowerCase().slice(0, 140),
    document: doc,
    phone: String(p.phone || waId || '').replace(/\D/g, '').slice(0, 15)
  };
}

// ---------------------------------------------------------------------------
// WEBHOOK
//
// A Simplify NÃO assina o webhook — não há segredo compartilhado nem HMAC na
// documentação. Então a notificação é tratada como um AVISO, não como prova:
// ela diz qual cobrança olhar, e a confirmação vem de bater o valor com o que
// está registrado aqui. Sem isso, qualquer um que descobrisse a URL poderia
// marcar cobranças como pagas.
// ---------------------------------------------------------------------------
function webhookHandler(broadcast) {
  return (req, res) => {
    res.sendStatus(200);            // responde rápido; a Simplify reenvia se demorar
    try {
      const b = req.body || {};
      const evento = String(b.event || '');
      const status = String(b.status || '').toLowerCase();
      const externo = String(b.external_id || '');

      store.logEvent({
        type: 'simplify_webhook', event: evento, status,
        external_id: externo, internal_id: b.internal_id || null
      });

      const pago = /paid/i.test(evento) || status === 'approved' || status === 'paid';
      if (!pago || !externo) return;

      const elitepay = require('./elitepay');
      const achado = elitepay.findChargeAnywhere(externo);
      if (!achado) {
        store.logEvent({ type: 'simplify_unmatched', external_id: externo });
        return;
      }
      const { acc, ch: charge } = achado;

      // O valor da notificação tem que bater com o da cobrança. Divergiu, não
      // confirma: registra e deixa para conferência manual.
      const centavos = Math.round(Number(String(b.amount || '0').replace(',', '.')) * 100);
      if (centavos && Math.abs(centavos - charge.value) > 1) {
        store.logEvent({
          type: 'simplify_valor_divergente', external_id: externo,
          esperado: charge.value, recebido: centavos
        });
        return;
      }

      elitepay.markPaidFromGateway(acc, charge, broadcast);
    } catch (e) {
      store.logEvent({ type: 'simplify_webhook_erro', error: e.message });
    }
  };
}

module.exports = { BASE, cfg, configured, call, dadosDoPagador, webhookHandler };
