// ============================================================================
// ANTIABUSO — conta nova não é conta nova só porque o e-mail é outro
//
// O QUE ESTE ARQUIVO PROTEGE, e é uma coisa só: a COMISSÃO DE AFILIADO.
//
// No Koonfy não existe teste grátis no caminho que as pessoas usam. Quem assina
// entra por /assinar, paga o plano, e a conta nasce ativa. O que se dá é
// comissão: uma porcentagem da PRIMEIRA assinatura e outra de CADA RENOVAÇÃO
// (hoje 30% e 15%).
//
// É por aí que se pega um plano mais barato sem parecer que se pegou:
//
//   AUTOINDICAÇÃO — a pessoa cria a conta pelo PRÓPRIO link de afiliado. Os 30%
//   da primeira assinatura voltam para a carteira dela, e os 15% de cada
//   renovação voltam TODO MÊS, para sempre. Não é um desconto de uma vez: é uma
//   assinatura permanentemente 15% mais barata, paga pela plataforma, sem nada
//   em troca — porque não houve indicação nenhuma, só alguém se indicando.
//
// A parte da renovação é a que mais custa, e é a que menos aparece: a primeira
// dá para notar num relatório, a de todo mês some no meio das outras.
//
// ---------------------------------------------------------------------------
// O QUE ESTE ARQUIVO NÃO FAZ, e é de propósito
// ---------------------------------------------------------------------------
// NÃO BLOQUEIA CADASTRO. Nenhum sinal daqui é forte o bastante para dizer "esta
// pessoa é fraudadora" — todos têm explicação inocente, e recusar um cliente
// que ia PAGAR para evitar uma comissão indevida é trocar a assinatura inteira
// pela fração dela.
//
// O que ele faz é segurar a COMISSÃO e avisar o admin. A conta nasce, o plano é
// cobrado normal, o cliente usa o produto — o que espera é só o repasse.
//
// ---------------------------------------------------------------------------
// POR QUE CADA SINAL PESA O QUE PESA
// ---------------------------------------------------------------------------
//
// DOCUMENTO (CPF/CNPJ) — o mais forte que existe aqui. Não se cria um CPF novo
//   como se cria um e-mail. Duas contas no mesmo documento é a mesma pessoa ou
//   a mesma empresa, quase sem exceção. Mesmo assim NÃO bloqueia: um MEI pode
//   tocar dois negócios no próprio CPF, e isso é legítimo. O que fica preso é a
//   comissão, não o direito de existir.
//
// TELEFONE — quase tão forte quanto. Número é caro de multiplicar e é o mesmo
//   raciocínio do documento.
//
// IP — o mais FRACO dos três, e o que mais engana. Um escritório inteiro sai
//   pelo mesmo IP; a operadora de celular põe um bairro inteiro atrás de um
//   CGNAT; um coworking, idem. Bloquear por IP é bloquear o colega de trabalho
//   do seu cliente. Aqui ele só SINALIZA, e só conta junto com outro sinal.
//
// ---------------------------------------------------------------------------
// PARA A COMISSÃO, ATÉ O SINAL FRACO DECIDE
// ---------------------------------------------------------------------------
// Se quem indicou e quem foi indicado dividem IP, documento ou telefone, o
// repasse fica RETIDO até alguém olhar. Não é acusação — é não pagar antes de
// conferir, que é o contrário de estornar depois de ter pago.
//
// O IP entra aqui sozinho, e não entra em mais lugar nenhum. A razão é o custo
// do engano: segurar um repasse por engano faz um afiliado honesto esperar;
// pagar por engano manda dinheiro embora todo mês e depois é preciso pedir de
// volta, o que quase nunca acontece.
//
// E a retenção vale para a PRIMEIRA e para as RENOVAÇÕES. Segurar só a primeira
// resolveria 30% do problema uma vez e deixaria 15% escapando para sempre.
// ============================================================================

const db = require('./db');
const store = require('./store');

const DIA = 24 * 3600 * 1000;

// Quantos dias para trás um IP ainda conta. Depois disso a chance de ser
// coincidência (IP dinâmico reciclado pela operadora) passa a ser maior do que
// a de ser a mesma pessoa.
const JANELA_IP_DIAS = 30;

// Quantas contas no mesmo IP dentro da janela antes de virar sinal. Duas é
// normal (o sócio, o marido, o colega da mesa ao lado). A partir da terceira,
// vale um olhar.
const CONTAS_POR_IP = 3;

// ---------------------------------------------------------------------------
// OS SINAIS DE UM CADASTRO
// ---------------------------------------------------------------------------
function ipDaRequisicao(req) {
  if (!req) return '';
  const enc = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  const bruto = enc || (req.socket && req.socket.remoteAddress) || '';
  // ::ffff:1.2.3.4 é o IPv4 embrulhado em IPv6 — o mesmo endereço escrito de
  // outro jeito. Sem normalizar, a mesma máquina apareceria como dois IPs e
  // nenhum sinal casaria.
  return String(bruto).replace(/^::ffff:/, '').slice(0, 45);
}

