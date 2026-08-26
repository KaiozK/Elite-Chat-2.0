// ============================================================================
// ASSINATURAS DO CLIENTE — Pix Automático no checkout
//
// Até aqui o checkout sabia cobrar UMA VEZ. Este arquivo é o que faltava para
// o cliente vender algo que se paga todo mês: o comprador autoriza uma vez no
// banco dele e a Woovi cobra sozinha a cada ciclo.
//
// NÃO CONFUNDIR COM AS OUTRAS DUAS RECORRÊNCIAS DO PRODUTO. São três, e o
// dinheiro anda em direções diferentes em cada uma:
//
//   1. O PLANO DA KOONFY        cliente  → plataforma   (saasbilling.js)
//   2. A RECARGA AUTOMÁTICA     cliente  → plataforma   (topup.js)
//   3. ESTE ARQUIVO             comprador → CLIENTE      (menos a taxa)
//
// As duas primeiras mandam dinheiro para a conta da plataforma, inteiro. Esta
// manda para a SUBCONTA do cliente, e a taxa da plataforma sai por split — a
// mesma rota que a cobrança avulsa já usa. Errar isso significa a plataforma
// ficando com a receita de assinatura dos clientes, o que ninguém percebe até
// alguém pedir para sacar.
//
// ---------------------------------------------------------------------------
// SÓ COM A WOOVI, e não é uma escolha de gosto
// ---------------------------------------------------------------------------
// Pix Automático é um produto do Banco Central que o gateway precisa oferecer.
// A Woovi tem; a Simplify, na integração que temos, não. Então a opção só
// aparece quando o processador Pix ativo é a Woovi — em vez de oferecer, o
// comprador autorizar, e nada acontecer.
//
// ---------------------------------------------------------------------------
// COMO O CICLO PAGO VIRA UMA VENDA AQUI DENTRO
// ---------------------------------------------------------------------------
// A cada mês a Woovi gera uma cobrança nova, com correlationID dela, que o
// Koonfy nunca viu. O webhook não acha essa cobrança em conta nenhuma — ela
// não foi criada por nós.
//
// Então o caminho é o inverso: a cobrança órfã é casada pela ASSINATURA que a
// gerou, e aí um registro de cobrança nasce na conta e passa pelo MESMO
// `finalizePaid` de sempre. É isso que faz o ciclo mensal cair no funil,
// creditar a carteira, disparar o aviso no celular, contar no tracking e mandar
// a confirmação no WhatsApp — sem uma linha duplicada de nenhuma dessas coisas.
// Um caminho paralelo aqui significaria descobrir daqui a seis meses que a
// renovação não avança o funil.
// ============================================================================

const db = require('./db');
const store = require('./store');

function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

// ---------------------------------------------------------------------------
// DISPONIBILIDADE
// ---------------------------------------------------------------------------
function gatewayAtivo() { return (db.get().platform.pagamentos || {}).gateway || 'woovi'; }

// O Pix Automático está de pé na plataforma? Três condições, e todas já
// existiam separadas antes deste arquivo:
//
//   1. a Woovi é o processador Pix ativo (a Simplify não tem recorrência);
//   2. a Woovi está configurada (AppID salvo);
//   3. o admin não desligou o Pix Automático no painel.
//
// A terceira é a que eu quase esqueci. O interruptor já governava a assinatura
// do PLANO desde antes; se as assinaturas dos clientes o ignorassem, desligar
// no painel pararia uma recorrência e deixaria a outra correndo, e o admin não
// teria como saber disso olhando a tela.
function disponivel() {
  if (gatewayAtivo() !== 'woovi') return false;
  try {
    if (!require('./woovi').configured()) return false;
  } catch { return false; }
  return !!(db.get().platform.woovi || {}).pixAutomatic;
}

// E esta CONTA pode usar? Precisa da subconta pronta — sem ela o dinheiro da
// recorrência não teria para onde ir.
//
// `activeSubaccount` LEVANTA ERRO quando não há conta de recebimento; ela foi
// escrita para o caminho da cobrança, onde não ter conta é mesmo um erro que
// precisa parar tudo. Aqui a pergunta é outra — "dá para oferecer isto?" — e a
// resposta é `false`, não uma exceção subindo pela tela. Sem este try, abrir o
// checkout de quem ainda não montou a conta Koonpay estourava 400 em vez de
// simplesmente não mostrar a opção.
function subDaConta(acc) {
  try { return require('./pagamentos').activeSubaccount(acc); }
  catch { return null; }
}

