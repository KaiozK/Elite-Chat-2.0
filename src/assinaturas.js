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
// TRÊS MEIOS, E DOIS MOTORES DE RECORRÊNCIA DIFERENTES
// ---------------------------------------------------------------------------
// O lojista escolhe, por produto, quais meios a assinatura dele aceita. Quem
// faz a cobrança se repetir NÃO é o mesmo nos três:
//
//   • PIX AUTOMÁTICO → quem repete é a WOOVI. O comprador autoriza uma vez no
//     banco dele e a cobrança é gerada lá, todo mês, sem nós. Só existe com a
//     Woovi: é produto do Banco Central que o gateway precisa oferecer, e a
//     Simplify, na integração que temos, não oferece.
//
//   • CARTÃO → quem repete SOMOS NÓS. A primeira cobrança guarda o token do
//     cartão no adquirente e a varredura diária cobra de novo quando vence.
//
//   • BOLETO → quem repete somos nós, emitindo um boleto novo a cada ciclo. Ele
//     não se paga sozinho: é sempre um ato do comprador, e por isso é o meio com
//     mais inadimplência dos três.
//
// A diferença tem consequência: no Pix Automático, parar de cobrar é cancelar
// na Woovi. Nos outros dois é parar a nossa varredura. Confundir os dois lados
// deixa alguém sendo cobrado depois de cancelar.
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

const DIA = 24 * 3600 * 1000;
// SÓ MENSAL. É o único ciclo que a rota de assinatura da Woovi aceita
// (`frequency: MONTHLY`), e oferecer semanal ou anual só no cartão faria o
// mesmo produto ter ciclos diferentes conforme o meio escolhido pelo comprador.
const CICLO_DIAS = 30;

// QUANTOS DIAS ESPERAR DEPOIS DE CADA RECUSA, e nada além disso: o tamanho da
// lista é o número de RETENTATIVAS, e a falha seguinte encerra.
//
//   1ª recusa → tenta de novo em 3 dias
//   2ª recusa → tenta de novo em 5 dias
//   3ª recusa → para de cobrar (a assinatura fica inadimplente, não apagada)
//
// Três dias e cinco de propósito: cartão recusa por motivo passageiro o tempo
// todo — limite estourado hoje, saldo amanhã —, e essa janela cobre a virada de
// mês, que é quando a maioria volta a passar. Cancelar na primeira negativa
// perde assinante que teria pago na semana seguinte.
const ESPERA_APOS_FALHA = [3, 5];