const soDigitos = v => String(v || '').replace(/\D/g, '');

function sinaisDe(req, dados = {}) {
  return {
    ip: ipDaRequisicao(req),
    documento: soDigitos(dados.documento).slice(0, 14),
    telefone: soDigitos(dados.telefone).slice(0, 20),
    email: String(dados.email || '').toLowerCase().trim()
  };
}

// ---------------------------------------------------------------------------
// O QUE FICA GUARDADO NA CONTA
// ---------------------------------------------------------------------------
function ensure(acc) {
  if (!acc.origem || typeof acc.origem !== 'object') acc.origem = {};
  const o = acc.origem;
  if (o.ip === undefined) o.ip = '';
  if (o.criadoEm === undefined) o.criadoEm = acc.createdAt || Date.now();
  if (!Array.isArray(o.marcas)) o.marcas = [];    // o que o antiabuso apontou
  if (o.risco === undefined) o.risco = 0;
  if (o.trialNegado === undefined) o.trialNegado = false;
  if (o.revisadoPor === undefined) o.revisadoPor = '';
  return o;
}

function registrar(acc, sinais) {
  const o = ensure(acc);
  o.ip = sinais.ip || o.ip;
  o.criadoEm = o.criadoEm || Date.now();
  return o;
}

// ---------------------------------------------------------------------------
// AVALIAÇÃO
//
// `ignorar` é a conta que está nascendo: ela ainda não está na lista, mas se
// estiver (reavaliação), não pode casar consigo mesma.
// ---------------------------------------------------------------------------
function documentoDa(acc) {
  const p = acc.profile || {};
  const ep = acc.pagamentos || {};
  const sub = ep.subaccount || {};
  return soDigitos(p.document || sub.document);
}

function telefoneDa(acc) {
  return soDigitos((acc.profile || {}).phone);
}

function avaliar(sinais, { ignorar } = {}) {
  const agora = Date.now();
  const contas = db.get().accounts.filter(a => a.id !== (ignorar && ignorar.id));
  const motivos = [];
  const parentes = new Set();
  let risco = 0;

  // DOCUMENTO — o sinal forte.
  if (sinais.documento && sinais.documento.length >= 11) {
    const iguais = contas.filter(a => documentoDa(a) === sinais.documento);
    if (iguais.length) {
      risco += 60;
      motivos.push({
        chave: 'documento',
        texto: `Mesmo CPF/CNPJ de ${iguais.length} conta(s) já existente(s)`,
        contas: iguais.map(a => a.id)
      });
      iguais.forEach(a => parentes.add(a.id));
    }
  }

  // TELEFONE — quase tão forte.
  if (sinais.telefone && sinais.telefone.length >= 10) {
    const iguais = contas.filter(a => telefoneDa(a) === sinais.telefone);
    if (iguais.length) {
      risco += 50;
      motivos.push({
        chave: 'telefone',
        texto: `Mesmo WhatsApp de ${iguais.length} conta(s) já existente(s)`,
        contas: iguais.map(a => a.id)
      });
      iguais.forEach(a => parentes.add(a.id));
    }
  }

  // IP — o fraco. Só fala quando há MUITA gente no mesmo endereço.
  if (sinais.ip) {
    const iguais = contas.filter(a =>
      (a.origem && a.origem.ip) === sinais.ip &&
      agora - ((a.origem && a.origem.criadoEm) || 0) < JANELA_IP_DIAS * DIA
    );
    if (iguais.length >= CONTAS_POR_IP - 1) {
      risco += 20;
      motivos.push({
        chave: 'ip',
        texto: `${iguais.length + 1} contas criadas no mesmo IP em ${JANELA_IP_DIAS} dias`,
        contas: iguais.map(a => a.id)
      });
      iguais.forEach(a => parentes.add(a.id));
    }
  }

  return {
    risco: Math.min(100, risco),
    motivos,
    parentes: [...parentes],
    // TESTE GRÁTIS: RESGUARDO DORMENTE, e é honesto dizer que é isso.
    //
    // Hoje o cadastro que as pessoas usam (/assinar) nasce PAGO — não há teste
    // a negar. Este sinal só tem efeito em /api/register, que é rota de API e
    // nenhuma tela chama, e só se o admin ligar `trialDays`.
    //
    // Fica porque é a regra certa para o dia em que houver trial, e porque
    // custa quatro linhas. O que NÃO fica é a ideia de que isto é a defesa
    // principal: a defesa é a comissão, logo abaixo.
    //
    // "Pessoa" aqui é documento ou telefone — nunca IP sozinho, que negaria o
    // teste ao colega de escritório de quem já é cliente.
    semTrial: motivos.some(m => m.chave === 'documento' || m.chave === 'telefone')
  };
}