function contaPode(acc) {
  if (!disponivel()) return false;
  const sub = subDaConta(acc);
  return !!(sub && sub.pixKey);
}

// O motivo, por extenso, para a tela poder explicar em vez de só esconder.
function porQueNao(acc) {
  if (gatewayAtivo() !== 'woovi') {
    return 'O Pix Automático depende da Woovi como processador Pix da plataforma.';
  }
  try { if (!require('./woovi').configured()) return 'A Woovi ainda não está configurada na plataforma.'; }
  catch { return 'A Woovi ainda não está configurada na plataforma.'; }
  if (!(db.get().platform.woovi || {}).pixAutomatic) {
    return 'O Pix Automático está desligado no painel da plataforma.';
  }
  const sub = subDaConta(acc);
  if (!sub || !sub.pixKey) return 'A sua conta de recebimento ainda não está pronta.';
  return '';
}

// ---------------------------------------------------------------------------
// ONDE FICAM
// ---------------------------------------------------------------------------
function ensure(acc) {
  const ep = require('./pagamentos').ensure(acc);
  if (!Array.isArray(ep.subscriptions)) ep.subscriptions = [];
  return ep;
}

function lista(acc) { return ensure(acc).subscriptions; }
function achar(acc, id) {
  return lista(acc).find(s => s.id === id || s.correlationID === id) || null;
}

// ---------------------------------------------------------------------------
// CRIAÇÃO
//
// Nasce a partir de um PRODUTO marcado como assinatura. O valor sai do produto
// e não do corpo da requisição: o preço de uma recorrência não pode vir de
// quem está comprando.
// ---------------------------------------------------------------------------
async function criar(acc, { productId, pagador, waId, contactName, checkoutId }, broadcast) {
  const pagamentos = require('./pagamentos');
  const impedimento = porQueNao(acc);
  if (impedimento) throw erro(impedimento, 503);

  const prod = pagamentos.findProduct(acc, productId);
  if (!prod) throw erro('Produto não encontrado', 404);
  if (!prod.recorrente) throw erro('Este produto não é uma assinatura');
  if (!prod.active) throw erro('Este produto não está à venda');
  const valor = Math.round(Number(prod.price) || 0);
  if (valor < 100) throw erro('Valor mínimo da assinatura: R$ 1,00');

  // A Woovi precisa saber quem é o pagador para pedir a autorização no banco
  // dele. Sem isso não há Pix Automático — é o consentimento que o Banco
  // Central exige, e não um campo de cadastro qualquer.
  const nome = String((pagador && pagador.name) || contactName || '').trim();
  const email = String((pagador && pagador.email) || '').trim();
  if (!nome) throw erro('Informe o nome de quem vai assinar');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw erro('Informe um e-mail válido para a assinatura');

  const sub = pagamentos.activeSubaccount(acc);
  const { platformCut } = pagamentos.computeSplit(valor);
  // `platformCfg()` e não `platform.pagamentos` cru: ela cria os padrões na
  // primeira leitura. Lendo o objeto direto, uma plataforma que nunca abriu a
  // tela de gateways devolveria `undefined` e o split sumiria em silêncio.
  const cfg = pagamentos.platformCfg();
  // SEM TAXA, SEM SPLIT: mandar um split de valor zero é pedir para a Woovi
  // recusar a assinatura inteira por causa de uma linha que não cobra nada.
  const splits = (platformCut > 0 && cfg.splitPixKey)
    ? [{ pixKey: cfg.splitPixKey, value: platformCut }] : null;

  // PREFIXO PRÓPRIO. O webhook separa o que é do SaaS (`sub-`, `topup-`…) do
  // que é do Pagamentos (`ep-`) pelo começo do correlationID. Uma assinatura de
  // cliente que começasse com `sub-` seria lida como assinatura do PLANO e
  // ativaria plano na conta errada.
  const correlationID = `eps-${acc.id}-${db.genId('s').slice(-8)}`;

  let woo;
  try {
    woo = await require('./woovi').createSubscription({
      correlationID, value: valor,
      customer: {
        name: nome, email,
        phone: (pagador && pagador.phone) || (waId ? '+' + waId : ''),
        taxID: (pagador && pagador.document) || ''
      },
      comment: String(prod.name || 'Assinatura').slice(0, 140),
      subPixKey: sub.pixKey,
      splits
    });
  } catch (e) {
    store.logEvent({ type: 'assinatura_falhou', accountId: acc.id, productId, error: e.message });
    throw erro('Não foi possível criar a assinatura agora: ' + e.message, 502);
  }

  const reg = {
    id: db.genId('eas'),
    correlationID,
    wooviSubId: woo.globalID || woo.id || '',
    productId: prod.id,
    checkoutId: checkoutId || prod.checkoutId || '',
    nome: prod.name || '',
    valueCents: valor,
    // A SUBCONTA FICA GRAVADA, e não só usada: é o que permite conferir depois
    // para onde o dinheiro de cada recorrência foi. Ver a nota sobre a
    // suposição não confirmada em woovi.createSubscription.
    subPixKey: sub.pixKey || '',
    splitCents: platformCut,
    assinante: { nome, email, telefone: (pagador && pagador.phone) || '', documento: (pagador && pagador.document) || '' },
    waId: waId || null, contactName: contactName || nome,
    status: 'ativa',                 // ativa | cancelada
    criadaEm: Date.now(),
    ciclos: 0, ultimoCicloEm: 0, ultimoValorCents: 0,
    canceladaEm: 0,
    // O link que a Woovi devolve é onde o comprador autoriza no banco. Sem
    // ele a assinatura existe e ninguém autorizou nada.
    autorizacaoUrl: woo.paymentLinkUrl || woo.subscriptionUrl || woo.url || ''
  };
  lista(acc).unshift(reg);
  if (lista(acc).length > 2000) lista(acc).length = 2000;
  db.save();
  pagamentos.log(acc, {
    type: 'assinatura_criada', detail: `Assinatura de ${prod.name} criada para ${nome}`
  });
  store.logEvent({ type: 'assinatura_criada', accountId: acc.id, productId: prod.id, value: valor });
  if (broadcast) broadcast('pagamentos', { accountId: acc.id });
  return publico(reg);
}