const METODOS = ['pix', 'credito', 'boleto'];

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
async function criar(acc, { productId, metodo, pagador, waId, contactName, checkoutId }, broadcast) {
  const pagamentos = require('./pagamentos');

  const prod = pagamentos.findProduct(acc, productId);
  if (!prod) throw erro('Produto não encontrado', 404);
  if (!prod.recorrente) throw erro('Este produto não é uma assinatura');
  if (!prod.active) throw erro('Este produto não está à venda');
  const valor = Math.round(Number(prod.price) || 0);
  if (valor < 100) throw erro('Valor mínimo da assinatura: R$ 1,00');

  // O MÉTODO É REVALIDADO CONTRA O PRODUTO, e não aceito do corpo. O que chega
  // aqui veio da página, e a página é do comprador: sem revalidar, qualquer um
  // assina no boleto um produto que só aceita cartão só editando a requisição.
  const m = METODOS.includes(metodo) ? metodo : 'pix';
  const aceitos = pagamentos.metodosDoProduto(acc, prod, checkoutId);
  if (!aceitos[m]) {
    throw erro(`Este produto não aceita ${rotulo(m)}${aceitos.motivos[m] ? ': ' + aceitos.motivos[m] : ''}`, 400);
  }

  // Quem vai pagar. Nome e e-mail são exigidos nos três meios: é por eles que a
  // cobrança do mês seguinte é reconhecida e avisada.
  const nome = String((pagador && pagador.name) || contactName || '').trim();
  const email = String((pagador && pagador.email) || '').trim();
  if (!nome) throw erro('Informe o nome de quem vai assinar');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw erro('Informe um e-mail válido para a assinatura');

  // CARTÃO E BOLETO EXIGEM MAIS, e a conferência é ANTES de criar coisa alguma.
  //
  // Os dois passam por uma cobrança de verdade, e o adquirente pede documento e
  // telefone do pagador. `identifyPayer` já valida isso — mas ela roda DEPOIS de
  // a cobrança nascer, e uma recusa ali deixava uma cobrança órfã na conta do
  // lojista, sem pagador e sem assinatura, aparecendo na lista dele como venda
  // pendente que nunca existiu.
  if (m !== 'pix') {
    const doc = String((pagador && pagador.document) || '').replace(/\D/g, '');
    const tel = String((pagador && pagador.phone) || '').replace(/\D/g, '');
    if (doc.length !== 11 && doc.length !== 14) {
      throw erro(`Para assinar no ${rotulo(m)} é preciso informar CPF ou CNPJ`);
    }
    if (tel.length < 10) {
      throw erro(`Para assinar no ${rotulo(m)} é preciso informar um celular válido`);
    }
  }

  const reg = {
    id: db.genId('eas'),
    correlationID: '',
    wooviSubId: '',
    metodo: m,
    productId: prod.id,
    checkoutId: checkoutId || prod.checkoutId || '',
    nome: prod.name || '',
    valueCents: valor,
    subPixKey: '', splitCents: 0,
    assinante: {
      nome, email,
      telefone: (pagador && pagador.phone) || '',
      documento: (pagador && pagador.document) || ''
    },
    waId: waId || null, contactName: contactName || nome,
    // PENDENTE ATÉ O PRIMEIRO CICLO CAIR. Nos três meios existe uma etapa entre
    // "criada" e "cobrando": autorizar no banco, o cartão passar, o boleto ser
    // pago. Nascer como "ativa" faria a tela do lojista contar receita que
    // ainda não existe.
    status: 'pendente',
    criadaEm: Date.now(),
    ciclos: 0, ultimoCicloEm: 0, ultimoValorCents: 0,
    // Só o cartão e o boleto têm isto: no Pix Automático quem marca a data é a
    // Woovi, e uma data nossa em paralelo só teria como render divergência.
    proximoCicloEm: 0,
    falhas: 0, ultimaFalha: '',
    cartao: null,
    canceladaEm: 0, motivo: '',
    autorizacaoUrl: '',
    // A cobrança do primeiro ciclo, quando o meio precisa de uma (cartão e
    // boleto). É ela que a página abre em seguida.
    primeiraCobrancaId: ''
  };

  if (m === 'pix') {
    const impedimento = porQueNao(acc);
    if (impedimento) throw erro(impedimento, 503);
    await criarNaWoovi(acc, reg, prod, pagador, waId);
  } else {
    // CARTÃO E BOLETO: a assinatura nasce junto de uma cobrança normal do
    // primeiro ciclo, e é ela que o comprador paga na tela de sempre. Quando
    // essa cobrança for paga, `aoPagarCobranca` liga a assinatura e marca o
    // próximo ciclo — o mesmo caminho que qualquer venda percorre.
    const ch = await pagamentos.createCharge(acc, {
      valueCents: valor, comment: prod.name,
      origin: 'assinatura', productId: prod.id, checkoutId: reg.checkoutId,
      pagador: { name: nome, email, phone: (pagador && pagador.phone) || '', document: (pagador && pagador.document) || '', taxID: (pagador && pagador.document) || '' },
      contactName: nome, waId
    }, broadcast);
    ch.subscriptionId = reg.id;
    ch.ciclo = 1;
    reg.primeiraCobrancaId = ch.id;
    // IDENTIFICA O PAGADOR NA HORA, como a venda avulsa já faz. Sem isto a
    // cobrança nasce com `needsId`, e a página — que acabou de receber nome,
    // documento, e-mail e telefone — volta para o formulário e pede tudo de
    // novo. Quem preenche duas vezes a mesma tela desiste na segunda.
    await pagamentos.identifyPayer(ch.id, {
      name: nome, email,
      taxID: (pagador && pagador.document) || '',
      phone: (pagador && pagador.phone) || ''
    }, broadcast);
  }

  lista(acc).unshift(reg);
  if (lista(acc).length > 2000) lista(acc).length = 2000;
  db.save();
  pagamentos.log(acc, {
    type: 'assinatura_criada',
    detail: `Assinatura de ${prod.name} criada para ${nome} (${rotulo(m)})`
  });
  store.logEvent({ type: 'assinatura_criada', accountId: acc.id, productId: prod.id, value: valor, metodo: m });
  if (broadcast) broadcast('pagamentos', { accountId: acc.id });
  return publico(reg);
}