// ---------------------------------------------------------------------------
// AUTOINDICAÇÃO
//
// Aqui o IP CONTA, e conta sozinho. A diferença com o trial é o que está em
// jogo: lá, negar por engano tira sete dias de teste de um cliente legítimo;
// aqui, pagar por engano manda dinheiro embora e depois é preciso pedir de
// volta. Segurar uma comissão para conferir não custa nada a ninguém.
// ---------------------------------------------------------------------------
function indicacaoSuspeita(indicador, indicado, sinais) {
  if (!indicador || !indicado) return null;
  const motivos = [];

  const docA = documentoDa(indicador);
  const docB = sinais.documento || documentoDa(indicado);
  if (docA && docB && docA === docB) motivos.push('mesmo CPF/CNPJ do afiliado');

  const telA = telefoneDa(indicador);
  const telB = sinais.telefone || telefoneDa(indicado);
  if (telA && telB && telA === telB) motivos.push('mesmo WhatsApp do afiliado');

  const ipA = (indicador.origem && indicador.origem.ip) || '';
  const ipB = sinais.ip || (indicado.origem && indicado.origem.ip) || '';
  if (ipA && ipB && ipA === ipB) motivos.push('mesmo IP do afiliado');

  if (indicador.id === indicado.id) motivos.push('a conta indicou a si mesma');

  return motivos.length ? motivos : null;
}

// ---------------------------------------------------------------------------
// APLICAR NO CADASTRO — o único ponto de entrada que a API precisa conhecer
// ---------------------------------------------------------------------------
function aoCadastrar(acc, req, dados, indicador) {
  const sinais = sinaisDe(req, dados);
  registrar(acc, sinais);
  const r = avaliar(sinais, { ignorar: acc });
  const o = ensure(acc);
  o.risco = r.risco;
  o.marcas = r.motivos.map(m => ({ chave: m.chave, texto: m.texto, contas: m.contas, ts: Date.now() }));

  // A COMISSÃO, se houver indicação.
  let comissaoRetida = null;
  if (indicador) {
    const susp = indicacaoSuspeita(indicador, acc, sinais);
    if (susp) {
      comissaoRetida = susp;
      acc.affiliate.comissaoRetida = { motivos: susp, desde: Date.now(), liberadaPor: '' };
      o.marcas.push({
        chave: 'indicacao', texto: 'Indicação suspeita: ' + susp.join(', '),
        contas: [indicador.id], ts: Date.now()
      });
      o.risco = Math.min(100, o.risco + 30);
    }
  }

  if (r.semTrial) o.trialNegado = true;

  if (o.marcas.length) {
    store.logEvent({
      type: 'antiabuso', accountId: acc.id, risco: o.risco,
      marcas: o.marcas.map(m => m.chave), trialNegado: o.trialNegado,
      comissaoRetida: !!comissaoRetida
    });
  }
  return { ...r, comissaoRetida, trialNegado: o.trialNegado };
}

// A comissão desta conta pode ser paga?
function comissaoLiberada(acc) {
  const r = acc && acc.affiliate && acc.affiliate.comissaoRetida;
  return !r || !!r.liberadaPor;
}

// ---------------------------------------------------------------------------
// O QUE O ADMIN VÊ
// ---------------------------------------------------------------------------
function fila() {
  const linhas = [];
  for (const acc of db.get().accounts) {
    const o = acc.origem;
    if (!o || !Array.isArray(o.marcas) || !o.marcas.length) continue;
    const ret = acc.affiliate && acc.affiliate.comissaoRetida;
    linhas.push({
      accountId: acc.id, conta: acc.name, email: acc.email,
      criadoEm: o.criadoEm, ip: o.ip || '',
      documento: documentoDa(acc), telefone: telefoneDa(acc),
      risco: o.risco || 0,
      marcas: o.marcas,
      trialNegado: !!o.trialNegado,
      comissaoRetida: !!(ret && !ret.liberadaPor),
      motivosComissao: (ret && ret.motivos) || [],
      revisadoPor: o.revisadoPor || ''
    });
  }
  linhas.sort((a, b) => b.risco - a.risco || b.criadoEm - a.criadoEm);
  return {
    contas: linhas,
    total: linhas.length,
    comissoesRetidas: linhas.filter(l => l.comissaoRetida).length,
    trialsNegados: linhas.filter(l => l.trialNegado).length
  };
}

// Liberar é decisão de gente, e fica registrado quem decidiu.
function liberar(accountId, quem) {
  const acc = db.findAccount(accountId);
  if (!acc) { const e = new Error('Conta não encontrada'); e.status = 404; throw e; }
  const o = ensure(acc);
  o.revisadoPor = String(quem || 'admin').slice(0, 80);
  if (acc.affiliate && acc.affiliate.comissaoRetida) {
    acc.affiliate.comissaoRetida.liberadaPor = o.revisadoPor;
  }
  db.save();
  store.logEvent({ type: 'antiabuso_liberado', accountId: acc.id, por: o.revisadoPor });
  return fila();
}

module.exports = {
  JANELA_IP_DIAS, CONTAS_POR_IP,
  ipDaRequisicao, sinaisDe, ensure, registrar,
  avaliar, indicacaoSuspeita, aoCadastrar,
  comissaoLiberada, fila, liberar
};