// ---------------------------------------------------------------------------
// CANCELAMENTO
//
// Primeiro na Woovi, depois aqui — se marcarmos cancelada e a chamada lá
// falhar, o comprador continua sendo cobrado por algo que a tela diz que
// acabou, e a reclamação chega pelo cartão de crédito dele, não por aqui.
// ---------------------------------------------------------------------------
async function cancelar(acc, id, motivo, broadcast) {
  const s = achar(acc, id);
  if (!s) throw erro('Assinatura não encontrada', 404);
  if (s.status === 'cancelada') throw erro('Esta assinatura já foi cancelada');

  if (s.wooviSubId) {
    const r = await require('./woovi').cancelSubscription(s.wooviSubId);
    if (r && r.error) {
      store.logEvent({ type: 'assinatura_cancel_falhou', accountId: acc.id, id: s.id, error: r.error });
      throw erro('Não foi possível cancelar na Woovi agora. Tente de novo em instantes — ' +
        'até lá a cobrança continua ativa, e marcar como cancelada aqui só esconderia isso.', 502);
    }
  }
  s.status = 'cancelada';
  s.canceladaEm = Date.now();
  s.motivo = motivo || 'Cancelada pelo vendedor';
  db.save();
  require('./pagamentos').log(acc, {
    type: 'assinatura_cancelada', detail: `Assinatura de ${s.nome} cancelada (${s.assinante.nome})`
  });
  if (broadcast) broadcast('pagamentos', { accountId: acc.id });
  return publico(s);
}

// ---------------------------------------------------------------------------
// O CICLO PAGO
//
// Chamado pelo webhook quando chega uma cobrança que não é de ninguém: ela foi
// gerada pela Woovi a partir de uma assinatura. Aqui ela ganha um registro de
// cobrança na conta certa e segue pelo caminho normal de uma venda.
// ---------------------------------------------------------------------------

// Acha a assinatura de qualquer conta pelo correlationID que a Woovi mandou.
// O `startsWith` cobre o caso de a Woovi derivar o id do ciclo a partir do id
// da assinatura (`<cid>-1`, `<cid>-2`) em vez de mandá-lo em campo separado.
function acharPorCorrelacao(subCid, chargeCid) {
  const alvo = String(subCid || '');
  const cCid = String(chargeCid || '');
  for (const acc of db.get().accounts) {
    const ep = acc.pagamentos;
    if (!ep || !Array.isArray(ep.subscriptions)) continue;
    for (const s of ep.subscriptions) {
      if (!s.correlationID) continue;
      if (alvo && s.correlationID === alvo) return { acc, s };
      if (cCid && cCid.startsWith(s.correlationID)) return { acc, s };
    }
  }
  return null;
}

// A cobrança do ciclo veio de uma assinatura nossa?
function ehCicloDeAssinatura(charge) {
  const subCid = correlacaoDaAssinatura(charge);
  return !!acharPorCorrelacao(subCid, charge && charge.correlationID);
}