function rotulo(m) {
  return m === 'pix' ? 'Pix Automático' : m === 'credito' ? 'cartão de crédito' : 'boleto';
}

// A recorrência que a Woovi controla. Separada porque é a única em que a
// cobrança do mês nasce FORA daqui.
async function criarNaWoovi(acc, reg, prod, pagador, waId) {
  const pagamentos = require('./pagamentos');
  const sub = pagamentos.activeSubaccount(acc);
  const { platformCut } = pagamentos.computeSplit(reg.valueCents);
  const cfg = pagamentos.platformCfg();
  // SEM TAXA, SEM SPLIT: mandar uma linha de split que não cobra nada é pedir
  // para a Woovi recusar a assinatura inteira.
  const splits = (platformCut > 0 && cfg.splitPixKey)
    ? [{ pixKey: cfg.splitPixKey, value: platformCut }] : null;

  // PREFIXO PRÓPRIO. O webhook separa o que é do SaaS (`sub-`, `topup-`…) do
  // que é do Pagamentos (`ep-`) pelo começo do correlationID. Uma assinatura de
  // cliente que começasse com `sub-` seria lida como assinatura do PLANO e
  // ativaria plano na conta errada.
  reg.correlationID = `eps-${acc.id}-${db.genId('s').slice(-8)}`;

  let woo;
  try {
    woo = await require('./woovi').createSubscription({
      correlationID: reg.correlationID, value: reg.valueCents,
      customer: {
        name: reg.assinante.nome, email: reg.assinante.email,
        phone: reg.assinante.telefone || (waId ? '+' + waId : ''),
        taxID: reg.assinante.documento || ''
      },
      comment: String(prod.name || 'Assinatura').slice(0, 140),
      subPixKey: sub.pixKey,
      splits
    });
  } catch (e) {
    store.logEvent({ type: 'assinatura_falhou', accountId: acc.id, productId: prod.id, error: e.message });
    throw erro('Não foi possível criar a assinatura agora: ' + e.message, 502);
  }

  reg.wooviSubId = woo.globalID || woo.id || '';
  // A SUBCONTA FICA GRAVADA, e não só usada: é o que permite conferir depois
  // para onde o dinheiro de cada recorrência foi.
  reg.subPixKey = sub.pixKey || '';
  reg.splitCents = platformCut;
  reg.autorizacaoUrl = woo.paymentLinkUrl || woo.subscriptionUrl || woo.url || '';
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
// A COBRANÇA DE UM CICLO FOI PAGA (cartão e boleto)
//
// Chamado de dentro de `finalizePaid`, que é por onde TODA venda passa. É aqui
// que a assinatura sai de "pendente" e a data do próximo ciclo é marcada.
//
// O Pix Automático NÃO passa por aqui: lá quem gera a cobrança do mês é a
// Woovi, e o caminho é `aoPagarCiclo`, logo abaixo.
// ---------------------------------------------------------------------------
function aoPagarCobranca(acc, ch, resultadoDoCartao) {
  if (!ch || !ch.subscriptionId) return null;
  const s = achar(acc, ch.subscriptionId);
  if (!s) return null;

  s.status = 'ativa';
  s.ciclos = Math.max(s.ciclos || 0, ch.ciclo || (s.ciclos || 0) + 1);
  s.ultimoCicloEm = Date.now();
  s.ultimoValorCents = ch.value;
  s.falhas = 0;
  s.ultimaFalha = '';
  // A data do próximo ciclo conta do PAGAMENTO, e não da data prevista. Um
  // boleto pago com cinco dias de atraso empurra o ciclo seguinte junto — do
  // contrário o comprador pagaria dois boletos na mesma semana, e a segunda
  // cobrança pareceria erro nosso.
  s.proximoCicloEm = Date.now() + CICLO_DIAS * DIA;

  // O TOKEN DO CARTÃO é o que faz o mês seguinte existir sem pedir o cartão de
  // novo. O adquirente devolve na primeira cobrança e é a única coisa que
  // guardamos dele — nunca número completo, nunca CVV.
  if (resultadoDoCartao && (resultadoDoCartao.token || resultadoDoCartao.cardToken)) {
    s.cartao = {
      token: resultadoDoCartao.token || resultadoDoCartao.cardToken,
      brand: resultadoDoCartao.brand || (ch.card && ch.card.brand) || '',
      last4: resultadoDoCartao.last4 || (ch.card && ch.card.last4) || ''
    };
  }
  db.save();
  store.logEvent({ type: 'assinatura_ciclo', accountId: acc.id, id: s.id, ciclo: s.ciclos, metodo: s.metodo });
  return s;
}

// ---------------------------------------------------------------------------
// VARREDURA DOS CICLOS (cartão e boleto)
//
// Uma vez por dia: quem venceu, cobra. O Pix Automático fica de fora — a Woovi
// já cobra sozinha, e uma segunda cobrança nossa seria cobrança em dobro.
// ---------------------------------------------------------------------------
async function varrer(broadcast) {
  const pagamentos = require('./pagamentos');
  const resumo = { cobrados: 0, boletos: 0, falhas: 0, inadimplentes: 0, erros: 0 };
  const agora = Date.now();

  for (const acc of db.get().accounts) {
    const ep = acc.pagamentos;
    if (!ep || !Array.isArray(ep.subscriptions)) continue;

    for (const s of ep.subscriptions) {
      if (s.metodo === 'pix') continue;                 // quem repete é a Woovi
      if (s.status !== 'ativa' && s.status !== 'inadimplente') continue;
      if (!s.proximoCicloEm || s.proximoCicloEm > agora) continue;

      try {
        const prod = pagamentos.findProduct(acc, s.productId);
        const ciclo = (s.ciclos || 0) + 1;
        const ch = await pagamentos.createCharge(acc, {
          valueCents: s.valueCents,
          comment: `${s.nome} · assinatura`,
          origin: 'assinatura',
          productId: s.productId, checkoutId: s.checkoutId,
          pagador: {
            name: s.assinante.nome, email: s.assinante.email,
            phone: s.assinante.telefone, document: s.assinante.documento,
            taxID: s.assinante.documento
          },
          contactName: s.contactName, waId: s.waId
        }, broadcast);
        ch.subscriptionId = s.id;
        ch.ciclo = ciclo;

        if (s.metodo === 'credito') {
          await cobrarNoCartao(acc, s, ch, resumo, broadcast);
        } else {
          // BOLETO NÃO SE PAGA SOZINHO. O que a varredura faz é EMITIR e avisar;
          // quem paga é o comprador, e por isso este é o meio com mais
          // inadimplência dos três. O ciclo seguinte só é marcado quando este
          // for pago — marcar agora emitiria boletos em cima de boletos.
          await pagamentos.payWithBoleto(ch.id, {
            customer: {
              name: s.assinante.nome, taxId: s.assinante.documento,
              email: s.assinante.email, phone: s.assinante.telefone
            }
          }, broadcast);
          s.proximoCicloEm = 0;      // reaberto quando este boleto for pago
          resumo.boletos++;
          db.save();
        }
      } catch (e) {
        resumo.erros++;
        store.logEvent({ type: 'assinatura_ciclo_erro', accountId: acc.id, id: s.id, error: e.message });
      }
    }
  }
  return resumo;
}

// Cobra o cartão salvo. A recusa NÃO cancela: cartão recusa por motivo
// passageiro o tempo todo, e cancelar na primeira negativa perde assinante que
// teria pago três dias depois.
async function cobrarNoCartao(acc, s, ch, resumo, broadcast) {
  const pagamentos = require('./pagamentos');
  if (!s.cartao || !s.cartao.token) {
    // Sem token não há como cobrar sozinho. Não é falha do cartão: é assinatura
    // que nunca chegou a ter um. Fica parada em vez de tentar todo dia.
    s.status = 'inadimplente';
    s.ultimaFalha = 'Sem cartão salvo para cobrar';
    s.proximoCicloEm = 0;
    resumo.inadimplentes++;
    db.save();
    return;
  }

  try {
    const r = await pagamentos.cobrarComCartaoSalvo(acc, ch, s.cartao, broadcast);
    if (r && r.status === 'paid') { resumo.cobrados++; return; }
    throw new Error(r && r.message ? r.message : 'Recusado pelo emissor');
  } catch (e) {
    s.falhas = (s.falhas || 0) + 1;
    s.ultimaFalha = e.message;
    const espera = ESPERA_APOS_FALHA[s.falhas - 1];
    if (espera) {
      s.status = 'inadimplente';
      s.proximoCicloEm = Date.now() + espera * DIA;
      resumo.falhas++;
    } else {
      // Acabaram as tentativas. A assinatura para de cobrar e fica visível como
      // inadimplente para o lojista decidir — cancelar sozinho apagaria o
      // histórico de quem talvez só precise trocar o cartão.
      s.status = 'inadimplente';
      s.proximoCicloEm = 0;
      resumo.inadimplentes++;
    }
    db.save();
    pagamentos.log(acc, {
      type: 'assinatura_falha',
      detail: `Cobrança da assinatura de ${s.nome} recusada (${s.falhas}ª): ${e.message}`
    });
    if (broadcast) broadcast('pagamentos', { accountId: acc.id });
  }
}

// Tick diário, com uma primeira passada 3min depois de subir.
function startJob(broadcast) {
  const tick = async () => {
    try {
      const r = await varrer(broadcast);
      if (r.cobrados || r.boletos || r.falhas || r.inadimplentes) {
        store.logEvent({ type: 'assinaturas_varredura', ...r });
      }
    } catch (e) { store.logEvent({ type: 'assinaturas_varredura_erro', error: e.message }); }
  };
  setTimeout(tick, 180000);
  setInterval(tick, DIA);
}

// ---------------------------------------------------------------------------
// O QUE AS TELAS VEEM
// ---------------------------------------------------------------------------
function publico(s) {
  return {
    id: s.id, nome: s.nome, productId: s.productId,
    // O MEIO é o dado que explica todo o resto da linha: por que uma tem link
    // de autorização e outra não, por que uma pode ficar inadimplente e a de
    // Pix Automático não, quantos ciclos já rodaram sozinhos. Sem ele a tela
    // mostra estados que não se explicam.
    metodo: s.metodo || 'pix',
    metodoNome: rotulo(s.metodo || 'pix'),
    valueCents: s.valueCents, status: s.status,
    proximoCicloEm: s.proximoCicloEm || 0,
    falhas: s.falhas || 0, ultimaFalha: s.ultimaFalha || '',
    cartao: s.cartao ? { brand: s.cartao.brand, last4: s.cartao.last4 } : null,
    assinante: { nome: s.assinante.nome, email: s.assinante.email },
    criadaEm: s.criadaEm, ciclos: s.ciclos || 0, ultimoCicloEm: s.ultimoCicloEm || 0,
    canceladaEm: s.canceladaEm || 0,
    autorizacaoUrl: s.autorizacaoUrl || '',
    // A COBRANÇA DO PRIMEIRO CICLO, no cartão e no boleto. Sem ela aqui, quem
    // chama não tem como saber que existe uma cobrança a pagar — e a página
    // caía na tela de "autorize no seu banco" do Pix Automático mesmo quando o
    // comprador tinha escolhido cartão, oferecendo um link de autorização que
    // nunca existiu.
    primeiraCobrancaId: s.primeiraCobrancaId || '',
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
    pendentes: l.filter(s => s.status === 'pendente').length,
    inadimplentes: l.filter(s => s.status === 'inadimplente').length,
    // A RECEITA CONTA SÓ O QUE ESTÁ COBRANDO. Somar as pendentes e as
    // inadimplentes daria um número maior e falso — é dinheiro que ninguém
    // autorizou ou que já parou de entrar.
    receitaMensalCents: lista(acc).filter(s => s.status === 'ativa')
      .reduce((t, s) => t + (s.valueCents || 0), 0)
  };
}

module.exports = {
  disponivel, contaPode, porQueNao, gatewayAtivo, subDaConta,
  ensure, lista, achar,
  criar, cancelar,
  ehCicloDeAssinatura, aoPagarCiclo, aoPagarCobranca, correlacaoDaAssinatura, acharPorCorrelacao,
  varrer, startJob, cobrarNoCartao, rotulo, CICLO_DIAS,
  publico, visaoCliente
};
