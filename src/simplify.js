// ============================================================================
// SIMPLIFY — adquirente Pix (alternativa à Woovi)
//
// Documentação: https://simplifybr.gitbook.io/documentacao-simplify
//
// O MODELO É DIFERENTE DO DA WOOVI, e isso muda o desenho:
//
//   Woovi   → cada cliente tem uma SUBCONTA; o dinheiro cai direto nela e o
//             cliente saca de lá.
//   Simplify→ não há subconta. O depósito cai inteiro na conta da PLATAFORMA
//             (a das credenciais).
//
// Quem faz as contas é a CARTEIRA do Koonfy: a venda credita ao cliente o
// LÍQUIDO (valor menos a taxa da plataforma) e ele saca em Pagamentos. Ou
// seja, a taxa de PIX In fica retida por construção — não passa por split.
//
// A Simplify tem um `split` que manda uma fatia para outro usuário dela, mas
// ele não serve nem para repassar a venda ao cliente (o teto é 90% e a parte
// do cliente é ~97%) nem para a taxa. Não é usado.
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
  if (!p.simplify) p.simplify = { clientId: '', clientSecret: '' };
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
    phone: telefoneNacional(p.phone || waId)
  };
}

// ---------------------------------------------------------------------------
// TELEFONE — SEM o código do país
//
// O Koonfy guarda o telefone no formato do WhatsApp (E.164): 5511987654321,
// com o 55 do Brasil na frente. A Simplify espera o número NACIONAL, DDD mais
// o assinante — o exemplo da documentação dela é "82981440676", 11 dígitos.
//
// Mandando com o 55, ela lê o "55" como DDD: um (11) 98765-4321 chegava no
// painel dela como "(55) 11987-6543", telefone de outra pessoa. Se ela usar
// esse número para avisar o pagador, o aviso vai para o lugar errado.
//
// O tamanho desfaz a ambiguidade com o DDD 55 (Santa Maria/RS): um número
// nacional tem no máximo 11 dígitos, então 12 ou 13 dígitos começando em 55 só
// pode ser o código do país.
// ---------------------------------------------------------------------------
function telefoneNacional(valor) {
  let d = String(valor || '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d.slice(0, 11);
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

      const centavosPagos = Math.round(Number(String(b.amount || '0').replace(',', '.')) * 100);

      // COBRANÇA DO PRÓPRIO KOONFY (assinatura, recarga da carteira, conexão
      // extra, link rastreável). Elas não são venda de cliente e não vivem em
      // `pagamentos.charges` — são reconhecidas pelo prefixo do external_id e
      // liquidadas pela mesma regra de faturamento de sempre.
      //
      // Sem isto, com a Simplify como adquirente o cliente pagava a recarga e o
      // saldo nunca entrava: o webhook chegava, não achava a cobrança e ia
      // embora como "não identificada".
      const saaspix = require('./saaspix');
      if (saaspix.ehCobrancaSaaS(externo)) {
        const r = saaspix.confirmar(externo, centavosPagos, broadcast);
        store.logEvent({ type: 'simplify_saas_paid', external_id: externo, valor: centavosPagos, ok: !!(r && r.ok) });
        return;
      }

      const pagamentos = require('./pagamentos');
      const achado = pagamentos.findChargeAnywhere(externo);
      if (!achado) {
        store.logEvent({ type: 'simplify_unmatched', external_id: externo });
        return;
      }
      const { acc, ch: charge } = achado;

      // O valor da notificação tem que bater com o da cobrança. Divergiu, não
      // confirma: registra e deixa para conferência manual.
      const centavos = centavosPagos;
      if (centavos && Math.abs(centavos - charge.value) > 1) {
        store.logEvent({
          type: 'simplify_valor_divergente', external_id: externo,
          esperado: charge.value, recebido: centavos
        });
        return;
      }

      pagamentos.markPaidFromGateway(acc, charge, broadcast);
    } catch (e) {
      store.logEvent({ type: 'simplify_webhook_erro', error: e.message });
    }
  };
}

module.exports = { BASE, cfg, configured, call, dadosDoPagador, telefoneNacional, webhookHandler };