// A Woovi manda o vínculo em mais de um formato dependendo do evento; ler um
// só significa perder o ciclo silenciosamente quando ela usar o outro.
function correlacaoDaAssinatura(charge) {
  if (!charge) return '';
  const sub = charge.subscription;
  if (sub && typeof sub === 'object') return sub.correlationID || sub.globalID || sub.id || '';
  if (typeof sub === 'string') return sub;
  return charge.subscriptionCorrelationID || charge.subscriptionID || '';
}

function aoPagarCiclo(charge, broadcast) {
  const pagamentos = require('./pagamentos');
  const subCid = correlacaoDaAssinatura(charge);
  const achado = acharPorCorrelacao(subCid, charge && charge.correlationID);
  if (!achado) return { ok: false, reason: 'unmatched' };
  const { acc, s } = achado;
  const ep = pagamentos.ensure(acc);
  const cicloCid = String(charge.correlationID || '');

  // IDEMPOTÊNCIA. Webhook repete — a Woovi reenvia quando não recebe 200 a
  // tempo, e um ciclo contado duas vezes credita a carteira duas vezes.
  const jaTem = ep.charges.find(c => c.correlationID === cicloCid);
  if (jaTem) return { ok: true, duplicate: true, chargeId: jaTem.id };

  const valor = Math.round(Number(charge.value) || s.valueCents || 0);
  const { feePercent, platformCut } = pagamentos.computeSplit(valor);

  const ch = {
    id: db.genId('epc'),
    correlationID: cicloCid,
    status: 'active',
    value: valor,
    comment: `${s.nome} · assinatura`,
    waId: s.waId || null,
    contactName: s.contactName || s.assinante.nome || null,
    brCode: '', qrCodeImage: '', paymentLinkUrl: '',
    createdAt: Date.now(), paidAt: null, expiresAt: Date.now(),
    // A ORIGEM DIZ QUE É RECORRÊNCIA. O relatório precisa separar receita nova
    // de receita que se repete: são números que se leem de formas diferentes, e
    // somados viram uma média que não descreve nem uma nem outra.
    origin: 'assinatura', byName: null,
    productId: s.productId || '', checkoutId: s.checkoutId || '',
    subscriptionId: s.id,
    ciclo: (s.ciclos || 0) + 1,
    saas: null, message: null, buttonText: null,
    feePercent, platformCut,
    gateway: 'woovi', gatewayId: charge.identifier || charge.transactionID || ''
  };
  ep.charges.unshift(ch);
  if (ep.charges.length > 2000) ep.charges.length = 2000;

  s.ciclos = ch.ciclo;
  s.ultimoCicloEm = Date.now();
  s.ultimoValorCents = valor;
  db.save();

  store.logEvent({ type: 'assinatura_ciclo', accountId: acc.id, id: s.id, ciclo: ch.ciclo, value: valor });
  // E daqui em diante é uma venda como qualquer outra.
  return pagamentos.finalizePaid(acc, ch, broadcast);
}

// ---------------------------------------------------------------------------
// O QUE AS TELAS VEEM
// ---------------------------------------------------------------------------
function publico(s) {
  return {
    id: s.id, nome: s.nome, productId: s.productId,
    valueCents: s.valueCents, status: s.status,
    assinante: { nome: s.assinante.nome, email: s.assinante.email },
    criadaEm: s.criadaEm, ciclos: s.ciclos || 0, ultimoCicloEm: s.ultimoCicloEm || 0,
    canceladaEm: s.canceladaEm || 0,
    autorizacaoUrl: s.autorizacaoUrl || '',
    // Enquanto nenhum ciclo caiu, a assinatura existe mas ninguém autorizou
    // nada no banco. É uma diferença que a tela precisa mostrar: "criada" e
    // "cobrando" parecem a mesma coisa e não são.
    autorizada: (s.ciclos || 0) > 0
  };
}

function visaoCliente(acc) {
  const l = lista(acc).map(publico);
  return {
    disponivel: contaPode(acc),
    motivo: porQueNao(acc),
    assinaturas: l,
    ativas: l.filter(s => s.status === 'ativa').length,
    receitaMensalCents: lista(acc).filter(s => s.status === 'ativa')
      .reduce((t, s) => t + (s.valueCents || 0), 0)
  };
}

module.exports = {
  disponivel, contaPode, porQueNao, gatewayAtivo, subDaConta,
  ensure, lista, achar,
  criar, cancelar,
  ehCicloDeAssinatura, aoPagarCiclo, correlacaoDaAssinatura, acharPorCorrelacao,
  publico, visaoCliente
};
