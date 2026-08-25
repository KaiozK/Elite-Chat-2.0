// ============================================================================
// MODO BET — o Tracking pela régua do iGaming
//
// Só existe para contas de segmento `igaming` (src/segmentos.js). O Tracking
// comum conta VENDA: um pagamento, um valor, pronto. Uma operação de apostas
// não funciona assim — ela tem duas conversões, e a distância entre as duas é o
// negócio inteiro:
//
//   CADASTRO — o jogador criou conta. Custa dinheiro e ainda não trouxe nada.
//   FTD       — first time deposit, o PRIMEIRO depósito daquele jogador. É aqui
//               que o tráfego pago vira receita.
//
// Um criativo que traz cadastro barato e nenhum FTD é o pior resultado
// possível: parece ótimo no gerenciador de anúncios e não paga a conta. Por
// isso tudo aqui é medido nas DUAS pontas, e a tabela por campanha existe para
// mostrar exatamente onde a segunda ponta não acontece.
//
// De onde vêm os dados: dos eventos que a plataforma de apostas manda para
// POST /api/public/track/:accId, os mesmos que alimentam o resto do Tracking.
// Este módulo não inventa evento nenhum — ele CLASSIFICA o que chegou.
// ============================================================================

const db = require('./db');

// ---------------------------------------------------------------------------
// VOCABULÁRIO
//
// Cada casa nomeia o evento de um jeito, e quem integra manda o nome que já usa
// no pixel. Em vez de exigir um nome único (que daria relatório vazio e nenhuma
// pista do porquê), aceitamos os nomes de mercado.
//
// A comparação é sobre o nome em minúsculas, sem acento e sem separador, então
// `CompleteRegistration`, `complete_registration` e `Complete Registration`
// caem todos no mesmo lugar.
// ---------------------------------------------------------------------------
const CADASTRO = [
  'completeregistration', 'registration', 'register', 'signup', 'cadastro', 'lead'
];
const DEPOSITO = [
  'purchase', 'deposit', 'deposito', 'ftd', 'firstdeposit', 'recharge'
];

