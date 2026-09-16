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
const crypto = require('crypto');

const BASE = 'https://simplifybr.com/api/v1';

function cfg() {
  const p = db.get().platform;
  if (!p.simplify) p.simplify = { clientId: '', clientSecret: '' };
  return p.simplify;
}

// ---------------------------------------------------------------------------
// O AVISO DE PAGAMENTO PRECISA PROVAR QUE É DELA
//
// A Woovi e o cartão confirmam de outro jeito: quando o aviso chega, o Koonfy
// RECONSULTA a cobrança na API do adquirente e só acredita no que a própria API
// responde. A Simplify não tem consulta de transação — a documentação só expõe
// a criação do depósito —, então o corpo do aviso era a única palavra sobre o
// dinheiro ter entrado. E corpo de POST qualquer um escreve.
//
// O que isso valia na prática: o `external_id` de uma recarga de carteira é
// devolvido para o próprio dono da conta na resposta de `POST /billing/topup`.
// Bastava pegar esse id, não pagar o Pix, e postar em `/simplify-webhook`
// `{event:'paid', external_id:'<o id>', amount:'2000'}` para a carteira ser
// creditada com R$ 2.000 que ninguém pagou — saldo que paga assinatura,
// conexões e disparos, e que sai no saque.
//
// A prova agora é um TOKEN que só a Simplify recebe: ele vai embutido na
// `webhookURL` que mandamos junto com CADA depósito, então volta sozinho no
// aviso, sem ninguém precisar configurar nada. Ele também é aceito em cabeçalho
// (`x-webhook-token` ou `Authorization: Bearer`) para o caso de a URL de
// retorno ser a fixa do painel dela — é só colar a mesma URL com `?t=` lá.
// ---------------------------------------------------------------------------
function webhookToken() {
  const c = cfg();
  if (!c.webhookToken) { c.webhookToken = 'sm_' + crypto.randomBytes(24).toString('hex'); db.save(); }
  return c.webhookToken;
}

// Comparação de tempo constante: comparar com `===` vaza, pelo tempo de
// resposta, quantos caracteres do começo estavam certos.
function tokenConfere(a) {
  const A = Buffer.from(String(a || '')), B = Buffer.from(webhookToken());
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function tokenDoPedido(req) {
  const q = (req.query && (req.query.t || req.query.token)) || '';
  if (q) return q;
  const h = String(req.get('x-webhook-token') || '');
  if (h) return h;
  const a = String(req.get('authorization') || '');
  return /^bearer /i.test(a) ? a.slice(7).trim() : '';
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
    // A ROTA SÓ EXISTE DE VERDADE QUANDO A SIMPLIFY ESTÁ EM USO.
    //
    // Ela é montada sempre, em server.js, mas quem opera com a Woovi não tem
    // nenhum motivo para aceitar um aviso de pagamento da Simplify. Fechar aqui
    // apaga a superfície inteira para a maioria das instalações, sem depender
    // de mais nada estar certo.
    const ativo = (db.get().platform.pagamentos || {}).gateway === 'simplify';
    if (!ativo || !configured()) {
      return res.status(404).json({ error: 'não encontrado' });
    }
    if (!tokenConfere(tokenDoPedido(req))) {
      // Fica registrado em Logs de Webhook: se um aviso legítimo começar a ser
      // recusado, é aqui que aparece — e a saída é colar de novo, no painel da
      // Simplify, a URL de retorno que o Admin mostra (ela já vem com o `?t=`).
      store.logEvent({ type: 'simplify_webhook_negado', ip: req.ip, external_id: (req.body || {}).external_id || null });
      return res.status(401).json({ error: 'não autorizado' });
    }
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

module.exports = { BASE, cfg, configured, call, dadosDoPagador, telefoneNacional, webhookHandler, webhookToken };