function chave(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function ehCadastro(nome) { return CADASTRO.includes(chave(nome)); }
function ehDeposito(nome) { return DEPOSITO.includes(chave(nome)); }

// O valor do evento vem em REAIS no payload (é o que o pixel manda) e o resto
// do Koonfy trabalha em centavos. Converter na entrada evita float de reais
// atravessando soma.
function valorCents(ev) {
  const v = ev && ev.payload ? ev.payload.value : 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// ---------------------------------------------------------------------------
// Configuração por conta (Tracking → Modo Bet)
// ---------------------------------------------------------------------------
function cfg(acc) {
  const t = require('./tracking').ensure(acc);
  if (!t.bet || typeof t.bet !== 'object') t.bet = emptyCfg();
  for (const [k, v] of Object.entries(emptyCfg())) if (t.bet[k] === undefined) t.bet[k] = v;
  return t.bet;
}

function emptyCfg() {
  return {
    // INVESTIMENTO MANUAL, em centavos, no período.
    //
    // O Tracking já sabe o gasto do Meta Ads quando a conta sincroniza. Mas
    // tráfego de iGaming raramente é só Meta: é Google, Telegram, influencer,
    // rede de afiliados. Sem um lugar para digitar o resto, todo CPA sairia
    // otimista — e um CPA otimista é pior que CPA nenhum, porque parece certo.
    //
    // Zero = usa só o que veio do Meta.
    investimentoCents: 0,
    metaCpaFtdCents: 0     // meta de CPA por FTD; 0 = sem meta definida
  };
}

// ---------------------------------------------------------------------------
// O RELATÓRIO
// ---------------------------------------------------------------------------
function relatorio(acc, { dias = 30 } = {}) {
  const tracking = require('./tracking');
  const t = tracking.ensure(acc);
  const desde = Date.now() - dias * 86400000;
  const c = cfg(acc);

  const eventos = (t.events || []).filter(e => e.ts >= desde);
  const sessoes = new Map((t.sessions || []).map(s => [s.sid, s]));

  // ---- cadastros ----
  // Um jogador que dispara o evento duas vezes (recarregou a página, voltou no
  // dia seguinte) é UM cadastro. A chave é a sessão; sem sessão, o próprio id
  // do evento, que ao menos não infla o número com repetição do mesmo clique.
  const cadastros = new Map();     // sid → { ts, campanha }
  for (const e of eventos) {
    if (!ehCadastro(e.name)) continue;
    const k = e.sid || ('ev:' + e.id);
    const anterior = cadastros.get(k);
    if (!anterior || e.ts < anterior.ts) cadastros.set(k, { ts: e.ts, campanha: campanhaDe(e, sessoes) });
  }

  // ---- depósitos, e qual deles é o FTD ----
  // FTD é o PRIMEIRO depósito do jogador. Como os eventos chegam em ordem
  // qualquer, o primeiro é decidido por timestamp, e não por ordem de chegada.
  const porJogador = new Map();    // sid → [depósitos]
  for (const e of eventos) {
    if (!ehDeposito(e.name)) continue;
    const k = e.sid || ('ev:' + e.id);
    if (!porJogador.has(k)) porJogador.set(k, []);
    porJogador.get(k).push({ ts: e.ts, valor: valorCents(e), campanha: campanhaDe(e, sessoes) });
  }

  let ftds = [], redepositos = 0, depositoTotal = 0, ftdTotal = 0;
  for (const [k, lista] of porJogador) {
    lista.sort((a, b) => a.ts - b.ts);
    const primeiro = lista[0];
    // A campanha do FTD é a do CADASTRO quando ele existe: o crédito é de quem
    // trouxe o jogador, não de onde ele estava quando depositou. É a diferença
    // entre medir aquisição e medir remarketing.
    const cad = cadastros.get(k);
    ftds.push({ sid: k, ts: primeiro.ts, valor: primeiro.valor,
      campanha: (cad && cad.campanha) || primeiro.campanha,
      desdeCadastro: cad ? Math.max(0, primeiro.ts - cad.ts) : null });
    ftdTotal += primeiro.valor;
    redepositos += lista.length - 1;
    for (const d of lista) depositoTotal += d.valor;
  }

  // ---- investimento ----
  const meta = tracking.adSpend ? tracking.adSpend(acc) : 0;
  const manual = Math.max(0, Number(c.investimentoCents) || 0);
  const investimento = meta + manual;

  const nCad = cadastros.size, nFtd = ftds.length;
  const div = (a, b) => (b ? Math.round(a / b) : null);

  // ---- por campanha ----
  // A tabela que responde a pergunta do negócio: qual criativo traz jogador que
  // DEPOSITA. Volume de cadastro sozinho engana.
  const camps = new Map();
  const linha = nome => {
    if (!camps.has(nome)) camps.set(nome, { campanha: nome, cadastros: 0, ftds: 0, ftdTotal: 0 });
    return camps.get(nome);
  };
  for (const [, v] of cadastros) linha(v.campanha).cadastros++;
  for (const f of ftds) { const l = linha(f.campanha); l.ftds++; l.ftdTotal += f.valor; }

  const campanhas = [...camps.values()].map(l => ({
    ...l,
    taxa: l.cadastros ? +((l.ftds / l.cadastros) * 100).toFixed(1) : 0,
    ticketFtd: l.ftds ? Math.round(l.ftdTotal / l.ftds) : 0
  })).sort((a, b) => b.ftds - a.ftds || b.cadastros - a.cadastros);

  return {
    dias,
    geral: {
      cadastros: nCad,
      ftds: nFtd,
      redepositos,
      taxaFtd: nCad ? +((nFtd / nCad) * 100).toFixed(1) : 0,
      investimentoCents: investimento,
      investimentoMetaCents: meta,
      investimentoManualCents: manual,
      // Os dois números que dão nome ao Modo Bet.
      cpaCadastroCents: div(investimento, nCad),
      cpaFtdCents: div(investimento, nFtd),
      ticketFtdCents: nFtd ? Math.round(ftdTotal / nFtd) : 0,
      depositoTotalCents: depositoTotal,
      ftdTotalCents: ftdTotal,
      roas: investimento ? +(depositoTotal / investimento).toFixed(2) : null,
      // Mediana, e não média: um jogador que demorou trinta dias puxaria a média
      // para um número que não descreve ninguém. A mediana diz "metade deposita
      // até aqui", que é o que define a janela de remarketing.
      tempoAteFtdMs: mediana(ftds.map(f => f.desdeCadastro).filter(v => v != null)),
      metaCpaFtdCents: Math.max(0, Number(c.metaCpaFtdCents) || 0)
    },
    campanhas,
    alertas: alertas(campanhas, nCad, nFtd)
  };
}

// A campanha de um evento: a UTM da sessão dele, se houver.
function campanhaDe(ev, sessoes) {
  const s = ev.sid ? sessoes.get(ev.sid) : null;
  const u = (s && s.utm) || (ev.payload && ev.payload.utm) || {};
  return String(u.campaign || u.source || 'Sem campanha').slice(0, 80);
}

function mediana(v) {
  if (!v.length) return null;
  const a = [...v].sort((x, y) => x - y), m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

// ---------------------------------------------------------------------------
// ALERTAS — o que um operador de tráfego quer que alguém lhe diga sem ter de
// procurar. São observações sobre os dados, não conselhos genéricos.
// ---------------------------------------------------------------------------
function alertas(campanhas, nCad, nFtd) {
  const out = [];

  // O caso clássico de tráfego ruim ou fraude: cadastro entra, depósito nunca.
  // Cinco é o piso para não acusar campanha que mal começou.
  for (const c of campanhas) {
    if (c.cadastros >= 5 && c.ftds === 0) {
      out.push({ nivel: 'alto', campanha: c.campanha,
        texto: `${c.cadastros} cadastros e nenhum FTD. Tráfego que registra e não deposita costuma ser incentivado ou fraudado.` });
    }
  }

  // A melhor e a pior campanha em conversão, quando há base para comparar.
  const comBase = campanhas.filter(c => c.cadastros >= 5);
  if (comBase.length >= 2) {
    const ord = [...comBase].sort((a, b) => b.taxa - a.taxa);
    const melhor = ord[0], pior = ord[ord.length - 1];
    if (melhor.taxa > 0 && melhor.taxa >= pior.taxa * 2) {
      out.push({ nivel: 'info', campanha: melhor.campanha,
        texto: `Converte ${melhor.taxa}% de cadastro em FTD, contra ${pior.taxa}% de "${pior.campanha}". O orçamento rende mais aqui.` });
    }
  }

  if (nCad && !nFtd) {
    out.push({ nivel: 'alto', campanha: '',
      texto: 'Nenhum FTD no período. Confira se a plataforma está enviando o evento de depósito para o Koonfy.' });
  }
  if (!nCad) {
    out.push({ nivel: 'info', campanha: '',
      texto: 'Nenhum cadastro recebido. O Modo Bet lê os eventos que a sua plataforma envia — veja a aba Conexões para o endereço.' });
  }
  return out;
}

function salvarCfg(acc, b) {
  const c = cfg(acc);
  if (b.investimentoCents !== undefined) {
    c.investimentoCents = Math.max(0, Math.round(Number(b.investimentoCents) || 0));
  }
  if (b.metaCpaFtdCents !== undefined) {
    c.metaCpaFtdCents = Math.max(0, Math.round(Number(b.metaCpaFtdCents) || 0));
  }
  db.save();
  return cfg(acc);
}

module.exports = {
  CADASTRO, DEPOSITO, chave, ehCadastro, ehDeposito,
  cfg, emptyCfg, salvarCfg, relatorio, mediana
};
